import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { COMPONENT_ITEM_TYPE, SCHEMA_VERSION, SHIP_TYPE } from "../scripts/constants.js";
import { CANADENSIS_CONFIG, CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import { migrateShipActor } from "../scripts/foundry/migration.js";
import { createInitialState } from "../scripts/model/defaults.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";

const clone = (value) => structuredClone(value);

const LEGACY_IDS = Object.freeze({
  reactor: "canadensis-reactor",
  shield: "canadensis-shield",
  sensor: "canadensis-sensor",
  cooling: "canadensis-cooling",
  drive: "canadensis-drive",
  weapons: [
    "canadensis-twin-railgun",
    "canadensis-pulse-laser",
    "canadensis-port-macrocannon",
    "canadensis-starboard-macrocannon",
  ],
});

const V2_DRIVE_IDS = Object.freeze([
  "CanadMainDrive01",
  "CanadRevDrive001",
  "CanadLateralA001",
  "CanadLateralB001",
]);

const V2_WEAPON_IDS = Object.freeze([
  CANADENSIS_IDS.railgun,
  CANADENSIS_IDS.laser,
  CANADENSIS_IDS.portMacrocannon,
  CANADENSIS_IDS.starboardMacrocannon,
]);

class FakeForcedReplacement {
  constructor(value) {
    this.value = value;
  }

  static create(value) {
    return new FakeForcedReplacement(value);
  }
}

function mergeLikeFoundry(current, update) {
  if (Array.isArray(update) || !update || typeof update !== "object") return clone(update);
  const result = current && typeof current === "object" && !Array.isArray(current) ? clone(current) : {};
  for (const [key, value] of Object.entries(update)) {
    result[key] = Array.isArray(value) || !value || typeof value !== "object"
      ? clone(value)
      : mergeLikeFoundry(result[key], value);
  }
  return result;
}

function itemDocument(source, fallbackId) {
  const data = clone(source);
  const id = data._id ?? fallbackId;
  return {
    ...data,
    _id: id,
    id,
    getFlag(moduleId, key) {
      return this.flags?.[moduleId]?.[key];
    },
  };
}

class FakeActor {
  constructor(shipCombat = {}) {
    this.id = `actor-${FakeActor.nextActorId++}`;
    this.uuid = `Actor.${this.id}`;
    this.type = SHIP_TYPE;
    this.system = { shipCombat: clone(shipCombat) };
    this.items = new Map();
    this.creationCalls = [];
    this.updates = [];
  }

  async createEmbeddedDocuments(documentName, sources, options) {
    expect(documentName).toBe("Item");
    const created = sources.map((source, index) => itemDocument(source, `generated-${this.items.size + index + 1}`));
    for (const item of created) this.items.set(item.id, item);
    this.creationCalls.push({ items: created, options: clone(options) });
    return created;
  }

  async update(changes, options) {
    const supplied = changes["system.shipCombat"];
    const forced = supplied instanceof FakeForcedReplacement;
    const payload = forced ? supplied.value : supplied;
    this.system.shipCombat = forced
      ? clone(payload)
      : mergeLikeFoundry(this.system.shipCombat, payload);
    this.updates.push({ payload: clone(payload), forced, options: clone(options) });
    return this;
  }
}

FakeActor.nextActorId = 1;

function legacyReferenceShip() {
  const config = clone(CANADENSIS_CONFIG);
  const drives = config.components.drives;
  config.schemaVersion = 1;
  delete config.slots;
  config.components.drive = {
    id: LEGACY_IDS.drive,
    label: "Canadensis Aggregate Drive",
    class: "drive",
    regions: [...new Set(Object.values(drives).flatMap(({ regions }) => regions))],
    base: {
      forward: drives.main.base.thrust,
      retro: drives.reverse.base.thrust,
      port: drives.portLateral.base.thrust,
      starboard: drives.starboardLateral.base.thrust,
      rotation: drives.portLateral.base.rotation + drives.starboardLateral.base.rotation,
    },
    tiers: clone(config.powerSystems.engines.tiers),
    recoveryWork: {
      drive: Math.max(drives.main.recoveryWork, drives.reverse.recoveryWork),
      maneuveringThrusters: Math.max(
        drives.portLateral.recoveryWork,
        drives.starboardLateral.recoveryWork,
      ),
    },
  };
  delete config.components.drives;

  for (const componentClass of ["reactor", "shield", "sensor", "cooling"]) {
    config.components[componentClass].id = LEGACY_IDS[componentClass];
  }
  config.components.weapons.forEach((weapon, index) => {
    weapon.id = LEGACY_IDS.weapons[index];
  });
  config.hardpoints.forEach((hardpoint, index) => {
    hardpoint.weaponId = LEGACY_IDS.weapons[index];
  });
  config.weaponPriority = [...LEGACY_IDS.weapons];
  config.capabilityProfile.evasionHardware = [
    { componentId: LEGACY_IDS.drive, channel: "drive" },
    { componentId: LEGACY_IDS.drive, channel: "maneuveringThrusters" },
  ];
  config.criticalPools = {
    fore: [
      { id: `driveFailure:${LEGACY_IDS.drive}`, kind: "fault", componentId: LEGACY_IDS.drive, channelId: "driveFailure", sector: null, weight: 1 },
      { id: `weaponMalfunction:${LEGACY_IDS.weapons[0]}`, kind: "fault", componentId: LEGACY_IDS.weapons[0], channelId: "weaponMalfunction", sector: null, weight: 1 },
    ],
    port: [
      { id: `maneuveringThrusterFailure:${LEGACY_IDS.drive}`, kind: "fault", componentId: LEGACY_IDS.drive, channelId: "maneuveringThrusterFailure", sector: null, weight: 1 },
    ],
    starboard: [],
    aft: [
      { id: `reactorFault:${LEGACY_IDS.reactor}`, kind: "fault", componentId: LEGACY_IDS.reactor, channelId: "reactorFault", sector: null, weight: 1 },
      { id: "fire:aft", kind: "hazard", componentId: null, channelId: "fire", sector: "aft", weight: 1 },
    ],
  };

  const state = createInitialState(CANADENSIS_CONFIG);
  state.schemaVersion = 1;
  state.revision = 7;
  state.phase = "active";
  state.hull = 31;
  state.heat = 8;
  state.velocity = { x: 4.5, y: -2 };
  state.timeline = 2.25;
  state.rotationSpent = 17;
  state.history = [{ id: "kept-history", type: "coast", timestamp: 1234, submitterId: "gm" }];
  state.weapons = Object.fromEntries(LEGACY_IDS.weapons.map((id, index) => [
    id,
    clone(state.weapons[V2_WEAPON_IDS[index]]),
  ]));
  state.weaponPriority = [...LEGACY_IDS.weapons];
  state.conditions = {
    [`${LEGACY_IDS.drive}:driveFailure`]: {
      id: `${LEGACY_IDS.drive}:driveFailure`,
      targetId: LEGACY_IDS.drive,
      channelId: "driveFailure",
      tier: "destroyed",
    },
    [`${LEGACY_IDS.drive}:maneuveringThrusterFailure`]: {
      id: `${LEGACY_IDS.drive}:maneuveringThrusterFailure`,
      targetId: LEGACY_IDS.drive,
      channelId: "maneuveringThrusterFailure",
      tier: "critical",
    },
  };
  state.work = {
    [`recovery:${LEGACY_IDS.drive}:driveFailure`]: {
      id: `recovery:${LEGACY_IDS.drive}:driveFailure`,
      targetId: LEGACY_IDS.drive,
      conditionId: "driveFailure",
      current: 3,
      required: 4,
    },
    [`recovery:${LEGACY_IDS.drive}:maneuveringThrusterFailure`]: {
      id: `recovery:${LEGACY_IDS.drive}:maneuveringThrusterFailure`,
      targetId: LEGACY_IDS.drive,
      conditionId: "maneuveringThrusterFailure",
      current: 2,
      required: 3,
    },
  };
  state.effects = [{
    id: `weapon:${LEGACY_IDS.weapons[0]}`,
    type: "signature",
    category: `weapon:${LEGACY_IDS.weapons[0]}`,
    sourceId: LEGACY_IDS.weapons[0],
    modifier: -2,
  }];

  return { schemaVersion: 1, config, state };
}

function persistedItems(actor) {
  return [...actor.items.values()];
}

function allFaults(config) {
  return Object.values(config.criticalPools).flat().filter((entry) => entry.kind === "fault");
}

let previousFoundry;
let previousGame;
let previousUi;
let warnings;

beforeEach(() => {
  previousFoundry = globalThis.foundry;
  previousGame = globalThis.game;
  previousUi = globalThis.ui;
  warnings = [];
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: gm, users: { activeGM: gm } };
  globalThis.foundry = { data: { operators: { ForcedReplacement: FakeForcedReplacement } } };
  globalThis.ui = { notifications: { warn(message) { warnings.push(message); } } };
});

