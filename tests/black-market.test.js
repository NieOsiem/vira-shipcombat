import { describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import {
  BLACK_MARKET_COMPONENT_SOURCES,
  BLACK_MARKET_HELLFIRE_SOURCE,
  BLACK_MARKET_MAIN_DRIVE_SOURCE,
  BLACK_MARKET_REACTOR_SOURCE,
  BLACK_MARKET_REAPER_SOURCE,
  BLACK_MARKET_SHIELD_SOURCE,
  BLACK_MARKET_BUBBLE_SOURCE,
} from "../scripts/data/black-market-components.js";
import { createDefaultShipData, createInitialState } from "../scripts/model/defaults.js";
import { validateComponentItem } from "../scripts/model/validation.js";
import { commitAttack } from "../scripts/rules/combat.js";
import { applyConditionTiers } from "../scripts/rules/conditions.js";
import { runEndPhase, runStartPhase } from "../scripts/rules/lifecycle.js";
import { resolveShieldDamage } from "../scripts/rules/shields.js";
import { TRACK_STATUS } from "../scripts/rules/sensors.js";

const GUNNER = "canadensis-gunner-sensor";

function clone(value) {
  return structuredClone(value);
}

function freshShip() {
  const defaults = createDefaultShipData();
  const config = clone(defaults.config);
  return { config, state: createInitialState(config) };
}

describe("Black Market components and drawbacks", () => {
  test("all bundled black market component blueprints pass schema validation", () => {
    for (const source of BLACK_MARKET_COMPONENT_SOURCES) {
      const validation = validateComponentItem(source);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    }
  });

  describe("Drawback 1: Weapon Misfire / Jam (unreliable)", () => {
    test("rolling a natural 1 jams an unreliable weapon with weaponMalfunction", () => {
      const attacker = freshShip();
      const target = freshShip();
      const weaponId = CANADENSIS_IDS.railgun;

      // Add unreliable trait to attacker's railgun
      attacker.config.components.weapons.find((w) => w.id === weaponId).traits.push({
        id: "unreliable",
      });

      attacker.state.phase = "active";
      attacker.state.resources.actions[GUNNER] = 1;
      attacker.state.weapons[weaponId].status = "online";
      attacker.state.tracks.target = {
        targetUuid: "target",
        state: TRACK_STATUS.TARGETED,
        passiveContact: true,
      };

      const declaration = {
        weaponId,
        operatorId: GUNNER,
        targetUuid: "target",
        attackerUuid: "attacker",
        attackerPosition: { x: 0, y: 0 },
        targetPosition: { x: 0, y: -30 },
        attackerVelocity: { x: 0, y: 0 },
        targetVelocity: { x: 0, y: 0 },
        attackerFacing: 0,
        targetFacing: 0,
        lineOfSight: true,
      };

      const attackerDraft = clone(attacker.state);
      const targetDraft = clone(target.state);

      const result = commitAttack({
        attackerConfig: attacker.config,
        attackerDraft,
        targetConfig: target.config,
        targetDraft,
        declaration,
        helpers: { resolveShieldDamage, applyConditionTiers },
        rollD20: () => 1, // Natural 1!
      });

      expect(result.public.roll.natural).toBe(1);
      expect(result.public.drawback).toMatchObject({
        type: "jam",
        weaponId,
      });

      // Weapon malfunction fault was applied to the attacker's weapon
      const conditionKey = `${weaponId}:weaponMalfunction`;
      expect(attackerDraft.conditions[conditionKey]).toBeDefined();
      expect(attackerDraft.conditions[conditionKey].severity).toBe("minor");
    });

    test("a successful roll does not jam an unreliable weapon", () => {
      const attacker = freshShip();
      const target = freshShip();
      const weaponId = CANADENSIS_IDS.railgun;

      attacker.config.components.weapons.find((w) => w.id === weaponId).traits.push({
        id: "unreliable",
      });

      attacker.state.phase = "active";
      attacker.state.resources.actions[GUNNER] = 1;
      attacker.state.weapons[weaponId].status = "online";
      attacker.state.tracks.target = {
        targetUuid: "target",
        state: TRACK_STATUS.TARGETED,
        passiveContact: true,
      };

      const declaration = {
        weaponId,
        operatorId: GUNNER,
        targetUuid: "target",
        attackerUuid: "attacker",
        attackerPosition: { x: 0, y: 0 },
        targetPosition: { x: 0, y: -30 },
        attackerVelocity: { x: 0, y: 0 },
        targetVelocity: { x: 0, y: 0 },
        attackerFacing: 0,
        targetFacing: 0,
        lineOfSight: true,
      };

      const attackerDraft = clone(attacker.state);
      const targetDraft = clone(target.state);

      const result = commitAttack({
        attackerConfig: attacker.config,
        attackerDraft,
        targetConfig: target.config,
        targetDraft,
        declaration,
        helpers: { resolveShieldDamage, applyConditionTiers },
        rollD20: () => 12,
      });

      expect(result.public.roll.natural).toBe(12);
      expect(result.public.drawback).toBeUndefined();
      const conditionKey = `${weaponId}:weaponMalfunction`;
      expect(attackerDraft.conditions[conditionKey]).toBeUndefined();
    });
  });

  describe("Drawback 2: Weapon Thermal Blowback (incendiaryBackfire)", () => {
    test("rolling a natural 1 ignites a fire hazard in the weapon bay", () => {
      const attacker = freshShip();
      const target = freshShip();
      const weaponId = CANADENSIS_IDS.railgun;

      attacker.config.components.weapons.find((w) => w.id === weaponId).traits.push({
        id: "incendiaryBackfire",
      });

      attacker.state.phase = "active";
      attacker.state.resources.actions[GUNNER] = 1;
      attacker.state.weapons[weaponId].status = "online";
      attacker.state.tracks.target = {
        targetUuid: "target",
        state: TRACK_STATUS.TARGETED,
        passiveContact: true,
      };

      const declaration = {
        weaponId,
        operatorId: GUNNER,
        targetUuid: "target",
        attackerUuid: "attacker",
        attackerPosition: { x: 0, y: 0 },
        targetPosition: { x: 0, y: -30 },
        attackerVelocity: { x: 0, y: 0 },
        targetVelocity: { x: 0, y: 0 },
        attackerFacing: 0,
        targetFacing: 0,
        lineOfSight: true,
      };

      const attackerDraft = clone(attacker.state);
      const targetDraft = clone(target.state);

      const result = commitAttack({
        attackerConfig: attacker.config,
        attackerDraft,
        targetConfig: target.config,
        targetDraft,
        declaration,
        helpers: { resolveShieldDamage, applyConditionTiers },
        rollD20: () => 1,
      });

      expect(result.public.drawback).toMatchObject({
        backfire: true,
        sector: "fore",
      });

      // Fire hazard ignited in fore region
      expect(attackerDraft.conditions["fire:fore"]).toBeDefined();
      expect(attackerDraft.conditions["fire:fore"].severity).toBe("minor");
    });
  });

  describe("Drawback 3: Cascading Shield Collapse (cascadingCollapse)", () => {
    test("when one sector falls to 0 HP, all shield sectors collapse", () => {
      const ship = freshShip();
      ship.config.components.shield.cascadingCollapse = true;
      ship.state.shields = {
        hp: { fore: 10, port: 15, starboard: 15, aft: 15 },
        allocation: { fore: 15, port: 15, starboard: 15, aft: 15 },
        collapse: {},
      };

      // Hit fore sector for 20 shield damage, exceeding its 10 HP
      const result = resolveShieldDamage(ship.config, ship.state, {
        sector: "fore",
        shieldDamage: 20,
      });

      expect(result.collapsed).toBe(true);
      expect(result.cascadingCollapse).toBe(true);

      // All 4 sectors should now have 0 HP and active collapse timers
      expect(ship.state.shields.hp.fore).toBe(0);
      expect(ship.state.shields.hp.port).toBe(0);
      expect(ship.state.shields.hp.starboard).toBe(0);
      expect(ship.state.shields.hp.aft).toBe(0);

      const delay = ship.config.components.shield.rechargeDelay;
      expect(ship.state.shields.collapse.fore).toBe(delay);
      expect(ship.state.shields.collapse.port).toBe(delay);
      expect(ship.state.shields.collapse.starboard).toBe(delay);
      expect(ship.state.shields.collapse.aft).toBe(delay);
    });

    test("normal shields only collapse the struck sector", () => {
      const ship = freshShip();
      ship.config.components.shield.cascadingCollapse = false;
      ship.state.shields = {
        hp: { fore: 10, port: 15, starboard: 15, aft: 15 },
        allocation: { fore: 15, port: 15, starboard: 15, aft: 15 },
        collapse: {},
      };

      const result = resolveShieldDamage(ship.config, ship.state, {
        sector: "fore",
        shieldDamage: 20,
      });

      expect(result.collapsed).toBe(true);
      expect(result.cascadingCollapse).toBe(false);

      expect(ship.state.shields.hp.fore).toBe(0);
      expect(ship.state.shields.hp.port).toBe(15);
      expect(ship.state.shields.hp.starboard).toBe(15);
      expect(ship.state.shields.hp.aft).toBe(15);
    });
  });

  describe("Drawback 4: Shield Thermal Bleed (thermalBleedFraction)", () => {
    test("shunts a percentage of absorbed shield damage into internal heat", () => {
      const ship = freshShip();
      ship.config.components.shield.thermalBleedFraction = 0.25;
      ship.state.heat = 0;
      ship.state.shields = {
        hp: { fore: 20, port: 15, starboard: 15, aft: 15 },
        allocation: { fore: 20, port: 15, starboard: 15, aft: 15 },
        collapse: {},
      };

      // 16 shield damage absorbed (shieldDamageApplied = 16)
      const result = resolveShieldDamage(ship.config, ship.state, {
        sector: "fore",
        shieldDamage: 16,
      });

      expect(result.shieldDamageApplied).toBe(16);
      expect(result.thermalBleed).toBe(4); // 16 * 0.25 = 4
      expect(ship.state.heat).toBe(4);
    });
  });

  describe("Drawback 5: Reactor Dirty Core (dirtyCore)", () => {
    test("triggers reactorInstability hazard at End Phase on low roll", () => {
      const ship = freshShip();
      ship.config.components.reactor.dirtyCore = true;
      ship.state.phase = "end";

      // random roll = 0.04 (d20 roll = 1)
      const end = runEndPhase(ship.config, ship.state, { random: [0.04] });

      const dirtyCoreEvent = end.events.find((e) => e.type === "dirtyCoreInstability");
      expect(dirtyCoreEvent).toBeDefined();
      expect(dirtyCoreEvent.roll).toBe(1);

      // reactorInstability created
      expect(ship.state.conditions["reactorInstability"]).toBeDefined();
      expect(ship.state.conditions["reactorInstability"].severity).toBe("minor");
    });

    test("does not trigger reactorInstability on a high roll", () => {
      const ship = freshShip();
      ship.config.components.reactor.dirtyCore = true;
      ship.state.phase = "end";

      // random roll = 0.5 (d20 roll = 10)
      const end = runEndPhase(ship.config, ship.state, { random: [0.5] });

      const dirtyCoreEvent = end.events.find((e) => e.type === "dirtyCoreInstability");
      expect(dirtyCoreEvent).toBeUndefined();
      expect(ship.state.conditions["reactorInstability"]).toBeUndefined();
    });
  });

  describe("Drawback 6: Drive Gasket Blowout (gasketBlowout)", () => {
    test("triggers driveFailure fault when maintaining Overclock on a low roll", () => {
      const ship = freshShip();
      const mainDrive = ship.config.components.drives.main;
      mainDrive.gasketBlowout = true;

      ship.state.phase = "start";
      ship.state.power.engines = 4; // Overclock tier for Canadensis

      // random roll = 0.05 (< 1/6)
      const start = runStartPhase(ship.config, ship.state, { random: [0.05] });

      const blowoutEvent = start.events.find((e) => e.type === "driveGasketBlowout");
      expect(blowoutEvent).toBeDefined();

      const conditionKey = `${mainDrive.id}:driveFailure`;
      expect(ship.state.conditions[conditionKey]).toBeDefined();
      expect(ship.state.conditions[conditionKey].severity).toBe("minor");
    });

    test("does not trigger driveFailure when engine is at nominal power", () => {
      const ship = freshShip();
      const mainDrive = ship.config.components.drives.main;
      mainDrive.gasketBlowout = true;

      ship.state.phase = "start";
      ship.state.power.engines = 3; // Nominal tier 3 (not overclock)

      const start = runStartPhase(ship.config, ship.state, { random: [0.05] });

      const blowoutEvent = start.events.find((e) => e.type === "driveGasketBlowout");
      expect(blowoutEvent).toBeUndefined();

      const conditionKey = `${mainDrive.id}:driveFailure`;
      expect(ship.state.conditions[conditionKey]).toBeUndefined();
    });
  });
});
