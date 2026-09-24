import { describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import {
  createDefaultShipData,
  createInitialState,
} from "../scripts/model/defaults.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";
import { validateHullConfig } from "../scripts/model/validation.js";
import { executeShipOperation } from "../scripts/rules/operations.js";
import {
  applyMaintainedOverclockHeat,
  applyPowerShedding,
  commitPowerRoute,
  getPowerState,
  previewPowerRoute,
} from "../scripts/rules/power.js";
import { applyConditionTiers, conditionKey } from "../scripts/rules/conditions.js";
import {
  allocateRegeneration,
  applyShieldCapacityClamping,
  applyShieldRegeneration,
  commitDefenseRoute,
  previewDefenseRoute,
  recoverShieldEmitter,
  resolveShieldDamage,
  tickShieldRecharge,
} from "../scripts/rules/shields.js";
import { runEndPhase, runStartPhase } from "../scripts/rules/lifecycle.js";

const SOURCE = "Scene.test.Token.power-lifecycle";
const clone = (value) => structuredClone(value);

function freshShip(configure = () => {}) {
  const defaults = createDefaultShipData();
  const config = clone(defaults.config);
  configure(config);
  return { config, state: createInitialState(config) };
}

function captureViolation(callback, code) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({ name: "RuleViolation", code });
  return caught;
}

function gmContext(record) {
  return {
    ships: { [SOURCE]: clone(record) },
    userId: "gm-user",
    isGM: true,
    rollD20: () => 10,
    random: () => 0,
  };
}

function gmRequest(type, payload = {}) {
  return {
    type,
    sourceUuid: SOURCE,
    targetUuids: [],
    expectedRevisions: { [SOURCE]: 0 },
    payload: clone(payload),
  };
}

function emitterFault(config, sector, severity = "destroyed") {
  return {
    id: `emitter-fault:${sector}`,
    kind: "fault",
    conditionId: "shieldEmitterDamage",
    channelId: "shieldEmitterDamage",
    componentId: config.components.shield.id,
    targetId: `${config.components.shield.id}:${sector}`,
    sector,
    severity,
  };
}

function driveFault(config, role, severity = "destroyed") {
  const componentId = config.components.drives[role].id;
  return {
    id: `drive-fault:${componentId}`,
    kind: "fault",
    channelId: role === "portLateral" || role === "starboardLateral"
      ? "maneuveringThrusterFailure"
      : "driveFailure",
    componentId,
    targetId: componentId,
    severity,
  };
}

