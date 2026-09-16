import { RuleViolation } from "../constants.js";
import { getFaultEffects } from "./conditions.js";
import {
  EPSILON,
  add,
  dot,
  lerp,
  localToWorld,
  magnitude,
  normalizeHeading,
  roundHalfAwayFromZero,
  roundTo,
  scale,
  subtract,
} from "./math.js";
import {
  circleContactNormal,
  closestPointOnSegment,
  isInFiringArc,
  struckSector,
  sweptCircleVsCircle,
  sweptCircleVsSegment,
  wallContactNormal,
} from "./geometry.js";

export { isInFiringArc, struckSector } from "./geometry.js";

export const INTEGRATION_STEPS_PER_INTERVAL = 64;
export const MAX_COAST_COLLISIONS = 64;
export const SIZE_MASS = Object.freeze({
  tiny: 1,
  small: 2,
  medium: 4,
  large: 8,
  huge: 16,
  gargantuan: 32,
});
export const SIZE_ORDER = Object.freeze(Object.keys(SIZE_MASS));
export const SIZE_DAMAGE_MULTIPLIERS = Object.freeze([
  Object.freeze({ smaller: 1, larger: 1 }),
  Object.freeze({ smaller: 1.25, larger: 0.75 }),
  Object.freeze({ smaller: 2, larger: 0.5 }),
  Object.freeze({ smaller: 3, larger: 0.25 }),
  Object.freeze({ smaller: 4, larger: 0.1 }),
  Object.freeze({ smaller: 5, larger: 0.05 }),
]);
function tierAt(component, power) {
  const tiers = Array.from(component?.tiers ?? []).filter((tier) => Number(tier?.power) <= power);
  tiers.sort((left, right) => Number(left.power) - Number(right.power));
  return tiers.at(-1) ?? { multiplier: 0, online: false };
}

export function getDriveCapabilities(config, state) {
  const drive = config?.components?.drive ?? {};
  const tier = tierAt(drive, Number(state?.power?.engines ?? 0));
  const driveFault = getFaultEffects(config, state, { componentId: drive.id, channel: "driveFailure" });
  const thrusterFault = getFaultEffects(config, state, { componentId: drive.id, channel: "maneuveringThrusterFailure" });
  const base = drive.base ?? {};
  const multiplier = Number(tier.multiplier ?? 0);
  return {
    forward: Number(base.forward ?? 0) * multiplier * Number(driveFault.forwardMultiplier ?? driveFault.capabilityMultiplier ?? 1),
    retro: Number(base.retro ?? 0) * multiplier * Number(driveFault.retroMultiplier ?? driveFault.capabilityMultiplier ?? 1),
    port: Number(base.port ?? 0) * multiplier * Number(thrusterFault.lateralMultiplier ?? thrusterFault.capabilityMultiplier ?? 1),
    starboard: Number(base.starboard ?? 0) * multiplier * Number(thrusterFault.lateralMultiplier ?? thrusterFault.capabilityMultiplier ?? 1),
    rotation: Number(base.rotation ?? 0) * multiplier * Number(thrusterFault.rotationMultiplier ?? thrusterFault.capabilityMultiplier ?? 1),
  };
}

function violation(code, message, details = undefined) {
  throw new RuleViolation(code, message, details);
}

function finiteNumber(value, code, field) {
  if (!Number.isFinite(value)) violation(code, `${field} must be finite`, { field, value });
  return value;
}

function finiteVector(value, code, field) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    violation(code, `${field} must be a finite vector`, { field, value });
  }
  return { x: value.x, y: value.y };
}

function requestedAxes(input = {}) {
  const requested = input.deltaV ?? input.requestedDeltaV ?? input.localDeltaV ?? {};
  const forward = requested.forward ?? requested.y ?? 0;
  const lateral = requested.lateral ?? requested.starboard ?? requested.x ?? 0;
  finiteNumber(forward, "MOVEMENT_INVALID_DELTA_V", "deltaV.forward");
  finiteNumber(lateral, "MOVEMENT_INVALID_DELTA_V", "deltaV.lateral");
  return { forward, lateral };
}

function directionalCapabilities(input = {}) {
  const capabilities = input.capabilities ?? input;
  return {
    forward: capabilities.forward ?? capabilities.forwardDeltaV ?? 0,
    retro: capabilities.retro ?? capabilities.retroDeltaV ?? 0,
    port: capabilities.port ?? capabilities.portDeltaV ?? 0,
    starboard: capabilities.starboard ?? capabilities.starboardDeltaV ?? 0,
    rotation: capabilities.rotation ?? capabilities.rotationDegrees ?? 0,
  };
}

function timelineValue(source) {
  return source?.timeline ?? source?.timelineUsed ?? 0;
}

function reservedEvasion(source) {
  if (!source) return 0;
  return source.evasion?.reserved ?? source.evasionReserved ?? 0;
}

function compareIds(left, right) {
  const first = String(left?.obstacleId ?? obstacleSortId(left));
  const second = String(right?.obstacleId ?? obstacleSortId(right));
  return first < second ? -1 : first > second ? 1 : 0;
}

function unitNormal(value) {
  const normal = finiteVector(value, "MOVEMENT_INVALID_NORMAL", "normal");
  const length = magnitude(normal);
  if (length <= EPSILON) violation("MOVEMENT_INVALID_NORMAL", "Collision normal cannot be zero");
  return scale(normal, 1 / length);
}

