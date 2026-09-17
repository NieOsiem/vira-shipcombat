import { describe, expect, test } from "bun:test";

import { CANADENSIS_CONFIG, CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import {
  createDefaultShipData,
  createDefaultShipSystemData,
  normalizeShipData,
} from "../scripts/model/defaults.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";
import { validateComponentItem, validateHullConfig, validateShipConfig } from "../scripts/model/validation.js";
import { nativeVehicleFieldValues } from "../scripts/model/native-vehicle.js";


const clone = (value) => structuredClone(value);

function expectValidationErrors(config, expectedErrors) {
  const result = validateShipConfig(config, { tokenWidth: 1 });

  expect(result.valid).toBe(false);
  expect(result.errors.map(({ code, path }) => ({ code, path }))).toEqual(expectedErrors);
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

  test("reports component-cardinality errors", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.components.reactor = [config.components.reactor];

    expectValidationErrors(config, [
      {
        code: "COMPONENT_CARDINALITY",
        path: "components.reactor",
      },
      {
        code: "UNKNOWN_CRITICAL_COMPONENT",
        path: "criticalPools.aft[1].componentId",
      },
    ]);
  });

  test("reports invalid mount errors", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.hardpoints[0].mountSize = "invalid";
    config.components.weapons[0].mountSize = "invalid";

    expectValidationErrors(config, [
      {
        code: "INVALID_MOUNT_SIZE",
        path: "hardpoints[0].mountSize",
      },
      {
        code: "INVALID_MOUNT_SIZE",
        path: "components.weapons[0].mountSize",
      },
    ]);
  });

  test("reports when optimal range exceeds maximum range", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.components.weapons[0].range.optimal = 121;

    expectValidationErrors(config, [
      {
        code: "INVALID_WEAPON_RANGE",
        path: "components.weapons[0].range",
      },
    ]);
  });

  test("reports an invalid numeric boundary", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.maxHull = 0;

    expectValidationErrors(config, [
      {
        code: "INVALID_NUMBER",
        path: "maxHull",
      },
    ]);
  });

  test("reports unsupported trait data", () => {
    const config = clone(CANADENSIS_CONFIG);
    config.components.weapons[0].traits = [{ id: "unsupported-training-trait" }];

    expectValidationErrors(config, [
      {
        code: "UNSUPPORTED_TRAIT",
        path: "components.weapons[0].traits[0].id",
      },
    ]);
  });
});

describe("component Item identity", () => {
  test("rejects a reactor definition identity while materializing the embedded identity without prior validation", () => {
    const defaults = createDefaultShipData();
    const reactor = defaults.items.find(({ _id }) => _id === CANADENSIS_IDS.reactor);
    const slot = defaults.hull.slots.find(({ itemId }) => itemId === reactor._id);
    Object.assign(reactor.system.definition, {
      id: "forged-reactor",
      label: "Forged Reactor",
      class: "sensor",
      slotId: "forged-slot",
      regions: ["fore"],
    });

    const effective = materializeShipConfig(defaults.hull, defaults.items);
    expect(effective.components.reactor).toMatchObject({
      id: reactor._id,
      label: reactor.name,
      class: "reactor",
      slotId: slot.id,
      regions: slot.regions,
    });
    const result = validateComponentItem(reactor);
    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code, path }) => ({ code, path }))).toEqual(
      ["id", "label", "class", "slotId", "regions"].map((key) => ({
        code: "RESERVED_COMPONENT_FIELD", path: `system.definition.${key}`,
      })),
    );
  });

  test("rejects weapon definition identity and placement fields without letting them override the mount", () => {
    const defaults = createDefaultShipData();
    const item = defaults.items.find(({ _id }) => _id === CANADENSIS_IDS.railgun);
    const hardpoint = defaults.hull.hardpoints.find(({ weaponId }) => weaponId === item._id);
    const reserved = {
      id: "forged-weapon", label: "Forged Weapon", class: "reactor", slotId: "forged-slot",
      hardpointId: "forged-hardpoint", regions: [], driveRole: "main", mountSize: "invalid",
    };
    Object.assign(item.system.definition, reserved);

    const effective = materializeShipConfig(defaults.hull, defaults.items);
    expect(effective.components.weapons.find(({ id }) => id === item._id)).toMatchObject({
      id: item._id, label: item.name, class: "weapon", hardpointId: hardpoint.id,
      regions: hardpoint.regions, mountSize: hardpoint.mountSize,
    });
    const result = validateComponentItem(item);
    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code, path }) => ({ code, path }))).toEqual(
      Object.keys(reserved).map((key) => ({ code: "RESERVED_COMPONENT_FIELD", path: `system.definition.${key}` })),
    );
  });

  test("independent copies with the same stats keep their own embedded identities", () => {
    const first = createDefaultShipData();
    const second = createDefaultShipData();
    const reactor = second.items.find(({ _id }) => _id === CANADENSIS_IDS.reactor);
    second.hull.slots.find(({ itemId }) => itemId === reactor._id).itemId = "copied-reactor";
    reactor._id = "copied-reactor";
    reactor.name = "Copied Reactor";

    const firstConfig = materializeShipConfig(first.hull, first.items);
    const secondConfig = materializeShipConfig(second.hull, second.items);
    expect(firstConfig.components.reactor.id).toBe(CANADENSIS_IDS.reactor);
    expect(secondConfig.components.reactor).toMatchObject({ id: "copied-reactor", label: "Copied Reactor" });
    expect(firstConfig.components.reactor.nominalOutput).toBe(secondConfig.components.reactor.nominalOutput);
    for (const defaults of [first, second]) {
      for (const item of defaults.items) expect(validateComponentItem(item)).toMatchObject({ valid: true, errors: [] });
    }
    for (const config of [firstConfig, secondConfig]) {
      expect(validateShipConfig(config, { tokenWidth: 1 })).toMatchObject({ valid: true, errors: [] });
    }
  });
});