afterEach(() => {
  globalThis.foundry = previousFoundry;
  globalThis.game = previousGame;
  globalThis.ui = previousUi;
});

describe("ship schema migration", () => {
  test("initializes a new ship once with twelve independent Items outside combat", async () => {
    const actor = new FakeActor();

    expect(await migrateShipActor(actor)).toBe(true);
    expect(await migrateShipActor(actor)).toBe(false);

    const items = persistedItems(actor);
    expect(items).toHaveLength(12);
    expect(new Set(items.map((item) => item.id)).size).toBe(12);
    expect(items.every((item) => item.type === COMPONENT_ITEM_TYPE)).toBe(true);
    expect(actor.creationCalls).toHaveLength(1);
    expect(actor.creationCalls[0].items).toHaveLength(12);
    expect(actor.updates).toHaveLength(1);
    expect(actor.system.shipCombat.state.phase).toBe("outsideCombat");

    const port = actor.items.get("CanadLateralA001");
    const starboard = actor.items.get("CanadLateralB001");
    expect(port.system.definition).not.toBe(starboard.system.definition);
    port.system.definition.base.thrust = 99;
    expect(starboard.system.definition.base.thrust).toBe(2);
  });

  test("replaces a representative v1 snapshot, preserves play state, and migrates split drive identities once", async () => {
    const legacy = legacyReferenceShip();
    const actor = new FakeActor(legacy);

    expect(await migrateShipActor(actor)).toBe(true);
    expect(await migrateShipActor(actor)).toBe(false);

    const { config, state } = actor.system.shipCombat;
    expect(actor.updates).toHaveLength(1);
    expect(actor.creationCalls).toHaveLength(1);
    expect(persistedItems(actor)).toHaveLength(12);
    expect(actor.system.shipCombat.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.revision).toBe(8);
    expect(state).toMatchObject({
      phase: "active",
      hull: 31,
      heat: 8,
      velocity: { x: 4.5, y: -2 },
      timeline: 2.25,
      rotationSpent: 17,
      history: [{ id: "kept-history", type: "coast", timestamp: 1234, submitterId: "gm" }],
    });

    expect(Object.hasOwn(config, "components")).toBe(false);
    expect(config.capabilityProfile.evasionHardware.every((entry) => !Object.hasOwn(entry, "componentId"))).toBe(true);
    expect(allFaults(config).every((entry) => !Object.hasOwn(entry, "componentId"))).toBe(true);
    expect(Object.keys(state.conditions).some((key) => key.includes(LEGACY_IDS.drive))).toBe(false);
    expect(Object.keys(state.work).some((key) => key.includes(LEGACY_IDS.drive))).toBe(false);
    expect(Object.keys(state.weapons)).not.toContain(LEGACY_IDS.weapons[0]);
    expect(state.weaponPriority).not.toContain(LEGACY_IDS.weapons[0]);
    expect(JSON.stringify(state.effects)).not.toContain(LEGACY_IDS.weapons[0]);

    const effective = materializeShipConfig(config, persistedItems(actor));
    expect(Object.keys(effective.components.drives).sort()).toEqual([
      "main",
      "portLateral",
      "reverse",
      "starboardLateral",
    ]);
    expect(Object.values(effective.components.drives).map(({ id }) => id).sort()).toEqual([...V2_DRIVE_IDS].sort());

    const driveConditionTargets = Object.values(state.conditions)
      .filter(({ channelId }) => channelId === "driveFailure")
      .map(({ targetId }) => targetId)
      .sort();
    const thrusterConditionTargets = Object.values(state.conditions)
      .filter(({ channelId }) => channelId === "maneuveringThrusterFailure")
      .map(({ targetId }) => targetId)
      .sort();
    expect(driveConditionTargets).toEqual(["CanadMainDrive01", "CanadRevDrive001"].sort());
    expect(thrusterConditionTargets).toEqual(["CanadLateralA001", "CanadLateralB001"].sort());
    expect([...driveConditionTargets, ...thrusterConditionTargets].every((id) => actor.items.has(id))).toBe(true);

    const recovery = Object.values(state.work);
    expect(recovery).toHaveLength(2);
    expect(recovery.map(({ current }) => current).sort()).toEqual([2, 3]);
    expect(recovery.filter(({ conditionId }) => conditionId === "driveFailure")).toHaveLength(1);
    expect(recovery.filter(({ conditionId }) => conditionId === "maneuveringThrusterFailure")).toHaveLength(1);
    expect(recovery.every(({ targetId }) => actor.items.has(targetId))).toBe(true);
  });

  test("drops unsupported Special and orphan equipment while leaving a materializable v2 hull", async () => {
    const legacy = legacyReferenceShip();
    const special = legacy.config.components.weapons[0];
    special.category = "Special";
    const orphan = clone(legacy.config.components.weapons[1]);
    orphan.id = "canadensis-orphan-weapon";
    orphan.label = "Orphan Weapon";
    legacy.config.components.weapons.push(orphan);
    legacy.config.weaponPriority.push(orphan.id);
    legacy.config.criticalPools.fore.push(
      { id: `weaponMalfunction:${orphan.id}`, kind: "fault", componentId: orphan.id, channelId: "weaponMalfunction", sector: null, weight: 1 },
    );
    legacy.state.weapons[orphan.id] = clone(legacy.state.weapons[LEGACY_IDS.weapons[1]]);
    legacy.state.conditions[`weaponMalfunction:${special.id}`] = {
      id: `weaponMalfunction:${special.id}`,
      targetId: special.id,
      channelId: "weaponMalfunction",
      tier: "major",
    };
    legacy.state.conditions[`weaponMalfunction:${orphan.id}`] = {
      id: `weaponMalfunction:${orphan.id}`,
      targetId: orphan.id,
      channelId: "weaponMalfunction",
      tier: "minor",
    };
    const actor = new FakeActor(legacy);

    expect(await migrateShipActor(actor)).toBe(true);
    expect(warnings).toHaveLength(1);

    const { config, state } = actor.system.shipCombat;
    const effective = materializeShipConfig(config, persistedItems(actor));
    expect(effective.components.weapons).toHaveLength(3);
    expect(config.hardpoints.find(({ id }) => id === CANADENSIS_IDS.prowHardpoint).weaponId).toBeNull();
    expect(persistedItems(actor).some(({ name }) => name === special.label || name === orphan.label)).toBe(false);
    expect(allFaults(config).some(({ id }) => id.includes(special.id) || id.includes(orphan.id))).toBe(false);
    expect(Object.keys(state.weapons)).not.toContain(special.id);
    expect(Object.keys(state.weapons)).not.toContain(orphan.id);
    expect(Object.keys(state.conditions).some((key) => key.includes(special.id) || key.includes(orphan.id))).toBe(false);
    expect(actor.system.shipCombat.schemaVersion).toBe(SCHEMA_VERSION);
    expect(state.revision).toBe(8);
  });
});
