import { describe, expect, test } from "bun:test";

import { CANADENSIS_CONFIG } from "../scripts/data/canadensis.js";
import {
  createDefaultShipData,
  normalizeShipData,
} from "../scripts/model/defaults.js";
import { validateShipConfig } from "../scripts/model/validation.js";
import { nativeVehicleFieldValues } from "../scripts/model/native-vehicle.js";


const clone = (value) => structuredClone(value);

function expectValidationErrors(config, expectedErrors) {
  const result = validateShipConfig(config, { tokenWidth: 1 });

  expect(result.valid).toBe(false);
  expect(result.errors).toEqual(expectedErrors);
  expect(result.warnings).toEqual([]);
}

describe("ship configuration validation", () => {
  test("the exact Canadensis configuration validates for a positive token width", () => {
    expect(validateShipConfig(CANADENSIS_CONFIG, { tokenWidth: 1 })).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
  });

  test("reports stable component-cardinality errors", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.components.reactor = [config.components.reactor];

    expectValidationErrors(config, [
      {
        code: "COMPONENT_CARDINALITY",
        path: "components.reactor",
        message: "Exactly one reactor component is required.",
      },
      {
        code: "UNKNOWN_CRITICAL_COMPONENT",
        path: "criticalPools.aft[2].componentId",
        message: "Fault entry references an unknown component.",
      },
    ]);
  });

  test("reports stable invalid mount errors", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.hardpoints[0].mountSize = "invalid";
    config.components.weapons[0].mountSize = "invalid";

    expectValidationErrors(config, [
      {
        code: "INVALID_MOUNT_SIZE",
        path: "hardpoints[0].mountSize",
        message: "Hardpoint mount size is invalid.",
      },
      {
        code: "INVALID_MOUNT_SIZE",
        path: "components.weapons[0].mountSize",
        message: "Hardpoint weapon requires a valid mount size.",
      },
    ]);
  });

  test("reports a stable error when optimal range exceeds maximum range", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.components.weapons[0].range.optimal = 121;

    expectValidationErrors(config, [
      {
        code: "INVALID_WEAPON_RANGE",
        path: "components.weapons[0].range",
        message: "Optimal range cannot exceed maximum range.",
      },
    ]);
  });

  test("reports a stable error for an invalid numeric boundary", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.maxHull = 0;

    expectValidationErrors(config, [
      {
        code: "INVALID_NUMBER",
        path: "maxHull",
        message: "Must be a finite number greater than 0.",
      },
    ]);
  });

  test("reports a stable error for unsupported trait data", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.components.weapons[0].traits = [{ id: "unsupported-training-trait" }];

    expectValidationErrors(config, [
      {
        code: "UNSUPPORTED_TRAIT",
        path: "components.weapons[0].traits[0].id",
        message: "Trait 'unsupported-training-trait' is not supported for automated play.",
      },
    ]);
  });
});

describe("ship data defaults", () => {
  test("returns independent mutable configs and states without modifying the frozen reference", () => {
    const first = createDefaultShipData();
    const second = createDefaultShipData();

    expect(first.config).toEqual(CANADENSIS_CONFIG);
    expect(first.config).not.toBe(second.config);
    expect(first.config.components.drive).not.toBe(second.config.components.drive);
    expect(first.state).not.toBe(second.state);
    expect(first.state.shields).not.toBe(second.state.shields);
    expect(Object.isFrozen(CANADENSIS_CONFIG)).toBe(true);
    expect(Object.isFrozen(CANADENSIS_CONFIG.components.drive.base)).toBe(true);

    first.config.label = "Mutable Test Ship";
    first.config.components.drive.base.forward = 99;
    first.state.hull = 1;
    first.state.history.push({ type: "test-event" });

    expect(first.config.label).toBe("Mutable Test Ship");
    expect(first.config.components.drive.base.forward).toBe(99);
    expect(first.state.hull).toBe(1);
    expect(first.state.history).toEqual([{ type: "test-event" }]);
    expect(second.config.label).toBe("Canadensis Training Corvette");
    expect(second.config.components.drive.base.forward).toBe(6);
    expect(second.state.hull).toBe(50);
    expect(second.state.history).toEqual([]);
    expect(CANADENSIS_CONFIG.label).toBe("Canadensis Training Corvette");
    expect(CANADENSIS_CONFIG.components.drive.base.forward).toBe(6);
  });

  test("normalization preserves supplied values, fills missing fields, and does not mutate its input", () => {
    const supplied = createDefaultShipData();
    supplied.config.label = "Supplied Ship";
    supplied.state.hull = 17;
    supplied.state.power.engines = 4;
    supplied.state.history = [{ type: "supplied-event", details: { kept: true } }];
    supplied.state.extension = { nested: ["kept"] };
    delete supplied.schemaVersion;
    delete supplied.state.schemaVersion;
    delete supplied.state.phase;
    delete supplied.state.power.shields;
    delete supplied.state.velocity;
    const before = clone(supplied);

    const normalized = normalizeShipData(supplied);

    expect(supplied).toEqual(before);
    expect(normalized).not.toBe(supplied);
    expect(normalized.config).not.toBe(supplied.config);
    expect(normalized.state).not.toBe(supplied.state);
    expect(normalized.state.power).not.toBe(supplied.state.power);
    expect(normalized.state.history).not.toBe(supplied.state.history);
    expect(normalized.config.label).toBe("Supplied Ship");
    expect(normalized.state.hull).toBe(17);
    expect(normalized.state.power.engines).toBe(4);
    expect(normalized.state.history).toEqual([{ type: "supplied-event", details: { kept: true } }]);
    expect(normalized.state.extension).toEqual({ nested: ["kept"] });
    expect(normalized.schemaVersion).toBe(CANADENSIS_CONFIG.schemaVersion);
    expect(normalized.state.schemaVersion).toBe(CANADENSIS_CONFIG.schemaVersion);
    expect(normalized.state.phase).toBe("start");
    expect(normalized.state.power.shields).toBe(3);
    expect(normalized.state.velocity).toEqual({ x: 0, y: 0 });

    normalized.config.label = "Changed Normalized Ship";
    normalized.state.history[0].details.kept = false;
    normalized.state.extension.nested.push("changed");

    expect(supplied.config.label).toBe("Supplied Ship");
    expect(supplied.state.history[0].details.kept).toBe(true);
    expect(supplied.state.extension.nested).toEqual(["kept"]);
  });
});

