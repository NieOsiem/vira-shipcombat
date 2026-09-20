import { describe, expect, test } from "bun:test";

import {
  CANADENSIS_CONFIG,
  CANADENSIS_IDS,
} from "../scripts/data/canadensis.js";
import {
  CANADENSIS_COMPONENT_SOURCES,
  CANADENSIS_DEFAULT_COMPONENT_SOURCES,
} from "../scripts/data/canadensis-components.js";
import {
  createDefaultShipData,
  createDefaultShipSystemData,
  normalizeShipData,
} from "../scripts/model/defaults.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";
import {
  validateComponentItem,
  validateHullConfig,
  validateShipConfig,
} from "../scripts/model/validation.js";
import {
  nativeVehicleFieldValues,
  shipFieldsFromNativeVehicleChanges,
} from "../scripts/model/native-vehicle.js";
import { buildShipConsoleView } from "../scripts/foundry/ship-view-model.js";

const clone = (value) => structuredClone(value);

test("bundled ship documents use Foundry-legal document ids", () => {
  // Foundry (through the dnd5e Item model) rejects ids that are not 16 alphanumeric characters, so a
  // malformed bundled blueprint id can only fail at install time, on a live world.
  const ids = [
    ...CANADENSIS_COMPONENT_SOURCES.map((source) => source._id),
    ...CANADENSIS_DEFAULT_COMPONENT_SOURCES.map((source) => source._id),
  ];
  for (const id of ids) {
    expect(String(id)).toMatch(/^[A-Za-z0-9]{16}$/);
  }
});

function expectValidationErrors(config, expectedErrors) {
  const result = validateShipConfig(config, { tokenWidth: 1 });

  expect(result.valid).toBe(false);
  expect(result.errors.map(({ code, path }) => ({ code, path }))).toEqual(
    expectedErrors,
  );
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
    config.components.weapons[0].traits = [{
      id: "unsupported-training-trait",
    }];

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
    const reactor = defaults.items.find(({ _id }) =>
      _id === CANADENSIS_IDS.reactor
    );
    const slot = defaults.hull.slots.find(({ itemId }) =>
      itemId === reactor._id
    );
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
        code: "RESERVED_COMPONENT_FIELD",
        path: `system.definition.${key}`,
      })),
    );
  });

  test("rejects weapon definition identity and placement fields without letting them override the mount", () => {
    const defaults = createDefaultShipData();
    const item = defaults.items.find(({ _id }) =>
      _id === CANADENSIS_IDS.railgun
    );
    const hardpoint = defaults.hull.hardpoints.find(({ weaponId }) =>
      weaponId === item._id
    );
    const reserved = {
      id: "forged-weapon",
      label: "Forged Weapon",
      class: "reactor",
      slotId: "forged-slot",
      hardpointId: "forged-hardpoint",
      regions: [],
      driveRole: "main",
      mountSize: "invalid",
    };
    Object.assign(item.system.definition, reserved);

    const effective = materializeShipConfig(defaults.hull, defaults.items);
    expect(effective.components.weapons.find(({ id }) => id === item._id))
      .toMatchObject({
        id: item._id,
        label: item.name,
        class: "weapon",
        hardpointId: hardpoint.id,
        regions: hardpoint.regions,
        mountSize: hardpoint.mountSize,
      });
    const result = validateComponentItem(item);
    expect(result.valid).toBe(false);
    expect(result.errors.map(({ code, path }) => ({ code, path }))).toEqual(
      Object.keys(reserved).map((key) => ({
        code: "RESERVED_COMPONENT_FIELD",
        path: `system.definition.${key}`,
      })),
    );
  });

  test("independent copies with the same stats keep their own embedded identities", () => {
    const first = createDefaultShipData();
    const second = createDefaultShipData();
    const reactor = second.items.find(({ _id }) =>
      _id === CANADENSIS_IDS.reactor
    );
    second.hull.slots.find(({ itemId }) => itemId === reactor._id).itemId =
      "copied-reactor";
    reactor._id = "copied-reactor";
    reactor.name = "Copied Reactor";

    const firstConfig = materializeShipConfig(first.hull, first.items);
    const secondConfig = materializeShipConfig(second.hull, second.items);
    expect(firstConfig.components.reactor.id).toBe(CANADENSIS_IDS.reactor);
    expect(secondConfig.components.reactor).toMatchObject({
      id: "copied-reactor",
      label: "Copied Reactor",
    });
    expect(firstConfig.components.reactor.nominalOutput).toBe(
      secondConfig.components.reactor.nominalOutput,
    );
    for (const defaults of [first, second]) {
      for (const item of defaults.items) {
        expect(validateComponentItem(item)).toMatchObject({
          valid: true,
          errors: [],
        });
      }
    }
    for (const config of [firstConfig, secondConfig]) {
      expect(validateShipConfig(config, { tokenWidth: 1 })).toMatchObject({
        valid: true,
        errors: [],
      });
    }
  });
});

