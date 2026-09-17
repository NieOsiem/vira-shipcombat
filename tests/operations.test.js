import { describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import { createDefaultShipData, createInitialState } from "../scripts/model/defaults.js";
import { executeShipOperation } from "../scripts/rules/operations.js";
import { trackKey } from "../scripts/rules/sensors.js";

const SOURCE = "Scene.test.Token.source";
const TARGET_A = "Scene.test.Token.target-a";
const TARGET_B = "Scene.test.Token.target-b";
const PILOT = "canadensis-pilot-commander";
const GUNNER = "canadensis-gunner-sensor";
const DAMAGE_CONTROL = "canadensis-damage-control";

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

describe("authority invariants", () => {
  test("client cost and free flags cannot bypass a paid sensor Action", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    source.state.resources.actions[GUNNER] = 1;
    assignedUser(source, GUNNER, "sensor-user");

    const result = executeShipOperation(
      request("ping", SOURCE, [], { operatorId: GUNNER, cost: 0, free: true, operation: { free: true } }),
      context([[SOURCE, source]], { isGM: false, userId: "sensor-user" }),
    );

    expect(result.shipStates[SOURCE].resources.actions[GUNNER]).toBe(0);
  });

  test("roster identities already assigned to another ship are rejected", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    expect(errorCode(() => executeShipOperation(
      request("setRoster", SOURCE, [TARGET_A], { roster: clone(source.state.roster), occupiedIdentities: [] }),
      context([[SOURCE, source], [TARGET_A, target]]),
    ))).toBe("DUPLICATE_OPERATOR");
  });

  test("Start cannot run twice and End requires the mandatory coast", () => {
    const active = ship(SOURCE);
    active.state.phase = "active";
    expect(errorCode(() => executeShipOperation(
      request("startPhase", SOURCE),
      context([[SOURCE, active]]),
    ))).toBe("SHIP_NOT_STARTING");
    expect(errorCode(() => executeShipOperation(
      request("endPhase", SOURCE),
      context([[SOURCE, active]]),
    ))).toBe("COAST_REQUIRED");
  });

  test("Power and Defense controls release on commit while free weapon toggles need no control or resource", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    assignedUser(source, GUNNER, "operator-user");
    source.state.resources.actions[GUNNER] = 0;

    source.state.controls.power = { operatorId: GUNNER };
    const power = executeShipOperation(
      request("routePower", SOURCE, [], { operatorId: GUNNER, allocation: clone(source.state.power) }),
      context([[SOURCE, source]], { isGM: false, userId: "operator-user" }),
    );
    expect(power.shipStates[SOURCE].controls.power).toBeNull();

    const defenseSource = clone(source);
    defenseSource.state.controls.defense = { operatorId: GUNNER };
    const defense = executeShipOperation(
      request("routeDefense", SOURCE, [], { operatorId: GUNNER }),
      context([[SOURCE, defenseSource]], { isGM: false, userId: "operator-user" }),
    );
    expect(defense.shipStates[SOURCE].controls.defense).toBeNull();

    const toggled = executeShipOperation(
      request("toggleWeapon", SOURCE, [], {
        operatorId: GUNNER,
        weaponId: CANADENSIS_IDS.railgun,
        status: "off",
      }),
      context([[SOURCE, source]], { isGM: false, userId: "operator-user" }),
    );
    expect(toggled.shipStates[SOURCE].weapons[CANADENSIS_IDS.railgun].status).toBe("off");
    expect(toggled.shipStates[SOURCE].resources.actions[GUNNER]).toBe(0);
  });

  test("immediate fault consequences shed Power and invalidate sensors without coupling drive roles", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    assignedUser(source, GUNNER, "operator-user");
    source.state.resources.actions[GUNNER] = 0;
    source.state.evasion = { armed: true, reserved: 0.2 };
    source.state.tracks[TARGET_A] = {
      targetUuid: TARGET_A,
      state: "targeted",
      passiveContact: true,
      firingSolution: true,
      remembered: {},
      jams: [],
    };
    source.state.conditions.reactor = {
      kind: "fault",
      conditionId: "reactorFault",
      channelId: "reactorFault",
      componentId: source.config.components.reactor.id,
      severity: "minor",
    };
    source.state.conditions.drive = {
      kind: "fault",
      conditionId: "driveFailure",
      channelId: "driveFailure",
      componentId: source.config.components.drives.main.id,
      severity: "destroyed",
    };
    source.state.conditions.sensor = {
      kind: "fault",
      conditionId: "sensorFault",
      channelId: "sensorFault",
      componentId: source.config.components.sensor.id,
      severity: "destroyed",
    };

    const result = executeShipOperation(
      request("toggleWeapon", SOURCE, [], {
        operatorId: GUNNER,
        weaponId: CANADENSIS_IDS.railgun,
        status: "off",
      }),
      context([[SOURCE, source]], { isGM: false, userId: "operator-user" }),
    );
    const state = result.shipStates[SOURCE];
    const committed = ["engines", "shields", "sensors", "cooling", "weapons"]
      .reduce((total, system) => total + state.power[system], 0);
    expect(committed).toBeLessThanOrEqual(11);
    expect(state.evasion.armed).toBe(true);
    expect(state.tracks[trackKey(TARGET_A)].state).toBe("undetected");
    expect(state.tracks[trackKey(TARGET_A)].firingSolution).toBe(false);
  });

  test("the other lateral remains independently repairable while its counterpart is destroyed", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    source.state.resources.orders[DAMAGE_CONTROL] = 1;
    assignedUser(source, DAMAGE_CONTROL, "repair-user");
    source.state.conditions.port = {
      kind: "fault",
      conditionId: "maneuveringThrusterFailure",
      componentId: source.config.components.drives.portLateral.id,
      severity: "destroyed",
    };
    source.state.conditions.starboard = {
      kind: "fault",
      conditionId: "maneuveringThrusterFailure",
      componentId: source.config.components.drives.starboardLateral.id,
      severity: "minor",
    };

    const result = executeShipOperation(
      request("repair", SOURCE, [], { operatorId: DAMAGE_CONTROL, conditionId: "starboard" }),
      context([[SOURCE, source]], { isGM: false, userId: "repair-user" }),
    );

    expect(result.shipStates[SOURCE].conditions.port).toMatchObject({
      componentId: source.config.components.drives.portLateral.id,
      severity: "destroyed",
    });
    expect(result.shipStates[SOURCE].conditions.starboard).toBeUndefined();
    expect(result.shipStates[SOURCE].resources.orders[DAMAGE_CONTROL]).toBe(0);
  });

  test("requested subsystem operations reject atomically on an empty loadout", () => {
    const source = ship(SOURCE);
    source.config.components = { drives: {}, weapons: [] };
    source.config.weaponPriority = [];
    source.state = createInitialState(source.config);
    source.state.phase = "active";
    source.state.resources.actions[GUNNER] = 1;
    source.state.controls.defense = { operatorId: GUNNER };
    assignedUser(source, GUNNER, "operator-user");

    const cases = [
      ["routeDefense", { operatorId: GUNNER }, "MISSING_SHIELD"],
      ["cooling", { operatorId: GUNNER }, "COOLING_COMPONENT_REQUIRED"],
      ["ping", { operatorId: GUNNER }, "SENSORS_OFFLINE"],
    ];
    for (const [type, payload, code] of cases) {
      const authority = context([[SOURCE, source]], { isGM: false, userId: "operator-user" });
      const operationRequest = request(type, SOURCE, [], payload);
      const before = clone({ ships: authority.ships, request: operationRequest });
      expect(errorCode(() => executeShipOperation(
        operationRequest,
        authority,
      ))).toBe(code);
      expect({ ships: authority.ships, request: operationRequest }).toEqual(before);
    }
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
    const weaponId = CANADENSIS_IDS.railgun;
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
