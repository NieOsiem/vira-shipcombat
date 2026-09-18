import { describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import {
  createDefaultShipData,
  createInitialState,
} from "../scripts/model/defaults.js";
import { executeShipOperation } from "../scripts/rules/operations.js";
import {
  assignedUserIds,
  rosterIdentityConflicts,
} from "../scripts/rules/operators.js";
import { trackKey } from "../scripts/rules/sensors.js";
import { publishOperationEvents } from "../scripts/foundry/chat.js";

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
    ships: Object.fromEntries(
      records.map(([uuid, record]) => [uuid, clone(record)]),
    ),
    userId: "gm-user",
    isGM: true,
    rollD20: () => 20,
    random: () => 0,
    ...overrides,
  };
}

function request(
  type,
  sourceUuid = SOURCE,
  targetUuids = [],
  payload = {},
  revisions = {},
) {
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

async function withChat(callback) {
  const previousFoundry = globalThis.foundry;
  const previousGame = globalThis.game;
  const created = [];
  globalThis.foundry = {
    utils: {
      escapeHTML: (value) =>
        String(value).replace(
          /[&<>"']/g,
          (character) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[character],
        ),
    },
    documents: {
      ChatMessage: {
        implementation: {
          getSpeaker: () => ({ alias: "Ship combat" }),
          createDocuments: async (messages) => {
            created.push(...messages);
            return messages;
          },
        },
      },
    },
  };
  globalThis.game = {
    users: [{ id: "gm", isGM: true }, { id: "player", isGM: false }],
  };
  try {
    await callback(created);
  } finally {
    globalThis.foundry = previousFoundry;
    globalThis.game = previousGame;
  }
}

function assignedUser(record, operatorId, userId) {
  const operator = record.config.operators.find((entry) =>
    entry.id === operatorId
  );
  operator.userId = userId;
  for (
    const entries of [record.state.roster.command, record.state.roster.crew]
  ) {
    const assignment = entries.find((entry) => entry.operatorId === operatorId);
    if (assignment) assignment.userId = userId;
  }
}

function lifecycleResult(type, phase, payload = {}) {
  const source = ship(SOURCE);
  source.state.phase = phase;
  return executeShipOperation(
    request(type, SOURCE, [], payload),
    context([[SOURCE, source]]),
  );
}

function operationDetail(result, type) {
  return [...result.gmEvents, ...result.publicEvents]
    .find((entry) => entry.type === type).detail;
}

function startPhaseConflicts(result) {
  const { events } = operationDetail(result, "startPhase");
  return events.find((event) => event.type === "openingHousekeeping").roster
    .conflicts;
}

describe("executeShipOperation lifecycle dispatch", () => {
  test("canonical and stable aliases dispatch to the same lifecycle transitions", () => {
    const cases = [
      [
        "enterCombat",
        "combat.enter",
        "outsideCombat",
        { turnKey: "round-1" },
        "start",
      ],
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
    const result = lifecycleResult("combat.enter", "outsideCombat", {
      turnKey: "round-2",
    });
    expect(result.publicEvents).toEqual([]);
    expect(result.gmEvents).toHaveLength(1);
    expect(result.gmEvents[0]).toMatchObject({
      type: "enterCombat",
      sourceUuid: SOURCE,
      targetUuids: [],
    });
  });
});

describe("dispatcher rejection and authority", () => {
  test("unknown operation and stale revision reject stably without touching context", () => {
    const source = ship(SOURCE);
    source.state.revision = 4;
    const authority = context([[SOURCE, source]]);
    const before = json(authority);

    expect(
      errorCode(() =>
        executeShipOperation(
          request("warp", SOURCE, [], {}, { [SOURCE]: 4 }),
          authority,
        )
      ),
    ).toBe("UNKNOWN_OPERATION");
    expect(json(authority)).toBe(before);
    expect(
      errorCode(() =>
        executeShipOperation(
          request("enterCombat", SOURCE, [], {}, { [SOURCE]: 3 }),
          authority,
        )
      ),
    ).toBe("STALE_SHIP_REVISION");
    expect(json(authority)).toBe(before);
  });

  test("successful dispatch returns replacements without mutating the supplied context", () => {
    const source = ship(SOURCE);
    source.state.phase = "outsideCombat";
    const authority = context([[SOURCE, source]]);
    const before = clone(authority.ships);

    const result = executeShipOperation(
      request("enterCombat", SOURCE, [], { turnKey: "round-3" }),
      authority,
    );

    expect(authority.ships).toEqual(before);
    expect(result.shipStates[SOURCE]).not.toBe(authority.ships[SOURCE].state);
    expect(result.shipStates[SOURCE].phase).toBe("start");
  });

  test("failed Active-phase operations are atomic and leave context byte-identical", () => {
    const source = ship(SOURCE);
    assignedUser(source, PILOT, "pilot-user");
    const authority = context([[SOURCE, source]], {
      isGM: false,
      userId: "pilot-user",
    });
    const before = json(authority);

    expect(
      errorCode(() =>
        executeShipOperation(
          request("spendResource", SOURCE, [], { operatorId: PILOT }),
          authority,
        )
      ),
    ).toBe("SHIP_NOT_ACTIVE");
    expect(json(authority)).toBe(before);
  });

  test("non-GM authorization is ship-local and bound to the assigned userId", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    source.state.resources.actions[PILOT] = 1;
    assignedUser(source, PILOT, "owner-user");
    const owned = context([[SOURCE, source]], {
      isGM: false,
      userId: "owner-user",
    });
    const accepted = executeShipOperation(
      request("spendResource", SOURCE, [], { operatorId: PILOT }),
      owned,
    );
    expect(accepted.shipStates[SOURCE].resources.actions[PILOT]).toBe(0);

    const foreign = context([[SOURCE, source]], {
      isGM: false,
      userId: "other-user",
    });
    const before = json(foreign);
    expect(
      errorCode(() =>
        executeShipOperation(
          request("spendResource", SOURCE, [], { operatorId: PILOT }),
          foreign,
        )
      ),
    ).toBe("OPERATOR_PERMISSION_DENIED");
    expect(json(foreign)).toBe(before);
  });

  test("an explicit GM override permits an unassigned operator but no implicit override does", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    source.state.resources.actions[PILOT] = 1;
    assignedUser(source, PILOT, "owner-user");
    const authority = context([[SOURCE, source]], {
      isGM: true,
      userId: "different-user",
    });

    expect(
      errorCode(() =>
        executeShipOperation(
          request("spendResource", SOURCE, [], { operatorId: PILOT }),
          authority,
        )
      ),
    ).toBe("OPERATOR_PERMISSION_DENIED");
    const result = executeShipOperation(
      request("spendResource", SOURCE, [], {
        operatorId: PILOT,
        gmOverride: true,
      }),
      authority,
    );
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
      request("ping", SOURCE, [], {
        operatorId: GUNNER,
        cost: 0,
        free: true,
        operation: { free: true },
      }),
      context([[SOURCE, source]], { isGM: false, userId: "sensor-user" }),
    );

    expect(result.shipStates[SOURCE].resources.actions[GUNNER]).toBe(0);
  });

  test("two participating ships sharing all template operators can both resolve Start", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "start";
    target.state.phase = "start";
    const authority = context([[SOURCE, source], [TARGET_A, target]]);

    const sourceStart = executeShipOperation(
      request("startPhase", SOURCE),
      authority,
    );
    authority.ships[SOURCE].state = sourceStart.shipStates[SOURCE];
    const targetStart = executeShipOperation(
      request("startPhase", TARGET_A),
      authority,
    );

    for (
      const [uuid, result] of [[SOURCE, sourceStart], [TARGET_A, targetStart]]
    ) {
      expect(result.shipStates[uuid].phase).toBe("active");
      expect(result.shipStates[uuid].resources).toEqual({
        actions: { [PILOT]: 3, [GUNNER]: 3 },
        orders: { [DAMAGE_CONTROL]: 1, "canadensis-loader-general": 1 },
      });
    }
  });

  test("Start reports a bound actor already assigned to another participating ship", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "start";
    target.state.phase = "active";
    source.config.operators.find((entry) => entry.id === PILOT).actorId =
      "shared-actor";
    target.state.roster.command.find((entry) => entry.operatorId === GUNNER)
      .actorId = "shared-actor";

    const result = executeShipOperation(
      request("startPhase", SOURCE, [], { occupiedIdentities: [] }),
      context([[SOURCE, source], [TARGET_A, target]]),
    );

    expect(result.shipStates[SOURCE].phase).toBe("active");
    expect(startPhaseConflicts(result)).toEqual([{
      tokens: ["actor:shared-actor"],
      operators: [{ slot: "command", index: 0, operatorId: PILOT }],
      scope: "crossShip",
    }]);
  });

  test("roster edits report a bound user already assigned to another participating ship", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "start";
    target.state.phase = "end";
    assignedUser(source, PILOT, "shared-user");
    assignedUser(target, GUNNER, "shared-user");

    const result = executeShipOperation(
      request("setRoster", SOURCE, [TARGET_A], {
        roster: clone(source.state.roster),
        occupiedIdentities: [],
      }),
      context([[SOURCE, source], [TARGET_A, target]]),
    );

    const roster = result.shipStates[SOURCE].roster;
    expect(roster.command.find((entry) => entry.operatorId === PILOT).userId)
      .toBe("shared-user");
    expect(operationDetail(result, "setRoster").conflicts).toEqual([{
      tokens: ["user:shared-user"],
      operators: [{ slot: "command", index: 0, operatorId: PILOT }],
      scope: "crossShip",
    }]);
  });

  test("resource refresh reports but never rejects a user bound on another ship", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "active";
    target.state.phase = "active";
    assignedUser(source, PILOT, "shared-user");
    assignedUser(target, GUNNER, "shared-user");

    const result = executeShipOperation(
      request("refreshResources", SOURCE),
      context([[SOURCE, source], [TARGET_A, target]]),
    );

    expect(result.shipStates[SOURCE].resources.actions[PILOT]).toBe(3);
    expect(operationDetail(result, "refreshResources").conflicts).toEqual([{
      tokens: ["user:shared-user"],
      operators: [{ slot: "command", index: 0, operatorId: PILOT }],
      scope: "crossShip",
    }]);
  });

  test("Start ignores bound individuals on ships outside combat", () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "start";
    for (const record of [source, target]) {
      record.config.operators.find((entry) => entry.id === PILOT).actorId =
        "shared-actor";
      assignedUser(record, PILOT, "shared-user");
    }

    const result = executeShipOperation(
      request("startPhase", SOURCE),
      context([[SOURCE, source], [TARGET_A, target]]),
    );

    expect(result.shipStates[SOURCE].phase).toBe("active");
    expect(result.shipStates[SOURCE].resources.actions[PILOT]).toBe(3);
  });

  test("the same template operator cannot occupy two slots on one ship", () => {
    const source = ship(SOURCE);
    source.state.roster.command[1].operatorId = PILOT;

    expect(errorCode(() =>
      executeShipOperation(
        request("setRoster", SOURCE, [], {
          roster: clone(source.state.roster),
        }),
        context([[SOURCE, source]]),
      )
    )).toBe("DUPLICATE_OPERATOR");
  });

  test("Start with one operator in two slots resolves Active and reports the conflict", () => {
    const source = ship(SOURCE);
    source.state.phase = "start";
    source.state.roster.command[1].operatorId = PILOT;

    const result = executeShipOperation(
      request("startPhase", SOURCE),
      context([[SOURCE, source]]),
    );

    expect(result.shipStates[SOURCE].phase).toBe("active");
    expect(result.shipStates[SOURCE].resources.actions).toEqual({
      [PILOT]: 3,
    });
    expect(result.shipStates[SOURCE].roster.command).toEqual([
      { operatorId: PILOT, slot: 0 },
      { operatorId: PILOT, slot: 1 },
    ]);
    expect(startPhaseConflicts(result)).toEqual([{
      tokens: [`operator:${PILOT}`],
      operators: [
        { slot: "command", index: 0, operatorId: PILOT },
        { slot: "command", index: 1, operatorId: PILOT },
      ],
      scope: "roster",
    }]);
  });

  test("Start cannot run twice and End requires the mandatory coast", () => {
    const active = ship(SOURCE);
    active.state.phase = "active";
    expect(errorCode(() =>
      executeShipOperation(
        request("startPhase", SOURCE),
        context([[SOURCE, active]]),
      )
    )).toBe("SHIP_NOT_STARTING");
    expect(errorCode(() =>
      executeShipOperation(
        request("endPhase", SOURCE),
        context([[SOURCE, active]]),
      )
    )).toBe("COAST_REQUIRED");
  });

  test("Power and Defense controls release on commit while free weapon toggles need no control or resource", () => {
    const source = ship(SOURCE);
    source.state.phase = "active";
    assignedUser(source, GUNNER, "operator-user");
    source.state.resources.actions[GUNNER] = 0;

    source.state.controls.power = { operatorId: GUNNER };
    const power = executeShipOperation(
      request("routePower", SOURCE, [], {
        operatorId: GUNNER,
        allocation: clone(source.state.power),
      }),
      context([[SOURCE, source]], { isGM: false, userId: "operator-user" }),
    );
    expect(power.shipStates[SOURCE].controls.power).toBeNull();

    const defenseSource = clone(source);
    defenseSource.state.controls.defense = { operatorId: GUNNER };
    const defense = executeShipOperation(
      request("routeDefense", SOURCE, [], { operatorId: GUNNER }),
      context([[SOURCE, defenseSource]], {
        isGM: false,
        userId: "operator-user",
      }),
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
    expect(toggled.shipStates[SOURCE].weapons[CANADENSIS_IDS.railgun].status)
      .toBe("off");
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
      request("repair", SOURCE, [], {
        operatorId: DAMAGE_CONTROL,
        conditionId: "starboard",
      }),
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
      const authority = context([[SOURCE, source]], {
        isGM: false,
        userId: "operator-user",
      });
      const operationRequest = request(type, SOURCE, [], payload);
      const before = clone({
        ships: authority.ships,
        request: operationRequest,
      });
      expect(errorCode(() =>
        executeShipOperation(
          operationRequest,
          authority,
        )
      )).toBe(code);
      expect({ ships: authority.ships, request: operationRequest }).toEqual(
        before,
      );
    }
  });
});

