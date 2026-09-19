import {
  ANGLE_EPSILON,
  EPSILON,
  add,
  bearingDegrees,
  clamp,
  distance,
  distanceSquared,
  dot,
  magnitudeSquared,
  normalize,
  normalizeAngle,
  perpendicularCounterclockwise,
  scale,
  subtract,
} from "./math.js";

export const SECTOR_ORDER = Object.freeze(["fore", "port", "starboard", "aft"]);
export const WALL_REFINEMENT_ITERATIONS = 40;

/** @param {{x:number,y:number}} point @param {{x:number,y:number}} start @param {{x:number,y:number}} end @returns {{point:{x:number,y:number},fraction:number,distanceSquared:number}} */
export function closestPointOnSegment(point, start, end) {
  const segment = subtract(end, start);
  const lengthSquared = magnitudeSquared(segment);
  const fraction = lengthSquared <= EPSILON * EPSILON
    ? 0
    : clamp(dot(subtract(point, start), segment) / lengthSquared, 0, 1);
  const closest = add(start, scale(segment, fraction));
  return { point: closest, fraction, distanceSquared: distanceSquared(point, closest) };
}

/** @param {{x:number,y:number}} point @param {{x:number,y:number}} start @param {{x:number,y:number}} end @returns {number} */
export function pointToSegmentDistance(point, start, end) {
  return Math.sqrt(closestPointOnSegment(point, start, end).distanceSquared);
}

/** @param {string} firstId @param {string} secondId @returns {{x:number,y:number}} */
export function stableCoincidentNormal(firstId = "", secondId = "") {
  const first = String(firstId);
  const second = String(secondId);
  const ordered = first <= second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
  let hash = 2166136261;
  for (let index = 0; index < ordered.length; index += 1) {
    hash ^= ordered.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const angle = (hash / 0x100000000) * Math.PI * 2;
  const normal = { x: Math.cos(angle), y: Math.sin(angle) };
  return first <= second ? normal : scale(normal, -1);
}

/** @param {{x:number,y:number}} firstCenter @param {{x:number,y:number}} secondCenter @param {string} firstId @param {string} secondId @returns {{x:number,y:number}} */
export function circleContactNormal(firstCenter, secondCenter, firstId = "", secondId = "") {
  return normalize(subtract(secondCenter, firstCenter), stableCoincidentNormal(firstId, secondId));
}

/** @param {{x:number,y:number}} center @param {{a:{x:number,y:number},b:{x:number,y:number},id?:string}} wall @param {{x:number,y:number}} velocity @returns {{x:number,y:number}} */
export function wallContactNormal(center, wall, velocity = { x: 0, y: 0 }) {
  const closest = closestPointOnSegment(center, wall.a, wall.b).point;
  const offset = subtract(center, closest);
  if (magnitudeSquared(offset) > EPSILON * EPSILON) return normalize(offset);
  const tangent = normalize(subtract(wall.b, wall.a), { x: 1, y: 0 });
  let normal = perpendicularCounterclockwise(tangent);
  const into = dot(velocity, normal);
  if (Math.abs(into) > EPSILON) return into < 0 ? normal : scale(normal, -1);
  const key = `${wall.id ?? ""}\u0000${wall.a.x},${wall.a.y}\u0000${wall.b.x},${wall.b.y}`;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash & 1) === 0 ? normal : scale(normal, -1);
}

/** @param {{x:number,y:number}} startA @param {{x:number,y:number}} endA @param {number} radiusA @param {{x:number,y:number}} startB @param {{x:number,y:number}} endB @param {number} radiusB @param {string} idA @param {string} idB @returns {null|object} */
export function sweptCircleVsCircle(startA, endA, radiusA, startB, endB, radiusB, idA = "", idB = "") {
  const relativeStart = subtract(startA, startB);
  const relativeDelta = subtract(subtract(endA, startA), subtract(endB, startB));
  const combinedRadius = radiusA + radiusB;
  const c = magnitudeSquared(relativeStart) - (combinedRadius * combinedRadius);
  let fraction;
  let initialOverlap = false;

  if (c <= EPSILON) {
    fraction = 0;
    initialOverlap = c < -EPSILON;
    const initialNormal = circleContactNormal(startA, startB, idA, idB);
    if (dot(relativeDelta, initialNormal) <= EPSILON) return null;
  } else {
    const a = magnitudeSquared(relativeDelta);
    if (a <= EPSILON * EPSILON) return null;
    const b = 2 * dot(relativeStart, relativeDelta);
    const discriminant = (b * b) - (4 * a * c);
    if (discriminant < -EPSILON) return null;
    const root = Math.sqrt(Math.max(0, discriminant));
    const first = (-b - root) / (2 * a);
    if (first < -EPSILON || first > 1 + EPSILON) return null;
    fraction = clamp(first, 0, 1);
  }

  const centerA = add(startA, scale(subtract(endA, startA), fraction));
  const centerB = add(startB, scale(subtract(endB, startB), fraction));
  const normal = circleContactNormal(centerA, centerB, idA, idB);
  const relativeMotion = relativeDelta;
  return {
    fraction,
    point: add(centerA, scale(normal, radiusA)),
    centerA,
    centerB,
    normal,
    initialOverlap,
    closing: dot(relativeMotion, normal) > EPSILON,
    separation: Math.max(0, combinedRadius - distance(centerA, centerB)),
  };
}

