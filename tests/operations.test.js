import { describe, expect, test } from "bun:test";

import { createDefaultShipData, createInitialState } from "../scripts/model/defaults.js";
import { executeShipOperation } from "../scripts/rules/operations.js";
import { trackKey } from "../scripts/rules/sensors.js";

const SOURCE = "Scene.test.Token.source";
const TARGET_A = "Scene.test.Token.target-a";
const TARGET_B = "Scene.test.Token.target-b";
const PILOT = "canadensis-pilot-commander";
const GUNNER = "canadensis-gunner-sensor";

function clone(value) {
  return structuredClone(value);
}

function ship(uuid, overrides = {}) {
  const data = createDefaultShipData();
  data.state = createInitialState(data.config);
  return {
    config: data.config,
    state: data.state,
    token: { uuid, x: 0, y: 0, rotation: 0, width: 2 },
    ...overrides,
  };
}

function context(records, overrides = {}) {
  return {
    ships: Object.fromEntries(records.map(([uuid, record]) => [uuid, clone(record)])),
    userId: "gm-user",
    isGM: true,
    rollD20: () => 20,
    random: () => 0,
    ...overrides,
  };
}

function request(type, sourceUuid = SOURCE, targetUuids = [], payload = {}, revisions = {}) {
  return {
    type,
    sourceUuid,
    targetUuids,
    expectedRevisions: {
      [sourceUuid]: 0,
      ...Object.fromEntries(targetUuids.map((uuid) => [uuid, 0])),
      ...revisions,
    },
    payload,
  };
}

function errorCode(callback) {
  try {
    callback();
  } catch (error) {
    return error.code;
  }
  throw new Error("Expected operation to be rejected");
}

function json(value) {
  return JSON.stringify(value);
}

function assignedUser(record, operatorId, userId) {
  const operator = record.config.operators.find((entry) => entry.id === operatorId);
  operator.userId = userId;
  for (const entries of [record.state.roster.command, record.state.roster.crew]) {
    const assignment = entries.find((entry) => entry.operatorId === operatorId);
    if (assignment) assignment.userId = userId;
  }
}

function lifecycleResult(type, phase, payload = {}) {
  const source = ship(SOURCE);
  source.state.phase = phase;
  return executeShipOperation(request(type, SOURCE, [], payload), context([[SOURCE, source]]));
}

describe("executeShipOperation lifecycle dispatch", () => {
  test("canonical and stable aliases dispatch to the same lifecycle transitions", () => {
    const cases = [
      ["enterCombat", "combat.enter", "outsideCombat", { turnKey: "round-1" }, "start"],
      ["coast", "phase.coast", "active", {}, "end"],
      ["endPhase", "phase.end", "end", {}, "start"],
      ["leaveCombat", "combat.leave", "start", {}, "outsideCombat"],
    ];

    for (const [canonical, alias, phase, payload, expectedPhase] of cases) {
      const canonicalResult = lifecycleResult(canonical, phase, payload);
      const aliasResult = lifecycleResult(alias, phase, payload);
      expect(aliasResult).toEqual(canonicalResult);
      expect(canonicalResult.shipStates[SOURCE].phase).toBe(expectedPhase);
    }
  });

  test("lifecycle events remain GM-only", () => {
    const result = lifecycleResult("combat.enter", "outsideCombat", { turnKey: "round-2" });
    expect(result.publicEvents).toEqual([]);
    expect(result.gmEvents).toHaveLength(1);
    expect(result.gmEvents[0]).toMatchObject({ type: "enterCombat", sourceUuid: SOURCE, targetUuids: [] });
  });
});

describe("dispatcher rejection and authority", () => {
  test("unknown operation and stale revision reject stably without touching context", () => {
    const source = ship(SOURCE);
    source.state.revision = 4;
    const authority = context([[SOURCE, source]]);
    const before = json(authority);

    expect(errorCode(() => executeShipOperation(request("warp", SOURCE, [], {}, { [SOURCE]: 4 }), authority))).toBe("UNKNOWN_OPERATION");
    expect(json(authority)).toBe(before);
    expect(errorCode(() => executeShipOperation(request("enterCombat", SOURCE, [], {}, { [SOURCE]: 3 }), authority))).toBe("STALE_SHIP_REVISION");
    expect(json(authority)).toBe(before);
  });

  test("successful dispatch returns replacements without mutating the supplied context", () => {
    const source = ship(SOURCE);
    source.state.phase = "outsideCombat";
    const authority = context([[SOURCE, source]]);
    const before = clone(authority.ships);

    const result = executeShipOperation(request("enterCombat", SOURCE, [], { turnKey: "round-3" }), authority);

    expect(authority.ships).toEqual(before);
    expect(result.shipStates[SOURCE]).not.toBe(authority.ships[SOURCE].state);
    expect(result.shipStates[SOURCE].phase).toBe("start");
  });

  test("failed Active-phase operations are atomic and leave context byte-identical", () => {
    const source = ship(SOURCE);
    assignedUser(source, PILOT, "pilot-user");
    const authority = context([[SOURCE, source]], { isGM: false, userId: "pilot-user" });
    const before = json(authority);

    expect(errorCode(() => executeShipOperation(request("spendResource", SOURCE, [], { operatorId: PILOT }), authority))).toBe("SHIP_NOT_ACTIVE");
    expect(json(authority)).toBe(before);
  });

  test("non-GM authorization is ship-local and bound to the assigned userId", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    source.state.resources.actions[PILOT] = 1;
    assignedUser(source, PILOT, "owner-user");
    const owned = context([[SOURCE, source]], { isGM: false, userId: "owner-user" });
    const accepted = executeShipOperation(request("spendResource", SOURCE, [], { operatorId: PILOT }), owned);
    expect(accepted.shipStates[SOURCE].resources.actions[PILOT]).toBe(0);

    const foreign = context([[SOURCE, source]], { isGM: false, userId: "other-user" });
    const before = json(foreign);
    expect(errorCode(() => executeShipOperation(request("spendResource", SOURCE, [], { operatorId: PILOT }), foreign))).toBe("OPERATOR_PERMISSION_DENIED");
    expect(json(foreign)).toBe(before);
  });

  test("an explicit GM override permits an unassigned operator but no implicit override does", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    source.state.resources.actions[PILOT] = 1;
    assignedUser(source, PILOT, "owner-user");
    const authority = context([[SOURCE, source]], { isGM: true, userId: "different-user" });

    expect(errorCode(() => executeShipOperation(request("spendResource", SOURCE, [], { operatorId: PILOT }), authority))).toBe("OPERATOR_PERMISSION_DENIED");
    const result = executeShipOperation(request("spendResource", SOURCE, [], { operatorId: PILOT, gmOverride: true }), authority);
    expect(result.shipStates[SOURCE].resources.actions[PILOT]).toBe(0);
  });
});

