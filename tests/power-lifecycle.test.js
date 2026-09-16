import { describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import { createDefaultShipData, createInitialState } from "../scripts/model/defaults.js";
import { executeShipOperation } from "../scripts/rules/operations.js";
import {
  applyMaintainedOverclockHeat,
  applyPowerShedding,
  commitPowerRoute,
  previewPowerRoute,
} from "../scripts/rules/power.js";
import {
  allocateRegeneration,
  applyShieldRegeneration,
  recoverShieldEmitter,
  resolveShieldDamage,
  tickShieldRecharge,
} from "../scripts/rules/shields.js";
import { runEndPhase } from "../scripts/rules/lifecycle.js";

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

describe("Power routing and weapon lifecycle", () => {
  test("Power routing accepts only installed integer tiers and fails atomically", () => {
    const { config, state } = freshShip();
    const before = clone(state);

    captureViolation(
      () => commitPowerRoute(config, state, clone({ allocation: { engines: 2.5, sensors: 1 } })),
      "INVALID_POWER_ALLOCATION",
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
    expect(legal.state.weapons[CANADENSIS_IDS.portMacrocannon].status).toBe("off");

    const illegal = freshShip();
    const before = clone(illegal.state);
    captureViolation(
      () => commitPowerRoute(illegal.config, illegal.state, clone({ allocation: { weapons: 2 } })),
      "WEAPONS_POWER_EXCEEDED",
    );
    expect(illegal.state).toEqual(before);
  });

  test("Redline and subsystem entry Heat is charged once, then maintained every Start", () => {
    const { config, state } = freshShip();

    const entered = commitPowerRoute(config, state, clone({ allocation: { engines: 4 } }));
    expect(entered.redlining).toBe(true);
    expect(entered.heatAdded).toBe(7);
    expect(entered.overclockEntries).toEqual([
      { system: "engines", heat: 3 },
      { system: "reactor", heat: 4 },
    ]);
    expect(state.heat).toBe(7);

    const unchanged = commitPowerRoute(config, state, clone({ allocation: { engines: 4 } }));
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

    expect(result.ceilings).toMatchObject({ nominal: 9, maximum: 11, fault: "minor" });
    expect(result.committed).toBe(11);
    expect(result.events).toEqual([
      { type: "tierShed", system: "weapons", from: 3, to: 2 },
      { type: "weaponShed", weaponId: CANADENSIS_IDS.portMacrocannon, released: 1 },
    ]);
    expect(result.weaponReserved).toBe(2);
    expect(state.weapons[CANADENSIS_IDS.railgun].status).toBe("online");
    expect(state.weapons[CANADENSIS_IDS.portMacrocannon]).toMatchObject({
      status: "off",
      mode: "nominal",
      bootCounter: 0,
    });
  });
});

describe("shield allocation, collapse, and recovery", () => {
  test("integer regeneration uses stable directional tie-breaking", () => {
    expect(allocateRegeneration(3, clone({ fore: 25, port: 25, starboard: 25, aft: 25 }))).toEqual({
      fore: 1,
      port: 1,
      starboard: 1,
      aft: 0,
    });
  });

  test("collapsed and destroyed directional emitters lose their shares until recovery", () => {
    const { config, state } = freshShip();
    state.power.shields = 2;
    state.shields.charge = { fore: 0, port: 0, starboard: 0, aft: 0 };
    state.shields.regenerationAllocation = { fore: 25, port: 25, starboard: 25, aft: 25 };
    state.shields.collapse = { fore: 1, port: 0, starboard: 0, aft: 0 };
    state.conditions.portEmitter = emitterFault(config, "port");

    const blocked = applyShieldRegeneration(config, state);
    expect(blocked.assigned).toEqual({ fore: 1, port: 1, starboard: 1, aft: 1 });
    expect(blocked.gains).toEqual({ fore: 0, port: 0, starboard: 1, aft: 1 });
    expect(blocked.losses).toEqual(expect.arrayContaining([
      { sector: "fore", amount: 1, reason: "collapsed" },
      { sector: "port", amount: 1, reason: "destroyed" },
    ]));

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
      charge: 0,
      rechargeCounter: 1,
      capacity: 6,
    });
    expect(tickShieldRecharge(config, state).events).toEqual([
      { sector: "port", from: 1, to: 0, reactivated: true },
    ]);

    state.shields.regenerationAllocation = { fore: 0, port: 100, starboard: 0, aft: 0 };
    const restored = applyShieldRegeneration(config, state);
    expect(restored.assigned.port).toBe(4);
    expect(restored.gains.port).toBe(1);
    expect(state.shields.charge.port).toBe(1);
  });

  test("a bubble maps directional impacts to one field, then recharges and regenerates", () => {
    const { config, state } = freshShip((draft) => {
      draft.components.shield.topology = "bubble";
      draft.components.shield.sectors = ["bubble"];
      draft.components.shield.emitters = [{ id: `${draft.components.shield.id}:bubble`, sector: "bubble", regions: ["fore", "port", "starboard", "aft"] }];
      draft.components.shield.sectorCap = 30;
      draft.components.shield.totalBudget = 30;
    });
    state.power.shields = 2;
    state.shields.charge.bubble = 10;

    const impact = resolveShieldDamage(config, state, clone({
      sector: "fore",
      shieldDamage: 25,
      hullDamage: 10,
      heatDamage: 5,
      armorPiercing: 1,
    }));

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
    expect(state.shields.charge).toEqual({ bubble: 0 });

    expect(tickShieldRecharge(config, state).events).toEqual([
      { sector: "bubble", from: 1, to: 0, reactivated: true },
    ]);
    const regeneration = applyShieldRegeneration(config, state);
    expect(regeneration.assigned).toEqual({ bubble: 4 });
    expect(regeneration.gains).toEqual({ bubble: 4 });
    expect(state.shields.charge).toEqual({ bubble: 4 });
  });
});

