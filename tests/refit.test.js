import { beforeEach, describe, expect, test } from "bun:test";

import { CANADENSIS_CONFIG, CANADENSIS_HULL_CONFIG, CANADENSIS_SLOT_IDS } from "../scripts/data/canadensis.js";
import {
  CANADENSIS_DEFAULT_COMPONENT_SOURCES,
  CANADENSIS_LATERAL_DRIVE_SOURCE,
} from "../scripts/data/canadensis-components.js";
import { createDefaultShipData } from "../scripts/model/defaults.js";
import * as refit from "../scripts/foundry/refit.js";
import { registerShipHooks } from "../scripts/foundry/hooks.js";
import { SHIP_TYPE } from "../scripts/constants.js";

const clone = (value) => structuredClone(value);

class FakeForcedReplacement {
  constructor(value) {
    this.value = value;
  }

  static create(value) {
    return new FakeForcedReplacement(value);
  }
}

class FakeItem {
  constructor(source) {
    Object.assign(this, clone(source));
    this.id = source._id;
    this._id = source._id;
  }

  toObject() {
    return clone({ ...this, id: undefined });
  }
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = clone(value);
}

function references(hull) {
  return [
    ...(hull.slots ?? []).map((slot) => slot.itemId),
    ...(hull.hardpoints ?? []).map((hardpoint) => hardpoint.weaponId),
  ].filter(Boolean);
}

class FakeActor {
  constructor() {
    const defaults = createDefaultShipData();
    this.id = "ship-1";
    this.uuid = "Actor.ship-1";
    this.system = { shipCombat: { config: clone(defaults.hull), state: clone(defaults.state) } };
    this.prototypeToken = { width: 1 };
    this.items = new Map(defaults.items.map((source) => {
      const item = new FakeItem(source);
      return [item.id, item];
    }));
    this.events = [];
    this.nextId = 1;
    this.failNextUpdate = false;
  }

  async createEmbeddedDocuments(documentName, sources, options) {
    expect(documentName).toBe("Item");
    const created = sources.map((source) => {
      expect(source._id).toBeUndefined();
      expect(source.id).toBeUndefined();
      const item = new FakeItem({ ...clone(source), _id: `fresh-${String(this.nextId++).padStart(4, "0")}` });
      this.items.set(item.id, item);
      return item;
    });
    this.events.push({ type: "create", ids: created.map((item) => item.id), options: clone(options) });
    return created;
  }

  async update(changes, options) {
    this.events.push({ type: "update", options: clone(options) });
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("simulated update failure");
    }
    for (const [path, supplied] of Object.entries(changes)) {
      const value = supplied instanceof FakeForcedReplacement ? supplied.value : supplied;
      setPath(this, path, value);
    }
    return this;
  }

  async deleteEmbeddedDocuments(documentName, ids, options) {
    expect(documentName).toBe("Item");
    const visibleReferences = references(this.system.shipCombat.config);
    this.events.push({ type: "delete", ids: [...ids], visibleReferences, options: clone(options) });
    const deleted = ids.map((id) => this.items.get(id)).filter(Boolean);
    for (const id of ids) this.items.delete(id);
    return deleted;
  }
}

function withoutId(source) {
  const result = clone(source);
  delete result._id;
  delete result.id;
  return result;
}

let actor;
let activeGm;

beforeEach(() => {
  activeGm = { id: "gm-active", isGM: true, active: true };
  globalThis.game = {
    user: activeGm,
    users: Object.assign(new Map([[activeGm.id, activeGm]]), { activeGM: activeGm }),
  };
  globalThis.foundry = {
    data: { operators: { ForcedReplacement: FakeForcedReplacement } },
    utils: { deepClone: clone },
  };
  actor = new FakeActor();
});