/** @param {{deltaV?:object,requestedDeltaV?:object,capabilities:object,duration?:number}} input @returns {{duration:number,axisTimes:{forward:number,lateral:number},deltaV:{forward:number,lateral:number},coast:boolean}} */
export function getManeuverTime(input) {
  const deltaV = requestedAxes(input);
  const capabilities = directionalCapabilities(input.capabilities ?? {});
  for (const [key, value] of Object.entries(capabilities)) {
    finiteNumber(value, "MOVEMENT_INVALID_CAPABILITY", `capabilities.${key}`);
    if (value < 0) violation("MOVEMENT_INVALID_CAPABILITY", `capabilities.${key} cannot be negative`, { axis: key, value });
  }

  const forwardCapability = deltaV.forward >= 0 ? capabilities.forward : capabilities.retro;
  const lateralCapability = deltaV.lateral >= 0 ? capabilities.starboard : capabilities.port;
  if (Math.abs(deltaV.forward) > EPSILON && forwardCapability <= EPSILON) {
    violation("MOVEMENT_AXIS_UNAVAILABLE", "Requested longitudinal thrust has no available capability", { axis: deltaV.forward >= 0 ? "forward" : "retro" });
  }
  if (Math.abs(deltaV.lateral) > EPSILON && lateralCapability <= EPSILON) {
    violation("MOVEMENT_AXIS_UNAVAILABLE", "Requested lateral thrust has no available capability", { axis: deltaV.lateral >= 0 ? "starboard" : "port" });
  }

  const forwardTime = Math.abs(deltaV.forward) <= EPSILON ? 0 : Math.abs(deltaV.forward) / forwardCapability;
  const lateralTime = Math.abs(deltaV.lateral) <= EPSILON ? 0 : Math.abs(deltaV.lateral) / lateralCapability;
  const coast = forwardTime <= EPSILON && lateralTime <= EPSILON;
  let duration = Math.max(forwardTime, lateralTime);
  if (coast) {
    duration = input.duration ?? 0;
    finiteNumber(duration, "MOVEMENT_INVALID_DURATION", "duration");
    if (duration < 0) violation("MOVEMENT_INVALID_DURATION", "Coast duration cannot be negative", { duration });
  } else if (input.duration !== undefined && Math.abs(input.duration - duration) > EPSILON) {
    violation("MOVEMENT_DURATION_MISMATCH", "Powered maneuver duration is determined by directional capability", { supplied: input.duration, required: duration });
  }

  return {
    duration: roundTo(duration, 12),
    axisTimes: { forward: roundTo(forwardTime, 12), lateral: roundTo(lateralTime, 12) },
    deltaV,
    coast,
  };
}

/** @param {object} input @returns {object} */
export function validateManeuverTime(input) {
  const maneuver = getManeuverTime(input);
  const timelineUsed = finiteNumber(input.timelineUsed ?? timelineValue(input.state), "MOVEMENT_INVALID_TIMELINE", "timelineUsed");
  const reserve = finiteNumber(input.evasionReserved ?? reservedEvasion(input.state), "MOVEMENT_INVALID_EVASION_RESERVE", "evasionReserved");
  if (timelineUsed < -EPSILON || timelineUsed > 1 + EPSILON) {
    violation("MOVEMENT_INVALID_TIMELINE", "Maneuver timeline must be between 0 and 1", { timelineUsed });
  }
  if (reserve < -EPSILON || reserve > 1 + EPSILON) {
    violation("MOVEMENT_INVALID_EVASION_RESERVE", "Evasion reserve must be between 0 and 1", { reserve });
  }
  const limit = 1 - reserve;
  if (timelineUsed + maneuver.duration > limit + EPSILON) {
    violation("MOVEMENT_TIMELINE_EXCEEDED", "Maneuver exceeds the unreserved timeline", {
      timelineUsed,
      duration: maneuver.duration,
      reserve,
      limit,
    });
  }

  const rotation = finiteNumber(input.rotation ?? 0, "MOVEMENT_INVALID_ROTATION", "rotation");
  const capabilities = directionalCapabilities(input.capabilities ?? {});
  const rotationSpent = finiteNumber(input.rotationSpent ?? input.state?.rotationSpent ?? 0, "MOVEMENT_INVALID_ROTATION_SPENT", "rotationSpent");
  if (rotationSpent < -EPSILON) violation("MOVEMENT_INVALID_ROTATION_SPENT", "Spent rotation cannot be negative", { rotationSpent });
  const rotationRemaining = Math.max(0, capabilities.rotation - rotationSpent);
  if (Math.abs(rotation) > rotationRemaining + EPSILON) {
    violation("MOVEMENT_ROTATION_EXCEEDED", "Maneuver exceeds remaining absolute rotation", {
      requested: Math.abs(rotation),
      rotationSpent,
      capability: capabilities.rotation,
    });
  }

  return {
    ...maneuver,
    timelineUsed,
    timelineLimit: limit,
    timelineRemainingAfter: Math.max(0, limit - timelineUsed - maneuver.duration),
    reserve,
    rotation,
    rotationSpent,
    rotationRemaining,
  };
}