describe("multi-ship replacement scope and event privacy", () => {
  test("an attack replaces source and target while separating public from GM detail", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "active";
    target.token.y = -20;
    assignedUser(source, GUNNER, "gunner-user");
    source.state.resources.actions[GUNNER] = 1;
    source.state.tracks[TARGET_A] = { state: "targeted", firingSolution: true, effectiveAc: 10 };
    const weaponId = "canadensis-twin-railgun";
    source.state.weapons[weaponId].readiness = 1;

    const result = executeShipOperation(
      request("attack", SOURCE, [TARGET_A], { operatorId: GUNNER, weaponId, barrageRounds: 1 }),
      context([[SOURCE, source], [TARGET_A, target]], { isGM: false, userId: "gunner-user" }),
    );

    expect(result.changedUuids).toEqual([SOURCE, TARGET_A].sort());
    expect(Object.keys(result.shipStates).sort()).toEqual([SOURCE, TARGET_A].sort());
    expect(result.publicEvents).toHaveLength(1);
    expect(result.gmEvents).toHaveLength(1);
    expect(result.publicEvents[0]).toMatchObject({ type: "attack", sourceUuid: SOURCE, targetUuids: [TARGET_A] });
    expect(result.gmEvents[0]).toMatchObject({ type: "attack", sourceUuid: SOURCE, targetUuids: [TARGET_A] });
    expect(result.publicEvents[0].detail).not.toEqual(result.gmEvents[0].detail);
  });

  test("ship collision emits replacement state and token transforms for both participants", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "active";
    source.state.velocity = { x: 10, y: 0 };
    target.token.x = 5;
    target.state.velocity = { x: 0, y: 0 };

    const result = executeShipOperation(
      request("phase.coast", SOURCE, [TARGET_A]),
      context([[SOURCE, source], [TARGET_A, target]]),
    );

    expect(result.changedUuids).toEqual([SOURCE, TARGET_A].sort());
    expect(Object.keys(result.tokenUpdates).sort()).toEqual([SOURCE, TARGET_A].sort());
    expect(result.shipStates[SOURCE].tracks[trackKey(TARGET_A)]?.targetUuid).toBe(TARGET_A);
    expect(result.shipStates[TARGET_A].tracks[trackKey(SOURCE)]?.targetUuid).toBe(SOURCE);
    expect(result.gmEvents[0].detail.collisions[0].obstacleId).toBe(TARGET_A);
  });
});

describe("administrative reposition", () => {
  test("preserves velocity by default, resets only when requested, and scopes changed UUIDs", () => {
    for (const resetVelocity of [false, true]) {
      const source = ship(SOURCE);
      const unrelated = ship(TARGET_A);
      source.state.velocity = { x: 7, y: -3 };
      unrelated.state.velocity = { x: 99, y: 99 };
      const result = executeShipOperation(
        request("admin.reposition", SOURCE, [], { position: { x: 12, y: 34 }, facing: 90, resetVelocity }),
        context([[SOURCE, source], [TARGET_A, unrelated]]),
      );

      expect(result.changedUuids).toEqual([SOURCE]);
      expect(Object.keys(result.tokenUpdates)).toEqual([SOURCE]);
      expect(result.shipStates[SOURCE].velocity).toEqual(resetVelocity ? { x: 0, y: 0 } : { x: 7, y: -3 });
      expect(result.shipStates[TARGET_A]).toEqual(unrelated.state);
      expect(result.tokenUpdates[SOURCE]).toMatchObject({ x: 12, y: 34, rotation: 90 });
      expect(result.publicEvents).toEqual([]);
      expect(result.gmEvents[0].detail.velocityReset).toBe(resetVelocity);
    }
  });
});