describe("multi-ship replacement scope and event privacy", () => {
  test("an attack replaces both ships and presents readable, visibility-isolated outcomes", async () => {
    const source = ship(SOURCE);
    const target = ship(TARGET_A);
    source.state.phase = "active";
    target.token.y = -20;
    assignedUser(source, GUNNER, "gunner-user");
    source.state.resources.actions[GUNNER] = 1;
    source.state.tracks[TARGET_A] = {
      state: "targeted",
      firingSolution: true,
      effectiveAc: 10,
    };
    const weaponId = CANADENSIS_IDS.railgun;
    source.state.weapons[weaponId].readiness = 1;

    const result = executeShipOperation(
      request("attack", SOURCE, [TARGET_A], {
        operatorId: GUNNER,
        weaponId,
        barrageRounds: 1,
      }),
      context([[SOURCE, source], [TARGET_A, target]], {
        isGM: false,
        userId: "gunner-user",
      }),
    );

    expect(result.changedUuids).toEqual([SOURCE, TARGET_A].sort());
    expect(Object.keys(result.shipStates).sort()).toEqual(
      [SOURCE, TARGET_A].sort(),
    );
    expect(result.publicEvents).toHaveLength(1);
    expect(result.gmEvents).toHaveLength(1);
    expect(result.publicEvents[0]).toMatchObject({
      type: "attack",
      sourceUuid: SOURCE,
      targetUuids: [TARGET_A],
    });
    expect(result.gmEvents[0]).toMatchObject({
      type: "attack",
      sourceUuid: SOURCE,
      targetUuids: [TARGET_A],
    });
    expect(result.publicEvents[0].detail).not.toEqual(
      result.gmEvents[0].detail,
    );
    const before = clone(result);
    await withChat(async () => {
      const { publicMessages, gmMessages } = await publishOperationEvents(
        result,
      );
      const publicCard = publicMessages[0];
      const gmCard = gmMessages[0];
      expect(publicCard.content).toMatch(/[Hh]it!/);
      expect(publicCard.content).toContain(
        `total ${result.publicEvents[0].detail.roll.total}`,
      );
      expect(publicCard.content).not.toContain("Hull damage:");
      expect(gmCard.content).toContain(
        `Hull damage: ${result.gmEvents[0].detail.damage.totals.hullDamage}`,
      );
      expect(publicCard.whisper).toBeUndefined();
      expect(gmCard.whisper).toEqual(["gm"]);
      for (const card of [publicCard, gmCard]) {
        expect(card.content).not.toContain("<pre");
        expect(card.content).not.toContain("commitment");
        expect(card.content).not.toContain("sourceUuid");
        expect(card.content).not.toContain("{");
      }
    });
    expect(result).toEqual(before);
  });

  test("ship collisions keep damage notices while replacing both participants", async () => {
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
    expect(Object.keys(result.tokenUpdates).sort()).toEqual(
      [SOURCE, TARGET_A].sort(),
    );
    expect(result.shipStates[SOURCE].tracks[trackKey(TARGET_A)]?.targetUuid)
      .toBe(TARGET_A);
    expect(result.shipStates[TARGET_A].tracks[trackKey(SOURCE)]?.targetUuid)
      .toBe(SOURCE);
    expect(result.gmEvents[0].detail.collisions[0].obstacleId).toBe(TARGET_A);
    await withChat(async () => {
      const { publicMessages, gmMessages } = await publishOperationEvents(
        result,
      );
      expect(publicMessages).toEqual([]);
      expect(gmMessages[0].content).toContain("Collision!");
      expect(gmMessages[0].content).toContain("hull damage:");
      expect(gmMessages[0].content).not.toContain("obstacleId");
      expect(gmMessages[0].whisper).toEqual(["gm"]);
    });
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
        request("admin.reposition", SOURCE, [], {
          position: { x: 12, y: 34 },
          facing: 90,
          resetVelocity,
        }),
        context([[SOURCE, source], [TARGET_A, unrelated]]),
      );

      expect(result.changedUuids).toEqual([SOURCE]);
      expect(Object.keys(result.tokenUpdates)).toEqual([SOURCE]);
      expect(result.shipStates[SOURCE].velocity).toEqual(
        resetVelocity ? { x: 0, y: 0 } : { x: 7, y: -3 },
      );
      expect(result.shipStates[TARGET_A]).toEqual(unrelated.state);
      expect(result.tokenUpdates[SOURCE]).toMatchObject({
        x: 12,
        y: 34,
        rotation: 90,
      });
      expect(result.publicEvents).toEqual([]);
      expect(result.gmEvents[0].detail.velocityReset).toBe(resetVelocity);
    }
  });

  test("rotation and routine reposition retain audit events without creating chat", async () => {
    const source = ship(SOURCE);
    const result = executeShipOperation(
      request("admin.reposition", SOURCE, [], {
        position: { x: 0, y: 0 },
        facing: 45,
      }),
      context([[SOURCE, source]]),
    );
    const before = clone(result);
    await withChat(async (created) => {
      expect(await publishOperationEvents(result)).toEqual({
        publicMessages: [],
        gmMessages: [],
      });
      await publishOperationEvents({
        publicEvents: [],
        gmEvents: [
          { type: "rotate", detail: { facing: 90 } },
          { type: "maneuver", detail: { collisions: [] } },
          { type: "startPhase", detail: { state: { revision: 20 } } },
        ],
      });
      expect(created).toEqual([]);
    });
    expect(result).toEqual(before);
    expect(result.gmEvents[0].detail.facing).toBe(45);
  });

  test("GM failures are escaped prose without diagnostic payloads or public fallback", async () => {
    const result = {
      publicEvents: [],
      gmEvents: [{
        type: "operation.rejected",
        message: '<img src=x onerror="alert(1)"> failed',
        details: { secret: "hidden diagnostic", requestId: "technical-id" },
      }],
    };
    await withChat(async (created) => {
      const messages = await publishOperationEvents(result);
      expect(messages.publicMessages).toEqual([]);
      expect(messages.gmMessages[0].whisper).toEqual(["gm"]);
      expect(messages.gmMessages[0].content).toContain("&lt;img");
      expect(messages.gmMessages[0].content).not.toContain("<img");
      expect(messages.gmMessages[0].content).not.toContain("hidden diagnostic");
      expect(messages.gmMessages[0].content).not.toContain("technical-id");
      globalThis.game.users = [{ id: "player", isGM: false }];
      expect(await publishOperationEvents(result)).toEqual({
        publicMessages: [],
        gmMessages: [],
      });
      expect(created).toHaveLength(1);
    });
  });
});