/** @param {{position:{x:number,y:number},velocity:{x:number,y:number},facing:number,duration:number,deltaV?:object,rotation?:number,collisionRadius?:number}} input @returns {object} */
export function integrateBurn(input) {
  const position = finiteVector(input.position, "MOVEMENT_INVALID_POSITION", "position");
  const velocity = finiteVector(input.velocity, "MOVEMENT_INVALID_VELOCITY", "velocity");
  const facing = finiteNumber(input.facing, "MOVEMENT_INVALID_FACING", "facing");
  const duration = finiteNumber(input.duration, "MOVEMENT_INVALID_DURATION", "duration");
  const rotation = finiteNumber(input.rotation ?? 0, "MOVEMENT_INVALID_ROTATION", "rotation");
  const deltaV = requestedAxes(input);
  const collisionRadius = finiteNumber(input.collisionRadius ?? 0, "MOVEMENT_INVALID_RADIUS", "collisionRadius");
  if (duration < 0 || duration > 1 + EPSILON) violation("MOVEMENT_INVALID_DURATION", "Integration duration must be between 0 and 1", { duration });
  if (collisionRadius < 0) violation("MOVEMENT_INVALID_RADIUS", "Collision radius cannot be negative", { collisionRadius });
  if (duration <= EPSILON && (Math.abs(deltaV.forward) > EPSILON || Math.abs(deltaV.lateral) > EPSILON)) {
    violation("MOVEMENT_ZERO_DURATION_THRUST", "Nonzero thrust requires positive maneuver time");
  }

  const first = {
    time: 0,
    fraction: 0,
    position,
    velocity,
    facing: normalizeHeading(facing),
    unwrappedFacing: facing,
    acceleration: { x: 0, y: 0 },
    collisionRadius,
    id: String(input.id ?? input.ship?.id ?? "active"),
  };
  const path = [first];
  if (duration <= EPSILON) {
    const finalFacing = normalizeHeading(facing + rotation);
    if (Math.abs(rotation) > EPSILON) {
      path.push({ ...first, facing: finalFacing, unwrappedFacing: facing + rotation, fraction: 1 });
    }
    return { path, position: { ...position }, velocity: { ...velocity }, facing: finalFacing, duration: 0, rotation, deltaV };
  }

  const stepsPerInterval = input.stepsPerInterval ?? INTEGRATION_STEPS_PER_INTERVAL;
  if (!Number.isInteger(stepsPerInterval) || stepsPerInterval <= 0) {
    violation("MOVEMENT_INVALID_INTEGRATION_STEPS", "Integration steps must be a positive integer", { stepsPerInterval });
  }
  const steps = Math.max(1, Math.ceil((duration * stepsPerInterval) - EPSILON));
  const stepTime = duration / steps;
  const angularRate = rotation / duration;
  const localAcceleration = { x: deltaV.lateral / duration, y: deltaV.forward / duration };
  let currentPosition = position;
  let currentVelocity = velocity;

  for (let step = 0; step < steps; step += 1) {
    const startTime = step * stepTime;
    const midpointFacing = facing + (angularRate * (startTime + (stepTime / 2)));
    const acceleration = localToWorld(localAcceleration, midpointFacing);
    currentPosition = add(currentPosition, add(scale(currentVelocity, stepTime), scale(acceleration, 0.5 * stepTime * stepTime)));
    currentVelocity = add(currentVelocity, scale(acceleration, stepTime));
    const time = (step + 1) * stepTime;
    const unwrappedFacing = facing + (angularRate * time);
    path.push({
      time: roundTo(time, 15),
      fraction: (step + 1) / steps,
      position: currentPosition,
      velocity: currentVelocity,
      facing: normalizeHeading(unwrappedFacing),
      unwrappedFacing,
      acceleration,
      id: first.id,
      collisionRadius,
    });
  }

  return {
    path,
    position: { ...currentPosition },
    velocity: { ...currentVelocity },
    facing: normalizeHeading(facing + rotation),
    duration,
    rotation,
    deltaV,
  };
}

function interpolatePathState(start, end, fraction, contactPosition = undefined) {
  const elapsed = (end.time - start.time) * fraction;
  const acceleration = end.acceleration ?? { x: 0, y: 0 };
  const position = contactPosition ?? add(start.position, add(scale(start.velocity, elapsed), scale(acceleration, 0.5 * elapsed * elapsed)));
  const velocity = add(start.velocity, scale(acceleration, elapsed));
  const unwrappedFacing = lerp(start.unwrappedFacing ?? start.facing, end.unwrappedFacing ?? end.facing, fraction);
  return {
    time: lerp(start.time, end.time, fraction),
    fraction: lerp(start.fraction ?? 0, end.fraction ?? 1, fraction),
    position,
    velocity,
    facing: normalizeHeading(unwrappedFacing),
    unwrappedFacing,
    acceleration,
    collisionRadius: start.collisionRadius ?? end.collisionRadius ?? 0,
  };
}

function obstacleType(obstacle) {
  if (obstacle.type === "wall" || (obstacle.a && obstacle.b)) return "wall";
  return "ship";
}

function obstacleSortId(obstacle) {
  return String(obstacle.id ?? obstacle.tokenId ?? "");
}

/** @param {Array<object>|{path:Array<object>}} path @param {Array<object>} obstacles @returns {null|object} */
export function findFirstCollision(path, obstacles = []) {
  const points = Array.isArray(path) ? path : path?.path;
  if (!Array.isArray(points) || points.length < 2) return null;
  const orderedObstacles = [...obstacles].sort(compareIds);
  let earliest = null;
  const simultaneous = [];

  for (let legIndex = 1; legIndex < points.length; legIndex += 1) {
    const start = points[legIndex - 1];
    const end = points[legIndex];
    const radius = start.collisionRadius ?? end.collisionRadius ?? 0;
    for (const obstacle of orderedObstacles) {
      let contact;
      if (obstacleType(obstacle) === "wall") {
        finiteVector(obstacle.a, "MOVEMENT_INVALID_WALL", "wall.a");
        finiteVector(obstacle.b, "MOVEMENT_INVALID_WALL", "wall.b");
        contact = sweptCircleVsSegment(start.position, end.position, radius, obstacle.a, obstacle.b, { id: obstacle.id });
      } else {
        const obstaclePosition = obstacle.position ?? obstacle.center;
        if (!obstaclePosition) continue;
        finiteVector(obstaclePosition, "MOVEMENT_INVALID_POSITION", "obstacle.position");
        const obstacleRadius = finiteNumber(obstacle.radius ?? obstacle.collisionRadius ?? 0, "MOVEMENT_INVALID_RADIUS", "obstacle.radius");
        if (obstacleRadius < 0) violation("MOVEMENT_INVALID_RADIUS", "Collision radius cannot be negative", { obstacleId: obstacleSortId(obstacle), radius: obstacleRadius });
        contact = sweptCircleVsCircle(
          start.position,
          end.position,
          radius,
          obstaclePosition,
          obstaclePosition,
          obstacleRadius,
          String(points[0].id ?? "active"),
          obstacleSortId(obstacle),
        );
      }
      if (!contact) continue;
      const time = lerp(start.time, end.time, contact.fraction);
      const candidate = {
        type: obstacleType(obstacle),
        obstacleId: obstacleSortId(obstacle),
        obstacle,
        legIndex,
        legFraction: contact.fraction,
        time,
        pathFraction: points[points.length - 1].time > EPSILON ? time / points[points.length - 1].time : 0,
        ...contact,
      };
      if (!earliest || time < earliest.time - EPSILON) {
        earliest = candidate;
        simultaneous.length = 0;
        simultaneous.push(candidate);
      } else if (Math.abs(time - earliest.time) <= EPSILON) {
        simultaneous.push(candidate);
      }
    }
    if (earliest && earliest.legIndex === legIndex) break;
  }

  if (!earliest) return null;
  simultaneous.sort(compareIds);
  const selected = simultaneous[0];
  const start = points[selected.legIndex - 1];
  const end = points[selected.legIndex];
  const activePosition = selected.type === "ship" ? selected.centerA : selected.center;
  const activeState = interpolatePathState(start, end, selected.legFraction, activePosition);
  return { ...selected, activeState, simultaneous };
}