describe("ship data defaults", () => {
  test("returns independent mutable configs, Items, and states without modifying the frozen reference", () => {
    const first = createDefaultShipData();
    const second = createDefaultShipData();
    const firstMainDriveItem = first.items.find(({ _id }) => _id === CANADENSIS_IDS.mainDrive);
    const secondMainDriveItem = second.items.find(({ _id }) => _id === CANADENSIS_IDS.mainDrive);

    expect(first.config).not.toBe(second.config);
    expect(first.config.components.drives).not.toBe(second.config.components.drives);
    expect(first.config.components.drives.main).not.toBe(second.config.components.drives.main);
    expect(first.items).not.toBe(second.items);
    expect(firstMainDriveItem).not.toBe(secondMainDriveItem);
    expect(firstMainDriveItem.system.definition).not.toBe(secondMainDriveItem.system.definition);
    expect(first.state).not.toBe(second.state);
    expect(first.state.shields).not.toBe(second.state.shields);
    expect(Object.isFrozen(CANADENSIS_CONFIG)).toBe(true);
    expect(Object.isFrozen(CANADENSIS_CONFIG.components.drives.main.base)).toBe(true);

    first.config.label = "Mutable Test Ship";
    first.config.components.drives.main.base.thrust = 99;
    first.config.components.drives.main.tiers[0].multiplier = 99;
    firstMainDriveItem.system.definition.base.thrust = 77;
    first.state.hull = 1;
    first.state.history.push({ type: "test-event" });

    expect(first.config.label).toBe("Mutable Test Ship");
    expect(first.config.components.drives.main.base.thrust).toBe(99);
    expect(firstMainDriveItem.system.definition.base.thrust).toBe(77);
    expect(first.state.hull).toBe(1);
    expect(first.state.history).toEqual([{ type: "test-event" }]);
    expect(second.config.label).toBe("Canadensis Training Corvette");
    expect(second.config.components.drives.main.base.thrust).toBe(6);
    expect(firstMainDriveItem.system.definition.tiers[0].multiplier).toBe(0);
    expect(second.config.components.drives.main.tiers[0].multiplier).toBe(0);
    expect(CANADENSIS_CONFIG.components.drives.main.tiers[0].multiplier).toBe(0);
    expect(secondMainDriveItem.system.definition.base.thrust).toBe(6);
    expect(second.state.hull).toBe(50);
    expect(second.state.history).toEqual([]);
    expect(CANADENSIS_CONFIG.label).toBe("Canadensis Training Corvette");
    expect(CANADENSIS_CONFIG.components.drives.main.base.thrust).toBe(6);
  });

  test("stores a component-free hull and materializes independent embedded identities", () => {
    const stored = createDefaultShipSystemData();
    const defaults = createDefaultShipData();
    const effective = materializeShipConfig(defaults.hull, defaults.items);
    const railgun = effective.components.weapons.find(({ id }) => id === CANADENSIS_IDS.railgun);
    const installed = [
      effective.components.reactor,
      effective.components.shield,
      effective.components.sensor,
      effective.components.cooling,
      ...Object.values(effective.components.drives),
      ...effective.components.weapons,
    ];
    const embeddedIds = new Set(defaults.items.map(({ _id }) => _id));

    expect(Object.hasOwn(stored.config, "components")).toBe(false);
    expect(installed.every(({ id }) => embeddedIds.has(id))).toBe(true);
    expect(new Set(installed.map(({ id }) => id)).size).toBe(installed.length);
    expect(effective.components.reactor.id).toBe(CANADENSIS_IDS.reactor);
    expect(railgun.hardpointId).toBe(CANADENSIS_IDS.prowHardpoint);
  });

  test("preserves an intentionally empty compatible slot as a legal degraded loadout", () => {
    const defaults = createDefaultShipData();
    const sensorSlot = defaults.hull.slots.find(({ itemId }) => itemId === CANADENSIS_IDS.sensor);
    sensorSlot.itemId = null;

    expect(validateHullConfig(defaults.hull)).toMatchObject({ valid: true, errors: [] });
    const effective = materializeShipConfig(defaults.hull, defaults.items);
    const normalized = normalizeShipData({
      schemaVersion: defaults.schemaVersion,
      config: defaults.hull,
      state: {},
    }, defaults.items);

    expect(effective.components.sensor).toBeNull();
    expect(normalized.config.slots.find(({ id }) => id === sensorSlot.id).itemId).toBeNull();
    expect(normalized.state.power.sensors).toBe(0);
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
    expect(normalized.state.phase).toBe("outsideCombat");
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