describe("operator identity helpers", () => {
  test("assignedUserIds collects profile users and per-slot overrides", () => {
    const source = ship(SOURCE);
    const { config, state } = source;
    config.operators.find((entry) => entry.id === PILOT).userId = "profile-user";
    config.operators.find((entry) => entry.id === GUNNER).userId =
      "profile-gunner";
    const gunner = state.roster.command.find((entry) =>
      entry.operatorId === GUNNER
    );
    gunner.userId = "slot-user";

    expect([...assignedUserIds(config, state)].sort()).toEqual([
      "profile-user",
      "slot-user",
    ]);
  });

  test("assignedUserIds ignores unbound operators and blank user ids", () => {
    const source = ship(SOURCE);
    const { config, state } = source;
    state.roster.crew[0].userId = "";
    config.operators.find((entry) => entry.id === GUNNER).userId = "";

    expect(assignedUserIds(config, state).size).toBe(0);
    expect(assignedUserIds(config, {}).size).toBe(0);
  });

  test("rosterIdentityConflicts reports one operator holding two slots", () => {
    const source = ship(SOURCE);
    source.state.roster.command[1].operatorId = PILOT;

    expect(rosterIdentityConflicts(source.config, source.state.roster))
      .toEqual([{
        tokens: [`operator:${PILOT}`],
        operators: [
          { slot: "command", index: 0, operatorId: PILOT },
          { slot: "command", index: 1, operatorId: PILOT },
        ],
      }]);
  });

  test("rosterIdentityConflicts reports two operators bound to the same actor", () => {
    const source = ship(SOURCE);
    const { config, state } = source;
    for (const operatorId of [PILOT, GUNNER]) {
      config.operators.find((entry) => entry.id === operatorId).actorId =
        "shared-actor";
    }

    expect(rosterIdentityConflicts(config, state.roster)).toEqual([{
      tokens: ["actor:shared-actor"],
      operators: [
        { slot: "command", index: 0, operatorId: PILOT },
        { slot: "command", index: 1, operatorId: GUNNER },
      ],
    }]);
  });

  test("rosterIdentityConflicts is empty for a distinct roster", () => {
    const source = ship(SOURCE);
    source.config.operators.find((entry) => entry.id === PILOT).userId =
      "pilot-user";
    source.config.operators.find((entry) => entry.id === GUNNER).userId =
      "gunner-user";

    expect(rosterIdentityConflicts(source.config, source.state.roster))
      .toEqual([]);
    expect(rosterIdentityConflicts(source.config, {})).toEqual([]);
  });
});