function truncatedPath(path, collision, phase) {
  if (!collision) return path.map((point) => ({ ...point, phase }));
  const prefix = path.slice(0, collision.legIndex).map((point) => ({ ...point, phase }));
  prefix.push({ ...collision.activeState, phase, collision: true });
  return prefix;
}

function sizeIndex(size) {
  const index = SIZE_ORDER.indexOf(String(size ?? "medium").toLowerCase());
  if (index < 0) violation("MOVEMENT_INVALID_SIZE", "Unknown ship size", { size });
  return index;
}

/** @param {string} size @returns {number} */
export function getMassForSize(size) {
  const normalized = String(size ?? "medium").toLowerCase();
  const mass = SIZE_MASS[normalized];
  if (!mass) violation("MOVEMENT_INVALID_SIZE", "Unknown ship size", { size });
  return mass;
}

/** @param {string} recipientSize @param {string} otherSize @returns {number} */
export function getCollisionSizeMultiplier(recipientSize, otherSize) {
  const recipient = sizeIndex(recipientSize);
  const other = sizeIndex(otherSize);
  const difference = Math.min(5, Math.abs(recipient - other));
  if (difference === 0) return 1;
  return recipient < other ? SIZE_DAMAGE_MULTIPLIERS[difference].smaller : SIZE_DAMAGE_MULTIPLIERS[difference].larger;
}

/** @param {number} hullDamage @param {number} maxHull @returns {null|"minor"|"major"|"critical"} */
export function getCollisionSeverity(hullDamage, maxHull) {
  finiteNumber(hullDamage, "MOVEMENT_INVALID_DAMAGE", "hullDamage");
  finiteNumber(maxHull, "MOVEMENT_INVALID_MAX_HULL", "maxHull");
  if (maxHull <= 0) violation("MOVEMENT_INVALID_MAX_HULL", "Maximum Hull must be positive", { maxHull });
  if (hullDamage >= maxHull * 0.75) return "critical";
  if (hullDamage >= maxHull * 0.5) return "major";
  if (hullDamage >= maxHull * 0.25) return "minor";
  return null;
}

function collisionDamage(relativeSpeed, recipient, otherSize, applied = true) {
  const baseDamage = 2 * relativeSpeed;
  const multiplier = getCollisionSizeMultiplier(recipient.size, otherSize);
  const calculatedRawDamage = roundHalfAwayFromZero(baseDamage * multiplier);
  const armor = Math.max(0, recipient.armor ?? 0);
  const rawDamage = applied ? calculatedRawDamage : 0;
  const hullDamage = applied ? Math.max(0, rawDamage - armor) : 0;
  const severity = applied && recipient.maxHull != null ? getCollisionSeverity(hullDamage, recipient.maxHull) : null;
  return { baseDamage, multiplier, calculatedRawDamage, rawDamage, armor, hullDamage, severity, applied };
}

/** @param {{position:{x:number,y:number},radius:number,mass:number}} first @param {{position:{x:number,y:number},radius:number,mass:number}} second @param {{x:number,y:number}} normal @returns {object} */
export function separateOverlappingCircles(first, second, normal) {
  const positionA = finiteVector(first.position, "MOVEMENT_INVALID_POSITION", "first.position");
  const positionB = finiteVector(second.position, "MOVEMENT_INVALID_POSITION", "second.position");
  const radiusA = finiteNumber(first.radius, "MOVEMENT_INVALID_RADIUS", "first.radius");
  const radiusB = finiteNumber(second.radius, "MOVEMENT_INVALID_RADIUS", "second.radius");
  const massA = finiteNumber(first.mass, "MOVEMENT_INVALID_MASS", "first.mass");
  const massB = finiteNumber(second.mass, "MOVEMENT_INVALID_MASS", "second.mass");
  if (radiusA < 0 || radiusB < 0) violation("MOVEMENT_INVALID_RADIUS", "Collision radii cannot be negative");
  if (massA <= 0 || massB <= 0) violation("MOVEMENT_INVALID_MASS", "Collision masses must be positive");
  const direction = unitNormal(normal);
  const separation = Math.max(0, (radiusA + radiusB) - magnitude(subtract(positionB, positionA)));
  if (separation <= EPSILON) return { positionA, positionB, separation: 0 };
  const inverseA = 1 / massA;
  const inverseB = 1 / massB;
  const totalInverse = inverseA + inverseB;
  return {
    positionA: add(positionA, scale(direction, -(separation + EPSILON) * (inverseA / totalInverse))),
    positionB: add(positionB, scale(direction, (separation + EPSILON) * (inverseB / totalInverse))),
    separation,
  };
}