describe("exact Canadensis reference contract", () => {
  test("matches every static identity, durability, propulsion, and subsystem value", () => {
    expect(CANADENSIS_CONFIG).toMatchObject({
      label: "Canadensis Training Corvette",
      size: "medium",
      initiative: 0,
      ac: 14,
      baseSignature: 14,
      maxHull: 50,
      heatCapacity: 20,
      commandCapacity: 2,
      crewCapacity: 2,
      safeVelocity: 30,
      evasionReserve: 20,
      evasionAcBonus: 2,
      fatePolicy: "important",
      armor: { fore: 3, port: 2, starboard: 2, aft: 2 },
      components: {
        reactor: { nominalOutput: 12, redlineOutput: 14, overclockHeat: 4 },
        drive: {
          base: { forward: 6, retro: 3, port: 2, starboard: 2, rotation: 60 },
          tiers: [
            { power: 0, multiplier: 0, online: false },
            { power: 1, multiplier: 0.5, online: true },
            { power: 2, multiplier: 0.75, online: true },
            { power: 3, multiplier: 1, online: true },
            { power: 4, multiplier: 1.25, online: true, overclock: true, overclockHeat: 3 },
          ],
        },
        shield: {
          topology: "directional",
          totalBudget: 60,
          sectorCap: 24,
          rechargeDelay: 1,
          tiers: [
            { power: 0, online: false, regeneration: 0 },
            { power: 1, online: true, regeneration: 0 },
            { power: 2, online: true, regeneration: 4 },
            { power: 3, online: true, regeneration: 8 },
            { power: 4, online: true, regeneration: 10, overclock: true, overclockHeat: 2 },
          ],
        },
        sensor: {
          base: {
            passiveRange: 100,
            passiveStrength: 10,
            activeRange: 150,
            activeModifier: 0,
            ewModifier: 0,
          },
        },
        cooling: {
          tiers: [
            { power: 0, cooling: 2 },
            { power: 1, cooling: 4 },
            { power: 2, cooling: 6 },
            { power: 3, cooling: 8 },
          ],
          ventAmount: 10,
          ventCooldown: 2,
        },
      },
    });
  });

  test("matches every static hardpoint, preset, and priority value", () => {
    expect(CANADENSIS_CONFIG.hardpoints.map(({ label, orientation, weaponId }) => ({
      label, orientation, weaponId,
    }))).toEqual([
      { label: "Prow", orientation: 0, weaponId: "canadensis-twin-railgun" },
      { label: "Dorsal", orientation: 0, weaponId: "canadensis-pulse-laser" },
      { label: "Port", orientation: -90, weaponId: "canadensis-port-macrocannon" },
      { label: "Starboard", orientation: 90, weaponId: "canadensis-starboard-macrocannon" },
    ]);
    const weaponIds = new Set(CANADENSIS_CONFIG.components.weapons.map((weapon) => weapon.id));
    expect(CANADENSIS_CONFIG.hardpoints.every((hardpoint) => weaponIds.has(hardpoint.weaponId))).toBe(true);
    expect(CANADENSIS_CONFIG.powerPresets).toEqual([
      { id: "balanced-combat", label: "Balanced Combat", allocations: { engines: 3, shields: 3, sensors: 2, cooling: 1, weapons: 3 } },
      { id: "all-guns", label: "All Guns", allocations: { engines: 2, shields: 2, sensors: 1, cooling: 1, weapons: 6 } },
      { id: "pursuit", label: "Pursuit", allocations: { engines: 4, shields: 1, sensors: 2, cooling: 1, weapons: 4 } },
      { id: "defensive", label: "Defensive", allocations: { engines: 2, shields: 4, sensors: 2, cooling: 2, weapons: 2 } },
      { id: "silent-running", label: "Silent Running", allocations: { engines: 1, shields: 1, sensors: 1, cooling: 0, weapons: 0 } },
    ]);
    expect(CANADENSIS_CONFIG.sheddingPriority).toEqual(["sensors", "engines", "shields", "cooling", "weapons"]);
  });
});

describe("native D&D5e vehicle mirrors", () => {
  test("maps authoritative Canadensis combat values to stock vehicle fields", () => {
    const { config, state } = createDefaultShipData();
    state.hull = 37;
    expect(nativeVehicleFieldValues(config, state)).toEqual({
      "system.attributes.ac.calc": "flat",
      "system.attributes.ac.flat": 14,
      "system.attributes.hp.value": 37,
      "system.attributes.hp.max": 50,
      "system.traits.size": "med",
      "system.details.type": "space",
    });
  });
});