describe("ordered lifecycle transactions", () => {
  test("dispatcher Start runs the ordered batch and ticks only entry counters once", () => {
    const record = freshShip();
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
    expect(result.shipStates[SOURCE].weapons[CANADENSIS_IDS.railgun]).toMatchObject({
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
    expect(next.shipStates[SOURCE].weapons[CANADENSIS_IDS.railgun]).toMatchObject({
      status: "online",
      bootCounter: 0,
    });
  });

  test("End completes every ordered step after Hull reaches zero and resolves Fate last", () => {
    const { config, state } = freshShip();
    state.phase = "end";
    state.hull = 1;
    state.heat = 25;
    state.velocity = { x: 31, y: 0 };
    state.effects = [
      { id: "zeta", timing: "end", expiresAt: "end", harmful: true, hullDamage: 2, heat: 2 },
      { id: "alpha", timing: "end", expiresAt: "end", harmful: true, hullDamage: 2, heat: 1 },
    ];

    const result = runEndPhase(config, state, clone({ random: [0], endKey: "round-1" }));

    expect(result.events.map(({ step, type }) => [step, type])).toEqual([
      [1, "overspeedDamage"],
      [2, "hazardHeatPower"],
      [3, "hazardDamage"],
      [4, "hazardClocks"],
      [5, "heatOverflow"],
      [6, "persistentEffects"],
      ["afterEnd", "shipFate"],
    ]);
    expect(result.events[0]).toMatchObject({ beforeHull: 1, hullDamage: 2, hull: 0 });
    expect(result.events[4]).toMatchObject({ overflow: 5, hullDamage: 3, beforeHull: 0, hull: 0 });
    expect(result.events[5].applied.map(({ id }) => id)).toEqual(["alpha", "zeta"]);
    expect(result.events.at(-1).public).toEqual({ status: "pending", outcome: null, reason: "important" });
    expect(state).toMatchObject({
      phase: "start",
      hull: 0,
      heat: 28,
      pendingFate: { status: "pending", outcome: null, reason: "important" },
      effects: [],
    });
  });

  test("an injected mid-Start failure rolls back both the lifecycle transaction and dispatcher input", () => {
    const record = freshShip((config) => {
      config.components.cooling.tiers.find(({ power }) => power === 1).cooling = -1;
    });
    record.state.heat = 9;
    record.state.effects = [{ id: "expires", expiresAt: "nextStart" }];
    record.state.evasion = { armed: true, reserved: 0.2 };
    const authority = gmContext(record);
    const before = clone(authority.ships[SOURCE].state);

    captureViolation(
      () => executeShipOperation(gmRequest("phase.start", { turnKey: "round-failure" }), authority),
      "INVALID_COOLING_OUTPUT",
    );

    expect(authority.ships[SOURCE].state).toEqual(before);
  });
});