/** @param {{velocity:{x:number,y:number},mass:number}} first @param {{velocity:{x:number,y:number},mass:number}} second @param {{x:number,y:number}} normal @returns {object} */
export function resolveInelasticNormalResponse(first, second, normal) {
  const velocityA = finiteVector(first.velocity, "MOVEMENT_INVALID_VELOCITY", "first.velocity");
  const velocityB = finiteVector(second.velocity, "MOVEMENT_INVALID_VELOCITY", "second.velocity");
  const massA = finiteNumber(first.mass, "MOVEMENT_INVALID_MASS", "first.mass");
  const massB = finiteNumber(second.mass, "MOVEMENT_INVALID_MASS", "second.mass");
  if (massA <= 0 || massB <= 0) violation("MOVEMENT_INVALID_MASS", "Collision masses must be positive");
  const direction = unitNormal(normal);
  const normalA = dot(velocityA, direction);
  const normalB = dot(velocityB, direction);
  const closing = normalA - normalB > EPSILON;
  if (!closing) return { velocityA, velocityB, sharedNormalVelocity: null, closing: false };
  const sharedNormalVelocity = ((massA * normalA) + (massB * normalB)) / (massA + massB);
  return {
    velocityA: add(velocityA, scale(direction, sharedNormalVelocity - normalA)),
    velocityB: add(velocityB, scale(direction, sharedNormalVelocity - normalB)),
    sharedNormalVelocity,
    closing: true,
  };
}

/** @param {{shipA:object,shipB:object,normal?:{x:number,y:number}}} input @returns {object} */
export function resolveShipImpact(input) {
  const shipA = input.shipA;
  const shipB = input.shipB;
  const positionA = finiteVector(shipA.position, "MOVEMENT_INVALID_POSITION", "shipA.position");
  const positionB = finiteVector(shipB.position, "MOVEMENT_INVALID_POSITION", "shipB.position");
  const velocityA = finiteVector(shipA.velocity, "MOVEMENT_INVALID_VELOCITY", "shipA.velocity");
  const velocityB = finiteVector(shipB.velocity, "MOVEMENT_INVALID_VELOCITY", "shipB.velocity");
  const radiusA = finiteNumber(shipA.radius ?? shipA.collisionRadius, "MOVEMENT_INVALID_RADIUS", "shipA.radius");
  const radiusB = finiteNumber(shipB.radius ?? shipB.collisionRadius, "MOVEMENT_INVALID_RADIUS", "shipB.radius");
  if (radiusA < 0 || radiusB < 0) violation("MOVEMENT_INVALID_RADIUS", "Collision radii cannot be negative");
  const massA = shipA.mass ?? getMassForSize(shipA.size);
  const massB = shipB.mass ?? getMassForSize(shipB.size);
  if (!Number.isFinite(massA) || massA <= 0 || !Number.isFinite(massB) || massB <= 0) {
    violation("MOVEMENT_INVALID_MASS", "Collision masses must be positive finite numbers", { massA, massB });
  }
  const normal = unitNormal(input.normal ?? circleContactNormal(positionA, positionB, shipA.id, shipB.id));
  const relativeVelocity = subtract(velocityA, velocityB);
  const relativeImpactSpeed = magnitude(relativeVelocity);
  const response = resolveInelasticNormalResponse({ velocity: velocityA, mass: massA }, { velocity: velocityB, mass: massB }, normal);
  const positions = separateOverlappingCircles(
    { position: positionA, radius: radiusA, mass: massA },
    { position: positionB, radius: radiusB, mass: massB },
    normal,
  );
  const damageA = collisionDamage(relativeImpactSpeed, shipA, shipB.size, response.closing);
  const damageB = collisionDamage(relativeImpactSpeed, shipB, shipA.size, response.closing);
  const contactPointA = add(positionA, scale(normal, radiusA));
  const contactPointB = add(positionB, scale(normal, -radiusB));
  const contactPoint = scale(add(contactPointA, contactPointB), 0.5);
  const sectorA = struckSector({ target: positionA, source: contactPointA, facing: shipA.facing ?? 0, coincidentNormal: normal });
  const sectorB = struckSector({ target: positionB, source: contactPointB, facing: shipB.facing ?? 0, coincidentNormal: scale(normal, -1) });
  const conditionEvents = [];
  if (damageA.severity) conditionEvents.push({ shipId: shipA.id, severity: damageA.severity, sector: sectorA, contactPoint: contactPointA });
  if (damageB.severity) conditionEvents.push({ shipId: shipB.id, severity: damageB.severity, sector: sectorB, contactPoint: contactPointB });
  return {
    type: "ship",
    normal,
    contactPoint,
    contactPoints: { shipA: contactPointA, shipB: contactPointB },
    relativeVelocity,
    relativeImpactSpeed,
    closing: response.closing,
    shipA: { id: shipA.id, position: positions.positionA, velocity: response.velocityA, damage: damageA },
    shipB: { id: shipB.id, position: positions.positionB, velocity: response.velocityB, damage: damageB },
    damageEvents: [
      { shipId: shipA.id, ...damageA, bypassesShields: true },
      { shipId: shipB.id, ...damageB, bypassesShields: true },
    ],
    contactEvents: [
      { observerId: shipA.id, targetId: shipB.id, state: "contact", physical: true, expires: "nextStart" },
      { observerId: shipB.id, targetId: shipA.id, state: "contact", physical: true, expires: "nextStart" },
    ],
    conditionEvents,
  };
}

