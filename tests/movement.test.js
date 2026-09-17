import { describe, expect, test } from "bun:test";

import { createDefaultShipData, createInitialState } from "../scripts/model/defaults.js";
import {
  circleContactNormal,
  stableCoincidentNormal,
  sweptCircleVsCircle,
  sweptCircleVsSegment,
} from "../scripts/rules/geometry.js";
import {
  applyManeuver,
  armEvasion,
  getCollisionSizeMultiplier,
  getDriveCapabilities,
  getOverspeedDamage,
  integrateBurn,
  isInFiringArc,
  previewManeuver,
  resolveCoast,
  resolveInelasticNormalResponse,
  resolveShipImpact,
  separateOverlappingCircles,
  struckSector,
  validateManeuverTime,
} from "../scripts/rules/movement.js";
import { executeShipOperation, OPERATION_TYPES } from "../scripts/rules/operations.js";

const TOLERANCE = 1e-8;

function deepClone(value) {
  return structuredClone(value);
}

function freshShip() {
  const defaults = createDefaultShipData();
  const config = deepClone(defaults.config);
  return { config, state: createInitialState(deepClone(config)) };
}

function expectNear(actual, expected, tolerance = TOLERANCE) {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function expectVectorNear(actual, expected, tolerance = TOLERANCE) {
  expectNear(actual.x, expected.x, tolerance);
  expectNear(actual.y, expected.y, tolerance);
}

function captureViolation(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a RuleViolation");
}

function pointAtBearing(degrees, distance = 10) {
  const radians = degrees * (Math.PI / 180);
  return { x: Math.sin(radians) * distance, y: -Math.cos(radians) * distance };
}

function deterministicContext(ships, geometry = {}) {
  return {
    ships: deepClone(ships),
    isGM: true,
    userId: "gm-user",
    rollD20: () => 10,
    random: [0, 0, 0, 0],
    geometry,
  };
}

describe("movement integration and budgets", () => {
  test("a rotating burn samples acceleration at each step midpoint deterministically", () => {
    const input = deepClone({
      id: "burning-ship",
      position: { x: 3, y: -7 },
      velocity: { x: 1, y: 2 },
      facing: 0,
      duration: 0.5,
      deltaV: { forward: 4, lateral: 0 },
      rotation: 90,
      collisionRadius: 2,
      stepsPerInterval: 8,
    });
    const snapshot = deepClone(input);

    const first = integrateBurn(input);
    const second = integrateBurn(deepClone(input));

    expect(input).toEqual(snapshot);
    expect(second).toEqual(first);
    expect(first.path).toHaveLength(5);
    expect(first.path.map((point) => point.time)).toEqual([0, 0.125, 0.25, 0.375, 0.5]);
    for (let index = 1; index < first.path.length; index += 1) {
      const midpointDegrees = (index - 0.5) * 22.5;
      const midpointRadians = midpointDegrees * (Math.PI / 180);
      expectVectorNear(first.path[index].acceleration, {
        x: 8 * Math.sin(midpointRadians),
        y: -8 * Math.cos(midpointRadians),
      });
      expectNear(first.path[index].facing, index * 22.5);
    }
    expectVectorNear(first.path[1].position, {
      x: 3 + 0.125 + (0.5 * first.path[1].acceleration.x * (0.125 ** 2)),
      y: -7 + 0.25 + (0.5 * first.path[1].acceleration.y * (0.125 ** 2)),
    });

    const finer = integrateBurn({ ...deepClone(input), stepsPerInterval: 16 });
    expect(finer.path).toHaveLength(9);
    expectNear(finer.path.at(-1).time, 0.5);
    expectNear(finer.path.at(-1).facing, 90);
  });

  test("Timeline, Evasion reserve, and absolute rotation accept exact limits and reject excess atomically", () => {
    const { state } = freshShip();
    state.phase = "active";
    state.timeline = 0.6;
    state.rotationSpent = 25;
    state.evasion = { armed: true, reserved: 0.2 };
    const capabilities = { forward: 1, retro: 1, port: 1, starboard: 1, rotation: 60 };

    const boundary = validateManeuverTime(deepClone({
      state,
      capabilities,
      deltaV: { forward: 0.2, lateral: 0 },
      rotation: -35,
    }));
    expectNear(boundary.duration, 0.2);
    expectNear(boundary.timelineLimit, 0.8);
    expectNear(boundary.timelineRemainingAfter, 0);
    expectNear(boundary.rotationRemaining, 35);

    const beforeFailure = deepClone(state);
    const timelineError = captureViolation(() => applyManeuver(state, deepClone({
      position: { x: 0, y: 0 },
      facing: 0,
      capabilities,
      deltaV: { forward: 0.20001, lateral: 0 },
      rotation: 0,
    })));
    expect(timelineError).toMatchObject({ name: "RuleViolation", code: "MOVEMENT_TIMELINE_EXCEEDED" });
    expect(state).toEqual(beforeFailure);

    const rotationError = captureViolation(() => validateManeuverTime(deepClone({
      state,
      capabilities,
      duration: 0,
      deltaV: { forward: 0, lateral: 0 },
      rotation: -35.00001,
    })));
    expect(rotationError).toMatchObject({ name: "RuleViolation", code: "MOVEMENT_ROTATION_EXCEEDED" });
  });

  test("Evasion can reserve the exact remaining Timeline but cannot partially mutate on excess", () => {
    const eligibility = deepClone({
      phase: "active",
      hasHelm: true,
      enginesPower: 1,
      hardwareOperational: true,
      maneuverCapability: 1,
      evasionReserve: 0.2,
      evasionAcBonus: 3,
    });
    const boundaryState = freshShip().state;
    boundaryState.phase = "active";
    boundaryState.timeline = 0.8;

    const armed = armEvasion(boundaryState, deepClone(eligibility));
    expect(armed).toEqual({ armed: true, reserved: 0.2, acBonus: 3 });
    expect(boundaryState.evasion).toEqual({ armed: true, reserved: 0.2 });

    const rejectedState = freshShip().state;
    rejectedState.phase = "active";
    rejectedState.timeline = 0.80001;
    const before = deepClone(rejectedState);
    const error = captureViolation(() => armEvasion(rejectedState, deepClone(eligibility)));
    expect(error).toMatchObject({ name: "RuleViolation", code: "EVASION_TIMELINE_UNAVAILABLE" });
    expect(rejectedState).toEqual(before);
  });
  test("drive faults affect only their installed role and each lateral contributes independently", () => {
    const { config, state } = freshShip();
    expect(getDriveCapabilities(config, state)).toEqual({
      forward: 6,
      retro: 3,
      port: 2,
      starboard: 2,
      rotation: 60,
    });

    state.conditions.main = {
      kind: "fault",
      conditionId: "driveFailure",
      componentId: config.components.drives.main.id,
      severity: "destroyed",
    };
    expect(getDriveCapabilities(config, state)).toEqual({
      forward: 0,
      retro: 3,
      port: 2,
      starboard: 2,
      rotation: 60,
    });

    delete state.conditions.main;
    state.conditions.reverse = {
      kind: "fault",
      conditionId: "driveFailure",
      componentId: config.components.drives.reverse.id,
      severity: "destroyed",
    };
    state.conditions.port = {
      kind: "fault",
      conditionId: "maneuveringThrusterFailure",
      componentId: config.components.drives.portLateral.id,
      severity: "destroyed",
    };
    expect(getDriveCapabilities(config, state)).toEqual({
      forward: 6,
      retro: 0,
      port: 0,
      starboard: 2,
      rotation: 30,
    });
  });

  test("preview is pure while apply commits only the powered movement state", () => {
    const previewState = freshShip().state;
    previewState.phase = "active";
    const previewInput = deepClone({
      state: previewState,
      position: { x: 5, y: 6 },
      velocity: previewState.velocity,
      facing: 0,
      capabilities: { forward: 4, retro: 2, port: 2, starboard: 2, rotation: 60 },
      deltaV: { forward: 2, lateral: 0 },
      rotation: 30,
      collisionRadius: 1,
      safeVelocity: 30,
      obstacles: [],
    });
    const beforePreview = deepClone(previewInput);

    const preview = previewManeuver(previewInput);

    expect(previewInput).toEqual(beforePreview);
    expect(previewState.timeline).toBe(0);
    expect(previewState.rotationSpent).toBe(0);
    expect(preview.path[0].phase).toBe("powered");
    expect(preview.path.at(-1).phase).toBe("coast");
    expectNear(preview.timelineUsed, 0.5);
    expectNear(preview.timelineRemaining, 0.5);
    expectNear(preview.rotationRemaining, 30);

    const appliedState = freshShip().state;
    appliedState.phase = "active";
    const applyInput = deepClone({
      position: { x: 5, y: 6 },
      facing: 0,
      capabilities: { forward: 4, retro: 2, port: 2, starboard: 2, rotation: 60 },
      deltaV: { forward: 2, lateral: 0 },
      rotation: 30,
      collisionRadius: 1,
      safeVelocity: 30,
      obstacles: [],
    });
    const beforeApply = deepClone(appliedState);
    const beforeApplyInput = deepClone(applyInput);

    const applied = applyManeuver(appliedState, applyInput);

    expect(applyInput).toEqual(beforeApplyInput);
    expect(appliedState).not.toEqual(beforeApply);
    expectNear(appliedState.timeline, 0.5);
    expectNear(appliedState.rotationSpent, 30);
    expectVectorNear(appliedState.velocity, applied.poweredEnd.velocity);
    expectVectorNear(applied.position, applied.poweredEnd.position);
    expect(applied.coastEnd.position).not.toEqual(applied.position);
  });

  test("automatic coast consumes the remaining Timeline and persists velocity", () => {
    const { state } = freshShip();
    state.phase = "active";
    state.timeline = 0.25;
    state.velocity = { x: 3, y: 4 };
    const input = deepClone({
      position: { x: 10, y: -2 },
      facing: 370,
      collisionRadius: 1,
      obstacles: [],
    });
    const beforeInput = deepClone(input);

    const coast = resolveCoast(state, input);

    expect(input).toEqual(beforeInput);
    expect(coast.automatic).toBe(true);
    expectNear(coast.duration, 0.75);
    expectNear(coast.timelineUsed, 1);
    expectNear(coast.timelineRemaining, 0);
    expectVectorNear(coast.position, { x: 12.25, y: 1 });
    expectVectorNear(coast.velocity, { x: 3, y: 4 });
    expectVectorNear(state.velocity, { x: 3, y: 4 });
    expectNear(state.timeline, 1);
    expect(coast.path.every((point) => point.phase === "coast")).toBe(true);
  });
});

describe("continuous collision geometry", () => {
  test("swept ship and wall contacts return the exact first time of impact", () => {
    const shipContact = sweptCircleVsCircle(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      1,
      { x: 6, y: 0 },
      { x: 6, y: 0 },
      2,
      "moving",
      "stationary",
    );
    expect(shipContact).not.toBeNull();
    expectNear(shipContact.fraction, 0.3);
    expectVectorNear(shipContact.centerA, { x: 3, y: 0 });
    expectVectorNear(shipContact.centerB, { x: 6, y: 0 });
    expectVectorNear(shipContact.point, { x: 4, y: 0 });
    expect(shipContact.closing).toBe(true);
    expect(shipContact.initialOverlap).toBe(false);

    const wallContact = sweptCircleVsSegment(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      1,
      { x: 6, y: -5 },
      { x: 6, y: 5 },
      { id: "bulkhead" },
    );
    expect(wallContact).not.toBeNull();
    expectNear(wallContact.fraction, 0.5, 2e-8);
    expectVectorNear(wallContact.center, { x: 5, y: 0 }, 2e-8);
    expectVectorNear(wallContact.point, { x: 6, y: 0 }, 2e-8);
    expectVectorNear(wallContact.normal, { x: -1, y: 0 });
    expect(wallContact.closing).toBe(true);
    expect(wallContact.initialOverlap).toBe(false);
  });

  test("coincident circle normals are stable, unit length, and antisymmetric by ship order", () => {
    const first = stableCoincidentNormal("alpha", "beta");
    const repeated = stableCoincidentNormal("alpha", "beta");
    const reversed = stableCoincidentNormal("beta", "alpha");

    expect(repeated).toEqual(first);
    expectNear(Math.hypot(first.x, first.y), 1);
    expectVectorNear(reversed, { x: -first.x, y: -first.y });
    expectVectorNear(circleContactNormal({ x: 4, y: 4 }, { x: 4, y: 4 }, "alpha", "beta"), first);
  });

  test("overlap separation follows inverse mass and inelastic response conserves normal momentum", () => {
    const separated = separateOverlappingCircles(
      { position: { x: 0, y: 0 }, radius: 1, mass: 1 },
      { position: { x: 1, y: 0 }, radius: 1, mass: 3 },
      { x: 1, y: 0 },
    );
    const displacementA = Math.abs(separated.positionA.x);
    const displacementB = separated.positionB.x - 1;

    expectNear(separated.separation, 1);
    expectNear(displacementA / displacementB, 3);
    expect(separated.positionB.x - separated.positionA.x).toBeGreaterThan(2);
    expectNear(separated.positionA.y, 0);
    expectNear(separated.positionB.y, 0);

    const response = resolveInelasticNormalResponse(
      { velocity: { x: 4, y: 2 }, mass: 1 },
      { velocity: { x: 0, y: -3 }, mass: 3 },
      { x: 1, y: 0 },
    );
    expect(response.closing).toBe(true);
    expectNear(response.sharedNormalVelocity, 1);
    expectVectorNear(response.velocityA, { x: 1, y: 2 });
    expectVectorNear(response.velocityB, { x: 1, y: -3 });
    expectNear((1 * response.velocityA.x) + (3 * response.velocityB.x), 4);

    const separating = resolveInelasticNormalResponse(
      { velocity: { x: -1, y: 2 }, mass: 1 },
      { velocity: { x: 1, y: -3 }, mass: 3 },
      { x: 1, y: 0 },
    );
    expect(separating.closing).toBe(false);
    expect(separating.sharedNormalVelocity).toBeNull();
    expectVectorNear(separating.velocityA, { x: -1, y: 2 });
    expectVectorNear(separating.velocityB, { x: 1, y: -3 });
  });
});

describe("arcs, sectors, and impact consequences", () => {
  test("firing arcs include both angular edges across heading wrap and exclude points beyond them", () => {
    const arc = { origin: { x: 0, y: 0 }, facing: 350, arcCenter: 20, arcWidth: 70 };

    expect(isInFiringArc({ ...deepClone(arc), target: pointAtBearing(-25) })).toBe(true);
    expect(isInFiringArc({ ...deepClone(arc), target: pointAtBearing(45) })).toBe(true);
    expect(isInFiringArc({ ...deepClone(arc), target: pointAtBearing(-25.001) })).toBe(false);
    expect(isInFiringArc({ ...deepClone(arc), target: pointAtBearing(45.001) })).toBe(false);
    expect(isInFiringArc({ ...deepClone(arc), target: pointAtBearing(10), arcWidth: 0 })).toBe(true);
  });

  test("struck-sector boundaries have stable half-open ownership", () => {
    const sectorAt = (source) => struckSector({
      target: { x: 0, y: 0 },
      source,
      facing: 0,
    });

    expect(sectorAt({ x: -1, y: -1 })).toBe("fore");
    expect(sectorAt(pointAtBearing(44.999))).toBe("fore");
    expect(sectorAt({ x: 1, y: -1 })).toBe("starboard");
    expect(sectorAt(pointAtBearing(134.999))).toBe("starboard");
    expect(sectorAt({ x: 1, y: 1 })).toBe("aft");
    expect(sectorAt({ x: -1, y: 1 })).toBe("port");
    expect(sectorAt(pointAtBearing(-45.001))).toBe("port");
  });

  test("ship impact applies size and Armor asymmetrically and emits physical and condition events", () => {
    const impact = resolveShipImpact(deepClone({
      shipA: {
        id: "skiff",
        position: { x: 0, y: 0 },
        velocity: { x: 5, y: 0 },
        facing: 0,
        radius: 1,
        size: "small",
        armor: 5,
        maxHull: 40,
      },
      shipB: {
        id: "cruiser",
        position: { x: 2, y: 0 },
        velocity: { x: -5, y: 0 },
        facing: 0,
        radius: 1,
        size: "large",
        armor: 3,
        maxHull: 40,
      },
      normal: { x: 1, y: 0 },
    }));

    expectNear(getCollisionSizeMultiplier("small", "large"), 2);
    expectNear(getCollisionSizeMultiplier("large", "small"), 0.5);
    expectNear(impact.relativeImpactSpeed, 10);
    expect(impact.closing).toBe(true);
    expect(impact.shipA.damage).toMatchObject({
      multiplier: 2,
      calculatedRawDamage: 40,
      armor: 5,
      hullDamage: 35,
      severity: "critical",
      applied: true,
    });
    expect(impact.shipB.damage).toMatchObject({
      multiplier: 0.5,
      calculatedRawDamage: 10,
      armor: 3,
      hullDamage: 7,
      severity: null,
      applied: true,
    });
    expect(impact.conditionEvents).toHaveLength(1);
    expect(impact.conditionEvents[0]).toMatchObject({
      shipId: "skiff",
      severity: "critical",
      sector: "starboard",
    });
    expectVectorNear(impact.conditionEvents[0].contactPoint, { x: 1, y: 0 });
    expect(impact.contactEvents).toEqual([
      { observerId: "skiff", targetId: "cruiser", state: "contact", physical: true, expires: "nextStart" },
      { observerId: "cruiser", targetId: "skiff", state: "contact", physical: true, expires: "nextStart" },
    ]);
    expect(impact.damageEvents.every((event) => event.bypassesShields === true)).toBe(true);
  });

  test("authoritative automatic coast persists collision damage and physical Contacts without public leakage", () => {
    const source = freshShip();
    const target = freshShip();
    source.config.armor.starboard = 7;
    target.config.armor.port = 3;
    source.config.criticalPools.starboard = [{
      id: "source-drive-impact",
      kind: "fault",
      componentId: source.config.components.drives.starboardLateral.id,
      channelId: "maneuveringThrusterFailure",
      sector: null,
      weight: 1,
    }];
    target.config.criticalPools.port = [{
      id: "target-drive-impact",
      kind: "fault",
      componentId: target.config.components.drives.portLateral.id,
      channelId: "maneuveringThrusterFailure",
      sector: null,
      weight: 1,
    }];
    source.state.phase = "active";
    source.state.velocity = { x: 10, y: 0 };
    target.state.phase = "active";
    target.state.velocity = { x: 0, y: 0 };
    const ships = {
      source: { ...source, token: { x: 0, y: 0, width: 2, rotation: 0 } },
      target: { ...target, token: { x: 5, y: 0, width: 2, rotation: 0 } },
    };
    const context = deterministicContext(ships);
    const contextBefore = deepClone(context.ships);
    const operation = deepClone({
      type: OPERATION_TYPES.COAST,
      sourceUuid: "source",
      targetUuids: ["target"],
      expectedRevisions: { source: 0, target: 0 },
      payload: {},
    });

    const result = executeShipOperation(operation, context);

    expect(context.ships).toEqual(contextBefore);
    expect(result.changedUuids).toEqual(["source", "target"]);
    expect(result.publicEvents).toEqual([]);
    expect(result.gmEvents).toHaveLength(1);
    expect(result.gmEvents[0]).toMatchObject({ type: OPERATION_TYPES.COAST, sourceUuid: "source" });
    expect(result.gmEvents[0].detail.coast).toMatchObject({ automatic: true, timelineUsed: 1, timelineRemaining: 0 });
    expect(result.gmEvents[0].detail.collisions).toHaveLength(1);
    expect(result.gmEvents[0].detail.collisions[0].sourceDamage).toMatchObject({
      sector: "starboard",
      severity: "minor",
      damage: { armor: 7, hullDamageTaken: 13 },
    });
    expect(result.gmEvents[0].detail.collisions[0].targetDamage).toMatchObject({
      sector: "port",
      severity: "minor",
      damage: { armor: 3, hullDamageTaken: 17 },
    });

    expectNear(result.shipStates.source.timeline, 1);
    expect(result.shipStates.source.phase).toBe("end");
    expectVectorNear(result.shipStates.source.position, { x: 6.5, y: 0 }, 2e-8);
    expectNear(result.shipStates.source.velocity.x, 5);
    expectNear(result.shipStates.target.velocity.x, 5);
    expectNear(result.shipStates.source.hull, 37);
    expectNear(result.shipStates.target.hull, 33);
    expectNear(result.tokenUpdates.source.x, 6.5, 2e-8);
    expectNear(result.tokenUpdates.target.x, 5, 2e-8);
    expect(Object.values(result.shipStates.source.conditions)).toHaveLength(1);
    expect(Object.values(result.shipStates.source.conditions)[0].severity).toBe("minor");
    expect(Object.values(result.shipStates.target.conditions)).toHaveLength(1);
    expect(Object.values(result.shipStates.target.conditions)[0].severity).toBe("minor");

    expect(result.shipStates.source.tracks.target).toMatchObject({
      state: "contact",
      physicalUntilTurnKey: true,
      lastKnown: { facing: 0, stale: false },
    });
    expectVectorNear(result.shipStates.source.tracks.target.lastKnown.position, { x: 5, y: 0 });
    expect(result.shipStates.target.tracks.source).toMatchObject({
      state: "contact",
      physicalUntilTurnKey: true,
      lastKnown: { facing: 0, stale: false },
    });
    expectVectorNear(result.shipStates.target.tracks.source.lastKnown.position, { x: 3, y: 0 }, 2e-8);
  });

  test("overspeed uses vector magnitude for damage and preview warnings", () => {
    const overspeed = getOverspeedDamage({ x: 18, y: 24 }, 25);
    expectNear(overspeed.speed, 30);
    expect(overspeed).toMatchObject({ safeVelocity: 25, overspeed: 5, hullDamage: 10 });
    expect(getOverspeedDamage({ x: 18, y: 24 }, 30)).toMatchObject({ overspeed: 0, hullDamage: 0 });

    const { state } = freshShip();
    state.velocity = { x: 18, y: 24 };
    const preview = previewManeuver(deepClone({
      state,
      position: { x: 0, y: 0 },
      velocity: state.velocity,
      facing: 0,
      duration: 0,
      deltaV: { forward: 0, lateral: 0 },
      rotation: 0,
      capabilities: { forward: 0, retro: 0, port: 0, starboard: 0, rotation: 0 },
      collisionRadius: 0,
      obstacles: [],
      safeVelocity: 25,
    }));
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toMatchObject({
      code: "MOVEMENT_OVERSPEED",
      safeVelocity: 25,
      overspeed: 5,
      hullDamage: 10,
    });
    expectNear(preview.warnings[0].speed, 30);
  });
});