describe("Power routing and weapon lifecycle", () => {
  test("Power routing accepts only installed integer tiers and fails atomically", () => {
    const { config, state } = freshShip();
    const before = clone(state);

    captureViolation(
      () =>
        commitPowerRoute(
          config,
          state,
          clone({ allocation: { engines: 2.5, sensors: 1 } }),
        ),
      "INVALID_POWER_ALLOCATION",
    );

    expect(state).toEqual(before);
  });

  test("an empty reactor slot starts legally unpowered and stays so through Start Phase", () => {
    const defaults = createDefaultShipData();
    defaults.hull.slots.find((slot) => slot.class === "reactor").itemId = null;
    expect(validateHullConfig(defaults.hull).valid).toBe(true);
    const config = materializeShipConfig(defaults.hull, defaults.items);
    expect(config.components.reactor).toBeNull();

    const state = createInitialState(config);
    const allocation = {
      engines: 0,
      shields: 0,
      sensors: 0,
      cooling: 0,
      inertia: 0,
      weapons: 0,
    };
    const weaponStatuses = config.components.weapons.map(() => "off");
    expect(state.hull).toBe(config.maxHull);
    expect(state.power).toEqual({ ...allocation, redlining: false });
    expect(Object.values(state.weapons).map(({ status }) => status)).toEqual(weaponStatuses);
    expect(getPowerState(config, state)).toMatchObject({
      allocation,
      committed: 0,
      legal: true,
      weaponReserved: 0,
    });

    state.phase = "start";
    runStartPhase(config, state, { turnKey: "reactorless-round" });
    expect(state.phase).toBe("active");
    expect(state.power).toEqual({ ...allocation, redlining: false });
    expect(Object.values(state.weapons).map(({ status }) => status)).toEqual(weaponStatuses);
    expect(getPowerState(config, state).legal).toBe(true);
  });

  test("a missing reactor accepts an all-zero route and rejects positive power atomically", () => {
    const { config, state } = freshShip((candidate) => {
      delete candidate.components.reactor;
    });
    const allocation = {
      engines: 0,
      shields: 0,
      sensors: 0,
      cooling: 0,
      inertia: 0,
      weapons: 0,
    };
    const weaponStates = Object.fromEntries(
      Object.keys(state.weapons).map((
        weaponId,
      ) => [weaponId, { status: "off" }]),
    );

    const routed = commitPowerRoute(config, state, {
      allocation,
      weaponStates,
    });
    expect(routed).toMatchObject({
      allocation,
      committed: 0,
      unused: 0,
      ceilings: { nominal: 0, maximum: 0 },
    });

    const before = clone(state);
    captureViolation(
      () =>
        commitPowerRoute(config, state, {
          allocation: { ...allocation, engines: 1 },
        }),
      "REACTOR_CAPACITY_EXCEEDED",
    );
    expect(state).toEqual(before);
  });

  test("weapon reservations are validated against the complete staged result", () => {
    const legal = freshShip();
    const staged = {
      allocation: { weapons: 2 },
      weaponStates: { [CANADENSIS_IDS.portMacrocannon]: { status: "off" } },
    };
    const preview = previewPowerRoute(legal.config, legal.state, clone(staged));

    expect(preview.weaponReserved).toBe(2);
    expect(preview.weaponReservations).toMatchObject({
      [CANADENSIS_IDS.railgun]: 2,
      [CANADENSIS_IDS.portMacrocannon]: 0,
    });
    commitPowerRoute(legal.config, legal.state, clone(staged));
    expect(legal.state.power.weapons).toBe(2);
    expect(legal.state.weapons[CANADENSIS_IDS.portMacrocannon].status).toBe(
      "off",
    );

    const illegal = freshShip();
    const before = clone(illegal.state);
    captureViolation(
      () =>
        commitPowerRoute(
          illegal.config,
          illegal.state,
          clone({ allocation: { weapons: 2 } }),
        ),
      "WEAPONS_POWER_EXCEEDED",
    );
    expect(illegal.state).toEqual(before);
  });

  test("Redline and subsystem entry Heat is charged once, then maintained every Start", () => {
    const { config, state } = freshShip();

    const entered = commitPowerRoute(
      config,
      state,
      clone({ allocation: { engines: 4 } }),
    );
    expect(entered.redlining).toBe(true);
    expect(entered.heatAdded).toBe(7);
    expect(entered.overclockEntries).toEqual([
      { system: "engines", heat: 3 },
      { system: "reactor", heat: 4 },
    ]);
    expect(state.heat).toBe(7);

    const unchanged = commitPowerRoute(
      config,
      state,
      clone({ allocation: { engines: 4 } }),
    );
    expect(unchanged.heatAdded).toBe(0);
    expect(unchanged.overclockEntries).toEqual([]);
    expect(state.heat).toBe(7);

    const maintained = applyMaintainedOverclockHeat(config, state);
    expect(maintained).toEqual({
      heatAdded: 7,
      sources: [
        { system: "engines", heat: 3 },
        { system: "reactor", heat: 4 },
      ],
      redlining: true,
    });
    expect(state.heat).toBe(14);
  });

  test("a Destroyed Main Drive contributes no entry or maintained Heat at Engines 4", () => {
    const { config, state } = freshShip();
    state.conditions.main = driveFault(config, "main");
    const before = clone(state);
    const staged = { allocation: { engines: 4 } };

    const preview = previewPowerRoute(config, state, staged);
    expect(preview.heatAdded).toBe(6);
    expect(preview.overclockEntries).toEqual([
      { system: "engines", heat: 2 },
      { system: "reactor", heat: 4 },
    ]);
    expect(state).toEqual(before);

    const committed = commitPowerRoute(config, state, staged);
    expect(committed.heatAdded).toBe(preview.heatAdded);
    expect(committed.overclockEntries).toEqual(preview.overclockEntries);
    expect(state.heat).toBe(6);
    expect(commitPowerRoute(config, state, staged).heatAdded).toBe(0);

    const maintained = applyMaintainedOverclockHeat(config, state);
    expect(maintained.heatAdded).toBe(6);
    expect(maintained.sources).toEqual(preview.overclockEntries);
    expect(state.heat).toBe(12);
  });

  test("all Destroyed Drives generate zero Heat without suppressing reactor Redline Heat", () => {
    const { config, state } = freshShip();
    for (const role of Object.keys(config.components.drives)) {
      state.conditions[role] = driveFault(config, role);
    }
    const staged = { allocation: { engines: 4 } };
    const preview = previewPowerRoute(config, state, staged);
    expect(preview.heatAdded).toBe(4);
    expect(preview.overclockEntries).toEqual([{ system: "reactor", heat: 4 }]);
    expect(commitPowerRoute(config, state, staged).heatAdded).toBe(4);
    expect(applyMaintainedOverclockHeat(config, state)).toEqual({
      heatAdded: 4,
      sources: [{ system: "reactor", heat: 4 }],
      redlining: true,
    });
    expect(state.heat).toBe(8);

    commitPowerRoute(config, state, { allocation: { cooling: 0 } });
    expect(applyMaintainedOverclockHeat(config, state)).toEqual({
      heatAdded: 0,
      sources: [],
      redlining: false,
    });
    expect(state.heat).toBe(8);
  });

  test("lateral Heat follows each installed Drive's tier and independent operational state", () => {
    const { config, state } = freshShip((candidate) => {
      delete candidate.components.drives.main;
      delete candidate.components.drives.reverse;
      candidate.components.drives.starboardLateral.tiers.find(({ power }) =>
        power === 4
      ).overclockHeat = 2;
    });
    state.conditions.port = driveFault(config, "portLateral");
    state.conditions.starboard = driveFault(
      config,
      "starboardLateral",
      "critical",
    );
    const staged = { allocation: { engines: 4, cooling: 0 } };

    const preview = previewPowerRoute(config, state, staged);
    expect(preview.heatAdded).toBe(2);
    expect(preview.overclockEntries).toEqual([{ system: "engines", heat: 2 }]);
    expect(commitPowerRoute(config, state, staged).heatAdded).toBe(2);
    expect(applyMaintainedOverclockHeat(config, state)).toEqual({
      heatAdded: 2,
      sources: [{ system: "engines", heat: 2 }],
      redlining: false,
    });

    state.conditions.port.severity = "major";
    state.conditions.starboard.severity = "destroyed";
    expect(applyMaintainedOverclockHeat(config, state)).toEqual({
      heatAdded: 1,
      sources: [{ system: "engines", heat: 1 }],
      redlining: false,
    });
    expect(state.heat).toBe(5);
  });

  test("reactor degradation sheds deterministic reverse-priority tiers and weapons", () => {
    const { config, state } = freshShip();
    state.conditions.reactor = {
      id: "reactor",
      kind: "fault",
      conditionId: "reactorFault",
      componentId: config.components.reactor.id,
      severity: "minor",
    };

    const result = applyPowerShedding(config, state);

    expect(result.ceilings).toMatchObject({
      nominal: 11,
      maximum: 12,
      fault: "minor",
    });
    expect(result.committed).toBe(12);
    expect(result.events).toEqual([
      { type: "tierShed", system: "weapons", from: 3, to: 2 },
      { type: "tierShed", system: "weapons", from: 2, to: 1 },
      {
        type: "weaponShed",
        weaponId: CANADENSIS_IDS.portMacrocannon,
        released: 1,
      },
      {
        type: "weaponShed",
        weaponId: CANADENSIS_IDS.railgun,
        released: 2,
      },
    ]);
    expect(result.weaponReserved).toBe(0);
    expect(state.weapons[CANADENSIS_IDS.railgun]).toMatchObject({
      status: "off",
      mode: "nominal",
      bootCounter: 0,
    });
    expect(state.weapons[CANADENSIS_IDS.portMacrocannon]).toMatchObject({
      status: "off",
      mode: "nominal",
      bootCounter: 0,
    });
  });

  test("a Destroyed Emitter or Sensor at an overclock tier generates no Overclock Heat", () => {
    const cases = [
      {
        system: "shields",
        allocation: { engines: 2, shields: 4, sensors: 2, cooling: 1, weapons: 3 },
        fault: (config) =>
          conditionKey({
            kind: "fault",
            channelId: "shieldEmitterDamage",
            componentId: config.components.shield.id,
            sector: "fore",
          }),
      },
      {
        system: "sensors",
        allocation: { engines: 3, shields: 3, sensors: 3, cooling: 0, weapons: 3 },
        fault: (config) =>
          conditionKey({
            kind: "fault",
            channelId: "sensorFault",
            componentId: config.components.sensor.id,
          }),
      },
      {
        system: "cooling",
        configure: (config) => {
          const tier = config.components.cooling.tiers.find(({ power }) =>
            power === 3
          );
          Object.assign(tier, { overclock: true, overclockHeat: 2 });
        },
        allocation: { engines: 1, shields: 3, sensors: 2, cooling: 3, weapons: 3 },
        fault: (config) =>
          conditionKey({
            kind: "fault",
            channelId: "coolingFailure",
            componentId: config.components.cooling.id,
          }),
      },
    ];

    for (const { system, configure, allocation, fault } of cases) {
      const { config, state } = freshShip(configure);
      commitPowerRoute(config, state, clone({ allocation }));
      expect(applyMaintainedOverclockHeat(config, state).sources).toEqual([
        { system, heat: 2 },
      ]);

      state.heat = 0;
      const destroyed = applyConditionTiers(config, state, {
        conditionId: fault(config),
        tiers: 4,
      });
      expect(destroyed.applications[0].after).toBe("destroyed");

      state.phase = "start";
      const maintained = runStartPhase(config, state).events.find(
        ({ type }) => type === "maintainedOverclockHeat",
      );
      expect(maintained).toMatchObject({ heatAdded: 0, sources: [] });
      expect(state.heat).toBe(0);
    }
  });

  test("a Major Weapon Malfunction drops an overclocked mount instead of wedging the ship", () => {
    const { config, state } = freshShip();
    const weaponId = CANADENSIS_IDS.portMacrocannon;
    commitPowerRoute(
      config,
      state,
      clone({
        allocation: { weapons: 4 },
        weaponStates: { [weaponId]: { mode: "overclock" } },
      }),
    );
    expect(state.weapons[weaponId].mode).toBe("overclock");
    expect(getPowerState(config, state).weaponReserved).toBe(4);

    const applied = applyConditionTiers(config, state, {
      conditionId: `weaponMalfunction:${weaponId}`,
      tiers: 2,
    });
    expect(applied.applications[0].after).toBe("major");
    expect(state.weapons[weaponId]).toMatchObject({
      status: "online",
      mode: "nominal",
      readiness: 20,
    });

    expect(getPowerState(config, state).weaponReserved).toBe(3);
    expect(applyPowerShedding(config, state).weaponReserved).toBe(3);

    const before = clone(state);
    captureViolation(
      () =>
        commitPowerRoute(
          config,
          state,
          clone({ weaponStates: { [weaponId]: "overclock" } }),
        ),
      "WEAPON_OVERCLOCK_BLOCKED",
    );
    expect(state).toEqual(before);
  });

  test("Route Power stages only status, mode, and bootCounter", () => {
    const { config, state } = freshShip();
    const weaponId = CANADENSIS_IDS.portMacrocannon;
    const before = clone(state);

    captureViolation(
      () =>
        commitPowerRoute(
          config,
          state,
          clone({
            weaponStates: {
              [weaponId]: { status: "online", readiness: 99, reloadProgress: 7 },
            },
          }),
        ),
      "INVALID_WEAPON_INPUT",
    );
    expect(state).toEqual(before);

    commitPowerRoute(
      config,
      state,
      clone({
        weaponStates: {
          [weaponId]: { status: "off", mode: "nominal", bootCounter: 0 },
        },
      }),
    );
    expect(state.weapons[weaponId]).toEqual({
      status: "off",
      mode: "nominal",
      bootCounter: 0,
      readiness: 20,
      reloadProgress: 0,
      reloadWork: null,
    });
  });

  test("a stale power allocation degrades during passive inspection instead of rejecting every operation", () => {
    const { config, state } = freshShip();
    state.power.shields = 9;

    expect(getPowerState(config, state).allocation.shields).toBe(9);
    const shed = applyPowerShedding(config, state);
    expect(shed.committed).toBeLessThanOrEqual(shed.ceilings.maximum);

    captureViolation(
      () =>
        commitPowerRoute(
          config,
          state,
          clone({ allocation: { shields: 9 } }),
        ),
      "INVALID_POWER_TIER",
    );
  });
});