/** @param {{ship:object,wall:object,normal?:{x:number,y:number}}} input @returns {object} */
export function resolveWallImpact(input) {
  const ship = input.ship;
  const wall = input.wall;
  const position = finiteVector(ship.position, "MOVEMENT_INVALID_POSITION", "ship.position");
  const velocity = finiteVector(ship.velocity, "MOVEMENT_INVALID_VELOCITY", "ship.velocity");
  const radius = finiteNumber(ship.radius ?? ship.collisionRadius, "MOVEMENT_INVALID_RADIUS", "ship.radius");
  if (radius < 0) violation("MOVEMENT_INVALID_RADIUS", "Collision radius cannot be negative", { radius });
  const normal = unitNormal(input.normal ?? wallContactNormal(position, wall, velocity));
  const inwardSpeed = dot(velocity, normal);
  const postVelocity = inwardSpeed < -EPSILON ? subtract(velocity, scale(normal, inwardSpeed)) : { ...velocity };
  const closest = closestPointOnSegment(position, wall.a, wall.b);
  const overlap = Math.max(0, radius - Math.sqrt(closest.distanceSquared));
  const postPosition = overlap > 0 ? add(position, scale(normal, overlap + EPSILON)) : { ...position };
  const relativeImpactSpeed = magnitude(velocity);
  const closing = inwardSpeed < -EPSILON;
  const damage = collisionDamage(relativeImpactSpeed, ship, ship.size, closing);
  const contactPoint = closest.point;
  const conditionEvents = damage.severity
    ? [{ shipId: ship.id, severity: damage.severity, sector: struckSector({ target: position, source: contactPoint, facing: ship.facing ?? 0, coincidentNormal: scale(normal, -1) }), contactPoint }]
    : [];
  return {
    type: "wall",
    wallId: wall.id,
    normal,
    contactPoint,
    relativeVelocity: { ...velocity },
    relativeImpactSpeed,
    closing,
    ship: { id: ship.id, position: postPosition, velocity: postVelocity, damage },
    damageEvents: [{ shipId: ship.id, ...damage, bypassesShields: true }],
    contactEvents: [],
    conditionEvents,
  };
}

function shipDescriptor(input, statePoint) {
  const ship = input.ship ?? {};
  return {
    id: ship.id ?? input.id ?? "active",
    position: statePoint.position,
    velocity: statePoint.velocity,
    facing: statePoint.facing,
    radius: input.collisionRadius ?? ship.radius ?? ship.collisionRadius ?? 0,
    size: ship.size ?? input.size ?? "medium",
    mass: ship.mass,
    armor: ship.armor ?? input.armor ?? 0,
    maxHull: ship.maxHull ?? input.maxHull,
  };
}

function impactFromCollision(input, collision) {
  const active = shipDescriptor(input, collision.activeState);
  if (collision.type === "wall") {
    return resolveWallImpact({ ship: active, wall: collision.obstacle, normal: collision.normal });
  }
  const obstacle = collision.obstacle;
  return resolveShipImpact({
    shipA: active,
    shipB: {
      id: obstacle.id,
      position: obstacle.position ?? obstacle.center,
      velocity: obstacle.velocity ?? { x: 0, y: 0 },
      facing: obstacle.facing ?? 0,
      radius: obstacle.radius ?? obstacle.collisionRadius ?? 0,
      size: obstacle.size ?? "medium",
      mass: obstacle.mass,
      armor: obstacle.armor ?? 0,
      maxHull: obstacle.maxHull,
    },
    normal: collision.normal,
  });
}

function simulateSingleSegment(input, phase) {
  const integrated = integrateBurn(input);
  const collision = integrated.duration <= EPSILON ? null : findFirstCollision(integrated.path, input.obstacles ?? []);
  const path = truncatedPath(integrated.path, collision, phase);
  if (!collision) return { path, end: integrated.path[integrated.path.length - 1], collision: null, impact: null };
  const impact = impactFromCollision(input, collision);
  const activeResult = impact.type === "ship" ? impact.shipA : impact.ship;
  const end = { ...collision.activeState, position: activeResult.position, velocity: activeResult.velocity };
  path[path.length - 1] = { ...path[path.length - 1], position: end.position, velocity: end.velocity, impact };
  return { path, end, collision: { ...collision, impact }, impact };
}

function simulateAutomaticCoast(input) {
  const totalDuration = input.duration;
  let remaining = totalDuration;
  let position = { ...input.position };
  let velocity = { ...input.velocity };
  let elapsed = 0;
  const path = [];
  const collisions = [];
  const ignored = new Set(input.ignoredObstacleIds ?? []);
  let iteration = 0;

  while (remaining > EPSILON && iteration <= MAX_COAST_COLLISIONS) {
    const obstacles = (input.obstacles ?? []).filter((obstacle) => !ignored.has(obstacleSortId(obstacle)));
    const segment = simulateSingleSegment({ ...input, position, velocity, duration: remaining, deltaV: { forward: 0, lateral: 0 }, rotation: 0, obstacles }, "coast");
    const shifted = segment.path.map((point) => ({ ...point, time: point.time + elapsed }));
    if (path.length > 0) shifted.shift();
    path.push(...shifted);
    if (!segment.collision) {
      position = segment.end.position;
      velocity = segment.end.velocity;
      elapsed = totalDuration;
      remaining = 0;
      break;
    }
    const spent = segment.collision.time;
    position = segment.end.position;
    velocity = segment.end.velocity;
    elapsed += spent;
    remaining -= spent;
    collisions.push({ ...segment.collision, time: elapsed });
    ignored.add(segment.collision.obstacleId);
    iteration += 1;
    if (spent <= EPSILON && remaining > EPSILON && ignored.size >= (input.obstacles ?? []).length) {
      const tail = integrateBurn({ ...input, position, velocity, duration: remaining, deltaV: { forward: 0, lateral: 0 }, rotation: 0 });
      const shiftedTail = tail.path.slice(1).map((point) => ({ ...point, phase: "coast", time: point.time + elapsed }));
      path.push(...shiftedTail);
      position = tail.position;
      velocity = tail.velocity;
      elapsed = totalDuration;
      remaining = 0;
    }
  }
  if (iteration > MAX_COAST_COLLISIONS) violation("MOVEMENT_COLLISION_LIMIT", "Automatic coast exceeded deterministic collision limit", { limit: MAX_COAST_COLLISIONS });
  return { path, position, velocity, facing: normalizeHeading(input.facing), duration: elapsed, collisions };
}