describe("refit API", () => {
  test("exports only the shared API and materializes embedded component Items", () => {
    expect(Object.keys(refit).sort()).toEqual([
      "getRefitDenial",
      "installShipComponent",
      "materializeActorConfig",
      "removeShipComponent",
      "resetShipToCanadensis",
      "saveShipHull",
    ]);
    actor.items.set("ordinary-item", { id: "ordinary-item", type: "equipment", system: {} });
    expect(refit.materializeActorConfig(actor)).toEqual(CANADENSIS_CONFIG);
  });

  test("rejects mismatched hardware before creating an embedded copy", async () => {
    const wrongSize = clone(CANADENSIS_LATERAL_DRIVE_SOURCE);
    wrongSize._id = "catalog-wrong-size";
    wrongSize.system.size = "large";
    const specialWeapon = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES[8]);
    specialWeapon._id = "catalog-special-weapon";
    specialWeapon.system.definition.category = "spinal";
    const hardpointId = actor.system.shipCombat.config.hardpoints[0].id;

    await expect(refit.installShipComponent(actor, CANADENSIS_SLOT_IDS.portLateralDrive, wrongSize))
      .rejects.toMatchObject({ code: "INCOMPATIBLE_COMPONENT_SIZE" });
    await expect(refit.installShipComponent(actor, CANADENSIS_SLOT_IDS.mainDrive, CANADENSIS_LATERAL_DRIVE_SOURCE))
      .rejects.toMatchObject({ code: "INCOMPATIBLE_DRIVE_ROLE" });
    await expect(refit.installShipComponent(actor, hardpointId, CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]))
      .rejects.toMatchObject({ code: "INCOMPATIBLE_COMPONENT_CLASS" });
    await expect(refit.installShipComponent(actor, hardpointId, specialWeapon))
      .rejects.toMatchObject({ code: "UNSUPPORTED_SPECIAL_WEAPON" });
    expect(actor.events).toEqual([]);
  });

  test("installs a fresh copy, resets only replaced-component state, and bumps once", async () => {
    const mount = actor.system.shipCombat.config.hardpoints[0];
    const oldId = mount.weaponId;
    const beforeRevision = actor.system.shipCombat.state.revision;
    Object.assign(actor.system.shipCombat.state, {
      hull: 17,
      heat: 9,
      velocity: { x: 4, y: -2 },
      history: [{ type: "kept" }],
      conditions: {
        local: { id: "local", kind: "fault", componentId: oldId, targetId: oldId, severity: "major" },
        hazard: { id: "hazard", kind: "hazard", targetId: "fore", severity: "minor" },
      },
      work: {
        [`recover:${oldId}`]: { id: `recover:${oldId}`, targetId: oldId, current: 1 },
        global: { id: "global", targetId: "fore", current: 2 },
      },
    });
    actor.system.shipCombat.state.weapons[oldId].readiness = 0;
    const catalog = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES[9]);
    catalog._id = "catalog-laser-template";

    const created = await refit.installShipComponent(actor, mount.id, catalog);
    const freshId = created.id;
    const state = actor.system.shipCombat.state;

    expect(freshId).not.toBe(catalog._id);
    expect(actor.system.shipCombat.config.hardpoints[0].weaponId).toBe(freshId);
    expect(actor.items.has(oldId)).toBe(false);
    expect(actor.items.has(freshId)).toBe(true);
    expect(state.weapons[oldId]).toBeUndefined();
    expect(state.weapons[freshId].readiness).toBe(3);
    expect(state.conditions).toEqual({ hazard: expect.any(Object) });
    expect(state.work).toEqual({ global: expect.any(Object) });
    expect(state).toMatchObject({
      hull: 17,
      heat: 9,
      velocity: { x: 4, y: -2 },
      history: [{ type: "kept" }],
      revision: beforeRevision + 1,
    });
    expect(actor.events.map(({ type }) => type)).toEqual(["create", "update", "delete"]);
    expect(actor.events.every(({ options }) => options.viraShipCombatRefit === true)).toBe(true);
    expect(actor.events.at(-1).visibleReferences).not.toContain(oldId);
  });

  test("cleans up the fresh Item if the atomic Actor update fails", async () => {
    const mount = actor.system.shipCombat.config.slots[0];
    const oldId = mount.itemId;
    const beforeIds = [...actor.items.keys()];
    actor.failNextUpdate = true;

    await expect(refit.installShipComponent(actor, mount.id, CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]))
      .rejects.toThrow("simulated update failure");

    expect(actor.system.shipCombat.config.slots[0].itemId).toBe(oldId);
    expect([...actor.items.keys()]).toEqual(beforeIds);
    expect(actor.events.map(({ type }) => type)).toEqual(["create", "update", "delete"]);
    expect(actor.events.at(-1).ids).toEqual(["fresh-0001"]);
  });

  test("clears a mount and its local state before deleting the old Item", async () => {
    const mount = actor.system.shipCombat.config.hardpoints[1];
    const oldId = mount.weaponId;
    actor.system.shipCombat.state.conditions.weapon = {
      id: `weaponMalfunction:${oldId}`,
      componentId: oldId,
      targetId: oldId,
      kind: "fault",
    };
    const revision = actor.system.shipCombat.state.revision;

    await refit.removeShipComponent(actor, mount.id);

    expect(actor.events.map(({ type }) => type)).toEqual(["update", "delete"]);
    expect(actor.events[1].visibleReferences).not.toContain(oldId);
    expect(actor.system.shipCombat.config.hardpoints[1].weaponId).toBeNull();
    expect(actor.system.shipCombat.state.weapons[oldId]).toBeUndefined();
    expect(actor.system.shipCombat.state.conditions).toEqual({});
    expect(actor.system.shipCombat.state.revision).toBe(revision + 1);
  });

  test("hull saves reconcile sensor-local state while preserving ship-global state", async () => {
    const hull = clone(actor.system.shipCombat.config);
    const sensor = hull.slots.find(({ id }) => id === CANADENSIS_SLOT_IDS.sensor);
    const sensorId = sensor.itemId;
    sensor.itemId = null;
    Object.assign(actor.system.shipCombat.state, {
      hull: 23,
      heat: 8,
      tracks: { target: { targetUuid: "Scene.s.Token.t", state: "contact" } },
      history: [{ type: "kept" }],
      conditions: {
        sensor: { id: `sensorFault:${sensorId}`, kind: "fault", componentId: sensorId },
        fire: { id: "fire:fore", kind: "hazard", targetId: "fore" },
      },
    });
    const revision = actor.system.shipCombat.state.revision;

    await refit.saveShipHull(actor, hull);

    expect(actor.system.shipCombat.state).toMatchObject({
      hull: 23,
      heat: 8,
      tracks: {},
      history: [{ type: "kept" }],
      revision: revision + 1,
    });
    expect(actor.system.shipCombat.state.conditions).toEqual({ fire: expect.any(Object) });
    expect(actor.system.shipCombat.state.power.sensors).toBe(0);
    expect(actor.items.has(sensorId)).toBe(true);
  });

  test("reset creates twelve independent fresh Items and exact bundled hull/component data", async () => {
    actor.system.shipCombat.state.hull = 11;
    actor.system.shipCombat.state.heat = 7;
    actor.system.shipCombat.state.velocity = { x: 3, y: 6 };
    actor.system.shipCombat.state.history = [{ type: "kept" }];
    const oldIds = new Set(actor.items.keys());
    const revision = actor.system.shipCombat.state.revision;

    const effective = await refit.resetShipToCanadensis(actor);
    const hull = actor.system.shipCombat.config;
    const mountedIds = references(hull);

    expect(mountedIds).toHaveLength(12);
    expect(new Set(mountedIds).size).toBe(12);
    expect(mountedIds.every((id) => !oldIds.has(id))).toBe(true);
    expect(actor.items.size).toBe(12);
    expect(actor.events.map(({ type }) => type)).toEqual(["create", "update", "delete"]);
    expect(actor.events[0].ids).toHaveLength(12);
    expect(actor.events[2].visibleReferences.some((id) => oldIds.has(id))).toBe(false);

    const expectedHull = clone(CANADENSIS_HULL_CONFIG);
    expectedHull.slots.forEach((slot) => { slot.itemId = expect.any(String); });
    expectedHull.hardpoints.forEach((hardpoint) => { hardpoint.weaponId = expect.any(String); });
    expect(hull).toEqual(expectedHull);
    expect(effective).toEqual(refit.materializeActorConfig(actor));
    expect(effective.label).toBe(CANADENSIS_CONFIG.label);
    expect(effective.components.weapons).toHaveLength(4);

    const installedSources = mountedIds.map((id) => withoutId(actor.items.get(id).toObject()));
    expect(installedSources).toEqual(CANADENSIS_DEFAULT_COMPONENT_SOURCES.map(withoutId));
    expect(actor.items.get(mountedIds[6]).system).not.toBe(actor.items.get(mountedIds[7]).system);
    expect(actor.system.shipCombat.state).toMatchObject({
      hull: 11,
      heat: 7,
      velocity: { x: 3, y: 6 },
      history: [{ type: "kept" }],
      revision: revision + 1,
    });
  });

  test("rejects invalid hull scalars with every actionable field error before persistence", async () => {
    const hull = clone(actor.system.shipCombat.config);
    hull.maxHull = -1;
    hull.heatCapacity = 0;
    hull.ac = "invalid";
    const before = clone(actor.system.shipCombat);

    const error = await refit.saveShipHull(actor, hull).catch((failure) => failure);

    expect(error.code).toBe("INVALID_SHIP_CONFIG");
    expect(error.details.map(({ path }) => path)).toEqual(expect.arrayContaining(["maxHull", "heatCapacity", "ac"]));
    for (const path of ["maxHull", "heatCapacity", "ac"]) expect(error.message).toContain(path);
    expect(actor.system.shipCombat).toEqual(before);
    expect(actor.events).toEqual([]);
  });

  test("validates installation and removal candidates using the synthetic Actor token width", async () => {
    actor.token = { width: 0 };
    const before = clone(actor.system.shipCombat);
    const ids = [...actor.items.keys()];
    const mount = actor.system.shipCombat.config.slots[0];

    await expect(refit.installShipComponent(actor, mount.id, CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]))
      .rejects.toMatchObject({ code: "INVALID_SHIP_CONFIG", details: expect.arrayContaining([expect.objectContaining({ path: "tokenWidth" })]) });
    await expect(refit.removeShipComponent(actor, mount.id)).rejects.toMatchObject({ code: "INVALID_SHIP_CONFIG" });
    await expect(refit.resetShipToCanadensis(actor)).rejects.toMatchObject({ code: "INVALID_SHIP_CONFIG" });
    expect(actor.system.shipCombat).toEqual(before);
    expect([...actor.items.keys()]).toEqual(ids);
    expect(actor.events.some(({ type }) => type === "update")).toBe(false);
  });

  test("installs only a single detached clean source without inherited provenance or effects", async () => {
    const catalog = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]);
    Object.assign(catalog, {
      flags: { core: { sourceId: "Compendium.private.reactor" }, "vira-shipcombat": { migration: { source: "old" } } },
      folder: "private-folder", sort: 12, ownership: { default: 3 },
      effects: [{ name: "Catalog effect" }], _stats: { compendiumSource: "Compendium.private.reactor" },
      provenance: { originalId: "old-item" },
    });
    const source = { toObject() { return clone(catalog); } };

    const created = await refit.installShipComponent(actor, actor.system.shipCombat.config.slots[0].id, source);

    expect(withoutId(created.toObject())).toEqual({ name: catalog.name, img: catalog.img, type: catalog.type, system: catalog.system });
    expect(catalog.flags.core.sourceId).toBe("Compendium.private.reactor");
  });

  test("refit persistence does not schedule the Actor initializer as a second writer", async () => {
    const callbacks = new Map();
    globalThis.Hooks = { on(name, callback) { callbacks.set(name, callback); } };
    game.actors = [];
    game.scenes = [];
    registerShipHooks();
    actor.type = SHIP_TYPE;
    let scannedScenes = 0;
    game.scenes = { *[Symbol.iterator]() { scannedScenes += 1; } };
    const update = actor.update.bind(actor);
    actor.update = async (changes, options) => {
      await update(changes, options);
      callbacks.get("updateActor")(actor, changes, options);
      return actor;
    };

    await refit.removeShipComponent(actor, actor.system.shipCombat.config.hardpoints[0].id);

    expect(scannedScenes).toBe(0);
    expect(actor.events.filter(({ type }) => type === "update")).toHaveLength(1);
  });

  test("rejects a revision advanced during Item creation instead of overwriting newer state", async () => {
    const beforeHull = clone(actor.system.shipCombat.config);
    const beforeIds = [...actor.items.keys()];
    const create = actor.createEmbeddedDocuments.bind(actor);
    actor.createEmbeddedDocuments = async (...args) => {
      const created = await create(...args);
      actor.system.shipCombat.state.revision += 1;
      actor.system.shipCombat.state.hull = 7;
      actor.system.shipCombat.config.label = "Newer hull edit";
      return created;
    };
    const revision = actor.system.shipCombat.state.revision;

    await expect(refit.installShipComponent(actor, beforeHull.slots[0].id, CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]))
      .rejects.toMatchObject({ code: "STALE_REVISION" });

    expect(actor.system.shipCombat.config).toEqual({ ...beforeHull, label: "Newer hull edit" });
    expect(actor.system.shipCombat.state).toMatchObject({ revision: revision + 1, hull: 7 });
    expect([...actor.items.keys()]).toEqual(beforeIds);
    expect(actor.events.map(({ type }) => type)).toEqual(["create", "delete"]);
  });

  test("rejects combat entered during Item creation and retains the combat state", async () => {
    const beforeIds = [...actor.items.keys()];
    const create = actor.createEmbeddedDocuments.bind(actor);
    actor.createEmbeddedDocuments = async (...args) => {
      const created = await create(...args);
      actor.system.shipCombat.state.phase = "active";
      return created;
    };

    await expect(refit.resetShipToCanadensis(actor)).rejects.toMatchObject({ code: "REFIT_DENIED" });

    expect(actor.system.shipCombat.state.phase).toBe("active");
    expect([...actor.items.keys()]).toEqual(beforeIds);
    expect(actor.events.map(({ type }) => type)).toEqual(["create", "delete"]);
  });

  test("operator edits prune deleted and changed identities without changing ownership or global state", async () => {
    const hull = clone(actor.system.shipCombat.config);
    const [removed, changed] = hull.operators;
    actor.system.shipCombat.state.roster.command[1].userId = "former-user";
    actor.system.shipCombat.state.roster.lockedTurnKey = "preserved-key";
    actor.ownership = { default: 0, "former-user": 3, "other-user": 2 };
    const ownership = clone(actor.ownership);
    const beforeState = clone(actor.system.shipCombat.state);
    hull.operators = hull.operators.filter(({ id }) => id !== removed.id);
    changed.userId = "new-user";

    await refit.saveShipHull(actor, hull);

    expect(actor.system.shipCombat.state).toEqual({
      ...beforeState,
      revision: beforeState.revision + 1,
      roster: { ...beforeState.roster, command: [] },
    });
    expect(actor.ownership).toEqual(ownership);
  });

  test("denies combat refits and GMs who are not the active authority", async () => {
    actor.system.shipCombat.state.phase = "active";
    expect(refit.getRefitDenial(actor)).toContain("outside combat");
    await expect(refit.removeShipComponent(actor, actor.system.shipCombat.config.slots[0].id))
      .rejects.toMatchObject({ code: "REFIT_DENIED" });

    actor.system.shipCombat.state.phase = "outsideCombat";
    globalThis.game.user = { id: "gm-inactive", isGM: true, active: true };
    expect(refit.getRefitDenial(actor)).toContain("active GM");
    await expect(refit.resetShipToCanadensis(actor)).rejects.toMatchObject({ code: "REFIT_DENIED" });
    expect(actor.events).toEqual([]);
  });
});