test("Power commits persist allocations and validated shedding priorities", () => {
  const { config, state } = freshShip();
  const allocation = {
    engines: 4,
    shields: 1,
    sensors: 2,
    cooling: 1,
    inertia: 2,
    weapons: 4,
  };
  const sheddingPriority = [
    "weapons",
    "cooling",
    "inertia",
    "shields",
    "sensors",
    "engines",
  ];
  const weaponPriority = [...config.weaponPriority].reverse();

  const result = commitPowerRoute(
    config,
    state,
    clone({
      allocation,
      sheddingPriority,
      weaponPriority,
    }),
  );

  expect(result.allocation).toEqual(allocation);
  expect(state.power).toMatchObject(allocation);
  expect(state.sheddingPriority).toEqual(sheddingPriority);
  expect(state.weaponPriority).toEqual(weaponPriority);

  captureViolation(
    () =>
      commitPowerRoute(
        config,
        state,
        clone({
          allocation,
          sheddingPriority: [
            "engines",
            "engines",
            "sensors",
            "cooling",
            "inertia",
            "weapons",
          ],
        }),
      ),
    "INVALID_POWER_PRIORITY",
  );
});

describe("shield allocation, collapse, and recovery", () => {
  test("integer regeneration uses stable directional tie-breaking", () => {
    expect(
      allocateRegeneration(
        3,
        clone({ fore: 25, port: 25, starboard: 25, aft: 25 }),
      ),
    ).toEqual({
      fore: 1,
      port: 1,
      starboard: 1,
      aft: 0,
    });
  });

  test("regeneration allocation allows unassigned points and apportions allocated budget", () => {
    // 95% assigned (19 pips, 1 unassigned pip): target is Math.round(8 * 95 / 100) = 8
    expect(
      allocateRegeneration(8, { fore: 25, port: 25, starboard: 25, aft: 20 }),
    ).toEqual({ fore: 2, port: 2, starboard: 2, aft: 2 });

    // 75% assigned (15 pips, 5 unassigned): target is Math.round(8 * 75 / 100) = 6
    expect(
      allocateRegeneration(8, { fore: 25, port: 25, starboard: 25, aft: 0 }),
    ).toEqual({ fore: 2, port: 2, starboard: 2, aft: 0 });

    // 0% assigned: all 0
    expect(
      allocateRegeneration(8, { fore: 0, port: 0, starboard: 0, aft: 0 }),
    ).toEqual({ fore: 0, port: 0, starboard: 0, aft: 0 });

    // Exceeding 100% throws violation
    captureViolation(
      () => allocateRegeneration(8, { fore: 30, port: 30, starboard: 30, aft: 20 }),
      "INVALID_REGENERATION_TOTAL",
    );
  });

  test("defense routing allows committing without assigning all regen points", () => {
    const { config, state } = freshShip();
    const staged = {
      regenerationAllocation: { fore: 25, port: 25, starboard: 25, aft: 20 },
    };

    const preview = previewDefenseRoute(config, state, staged);
    expect(preview.regenerationAllocation).toEqual(staged.regenerationAllocation);

    const committed = commitDefenseRoute(config, state, staged);
    expect(committed.regenerationAllocation).toEqual(staged.regenerationAllocation);
    expect(state.shields.regenerationAllocation).toEqual(staged.regenerationAllocation);

    // Turn start shield regeneration applies cleanly with unassigned weights
    state.power.shields = 3;
    const regeneration = applyShieldRegeneration(config, state);
    expect(regeneration.assigned).toEqual({ fore: 2, port: 2, starboard: 2, aft: 2 });

    // Staging weights above 100% still fails validation
    captureViolation(
      () =>
        previewDefenseRoute(config, state, {
          regenerationAllocation: { fore: 30, port: 30, starboard: 30, aft: 20 },
        }),
      "INVALID_REGENERATION_TOTAL",
    );
  });

  test("a fresh shield commits hp, allocation, weights, and zero counters", () => {
    const { state } = freshShip();

    expect(state.shields).toEqual({
      hp: { fore: 15, port: 15, starboard: 15, aft: 15 },
      allocation: { fore: 15, port: 15, starboard: 15, aft: 15 },
      regenerationAllocation: { fore: 25, port: 25, starboard: 25, aft: 25 },
      collapse: { fore: 0, port: 0, starboard: 0, aft: 0 },
    });
  });

  test("regeneration raises hp toward the allocation ceiling and loses the excess", () => {
    const { config, state } = freshShip();
    state.power.shields = 3;
    state.shields.allocation = { fore: 4, port: 20, starboard: 20, aft: 1 };
    state.shields.hp = { fore: 4, port: 0, starboard: 0, aft: 0 };

    const regeneration = applyShieldRegeneration(config, state);

    expect(regeneration.assigned).toEqual({ fore: 2, port: 2, starboard: 2, aft: 2 });
    // Fore is already at its ceiling and aft can hold only one point: both shares are lost.
    expect(regeneration.gains).toEqual({ fore: 0, port: 2, starboard: 2, aft: 1 });
    expect(regeneration.regenerated).toBe(5);
    expect(regeneration.losses).toEqual([
      { sector: "fore", amount: 2, reason: "sectorCapacity" },
      { sector: "aft", amount: 1, reason: "sectorCapacity" },
    ]);
    expect(state.shields.hp).toEqual({ fore: 4, port: 2, starboard: 2, aft: 1 });
    expect(state.shields.allocation).toEqual({ fore: 4, port: 20, starboard: 20, aft: 1 });

    // hp stops at the committed ceiling, never at the 24-point emitter capacity.
    const clamping = applyShieldCapacityClamping(config, state);
    expect(clamping.capacities).toEqual({ fore: 24, port: 24, starboard: 24, aft: 24 });
    expect(clamping).toMatchObject({ totalAllocation: 45, totalHp: 9, losses: [] });
  });

  test("an emitter-damaged sector still regenerates the minimum one point of its share", () => {
    const { config, state } = freshShip();
    state.power.shields = 2;
    state.shields.hp = { fore: 0, port: 0, starboard: 0, aft: 0 };
    state.conditions.portEmitter = emitterFault(config, "port", "major");

    const regeneration = applyShieldRegeneration(config, state);

    expect(regeneration.assigned).toEqual({ fore: 1, port: 1, starboard: 1, aft: 1 });
    // Port's one-point share rounds below one against the Major 0.5 multiplier and is lifted to 1.
    expect(regeneration.gains).toEqual({ fore: 1, port: 1, starboard: 1, aft: 1 });
    expect(state.shields.hp).toEqual({ fore: 1, port: 1, starboard: 1, aft: 1 });
  });

  test("committed allocation above current hp survives a Start with no regeneration", () => {
    const { config, state } = freshShip();
    state.phase = "start";
    state.power.shields = 1;
    state.shields.allocation = { fore: 20, port: 20, starboard: 20, aft: 0 };
    state.shields.hp = { fore: 5, port: 5, starboard: 5, aft: 0 };

    const start = runStartPhase(config, state);
    const shields = start.events.find((event) => event.type === "shieldRegeneration");

    expect(shields.regeneration.gains).toEqual({ fore: 0, port: 0, starboard: 0, aft: 0 });
    expect(shields.regeneration.regenerated).toBe(0);
    expect(shields.clamping).toMatchObject({ totalAllocation: 60, totalHp: 15, losses: [] });
    expect(state.phase).toBe("active");
    expect(state.shields.allocation).toEqual({ fore: 20, port: 20, starboard: 20, aft: 0 });
    expect(state.shields.hp).toEqual({ fore: 5, port: 5, starboard: 5, aft: 0 });
  });

  test("defense routing re-allocates ceilings freely and clamps hp on a lowered sector", () => {
    const { config, state } = freshShip();
    const staged = { allocation: { fore: 10, port: 20, starboard: 15, aft: 15 } };

    const preview = previewDefenseRoute(config, state, staged);
    expect(preview.allocation).toEqual(staged.allocation);
    expect(preview.hp).toEqual({ fore: 10, port: 15, starboard: 15, aft: 15 });
    expect(preview.regenerationAllocation).toEqual({
      fore: 25,
      port: 25,
      starboard: 25,
      aft: 25,
    });
    expect(preview.totalAllocation).toBe(60);
    expect(preview.totalHp).toBe(55);
    expect(preview.capacityLosses).toEqual([
      { sector: "fore", amount: 5, reason: "sectorCapacity" },
    ]);
    expect(state.shields.allocation).toEqual({ fore: 15, port: 15, starboard: 15, aft: 15 });

    expect(commitDefenseRoute(config, state, staged).allocation).toEqual(staged.allocation);
    expect(state.shields.allocation).toEqual(staged.allocation);
    expect(state.shields.hp).toEqual({ fore: 10, port: 15, starboard: 15, aft: 15 });
    expect(state.shields.collapse.fore).toBe(0);

    // Lowering a ceiling without raising another is legal: the excess is lost, never transferred.
    const lowered = commitDefenseRoute(config, state, { allocation: { fore: 5 } });
    expect(lowered.totalAllocation).toBe(55);
    expect(state.shields.hp).toEqual({ fore: 5, port: 15, starboard: 15, aft: 15 });
    expect(state.shields.collapse.fore).toBe(0);
    expect(state.shields.collapse.port).toBe(0);
  });

  test("defense routing rejects staged ceilings above the budget or a sector cap", () => {
    const { config, state } = freshShip();
    const before = clone(state.shields);

    captureViolation(
      () =>
        previewDefenseRoute(config, state, {
          allocation: { fore: 24, port: 24, starboard: 24, aft: 24 },
        }),
      "SHIELD_TOTAL_BUDGET_EXCEEDED",
    );
    captureViolation(
      () => previewDefenseRoute(config, state, { allocation: { fore: 25 } }),
      "SHIELD_SECTOR_CAP_EXCEEDED",
    );
    expect(state.shields).toEqual(before);

    const exact = previewDefenseRoute(config, state, {
      allocation: { fore: 24, port: 12, starboard: 12, aft: 12 },
    });
    expect(exact.totalAllocation).toBe(60);
  });

  test("defense routing refuses to raise a collapsed or emitter-destroyed sector", () => {
    const collapsed = freshShip();
    collapsed.state.shields.collapse.fore = 1;

    captureViolation(
      () =>
        previewDefenseRoute(collapsed.config, collapsed.state, { allocation: { fore: 16 } }),
      "SHIELD_SECTOR_INELIGIBLE",
    );
    expect(
      previewDefenseRoute(collapsed.config, collapsed.state, { allocation: { fore: 10 } })
        .allocation.fore,
    ).toBe(10);

    const destroyed = freshShip();
    destroyed.state.conditions.foreEmitter = emitterFault(destroyed.config, "fore");
    expect(previewDefenseRoute(destroyed.config, destroyed.state, {}).capacities.fore).toBe(0);

    captureViolation(
      () =>
        previewDefenseRoute(destroyed.config, destroyed.state, { allocation: { fore: 5 } }),
      "SHIELD_SECTOR_CAP_EXCEEDED",
    );
  });

  test("damage reduces hp only and collapses an active sector at zero", () => {
    const { config, state } = freshShip();
    state.power.shields = 2;
    const allocation = clone(state.shields.allocation);

    const glancing = resolveShieldDamage(config, state, {
      sector: "fore",
      shieldDamage: 5,
      hullDamage: 40,
      heatDamage: 4,
    });
    expect(glancing).toMatchObject({
      collapsed: false,
      shieldBefore: 15,
      shieldAfter: 10,
      penetratingFraction: 0,
      transmittedHull: 0,
      transmittedHeat: 0,
    });
    expect(state.shields.hp.fore).toBe(10);
    expect(state.shields.collapse.fore).toBe(0);

    const collapse = resolveShieldDamage(config, state, { sector: "fore", shieldDamage: 10 });
    expect(collapse).toMatchObject({
      collapsed: true,
      shieldBefore: 10,
      shieldAfter: 0,
      penetratingFraction: 0.4,
      rechargeCounter: 1,
    });
    expect(state.shields.hp).toEqual({ fore: 0, port: 15, starboard: 15, aft: 15 });
    expect(state.shields.allocation).toEqual(allocation);
    expect(state.shields.collapse).toEqual({ fore: 1, port: 0, starboard: 0, aft: 0 });
  });

  test("emitter damage clamps the ceiling to the scaled Max and destroy zeroes both fields", () => {
    const { config, state } = freshShip();
    state.power.shields = 2;
    state.shields.allocation = { fore: 20, port: 14, starboard: 14, aft: 12 };
    state.shields.hp = { fore: 20, port: 14, starboard: 14, aft: 12 };
    const conditionId = conditionKey(
      config.criticalPools.fore.find((entry) => entry.channelId === "shieldEmitterDamage"),
    );

    applyConditionTiers(config, state, { conditionId, tiers: 2 });
    expect(state.shields.allocation).toEqual({ fore: 12, port: 14, starboard: 14, aft: 12 });
    expect(state.shields.hp).toEqual({ fore: 12, port: 14, starboard: 14, aft: 12 });

    applyConditionTiers(config, state, { conditionId, tiers: 1 });
    expect(state.shields.allocation.fore).toBe(6);
    expect(state.shields.hp.fore).toBe(6);

    applyConditionTiers(config, state, { conditionId, tiers: 1 });
    expect(state.shields.allocation.fore).toBe(0);
    expect(state.shields.hp.fore).toBe(0);

    const recovered = recoverShieldEmitter(config, state, "fore");
    expect(recovered).toMatchObject({
      recovered: true,
      hp: 0,
      collapsed: true,
      rechargeCounter: 1,
      capacity: 6,
    });
    expect(state.shields.hp.fore).toBe(0);
    expect(state.shields.collapse.fore).toBe(1);
    // Recovery keeps the committed ceiling: it must be re-routed before it can hold hp again.
    expect(state.shields.allocation.fore).toBe(0);

    const clamping = applyShieldCapacityClamping(config, state);
    expect(clamping.capacities.fore).toBe(6);
    expect(clamping.allocation.fore).toBe(0);
    expect(clamping.hp.fore).toBe(0);
    expect(clamping).toMatchObject({ totalAllocation: 40, totalHp: 40, losses: [] });
  });

  test("collapsed and destroyed directional emitters lose their shares until recovery", () => {
    const { config, state } = freshShip();
    state.power.shields = 2;
    state.shields.hp = { fore: 0, port: 0, starboard: 0, aft: 0 };
    state.shields.regenerationAllocation = {
      fore: 25,
      port: 25,
      starboard: 25,
      aft: 25,
    };
    state.shields.collapse = { fore: 1, port: 0, starboard: 0, aft: 0 };
    state.conditions.portEmitter = emitterFault(config, "port");

    const blocked = applyShieldRegeneration(config, state);
    expect(blocked.assigned).toEqual({
      fore: 1,
      port: 1,
      starboard: 1,
      aft: 1,
    });
    expect(blocked.gains).toEqual({ fore: 0, port: 0, starboard: 1, aft: 1 });
    expect(blocked.losses).toEqual(expect.arrayContaining([
      { sector: "fore", amount: 1, reason: "collapsed" },
      { sector: "port", amount: 1, reason: "destroyed" },
    ]));
    expect(state.shields.hp).toEqual({ fore: 0, port: 0, starboard: 1, aft: 1 });
    expect(state.shields.allocation).toEqual({ fore: 15, port: 0, starboard: 15, aft: 15 });

    state.shields.collapse.port = 1;

    expect(tickShieldRecharge(config, state).events).toEqual([
      { sector: "fore", from: 1, to: 0, reactivated: true },
    ]);
    expect(state.shields.collapse.port).toBe(1);

    const recovered = recoverShieldEmitter(config, state, "port");
    expect(recovered).toMatchObject({
      recovered: true,
      sector: "port",
      from: "destroyed",
      to: "critical",
      hp: 0,
      collapsed: true,
      rechargeCounter: 1,
      capacity: 6,
    });
    expect(state.shields.hp.port).toBe(0);
    expect(state.shields.collapse.port).toBe(1);
    expect(state.shields.allocation.port).toBe(0);

    expect(tickShieldRecharge(config, state).events).toEqual([
      { sector: "port", from: 1, to: 0, reactivated: true },
    ]);

    // Port's funnel stays legal: the hull caps one sector at 50 %, and Shields Power 3 doubles the
    // budget so the same 50 % share still hands port its four assigned points.
    state.power.shields = 3;
    state.shields.regenerationAllocation = {
      fore: 0,
      port: 50,
      starboard: 0,
      aft: 0,
    };
    expect(commitDefenseRoute(config, state, { allocation: { port: 6 } }).allocation.port).toBe(6);

    const restored = applyShieldRegeneration(config, state);
    expect(restored.assigned.port).toBe(4);
    expect(restored.gains.port).toBe(1);
    expect(state.shields.hp.port).toBe(1);
    expect(state.shields.allocation.port).toBe(6);
  });

  // The contract: the hull caps how much regeneration one sector may claim, so a single funnel
  // cannot out-heal sustained fire. The cap is inclusive, and 100 opts back out of it.
  test("the hull's regeneration weight cap is an inclusive per-sector ceiling", () => {
    const { config, state } = freshShip();
    expect(config.regenerationWeightCap).toBe(50);

    const atCap = previewDefenseRoute(config, state, {
      regenerationAllocation: { fore: 50, port: 50, starboard: 0, aft: 0 },
    });
    expect(atCap.regenerationAllocation).toEqual({ fore: 50, port: 50, starboard: 0, aft: 0 });

    const overCap = captureViolation(
      () =>
        previewDefenseRoute(config, state, {
          regenerationAllocation: { fore: 51, port: 49, starboard: 0, aft: 0 },
        }),
      "INVALID_REGENERATION_ALLOCATION",
    );
    expect(overCap.details).toEqual({ sector: "fore", weight: 51, cap: 50 });

    const uncapped = previewDefenseRoute({ ...config, regenerationWeightCap: 100 }, state, {
      regenerationAllocation: { fore: 100, port: 0, starboard: 0, aft: 0 },
    });
    expect(uncapped.regenerationAllocation).toEqual({ fore: 100, port: 0, starboard: 0, aft: 0 });
  });

  test("a bubble maps directional impacts to one field, then recharges and regenerates", () => {
    const { config, state } = freshShip((draft) => {
      draft.components.shield.topology = "bubble";
      draft.components.shield.sectors = ["bubble"];
      draft.components.shield.emitters = [{
        id: `${draft.components.shield.id}:bubble`,
        sector: "bubble",
        regions: ["fore", "port", "starboard", "aft"],
      }];
      delete draft.components.shield.sectorCap;
    });
    expect(state.shields).toEqual({
      hp: { bubble: 60 },
      allocation: { bubble: 60 },
      regenerationAllocation: { bubble: 100 },
      collapse: { bubble: 0 },
    });

    state.power.shields = 2;
    state.shields.hp.bubble = 10;
    expect(applyShieldCapacityClamping(config, state).capacities).toEqual({ bubble: 60 });

    const impact = resolveShieldDamage(
      config,
      state,
      clone({
        sector: "fore",
        shieldDamage: 25,
        hullDamage: 10,
        heatDamage: 5,
        armorPiercing: 1,
      }),
    );

    expect(impact).toMatchObject({
      sector: "bubble",
      armorSector: "fore",
      collapsed: true,
      penetratingFraction: 0.6,
      transmittedHull: 6,
      transmittedHeat: 3,
      armor: 3,
      effectiveArmor: 2,
      hullDamageTaken: 4,
      hullAfter: 46,
      heatAfter: 3,
      rechargeCounter: 1,
    });
    expect(state.shields.hp).toEqual({ bubble: 0 });
    expect(state.shields.allocation).toEqual({ bubble: 60 });

    expect(tickShieldRecharge(config, state).events).toEqual([
      { sector: "bubble", from: 1, to: 0, reactivated: true },
    ]);
    // The single bubble slot always regenerates at its fixed full weight.
    state.shields.regenerationAllocation = { bubble: 0 };
    const regeneration = applyShieldRegeneration(config, state);
    expect(regeneration.assigned).toEqual({ bubble: 4 });
    expect(regeneration.gains).toEqual({ bubble: 4 });
    expect(state.shields.hp).toEqual({ bubble: 4 });
  });
});