/** @param {object} input @returns {{path:Array<object>,poweredEnd:object,coastEnd:object,finalVelocity:object,finalFacing:number,timelineUsed:number,timelineRemaining:number,rotationRemaining:number,collisions:Array<object>,warnings:Array<object>}} */
export function previewManeuver(input) {
  const validated = validateManeuverTime(input);
  const position = finiteVector(input.position, "MOVEMENT_INVALID_POSITION", "position");
  const velocity = finiteVector(input.velocity ?? input.state?.velocity, "MOVEMENT_INVALID_VELOCITY", "velocity");
  const facing = finiteNumber(input.facing, "MOVEMENT_INVALID_FACING", "facing");
  const collisionRadius = finiteNumber(input.collisionRadius ?? input.ship?.radius ?? input.ship?.collisionRadius ?? 0, "MOVEMENT_INVALID_RADIUS", "collisionRadius");
  const powered = simulateSingleSegment({
    ...input,
    position,
    velocity,
    facing,
    collisionRadius,
    duration: validated.duration,
    deltaV: validated.deltaV,
    rotation: validated.rotation,
  }, validated.coast ? "deliberateCoast" : "powered");
  const elapsedDuration = powered.collision ? powered.collision.time : validated.duration;
  const elapsedRatio = validated.duration > EPSILON ? elapsedDuration / validated.duration : 1;
  const timelineUsed = Math.min(1, validated.timelineUsed + elapsedDuration);
  const rotationSpent = validated.rotationSpent + (Math.abs(validated.rotation) * elapsedRatio);
  const rotationRemaining = Math.max(0, directionalCapabilities(input.capabilities ?? {}).rotation - rotationSpent);
  const coastDuration = Math.max(0, 1 - timelineUsed);
  const coast = simulateAutomaticCoast({
    ...input,
    position: powered.end.position,
    velocity: powered.end.velocity,
    facing: powered.end.facing,
    collisionRadius,
    duration: coastDuration,
    ignoredObstacleIds: powered.collision ? [powered.collision.obstacleId] : [],
  });
  const collisions = [];
  if (powered.collision) collisions.push({ ...powered.collision, phase: validated.coast ? "deliberateCoast" : "powered" });
  collisions.push(...coast.collisions.map((collision) => ({ ...collision, phase: "coast", time: collision.time + elapsedDuration })));
  const finalVelocity = coast.velocity;
  const safeVelocity = input.safeVelocity ?? input.ship?.safeVelocity;
  const warnings = [];
  if (safeVelocity !== undefined) {
    const overspeed = getOverspeedDamage(finalVelocity, safeVelocity);
    if (overspeed.overspeed > 0) warnings.push({ code: "MOVEMENT_OVERSPEED", ...overspeed });
  }
  const poweredEnd = {
    position: { ...powered.end.position },
    velocity: { ...powered.end.velocity },
    facing: powered.end.facing,
    time: elapsedDuration,
  };
  const coastEnd = {
    position: { ...coast.position },
    velocity: { ...coast.velocity },
    facing: coast.facing,
    time: coastDuration,
  };
  return {
    path: [...powered.path, ...coast.path.slice(1)],
    poweredEnd,
    coastEnd,
    finalVelocity: { ...finalVelocity },
    finalFacing: powered.end.facing,
    timelineUsed: roundTo(timelineUsed, 12),
    timelineRemaining: roundTo(Math.max(0, 1 - timelineUsed), 12),
    rotationRemaining: roundTo(rotationRemaining, 12),
    collisions,
    warnings,
  };
}

/** @param {object} state @param {object} input @returns {object} */
export function applyManeuver(state, input) {
  if (!state || typeof state !== "object") violation("MOVEMENT_INVALID_STATE", "A caller-owned state draft is required");
  const preview = previewManeuver({
    ...input,
    state,
    velocity: state.velocity,
    timelineUsed: state.timeline,
    rotationSpent: state.rotationSpent,
    evasionReserved: reservedEvasion(state),
  });
  const requestedRotation = input.rotation ?? 0;
  const requestedDuration = getManeuverTime(input).duration;
  const elapsedRatio = requestedDuration > EPSILON ? preview.poweredEnd.time / requestedDuration : 1;
  const nextRotationSpent = roundTo((state.rotationSpent ?? 0) + (Math.abs(requestedRotation) * elapsedRatio), 12);
  state.velocity = { ...preview.poweredEnd.velocity };
  state.timeline = preview.timelineUsed;
  state.rotationSpent = nextRotationSpent;
  return {
    ...preview,
    position: { ...preview.poweredEnd.position },
    velocity: { ...preview.poweredEnd.velocity },
    facing: preview.poweredEnd.facing,
    collisionEvents: preview.collisions.filter((collision) => collision.phase !== "coast"),
  };
}

/** @param {object} state @param {object} input @returns {object} */
export function resolveCoast(state, input) {
  if (!state || typeof state !== "object") violation("MOVEMENT_INVALID_STATE", "A caller-owned state draft is required");
  const automatic = input.automatic !== false;
  const timelineUsed = timelineValue(state);
  const reserve = reservedEvasion(state);
  const duration = automatic ? Math.max(0, 1 - timelineUsed) : input.duration;
  if (!automatic) {
    validateManeuverTime({
      ...input,
      state,
      timelineUsed,
      rotationSpent: state.rotationSpent,
      duration,
      deltaV: { forward: 0, lateral: 0 },
      capabilities: input.capabilities ?? { forward: 0, retro: 0, port: 0, starboard: 0, rotation: 0 },
      evasionReserved: reserve,
    });
  }
  finiteNumber(duration, "MOVEMENT_INVALID_DURATION", "duration");
  if (!automatic && duration <= EPSILON) violation("MOVEMENT_INVALID_DURATION", "Deliberate coast requires positive duration", { duration });
  const result = simulateAutomaticCoast({
    ...input,
    position: finiteVector(input.position, "MOVEMENT_INVALID_POSITION", "position"),
    velocity: finiteVector(state.velocity, "MOVEMENT_INVALID_VELOCITY", "velocity"),
    facing: finiteNumber(input.facing, "MOVEMENT_INVALID_FACING", "facing"),
    duration,
    collisionRadius: input.collisionRadius ?? input.ship?.radius ?? input.ship?.collisionRadius ?? 0,
  });
  state.velocity = { ...result.velocity };
  state.timeline = roundTo(Math.min(1, timelineUsed + duration), 12);
  return {
    ...result,
    timelineUsed: state.timeline,
    timelineRemaining: Math.max(0, 1 - state.timeline),
    automatic,
    collisionEvents: result.collisions,
  };
}