describe("standalone component definitions", () => {
  test("accepts array Power tiers but rejects power-keyed objects before materialization or sheet rendering", () => {
    const defaults = createDefaultShipData();
    for (const componentClass of ["drive", "shield", "sensor", "cooling"]) {
      const item = defaults.items.find(({ system }) =>
        system.componentClass === componentClass
      );
      expect(validateComponentItem(item)).toMatchObject({
        valid: true,
        errors: [],
      });
      item.system.definition.tiers = Object.fromEntries(
        item.system.definition.tiers.map(({ power, ...tier }) => [power, tier]),
      );
      expect(validateComponentItem(item)).toMatchObject({
        valid: false,
        errors: [{
          code: "POWER_TIERS_REQUIRED",
          path: "system.definition.tiers",
        }],
      });
    }

    const reactor = defaults.items.find(({ system }) =>
      system.componentClass === "reactor"
    );
    reactor.system.definition.tiers = {};
    expect(validateComponentItem(reactor)).toMatchObject({
      valid: false,
      errors: [{
        code: "POWER_TIERS_REQUIRED",
        path: "system.definition.tiers",
      }],
    });

    const effective = clone(CANADENSIS_CONFIG);
    for (
      const component of [
        effective.powerSystems.engines,
        effective.components.shield,
        effective.components.sensor,
        effective.components.cooling,
      ]
    ) {
      component.tiers = Object.fromEntries(
        component.tiers.map(({ power, ...tier }) => [power, tier]),
      );
    }
    expect(validateShipConfig(effective, { tokenWidth: 1 })).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("requires exactly the sectors belonging to the shield topology", () => {
    const defaults = createDefaultShipData();
    const item = defaults.items.find(({ system }) =>
      system.componentClass === "shield"
    );
    for (
      const [topology, sectors] of [
        ["directional", undefined],
        ["directional", ["fore", "aft", "port"]],
        ["directional", ["fore", "aft", "port", "port"]],
        ["bubble", ["fore"]],
        ["bubble", ["bubble", "bubble"]],
      ]
    ) {
      Object.assign(item.system.definition, { topology, sectors });
      expect(validateComponentItem(item)).toMatchObject({
        valid: false,
        errors: [{
          code: "INVALID_SHIELD_SECTORS",
          path: "system.definition.sectors",
        }],
      });
    }
    for (
      const [topology, sectors] of [
        ["directional", ["aft", "port", "starboard", "fore"]],
        ["bubble", ["bubble"]],
      ]
    ) {
      Object.assign(item.system.definition, { topology, sectors });
      expect(validateComponentItem(item)).toMatchObject({
        valid: true,
        errors: [],
      });
      const effective = materializeShipConfig(defaults.hull, defaults.items);
      expect(effective.components.shield.emitters.map(({ sector }) => sector))
        .toEqual(sectors);
      expect(validateShipConfig(effective, { tokenWidth: 1 })).toMatchObject({
        valid: true,
        errors: [],
      });
    }
  });

  test("requires reactor redline output to meet nominal output", () => {
    const item = createDefaultShipData().items.find(({ system }) =>
      system.componentClass === "reactor"
    );
    item.system.definition.redlineOutput = item.system.definition.nominalOutput;
    expect(validateComponentItem(item)).toMatchObject({
      valid: true,
      errors: [],
    });
    item.system.definition.redlineOutput -= 1;
    expect(validateComponentItem(item)).toMatchObject({
      valid: false,
      errors: [{
        code: "INVALID_REACTOR_LIMITS",
        path: "system.definition.redlineOutput",
      }],
    });
  });

  test("requires positive passive and active sensor ranges while allowing signed modifiers", () => {
    const item = createDefaultShipData().items.find(({ system }) =>
      system.componentClass === "sensor"
    );
    Object.assign(item.system.definition.base, {
      passiveRange: 0.5,
      activeRange: 0.5,
      activeModifier: -1,
      ewModifier: -1,
    });
    expect(validateComponentItem(item)).toMatchObject({
      valid: true,
      errors: [],
    });
    Object.assign(item.system.definition.base, {
      passiveRange: 0,
      activeRange: -1,
    });
    expect(validateComponentItem(item)).toMatchObject({
      valid: false,
      errors: [
        { code: "INVALID_NUMBER", path: "system.definition.base.passiveRange" },
        { code: "INVALID_NUMBER", path: "system.definition.base.activeRange" },
      ],
    });
  });
});

describe("ship data defaults", () => {
  test("returns independent mutable configs, Items, and states without modifying the frozen reference", () => {
    const first = createDefaultShipData();
    const second = createDefaultShipData();
    const firstMainDriveItem = first.items.find(({ _id }) =>
      _id === CANADENSIS_IDS.mainDrive
    );
    const secondMainDriveItem = second.items.find(({ _id }) =>
      _id === CANADENSIS_IDS.mainDrive
    );

    expect(first.config).not.toBe(second.config);
    expect(first.config.components.drives).not.toBe(
      second.config.components.drives,
    );
    expect(first.config.components.drives.main).not.toBe(
      second.config.components.drives.main,
    );
    expect(first.items).not.toBe(second.items);
    expect(firstMainDriveItem).not.toBe(secondMainDriveItem);
    expect(firstMainDriveItem.system.definition).not.toBe(
      secondMainDriveItem.system.definition,
    );
    expect(first.state).not.toBe(second.state);
    expect(first.state.shields).not.toBe(second.state.shields);
    expect(Object.isFrozen(CANADENSIS_CONFIG)).toBe(true);
    expect(Object.isFrozen(CANADENSIS_CONFIG.components.drives.main.base)).toBe(
      true,
    );

    first.config.label = "Mutable Test Ship";
    first.config.components.drives.main.base.thrust = 99;
    first.config.components.drives.main.tiers[0].multiplier = 99;
    firstMainDriveItem.system.definition.base.thrust = 77;
    first.state.hull = 1;
    first.state.effects.push({ id: "test-effect" });

    expect(first.config.label).toBe("Mutable Test Ship");
    expect(first.config.components.drives.main.base.thrust).toBe(99);
    expect(firstMainDriveItem.system.definition.base.thrust).toBe(77);
    expect(first.state.hull).toBe(1);
    expect(first.state.effects).toEqual([{ id: "test-effect" }]);
    expect(second.config.label).toBe("Canadensis Training Corvette");
    expect(second.config.components.drives.main.base.thrust).toBe(6);
    expect(firstMainDriveItem.system.definition.tiers[0].multiplier).toBe(0);
    expect(second.config.components.drives.main.tiers[0].multiplier).toBe(0);
    expect(CANADENSIS_CONFIG.components.drives.main.tiers[0].multiplier).toBe(
      0,
    );
    expect(secondMainDriveItem.system.definition.base.thrust).toBe(6);
    expect(second.state.hull).toBe(50);
    expect(second.state.effects).toEqual([]);
    expect(CANADENSIS_CONFIG.label).toBe("Canadensis Training Corvette");
    expect(CANADENSIS_CONFIG.components.drives.main.base.thrust).toBe(6);
  });

  test("stores a component-free hull and materializes independent embedded identities", () => {
    const stored = createDefaultShipSystemData();
    const defaults = createDefaultShipData();
    const effective = materializeShipConfig(defaults.hull, defaults.items);
    const railgun = effective.components.weapons.find(({ id }) =>
      id === CANADENSIS_IDS.railgun
    );
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
    const sensorSlot = defaults.hull.slots.find(({ itemId }) =>
      itemId === CANADENSIS_IDS.sensor
    );
    sensorSlot.itemId = null;

    expect(validateHullConfig(defaults.hull)).toMatchObject({
      valid: true,
      errors: [],
    });
    const effective = materializeShipConfig(defaults.hull, defaults.items);
    const normalized = normalizeShipData({
      schemaVersion: defaults.schemaVersion,
      config: defaults.hull,
      state: {},
    }, defaults.items);

    expect(effective.components.sensor).toBeNull();
    expect(
      normalized.config.slots.find(({ id }) => id === sensorSlot.id).itemId,
    ).toBeNull();
    expect(normalized.state.power.sensors).toBe(0);
  });

  test("normalization preserves supplied values, fills missing fields, and does not mutate its input", () => {
    const supplied = createDefaultShipData();
    supplied.config.label = "Supplied Ship";
    supplied.state.hull = 17;
    supplied.state.power.engines = 4;
    supplied.state.history = [{
      type: "supplied-event",
      details: { kept: true },
    }];
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
    expect(normalized.state.history).toBeUndefined();
    expect(normalized.config.label).toBe("Supplied Ship");
    expect(normalized.state.hull).toBe(17);
    expect(normalized.state.power.engines).toBe(4);
    expect(supplied.state.history).toEqual([{
      type: "supplied-event",
      details: { kept: true },
    }]);
    expect(normalized.state.extension).toEqual({ nested: ["kept"] });
    expect(normalized.schemaVersion).toBe(CANADENSIS_CONFIG.schemaVersion);
    expect(normalized.state.schemaVersion).toBe(
      CANADENSIS_CONFIG.schemaVersion,
    );
    expect(normalized.state.phase).toBe("outsideCombat");
    expect(normalized.state.power.shields).toBe(3);
    expect(normalized.state.velocity).toEqual({ x: 0, y: 0 });

    normalized.config.label = "Changed Normalized Ship";
    normalized.state.extension.nested.push("changed");

    expect(supplied.config.label).toBe("Supplied Ship");
    expect(supplied.state.history).toEqual([{
      type: "supplied-event",
      details: { kept: true },
    }]);
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

  test("maps explicit flat and nested native edits into hull configuration and current hull", () => {
    const { config, state } = createDefaultShipData();
    const fields = {
      "system.attributes.ac.flat": 18,
      "system.attributes.hp.max": 80,
      "system.attributes.hp.value": 65,
      "system.traits.size": "grg",
    };
    const expected = {
      "system.shipCombat.config.ac": 18,
      "system.shipCombat.config.maxHull": 80,
      "system.shipCombat.state.hull": 65,
      "system.shipCombat.config.size": "gargantuan",
    };
    expect(shipFieldsFromNativeVehicleChanges(fields, config, state)).toEqual(
      expected,
    );
    expect(shipFieldsFromNativeVehicleChanges(
      {
        system: {
          attributes: { ac: { flat: 18 }, hp: { max: 80, value: 65 } },
          traits: { size: "grg" },
        },
      },
      config,
      state,
    )).toEqual(expected);
  });

  test("lowering maximum hull clamps damage state but raising it does not heal", () => {
    const { config, state } = createDefaultShipData();
    state.hull = 37;
    expect(
      shipFieldsFromNativeVehicleChanges(
        { "system.attributes.hp.max": 20 },
        config,
        state,
      ),
    ).toEqual({
      "system.shipCombat.config.maxHull": 20,
      "system.shipCombat.state.hull": 20,
    });
    expect(
      shipFieldsFromNativeVehicleChanges(
        { "system.attributes.hp.max": 80 },
        config,
        state,
      ),
    ).toEqual({
      "system.shipCombat.config.maxHull": 80,
    });
    expect(
      shipFieldsFromNativeVehicleChanges(
        { "system.attributes.hp.value": -5 },
        config,
        state,
      ),
    ).toEqual({
      "system.shipCombat.state.hull": 0,
    });
    expect(
      shipFieldsFromNativeVehicleChanges(
        { "system.attributes.hp.value": 90 },
        config,
        state,
      ),
    ).toEqual({
      "system.shipCombat.state.hull": 50,
    });
  });

  test("rejecting config edits still accepts current HP against the unchanged hull maximum", () => {
    const { config, state } = createDefaultShipData();
    state.hull = 10;
    expect(shipFieldsFromNativeVehicleChanges(
      {
        system: {
          attributes: { ac: { flat: 18 }, hp: { max: 20, value: 35 } },
          traits: { size: "lg" },
        },
      },
      config,
      state,
      { allowConfig: false },
    )).toEqual({
      "system.shipCombat.state.hull": 35,
    });
    expect(
      shipFieldsFromNativeVehicleChanges(
        { "system.attributes.hp.max": 5 },
        config,
        state,
        { allowConfig: false },
      ),
    ).toEqual({});
  });

  test("ignores unrelated or unsupported native changes rather than rewriting ship config", () => {
    const { config, state } = createDefaultShipData();
    expect(
      shipFieldsFromNativeVehicleChanges(
        { name: "Renamed ship" },
        config,
        state,
      ),
    ).toEqual({});
    expect(shipFieldsFromNativeVehicleChanges(
      {
        system: {
          attributes: {
            ac: { calc: "natural", flat: -1 },
            hp: { max: 0, temp: 12, value: "invalid" },
          },
          details: { type: "water" },
          traits: { size: "unsupported" },
        },
      },
      config,
      state,
    )).toEqual({});
    expect(
      shipFieldsFromNativeVehicleChanges(
        nativeVehicleFieldValues(config, state),
        config,
        state,
      ),
    ).toEqual({});
  });
});

describe("ship console display identities", () => {
  test("shows installed component names and fault labels while retaining recovery identities", () => {
    const defaults = createDefaultShipData();
    const names = new Map([
      [CANADENSIS_IDS.reactor, "Heart of the ship"],
      [CANADENSIS_IDS.mainDrive, "Longstride"],
      [CANADENSIS_IDS.railgun, "Needle"],
      [CANADENSIS_IDS.shield, "Guardian"],
    ]);
    for (const item of defaults.items) {
      if (names.has(item._id)) item.name = names.get(item._id);
    }
    const config = materializeShipConfig(defaults.hull, defaults.items);
    const emitter = config.components.shield.emitters.find(({ sector }) =>
      sector === "fore"
    );
    defaults.state.conditions = {
      reactorRecovery: {
        channelId: "reactorFault",
        componentId: CANADENSIS_IDS.reactor,
        severity: "minor",
      },
      driveRecovery: {
        channelId: "driveFailure",
        componentId: CANADENSIS_IDS.mainDrive,
        severity: "minor",
      },
      weaponRecovery: {
        channelId: "weaponMalfunction",
        componentId: CANADENSIS_IDS.railgun,
        severity: "minor",
      },
      emitterRecovery: {
        channelId: "shieldEmitterDamage",
        componentId: emitter.id,
        severity: "minor",
      },
      shieldRecovery: {
        channelId: "shieldEmitterDamage",
        componentId: CANADENSIS_IDS.shield,
        sector: "aft",
        severity: "major",
      },
    };
    const before = clone({ config, state: defaults.state });
    const conditions = new Map(
      buildShipConsoleView(config, defaults.state).conditions.map((
        condition,
      ) => [condition.id, condition]),
    );
    expect(conditions.get("reactorRecovery")).toMatchObject({
      componentLabel: "Heart of the ship",
      label: "Reactor Fault",
      componentId: CANADENSIS_IDS.reactor,
    });
    expect(conditions.get("driveRecovery")).toMatchObject({
      componentLabel: "Longstride",
      label: "Drive Failure",
      componentId: CANADENSIS_IDS.mainDrive,
    });
    expect(conditions.get("weaponRecovery")).toMatchObject({
      componentLabel: "Needle",
      label: "Weapon Malfunction",
      componentId: CANADENSIS_IDS.railgun,
    });
    expect(conditions.get("emitterRecovery")).toMatchObject({
      componentLabel: "Guardian · Fore emitter",
      label: "Shield Emitter Damage",
      componentId: emitter.id,
    });
    expect(conditions.get("shieldRecovery")).toMatchObject({
      componentLabel: "Guardian · Aft emitter",
      componentId: CANADENSIS_IDS.shield,
    });
    expect({ config, state: defaults.state }).toEqual(before);
  });

  test("names hazard regions without exposing unresolved condition or target identifiers", () => {
    const { config, state } = createDefaultShipData();
    state.conditions = {
      foreFire: {
        kind: "hazard",
        channelId: "fire",
        targetId: "fore",
        region: "fore",
        severity: "minor",
      },
      cascade: {
        kind: "hazard",
        channelId: "electricalCascade",
        targetId: "ship",
        severity: "minor",
      },
      missingRegion: {
        kind: "hazard",
        channelId: "breach",
        targetId: "opaque-region-id",
        severity: "minor",
      },
      missingComponent: {
        kind: "fault",
        channelId: "opaque-channel-id",
        componentId: "opaque-item-id",
        severity: "minor",
      },
      missingChannel: {
        id: "opaque-condition-id",
        componentId: "another-item-id",
        severity: "minor",
      },
    };
    const conditions = new Map(
      buildShipConsoleView(config, state).conditions.map((
        condition,
      ) => [condition.id, condition]),
    );
    expect(conditions.get("foreFire")).toMatchObject({
      label: "Fire",
      componentLabel: "Fore",
      componentId: "fore",
    });
    expect(conditions.get("cascade")).toMatchObject({
      label: "Electrical Cascade",
      componentLabel: "Ship",
      componentId: "ship",
    });
    expect(conditions.get("missingRegion")).toMatchObject({
      label: "Breach",
      componentLabel: "Unknown region",
      componentId: "opaque-region-id",
    });
    expect(conditions.get("missingComponent")).toMatchObject({
      label: "Unknown condition",
      componentLabel: "Unknown component",
      componentId: "opaque-item-id",
    });
    expect(conditions.get("missingChannel")).toMatchObject({
      label: "Unknown condition",
      componentLabel: "Unknown component",
      componentId: "another-item-id",
    });
  });

  test("formats combat phases and zero-based turns without displaying malformed bookkeeping", () => {
    const { config, state } = createDefaultShipData();
    expect(buildShipConsoleView(config, state).status).toMatchObject({
      phaseLabel: "Outside Combat",
      turnLabel: "",
    });
    state.phase = "start";
    state.turnKey = "private-combat-id:0:0";
    state.revision = 17;
    expect(buildShipConsoleView(config, state).status).toMatchObject({
      phase: "start",
      phaseLabel: "Start Phase",
      turnKey: "private-combat-id:0:0",
      turnLabel: "Round 0 / Turn 1",
      revision: 17,
    });
    state.phase = "active";
    state.turnKey = "private-combat-id:12:4";
    expect(buildShipConsoleView(config, state).status).toMatchObject({
      phaseLabel: "Active Phase",
      turnLabel: "Round 12 / Turn 5",
    });
    state.phase = "end";
    expect(buildShipConsoleView(config, state).status.phaseLabel).toBe(
      "End Phase",
    );
    state.phase = "opaque-phase-id";
    for (
      const turnKey of [
        null,
        "private-combat-id",
        ":2:0",
        "private-combat-id:2:-1",
        "private-combat-id:2:0.5",
        "private-combat-id:2:9007199254740991",
        "private-combat-id:2:0:extra",
      ]
    ) {
      state.turnKey = turnKey;
      expect(buildShipConsoleView(config, state).status).toMatchObject({
        phaseLabel: "Unknown phase",
        turnLabel: "",
      });
    }
  });
});