describe("ordered lifecycle transactions", () => {
  test("dispatcher Start runs the ordered batch and ticks only entry counters once", () => {
    const record = freshShip();
    record.state.phase = "start";
    record.state.heat = 10;
    record.state.ventCooldown = 2;
    record.state.weapons[CANADENSIS_IDS.railgun].status = "booting";
    record.state.weapons[CANADENSIS_IDS.railgun].bootCounter = 2;
    const authority = gmContext(record);
    const before = clone(authority.ships[SOURCE].state);

    const result = executeShipOperation(
      gmRequest("phase.start", { turnKey: "round-1" }),
      authority,
    );
    const events = result.gmEvents[0].detail.events;

    expect(events.map(({ step, type }) => [step, type])).toEqual([
      [0, "openingHousekeeping"],
      [1, "passiveCooling"],
      [2, "maintainedOverclockHeat"],
      [3, "shieldRecharge"],
      [4, "shieldRegeneration"],
      [5, "weaponBoot"],
      [6, "weaponReadiness"],
      [7, "beneficialSystems"],
      [8, "turnReset"],
      [9, "trackRefresh"],
    ]);
    expect(events[5].events).toEqual([
      { weaponId: CANADENSIS_IDS.railgun, from: 2, to: 1, becameOnline: false },
    ]);
    expect(events[7].counters).toEqual({ ventCooldown: { from: 2, to: 1 } });
    expect(result.shipStates[SOURCE]).toMatchObject({
      phase: "active",
      turnKey: "round-1",
      heat: 6,
      ventCooldown: 1,
    });
    expect(result.shipStates[SOURCE].weapons[CANADENSIS_IDS.railgun])
      .toMatchObject({
        status: "booting",
        bootCounter: 1,
      });
    expect(result.publicEvents).toEqual([]);
    expect(result.gmEvents).toHaveLength(1);
    expect(authority.ships[SOURCE].state).toEqual(before);

    const nextAuthority = gmContext({
      config: clone(record.config),
      state: clone(result.shipStates[SOURCE]),
    });
    nextAuthority.ships[SOURCE].state.phase = "start";
    const next = executeShipOperation(
      gmRequest("phase.start", { turnKey: "round-2" }),
      nextAuthority,
    );
    expect(next.gmEvents[0].detail.events[5].events).toEqual([
      { weaponId: CANADENSIS_IDS.railgun, from: 1, to: 0, becameOnline: true },
    ]);
    expect(next.gmEvents[0].detail.events[7].counters).toEqual({
      ventCooldown: { from: 1, to: 0 },
    });
    expect(next.shipStates[SOURCE].weapons[CANADENSIS_IDS.railgun])
      .toMatchObject({
        status: "online",
        bootCounter: 0,
      });
  });

  test("an empty loadout completes the passive combat lifecycle without component errors", () => {
    const record = freshShip((config) => {
      config.components = { drives: {}, weapons: [] };
      config.weaponPriority = [];
    });
    const phases = [];
    const operations = [
      ["combat.enter", { turnKey: "round-empty" }],
      ["phase.start", { turnKey: "round-empty" }],
      ["coast", {}],
      ["phase.end", { endKey: "round-empty" }],
      ["combat.leave", {}],
    ];

    for (const [type, payload] of operations) {
      const result = executeShipOperation(
        gmRequest(type, payload),
        gmContext(record),
      );
      record.state = clone(result.shipStates[SOURCE]);
      phases.push(record.state.phase);
    }

    expect(phases).toEqual([
      "start",
      "active",
      "end",
      "start",
      "outsideCombat",
    ]);
    expect(record.state).toMatchObject({
      hull: record.config.maxHull,
      heat: 0,
    });
  });

  test("End completes every ordered step after Hull reaches zero and resolves Fate last", () => {
    const { config, state } = freshShip();
    state.phase = "end";
    state.hull = 1;
    state.heat = 25;
    state.velocity = { x: 31, y: 0 };
    state.effects = [
      {
        id: "zeta",
        timing: "end",
        expiresAt: "end",
        harmful: true,
        hullDamage: 2,
        heat: 2,
      },
      {
        id: "alpha",
        timing: "end",
        expiresAt: "end",
        harmful: true,
        hullDamage: 2,
        heat: 1,
      },
    ];

    const result = runEndPhase(
      config,
      state,
      clone({ random: [0], endKey: "round-1" }),
    );

    expect(result.events.map(({ step, type }) => [step, type])).toEqual([
      [1, "overspeedDamage"],
      [2, "hazardHeatPower"],
      [3, "hazardDamage"],
      [4, "hazardClocks"],
      [5, "heatOverflow"],
      [6, "persistentEffects"],
      ["afterEnd", "shipFate"],
    ]);
    expect(result.events[0]).toMatchObject({
      beforeHull: 1,
      hullDamage: 2,
      hull: 0,
    });
    expect(result.events[4]).toMatchObject({
      overflow: 5,
      hullDamage: 3,
      beforeHull: 0,
      hull: 0,
    });
    expect(result.events[5].applied.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.events.at(-1).public).toEqual({
      status: "pending",
      outcome: null,
      reason: "important",
    });
    expect(state).toMatchObject({
      phase: "start",
      hull: 0,
      heat: 28,
      pendingFate: { status: "pending", outcome: null, reason: "important" },
      effects: [],
    });
  });

  test("End rewinds to Start with no retained turn key, so the next Start is accepted", () => {
    const { config, state } = freshShip();
    state.phase = "end";
    state.turnKey = "round-7";

    runEndPhase(config, state, clone({ random: [0], endKey: "round-7" }));

    expect(state).toMatchObject({ phase: "start", turnKey: null });

    runStartPhase(config, state, clone({ turnKey: "round-8" }));
    expect(state).toMatchObject({ phase: "active", turnKey: "round-8" });
  });

  test("a rewound Start replays the turn without repeating opening housekeeping", () => {
    const { config, state } = freshShip();
    state.phase = "end";
    state.turnKey = "round-7";
    runEndPhase(config, state, clone({ random: [0], endKey: "round-7" }));
    expect(state).toMatchObject({
      phase: "start",
      turnKey: null,
      completedTurnKey: "round-7",
    });

    state.heat = 20;
    for (const sector of Object.keys(state.shields.hp)) state.shields.hp[sector] = 1;
    const before = clone(state);

    const result = runStartPhase(config, state, clone({ turnKey: "round-7" }));

    expect(state).toMatchObject({
      phase: "active",
      turnKey: "round-7",
      completedTurnKey: null,
    });
    expect(state.heat).toBe(before.heat);
    expect(state.shields.hp).toEqual(before.shields.hp);
    // A replay restores the turn's pools; that is the point of replaying the turn.
    expect(Object.keys(state.resources.actions ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(state.resources.orders ?? {}).length).toBeGreaterThan(0);
    expect(result.events.at(-1)).toMatchObject({
      type: "turnReset",
      replay: true,
    });
  });

  test("a Start for a new turn still applies opening housekeeping", () => {
    const { config, state } = freshShip();
    state.phase = "end";
    state.turnKey = "round-7";
    runEndPhase(config, state, clone({ random: [0], endKey: "round-7" }));

    state.heat = 20;
    for (const sector of Object.keys(state.shields.hp)) state.shields.hp[sector] = 1;

    runStartPhase(config, state, clone({ turnKey: "round-8" }));

    expect(state.phase).toBe("active");
    expect(state.completedTurnKey).toBeNull();
    expect(Object.values(state.shields.hp).some((hp) => hp > 1)).toBe(true);
  });

  test("an injected mid-Start failure rolls back both the lifecycle transaction and dispatcher input", () => {
    const record = freshShip((config) => {
      config.components.cooling.tiers.find(({ power }) => power === 1).cooling =
        -1;
    });
    record.state.phase = "start";
    record.state.heat = 9;
    record.state.effects = [{ id: "expires", expiresAt: "nextStart" }];
    record.state.evasion = { armed: true, reserved: 0.2 };
    const authority = gmContext(record);
    const before = clone(authority.ships[SOURCE].state);

    captureViolation(
      () =>
        executeShipOperation(
          gmRequest("phase.start", { turnKey: "round-failure" }),
          authority,
        ),
      "INVALID_COOLING_OUTPUT",
    );

    expect(authority.ships[SOURCE].state).toEqual(before);
  });
});

test("registered hooks repair mixed synthetic data, retry failed startup, and grant each turn once", async () => {
  const { MODULE_ID, SHIP_TYPE } = await import("../scripts/constants.js");
  const { createDefaultShipSystemData } = await import(
    "../scripts/model/defaults.js"
  );
  const { CANADENSIS_DEFAULT_COMPONENT_SOURCES } = await import(
    "../scripts/data/canadensis-components.js"
  );
  const globals = [
    "game",
    "foundry",
    "Hooks",
    "ui",
    "CONST",
    "Item",
    "fromUuid",
  ];
  const previous = Object.fromEntries(
    globals.map((key) => [key, globalThis[key]]),
  );
  const errors = [];
  const notices = [];
  const callbacks = new Map();
  const hooks = {
    on(event, callback) {
      const list = callbacks.get(event) ?? [];
      list.push(callback);
      callbacks.set(event, list);
    },
    callAll(event, ...args) {
      for (const callback of callbacks.get(event) ?? []) callback(...args);
    },
  };
  class Collection extends Map {
    get contents() {
      return [...this.values()];
    }
    [Symbol.iterator]() {
      return this.values();
    }
    filter(callback) {
      return this.contents.filter(callback);
    }
  }
  class Replacement {
    constructor(value) {
      this.value = value;
    }
    static create(value) {
      return new Replacement(value);
    }
  }
  function assign(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    for (const key of keys) object = object[key] ??= {};
    object[last] = clone(value instanceof Replacement ? value.value : value);
  }
  const gm = { id: "lifecycle-gm", active: true, isGM: true };
  const users = new Collection([[gm.id, gm]]);
  users.activeGM = gm;
  const scene = {
    id: "lifecycle-hooks",
    grid: { size: 100, distance: 1 },
    tokens: new Collection(),
    walls: new Collection(),
  };
  function actor(id) {
    const ship = createDefaultShipSystemData();
    ship.state.phase = "start";
    ship.state.revision = 63;
    ship.state.heat = 9;
    return {
      id,
      name: id,
      uuid: `Actor.${id}`,
      documentName: "Actor",
      type: SHIP_TYPE,
      ownership: { default: 0 },
      flags: {},
      system: { shipCombat: clone(ship) },
      _source: { system: { shipCombat: clone(ship) } },
      items: new Collection(
        CANADENSIS_DEFAULT_COMPONENT_SOURCES.map((
          item,
        ) => [item._id, clone(item)]),
      ),
      async update(changes, options) {
        expect(options.viraShipCombatInternal).toBe(true);
        for (const [path, value] of Object.entries(changes)) {
          assign(this, path, value);
          assign(this._source, path, value);
        }
        hooks.callAll("updateActor", this, changes, options, gm.id);
        await Promise.resolve();
        return this;
      },
      async createEmbeddedDocuments() {
        throw new Error(
          "Mixed-data repair must never install default components",
        );
      },
    };
  }
  const source = actor("mixed-synthetic");
  const other = actor("template-peer");
  const world = actor("world-base");
  const legacy = {
    drive: { id: "canadensis-drive", customSetting: 42 },
    weapons: [{ id: "canadensis-twin-railgun" }],
  };
  source.system.shipCombat.config.components = clone(legacy);
  source._source.system.shipCombat.config.components = clone(legacy);
  const originalState = clone(source.system.shipCombat.state);
  function token(id, shipActor) {
    const document = {
      id,
      uuid: `Scene.${scene.id}.Token.${id}`,
      name: shipActor.name,
      documentName: "Token",
      actor: shipActor,
      parent: scene,
      x: 0,
      y: 0,
      rotation: 0,
      width: 1,
      height: 1,
      async update(changes) {
        Object.assign(this, changes);
        return this;
      },
    };
    scene.tokens.set(id, document);
    return document;
  }
  const sourceToken = token("source", source);
  token("other", other);
  source.uuid = `${sourceToken.uuid}.Actor.${source.id}`;
  const combatant = { id: "current", token: sourceToken };
  const combat = {
    id: "registered-hooks",
    round: 1,
    turn: 0,
    combatant,
    current: { combatantId: combatant.id },
    combatants: new Collection([[combatant.id, combatant]]),
  };
  combatant.parent = combat;
  async function settled(predicate, label) {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!predicate()) {
      throw new Error(
        `${label}: hook/authority work did not settle; notifications=${
          JSON.stringify(errors)
        }`,
      );
    }
  }
  try {
    globalThis.Hooks = hooks;
    // Foundry exposes Actor/Item as globals; sheet registration dereferences them.
    globalThis.Item = class Item {};
    globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2 } };
    globalThis.ui = {
      notifications: {
        error: (message) => errors.push(message),
        info: (message) => notices.push(message),
      },
    };
    globalThis.foundry = {
      applications: { apps: { DocumentSheetConfig: { registerSheet() {} } } },
      utils: { deepClone: clone, escapeHTML: (value) => String(value) },
      data: { operators: { ForcedReplacement: Replacement } },
      documents: {
        ChatMessage: {
          implementation: {
            getSpeaker: () => ({}),
            createDocuments: async (messages) => messages,
          },
        },
      },
    };
    globalThis.game = {
      user: gm,
      users,
      actors: new Collection([[world.id, world], [other.id, other]]),
      scenes: new Collection([[scene.id, scene]]),
      combats: new Collection([[combat.id, combat]]),
      socket: { on() {} },
    };
    globalThis.fromUuid = async (uuid) =>
      scene.tokens.contents.find((entry) => entry.uuid === uuid);
    const { initializeShipActor } = await import(
      "../scripts/foundry/initialization.js"
    );
    const existingBackup = { reactor: { id: "other-legacy-reactor" } };
    source.flags[MODULE_ID] = { legacyInlineComponents: clone(existingBackup) };
    await expect(initializeShipActor(source)).rejects.toThrow(
      "different legacy component backup",
    );
    expect(source.flags[MODULE_ID].legacyInlineComponents).toEqual(
      existingBackup,
    );
    expect(source.system.shipCombat.state).toEqual(originalState);
    expect(source.system.shipCombat.config.components).toEqual(legacy);
    delete source.flags[MODULE_ID].legacyInlineComponents;
    const missingId = source.system.shipCombat.config.slots[0].itemId;
    const missing = source.items.get(missingId);
    source.items.delete(missingId);
    const { registerShipHooks } = await import(
      "../scripts/foundry/hooks.js?registered-lifecycle-regression"
    );
    registerShipHooks();
    await settled(
      () => errors.some((message) => message.includes("combat.enter")),
      "failed startup notification",
    );
    expect(errors.some((message) => message.includes(sourceToken.uuid))).toBe(
      true,
    );
    expect(source.system.shipCombat.state).toEqual(originalState);
    expect(source.system.shipCombat.config.components).toEqual(legacy);
    expect(source.flags[MODULE_ID]?.legacyInlineComponents).toBeUndefined();
    expect(source._source.system.shipCombat.state).toEqual(originalState);

    source.items.set(missingId, missing);
    hooks.callAll("updateCombat", combat, {}, {}, gm.id);
    await settled(
      () => source.system.shipCombat.state.phase === "active",
      "repaired startup",
    );
    expect(source.system.shipCombat.config.components).toBeUndefined();
    expect(source.flags[MODULE_ID].legacyInlineComponents).toEqual(legacy);
    expect(notices).toHaveLength(1);
    expect(other.system.shipCombat.state.resources).toEqual({
      actions: {},
      orders: {},
    });
    const actions = source.system.shipCombat.state.resources.actions;
    const operator = Object.keys(actions)[0];
    expect(actions[operator]).toBeGreaterThan(0);
    actions[operator] = 0;
    const committedRevision = source.system.shipCombat.state.revision;
    hooks.callAll("updateCombat", combat, {}, {}, gm.id);
    hooks.callAll("combatTurnChange", combat);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(source.system.shipCombat.state.resources.actions[operator]).toBe(0);
    expect(source.system.shipCombat.state.revision).toBe(committedRevision);
    combat.round = 2;
    hooks.callAll("updateCombat", combat, { round: 2 }, {}, gm.id);
    await settled(
      () =>
        source.system.shipCombat.state.turnKey ===
          `${combat.id}:2:${combatant.id}`,
      "round transition",
    );
    expect(source.system.shipCombat.state.resources.actions[operator])
      .toBeGreaterThan(0);
    expect(notices).toHaveLength(1);
    expect(source.flags[MODULE_ID].legacyInlineComponents).toEqual(legacy);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const key of globals) globalThis[key] = previous[key];
  }
});