/** @param {object} state @param {object} input @returns {object} */
export function applyRotation(state, input) {
  return applyManeuver(state, { ...input, duration: 0, deltaV: { forward: 0, lateral: 0 } });
}

/** @param {{x:number,y:number}} velocity @param {number} safeVelocity @returns {{speed:number,safeVelocity:number,overspeed:number,hullDamage:number}} */
export function getOverspeedDamage(velocity, safeVelocity) {
  const resolvedVelocity = finiteVector(velocity, "MOVEMENT_INVALID_VELOCITY", "velocity");
  const resolvedSafeVelocity = finiteNumber(safeVelocity, "MOVEMENT_INVALID_SAFE_VELOCITY", "safeVelocity");
  if (resolvedSafeVelocity < 0) violation("MOVEMENT_INVALID_SAFE_VELOCITY", "Safe Velocity cannot be negative", { safeVelocity });
  const speed = magnitude(resolvedVelocity);
  const overspeed = Math.max(0, Math.ceil(speed - resolvedSafeVelocity));
  return { speed, safeVelocity: resolvedSafeVelocity, overspeed, hullDamage: 2 * overspeed };
}

/** @param {object} state @param {{phase:string,hasHelm:boolean,enginesPower:number,hardwareOperational:boolean,maneuverCapability:number,evasionReserve:number,evasionAcBonus?:number}} input @returns {object} */
export function armEvasion(state, input) {
  if (!state || typeof state !== "object") violation("MOVEMENT_INVALID_STATE", "A caller-owned state draft is required");
  const phase = input.phase ?? state.phase;
  if (phase !== "active") violation("EVASION_WRONG_PHASE", "Evasion can only be armed during the Active Phase", { phase });
  if (!input.hasHelm) violation("EVASION_HELM_REQUIRED", "Arming Evasion requires held Helm control");
  if (!(input.enginesPower > 0)) violation("EVASION_ENGINES_UNPOWERED", "Arming Evasion requires Engines Power above zero");
  if (!input.hardwareOperational || !(input.maneuverCapability > 0)) {
    violation("EVASION_HARDWARE_UNAVAILABLE", "Evasion-capable maneuvering hardware is unavailable");
  }
  const evasionReserve = finiteNumber(input.evasionReserve ?? input.config?.evasionReserve, "EVASION_INVALID_RESERVE", "evasionReserve");
  if (evasionReserve < 0 || evasionReserve > 1) violation("EVASION_INVALID_RESERVE", "Evasion reserve must be between 0 and 1", { evasionReserve });
  const existing = state.evasion && typeof state.evasion === "object" ? state.evasion : { armed: false, reserved: 0 };
  const reserved = Math.max(existing.reserved ?? 0, evasionReserve);
  if (timelineValue(state) > 1 - reserved + EPSILON) {
    violation("EVASION_TIMELINE_UNAVAILABLE", "Insufficient unspent timeline remains to reserve Evasion", { timeline: timelineValue(state), evasionReserve });
  }
  state.evasion = { armed: true, reserved };
  return { armed: true, reserved, acBonus: input.evasionAcBonus ?? input.config?.evasionAcBonus ?? 2 };
}

/** @param {object} state @returns {object} */
export function disarmEvasion(state) {
  if (!state || typeof state !== "object") violation("MOVEMENT_INVALID_STATE", "A caller-owned state draft is required");
  const reserved = reservedEvasion(state);
  state.evasion = { armed: false, reserved };
  return { armed: false, reserved, acBonus: 0 };
}

/** @param {object} state @returns {{armed:false,reserved:0}} */
export function resetEvasionAtStart(state) {
  if (!state || typeof state !== "object") violation("MOVEMENT_INVALID_STATE", "A caller-owned state draft is required");
  state.evasion = { armed: false, reserved: 0 };
  return { ...state.evasion };
}

/** @param {object} state @param {{enginesPower:number,hardwareOperational:boolean,maneuverCapability:number,evasionAcBonus?:number}} input @returns {object} */
export function enforceEvasionEligibility(state, input) {
  if (!state || typeof state !== "object") violation("MOVEMENT_INVALID_STATE", "A caller-owned state draft is required");
  const eligible = input.enginesPower > 0 && input.hardwareOperational && input.maneuverCapability > 0;
  if (!eligible && state.evasion?.armed) return { ...disarmEvasion(state), removed: true };
  return {
    armed: Boolean(state.evasion?.armed),
    reserved: reservedEvasion(state),
    acBonus: state.evasion?.armed ? (input.evasionAcBonus ?? input.config?.evasionAcBonus ?? 2) : 0,
    removed: false,
  };
}

/** @param {{position:{x:number,y:number},velocity:{x:number,y:number},duration?:number}} target @returns {object} */
export function projectCoast(target) {
  const duration = target.duration ?? 1;
  const integrated = integrateBurn({
    position: target.position,
    velocity: target.velocity,
    facing: target.facing ?? 0,
    duration,
    deltaV: { forward: 0, lateral: 0 },
    rotation: 0,
    collisionRadius: target.collisionRadius ?? 0,
  });
  return { path: integrated.path, position: integrated.position, velocity: integrated.velocity, duration };
}