/** @param {{x:number,y:number}} start @param {{x:number,y:number}} end @param {number} radius @param {{x:number,y:number}} wallStart @param {{x:number,y:number}} wallEnd @param {object} options @returns {null|object} */
export function sweptCircleVsSegment(start, end, radius, wallStart, wallEnd, options = {}) {
  const wall = { a: wallStart, b: wallEnd, id: options.id ?? "" };
  const movement = subtract(end, start);
  const radiusSquared = radius * radius;
  const startDistanceSquared = closestPointOnSegment(start, wallStart, wallEnd).distanceSquared;
  if (startDistanceSquared <= radiusSquared + EPSILON) {
    const normal = wallContactNormal(start, wall, movement);
    const initialOverlap = startDistanceSquared < radiusSquared - EPSILON;
    const closing = dot(movement, normal) < -EPSILON;
    if (!closing) return null;
    return {
      fraction: 0,
      point: subtract(start, scale(normal, radius)),
      center: { ...start },
      normal,
      initialOverlap,
      closing,
      separation: Math.max(0, radius - Math.sqrt(Math.max(0, startDistanceSquared))),
    };
  }
  if (magnitudeSquared(movement) <= EPSILON * EPSILON) return null;

  const candidates = [];
  const segment = subtract(wallEnd, wallStart);
  const segmentLengthSquared = magnitudeSquared(segment);
  const addEndpointCandidates = (endpoint) => {
    const relative = subtract(start, endpoint);
    const a = magnitudeSquared(movement);
    const b = 2 * dot(relative, movement);
    const c = magnitudeSquared(relative) - radiusSquared;
    const discriminant = (b * b) - (4 * a * c);
    if (discriminant < -EPSILON) return;
    const root = Math.sqrt(Math.max(0, discriminant));
    for (const candidate of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
      if (candidate >= -EPSILON && candidate <= 1 + EPSILON) candidates.push(clamp(candidate, 0, 1));
    }
  };

  addEndpointCandidates(wallStart);
  addEndpointCandidates(wallEnd);

  if (segmentLengthSquared > EPSILON * EPSILON) {
    const segmentLength = Math.sqrt(segmentLengthSquared);
    const tangent = scale(segment, 1 / segmentLength);
    const normal = perpendicularCounterclockwise(tangent);
    const startNormal = dot(subtract(start, wallStart), normal);
    const movementNormal = dot(movement, normal);
    if (Math.abs(movementNormal) > EPSILON) {
      for (const side of [-radius, radius]) {
        const candidate = (side - startNormal) / movementNormal;
        if (candidate < -EPSILON || candidate > 1 + EPSILON) continue;
        const center = add(start, scale(movement, clamp(candidate, 0, 1)));
        const along = dot(subtract(center, wallStart), tangent);
        if (along >= -EPSILON && along <= segmentLength + EPSILON) candidates.push(clamp(candidate, 0, 1));
      }
    }
  }

  candidates.sort((left, right) => left - right);
  let analyticFraction = null;
  for (const candidate of candidates) {
    const center = add(start, scale(movement, candidate));
    if (closestPointOnSegment(center, wallStart, wallEnd).distanceSquared <= radiusSquared + (EPSILON * 16)) {
      analyticFraction = candidate;
      break;
    }
  }
  if (analyticFraction === null) return null;

  let lower = 0;
  let upper = analyticFraction;
  const iterations = Number.isInteger(options.iterations) ? Math.max(0, options.iterations) : WALL_REFINEMENT_ITERATIONS;
  if (upper > 0) {
    const probe = Math.min(1, analyticFraction + Math.max(EPSILON, 1 / (2 ** 30)));
    const probeCenter = add(start, scale(movement, probe));
    if (closestPointOnSegment(probeCenter, wallStart, wallEnd).distanceSquared <= radiusSquared + EPSILON) upper = probe;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const middle = (lower + upper) / 2;
      const center = add(start, scale(movement, middle));
      if (closestPointOnSegment(center, wallStart, wallEnd).distanceSquared <= radiusSquared) upper = middle;
      else lower = middle;
    }
  }

  const fraction = clamp(upper, 0, 1);
  const center = add(start, scale(movement, fraction));
  const normal = wallContactNormal(center, wall, movement);
  const closest = closestPointOnSegment(center, wallStart, wallEnd).point;
  return {
    fraction,
    point: closest,
    center,
    normal,
    initialOverlap: false,
    closing: dot(movement, normal) < -EPSILON,
    separation: Math.max(0, radius - distance(center, closest)),
  };
}

/** @param {{target:{x:number,y:number},source:{x:number,y:number},facing:number,coincidentNormal?:{x:number,y:number}}} input @returns {"fore"|"port"|"starboard"|"aft"} */
export function struckSector(input) {
  const bearing = bearingDegrees(input.target, input.source, input.coincidentNormal);
  const relative = normalizeAngle(bearing - input.facing);
  if (relative >= -45 && relative < 45) return "fore";
  if (relative >= 45 && relative < 135) return "starboard";
  if (relative >= -135 && relative < -45) return "port";
  return "aft";
}

/** @param {{origin:{x:number,y:number},target:{x:number,y:number},facing:number,arcCenter?:number,arcWidth:number,coincidentNormal?:{x:number,y:number}}} input @returns {boolean} */
export function isInFiringArc(input) {
  if (!Number.isFinite(input.arcWidth) || input.arcWidth < 0) return false;
  if (input.arcWidth >= 360) return true;
  const bearing = bearingDegrees(input.origin, input.target, input.coincidentNormal);
  const center = input.facing + (input.arcCenter ?? 0);
  return Math.abs(normalizeAngle(bearing - center)) <= (input.arcWidth / 2) + ANGLE_EPSILON;
}
