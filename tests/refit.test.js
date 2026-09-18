import { beforeEach, describe, expect, test } from "bun:test";

import {
  CANADENSIS_CONFIG,
  CANADENSIS_HULL_CONFIG,
  CANADENSIS_SLOT_IDS,
} from "../scripts/data/canadensis.js";
import {
  CANADENSIS_DEFAULT_COMPONENT_SOURCES,
  CANADENSIS_LATERAL_DRIVE_SOURCE,
  CANADENSIS_SHIELD_SOURCE,
} from "../scripts/data/canadensis-components.js";
import { createDefaultShipData } from "../scripts/model/defaults.js";
import * as refit from "../scripts/foundry/refit.js";
import { registerShipHooks } from "../scripts/foundry/hooks.js";
import { getPowerState } from "../scripts/rules/power.js";
import { previewDefenseRoute } from "../scripts/rules/shields.js";
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
    this.system = {
      shipCombat: {
        config: clone(defaults.hull),
        state: clone(defaults.state),
      },
    };
    this.prototypeToken = { width: 1 };
    this.items = new Map(defaults.items.map((source) => {
      const item = new FakeItem(source);
      return [item.id, item];
    }));
    this.events = [];
    this.nextId = 1;
    this.failNextUpdate = false;
    this.cancelNextUpdate = false;
  }

  async createEmbeddedDocuments(documentName, sources, options) {
    expect(documentName).toBe("Item");
    const created = sources.map((source) => {
      expect(source._id).toBeUndefined();
      expect(source.id).toBeUndefined();
      const item = new FakeItem({
        ...clone(source),
        _id: `fresh-${String(this.nextId++).padStart(4, "0")}`,
      });
      this.items.set(item.id, item);
      return item;
    });
    this.events.push({
      type: "create",
      ids: created.map((item) => item.id),
      options: clone(options),
    });
    return created;
  }

  async update(changes, options) {
    const itemUpdates = changes.items ?? null;
    for (const update of itemUpdates ?? []) {
      if (!this.items.has(update._id)) {
        throw new Error(`Unknown embedded Item '${update._id}'`);
      }
    }
    this.events.push({
      type: "update",
      options: clone(options),
      items: clone(itemUpdates),
    });
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("simulated update failure");
    }
    if (this.cancelNextUpdate) {
      this.cancelNextUpdate = false;
      return undefined;
    }
    for (const [path, supplied] of Object.entries(changes)) {
      if (path === "items") continue;
      const value = supplied instanceof FakeForcedReplacement
        ? supplied.value
        : supplied;
      setPath(this, path, value);
    }
    for (const update of itemUpdates ?? []) {
      const item = this.items.get(update._id);
      for (const [path, supplied] of Object.entries(update)) {
        if (path === "_id") continue;
        const value = supplied instanceof FakeForcedReplacement
          ? supplied.value
          : supplied;
        setPath(item, path, value);
      }
    }
    return this;
  }

  async deleteEmbeddedDocuments(documentName, ids, options) {
    expect(documentName).toBe("Item");
    const visibleReferences = references(this.system.shipCombat.config);
    this.events.push({
      type: "delete",
      ids: [...ids],
      visibleReferences,
      options: clone(options),
    });
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

function componentDraft(actor, componentId) {
  return withoutId(actor.items.get(componentId).toObject());
}

function renameHardpoint(hull, from, to) {
  for (const hardpoint of hull.hardpoints) {
    if (hardpoint.id === from) hardpoint.id = to;
  }
  hull.weaponPriority = hull.weaponPriority.map((
    id,
  ) => (id === from ? to : id));
  for (const entries of Object.values(hull.criticalPools ?? {})) {
    for (const entry of entries) {
      if (entry.hardpointId === from) entry.hardpointId = to;
    }
  }
}

let actor;
let activeGm;

beforeEach(() => {
  activeGm = { id: "gm-active", isGM: true, active: true };
  globalThis.game = {
    user: activeGm,
    users: Object.assign(new Map([[activeGm.id, activeGm]]), {
      activeGM: activeGm,
    }),
  };
  globalThis.foundry = {
    applications: { api: { DialogV2: { confirm: async () => true } } },
    data: { operators: { ForcedReplacement: FakeForcedReplacement } },
    utils: { deepClone: clone },
  };
  actor = new FakeActor();
});

describe("refit API", () => {
  test("materializes embedded component Items while ignoring ordinary Items", () => {
    actor.items.set("ordinary-item", {
      id: "ordinary-item",
      type: "equipment",
      system: {},
    });
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

    await expect(
      refit.installShipComponent(
        actor,
        CANADENSIS_SLOT_IDS.portLateralDrive,
        wrongSize,
      ),
    )
      .rejects.toMatchObject({ code: "INCOMPATIBLE_COMPONENT_SIZE" });
    await expect(
      refit.installShipComponent(
        actor,
        CANADENSIS_SLOT_IDS.mainDrive,
        CANADENSIS_LATERAL_DRIVE_SOURCE,
      ),
    )
      .rejects.toMatchObject({ code: "INCOMPATIBLE_DRIVE_ROLE" });
    await expect(
      refit.installShipComponent(
        actor,
        hardpointId,
        CANADENSIS_DEFAULT_COMPONENT_SOURCES[0],
      ),
    )
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
        local: {
          id: "local",
          kind: "fault",
          componentId: oldId,
          targetId: oldId,
          severity: "major",
        },
        hazard: {
          id: "hazard",
          kind: "hazard",
          targetId: "fore",
          severity: "minor",
        },
      },
      work: {
        [`recover:${oldId}`]: {
          id: `recover:${oldId}`,
          targetId: oldId,
          current: 1,
        },
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
    expect(actor.events.map(({ type }) => type)).toEqual([
      "create",
      "update",
      "delete",
    ]);
    expect(
      actor.events.every(({ options }) => options.viraShipCombatRefit === true),
    ).toBe(true);
    expect(actor.events.at(-1).visibleReferences).not.toContain(oldId);
  });

  test("cleans up the fresh Item if the atomic Actor update fails", async () => {
    const mount = actor.system.shipCombat.config.slots[0];
    const oldId = mount.itemId;
    const beforeIds = [...actor.items.keys()];
    actor.failNextUpdate = true;

    await expect(
      refit.installShipComponent(
        actor,
        mount.id,
        CANADENSIS_DEFAULT_COMPONENT_SOURCES[0],
      ),
    )
      .rejects.toThrow("simulated update failure");

    expect(actor.system.shipCombat.config.slots[0].itemId).toBe(oldId);
    expect([...actor.items.keys()]).toEqual(beforeIds);
    expect(actor.events.map(({ type }) => type)).toEqual([
      "create",
      "update",
      "delete",
    ]);
    expect(actor.events.at(-1).ids).toEqual(["fresh-0001"]);
  });

  test.each([
    [
      "install",
      (ship) =>
        refit.installShipComponent(
          ship,
          ship.system.shipCombat.config.slots[0].id,
          CANADENSIS_DEFAULT_COMPONENT_SOURCES[0],
        ),
    ],
    [
      "remove",
      (ship) =>
        refit.removeShipComponent(
          ship,
          ship.system.shipCombat.config.hardpoints[1].id,
        ),
    ],
    ["reset", (ship) => refit.resetShipToCanadensis(ship)],
  ])(
    "a canceled %s retains mounted components and discards fresh copies",
    async (_operation, refitShip) => {
      const before = clone(actor.system.shipCombat);
      const beforeItems = [...actor.items.values()].map((item) =>
        item.toObject()
      );
      actor.cancelNextUpdate = true;

      await expect(refitShip(actor)).rejects.toMatchObject({
        name: "RuleViolation",
        code: "REFIT_UPDATE_FAILED",
      });

      expect(actor.system.shipCombat).toEqual(before);
      expect([...actor.items.values()].map((item) => item.toObject())).toEqual(
        beforeItems,
      );
      expect(
        references(actor.system.shipCombat.config).every((id) =>
          actor.items.has(id)
        ),
      ).toBe(true);
    },
  );

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
    const sensor = hull.slots.find(({ id }) =>
      id === CANADENSIS_SLOT_IDS.sensor
    );
    const sensorId = sensor.itemId;
    sensor.itemId = null;
    Object.assign(actor.system.shipCombat.state, {
      hull: 23,
      heat: 8,
      tracks: { target: { targetUuid: "Scene.s.Token.t", state: "contact" } },
      history: [{ type: "kept" }],
      conditions: {
        sensor: {
          id: `sensorFault:${sensorId}`,
          kind: "fault",
          componentId: sensorId,
        },
        fire: { id: "fire:fore", kind: "hazard", targetId: "fore" },
      },
    });
    const revision = actor.system.shipCombat.state.revision;

    await refit.saveShipHull(actor, hull, revision);

    expect(actor.system.shipCombat.state).toMatchObject({
      hull: 23,
      heat: 8,
      tracks: {},
      history: [{ type: "kept" }],
      revision: revision + 1,
    });
    expect(actor.system.shipCombat.state.conditions).toEqual({
      fire: expect.any(Object),
    });
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
    expect(actor.events.map(({ type }) => type)).toEqual([
      "create",
      "update",
      "delete",
    ]);
    expect(actor.events[0].ids).toHaveLength(12);
    expect(actor.events[2].visibleReferences.some((id) => oldIds.has(id))).toBe(
      false,
    );

    const expectedHull = clone(CANADENSIS_HULL_CONFIG);
    expectedHull.slots.forEach((slot) => {
      slot.itemId = expect.any(String);
    });
    expectedHull.hardpoints.forEach((hardpoint) => {
      hardpoint.weaponId = expect.any(String);
    });
    expect(hull).toEqual(expectedHull);
    expect(effective).toEqual(refit.materializeActorConfig(actor));
    expect(effective.label).toBe(CANADENSIS_CONFIG.label);
    expect(effective.components.weapons).toHaveLength(4);

    const installedSources = mountedIds.map((id) =>
      withoutId(actor.items.get(id).toObject())
    );
    expect(installedSources).toEqual(
      CANADENSIS_DEFAULT_COMPONENT_SOURCES.map(withoutId),
    );
    expect(actor.items.get(mountedIds[6]).system).not.toBe(
      actor.items.get(mountedIds[7]).system,
    );
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

    const error = await refit.saveShipHull(
      actor,
      hull,
      actor.system.shipCombat.state.revision,
    ).catch((failure) => failure);

    expect(error.code).toBe("INVALID_SHIP_CONFIG");
    expect(error.details.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["maxHull", "heatCapacity", "ac"]),
    );
    for (const path of ["maxHull", "heatCapacity", "ac"]) {
      expect(error.message).toContain(path);
    }
    expect(actor.system.shipCombat).toEqual(before);
    expect(actor.events).toEqual([]);
  });

  test("validates installation and removal candidates using the synthetic Actor token width", async () => {
    actor.token = { width: 0 };
    const before = clone(actor.system.shipCombat);
    const ids = [...actor.items.keys()];
    const mount = actor.system.shipCombat.config.slots[0];

    await expect(
      refit.installShipComponent(
        actor,
        mount.id,
        CANADENSIS_DEFAULT_COMPONENT_SOURCES[0],
      ),
    )
      .rejects.toMatchObject({
        code: "INVALID_SHIP_CONFIG",
        details: expect.arrayContaining([
          expect.objectContaining({ path: "tokenWidth" }),
        ]),
      });
    await expect(refit.removeShipComponent(actor, mount.id)).rejects
      .toMatchObject({ code: "INVALID_SHIP_CONFIG" });
    await expect(refit.resetShipToCanadensis(actor)).rejects.toMatchObject({
      code: "INVALID_SHIP_CONFIG",
    });
    expect(actor.system.shipCombat).toEqual(before);
    expect([...actor.items.keys()]).toEqual(ids);
    expect(actor.events.some(({ type }) => type === "update")).toBe(false);
  });

  test("installs only a single detached clean source without inherited provenance or effects", async () => {
    const catalog = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]);
    Object.assign(catalog, {
      flags: {
        core: { sourceId: "Compendium.private.reactor" },
        "vira-shipcombat": { migration: { source: "old" } },
      },
      folder: "private-folder",
      sort: 12,
      ownership: { default: 3 },
      effects: [{ name: "Catalog effect" }],
      _stats: { compendiumSource: "Compendium.private.reactor" },
      provenance: { originalId: "old-item" },
    });
    const source = {
      toObject() {
        return clone(catalog);
      },
    };

    const created = await refit.installShipComponent(
      actor,
      actor.system.shipCombat.config.slots[0].id,
      source,
    );

    expect(withoutId(created.toObject())).toEqual({
      name: catalog.name,
      img: catalog.img,
      type: catalog.type,
      system: catalog.system,
    });
    expect(catalog.flags.core.sourceId).toBe("Compendium.private.reactor");
  });

  test("refit persistence does not schedule the Actor initializer as a second writer", async () => {
    const callbacks = new Map();
    globalThis.Hooks = {
      on(name, callback) {
        callbacks.set(name, callback);
      },
    };
    game.actors = [];
    game.scenes = [];
    registerShipHooks();
    actor.type = SHIP_TYPE;
    let scannedScenes = 0;
    game.scenes = {
      *[Symbol.iterator]() {
        scannedScenes += 1;
      },
    };
    const update = actor.update.bind(actor);
    actor.update = async (changes, options) => {
      await update(changes, options);
      callbacks.get("updateActor")(actor, changes, options);
      return actor;
    };

    await refit.removeShipComponent(
      actor,
      actor.system.shipCombat.config.hardpoints[0].id,
    );

    expect(scannedScenes).toBe(0);
    expect(actor.events.filter(({ type }) => type === "update")).toHaveLength(
      1,
    );
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

    await expect(
      refit.installShipComponent(
        actor,
        beforeHull.slots[0].id,
        CANADENSIS_DEFAULT_COMPONENT_SOURCES[0],
      ),
    )
      .rejects.toMatchObject({ code: "STALE_REVISION" });

    expect(actor.system.shipCombat.config).toEqual({
      ...beforeHull,
      label: "Newer hull edit",
    });
    expect(actor.system.shipCombat.state).toMatchObject({
      revision: revision + 1,
      hull: 7,
    });
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

    await expect(refit.resetShipToCanadensis(actor)).rejects.toMatchObject({
      code: "REFIT_DENIED",
    });

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

    await refit.saveShipHull(actor, hull, beforeState.revision);

    expect(actor.system.shipCombat.state).toEqual({
      ...beforeState,
      revision: beforeState.revision + 1,
      roster: { ...beforeState.roster, command: [] },
    });
    expect(actor.ownership).toEqual(ownership);
  });

  test("preserves retained weapon state when two installed weapons swap mounts", async () => {
    const hull = clone(actor.system.shipCombat.config);
    const [port, starboard] = [hull.hardpoints[2], hull.hardpoints[3]];
    const movedId = port.weaponId;
    const otherId = starboard.weaponId;
    [port.weaponId, starboard.weaponId] = [otherId, movedId];
    actor.system.shipCombat.state.weapons[movedId].readiness = 0;
    actor.system.shipCombat.state.conditions = {
      fault: {
        id: `weaponMalfunction:${movedId}`,
        kind: "fault",
        channelId: "weaponMalfunction",
        componentId: movedId,
        targetId: movedId,
        severity: "major",
      },
      hazard: { id: "fire:fore", kind: "hazard", targetId: "fore" },
    };
    actor.system.shipCombat.state.shields.allocation.fore = 7;
    actor.system.shipCombat.state.shields.hp.fore = 5;
    actor.system.shipCombat.state.tracks = {
      contact: { targetUuid: "Scene.s.Token.t", state: "contact" },
    };
    const priority = clone(actor.system.shipCombat.state.weaponPriority);
    const revision = actor.system.shipCombat.state.revision;

    await refit.saveShipHull(actor, hull, revision);

    const state = actor.system.shipCombat.state;
    expect(actor.system.shipCombat.config.hardpoints[2].weaponId).toBe(otherId);
    expect(actor.system.shipCombat.config.hardpoints[3].weaponId).toBe(movedId);
    expect(actor.items.has(movedId)).toBe(true);
    expect(state.weapons[movedId]).toMatchObject({
      readiness: 0,
      status: "online",
    });
    expect(state.weapons[otherId]).toMatchObject({
      readiness: 20,
      status: "off",
    });
    expect(state.conditions.fault).toMatchObject({ severity: "major" });
    expect(state.conditions.hazard).toEqual(expect.any(Object));
    expect(state.weaponPriority).toEqual(priority);
    expect(state.shields.allocation.fore).toBe(7);
    expect(state.shields.hp.fore).toBe(5);
    expect(state.tracks.contact).toEqual(expect.any(Object));
    expect(state.revision).toBe(revision + 1);
  });

  test("retains installed identity and local state when a mount is renamed", async () => {
    const hull = clone(actor.system.shipCombat.config);
    const port = hull.hardpoints[2];
    const weaponId = port.weaponId;
    const renamedMountId = `${port.id}-renamed`;
    renameHardpoint(hull, port.id, renamedMountId);
    actor.system.shipCombat.state.weapons[weaponId].readiness = 0;
    actor.system.shipCombat.state.conditions = {
      fault: {
        id: `weaponMalfunction:${weaponId}`,
        kind: "fault",
        channelId: "weaponMalfunction",
        componentId: weaponId,
        targetId: weaponId,
        severity: "major",
      },
    };
    actor.system.shipCombat.state.tracks = {
      contact: { targetUuid: "Scene.s.Token.t", state: "targeted" },
    };
    actor.system.shipCombat.state.shields.allocation.fore = 9;
    actor.system.shipCombat.state.shields.hp.fore = 6;
    const power = clone(actor.system.shipCombat.state.power);
    const priority = clone(actor.system.shipCombat.state.weaponPriority);
    const revision = actor.system.shipCombat.state.revision;

    await refit.saveShipHull(actor, hull, revision);

    const config = actor.system.shipCombat.config;
    const state = actor.system.shipCombat.state;
    expect(config.hardpoints[2]).toMatchObject({
      id: renamedMountId,
      weaponId,
    });
    expect(actor.items.has(weaponId)).toBe(true);
    expect(state.weapons[weaponId].readiness).toBe(0);
    expect(state.conditions.fault).toEqual(expect.any(Object));
    expect(state.weaponPriority).toEqual(priority);
    expect(state.shields.allocation.fore).toBe(9);
    expect(state.shields.hp.fore).toBe(6);
    expect(state.tracks.contact).toEqual(expect.any(Object));
    expect(state.power).toEqual(power);
    expect(state.revision).toBe(revision + 1);
  });

  test("rejects missing, malformed, mismatched, and stale staged revisions without writes", async () => {
    const hull = clone(actor.system.shipCombat.config);
    const shieldId =
      hull.slots.find(({ id }) => id === CANADENSIS_SLOT_IDS.shield).itemId;
    const draft = componentDraft(actor, shieldId);
    draft.system.definition.totalBudget = 50;
    const revision = actor.system.shipCombat.state.revision;
    const before = clone(actor.system.shipCombat);

    await expect(refit.saveInstalledShipComponent(actor, shieldId, draft))
      .rejects.toMatchObject({ code: "REVISION_REQUIRED" });
    await expect(refit.saveInstalledShipComponent(actor, shieldId, draft, -1))
      .rejects.toMatchObject({ code: "REVISION_REQUIRED" });
    await expect(
      refit.saveInstalledShipComponent(actor, shieldId, draft, revision + 1),
    )
      .rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(
      refit.saveInstalledShipComponent(actor, shieldId, {
        ...draft,
        _id: "other-item",
      }, revision),
    )
      .rejects.toMatchObject({ code: "COMPONENT_ID_MISMATCH" });
    await expect(refit.saveShipHull(actor, hull))
      .rejects.toMatchObject({ code: "REVISION_REQUIRED" });
    await expect(refit.saveShipHull(actor, hull, revision + 1))
      .rejects.toMatchObject({ code: "STALE_REVISION" });

    expect(actor.system.shipCombat).toEqual(before);
    expect(actor.items.get(shieldId).system.definition.totalBudget).toBe(60);
    expect(actor.events).toEqual([]);
  });

  test("keeps an installed shield renderable across a bubble to directional topology edit", async () => {
    const bubble = clone(CANADENSIS_SHIELD_SOURCE);
    bubble._id = "catalog-bubble-shield";
    bubble.system.definition.topology = "bubble";
    bubble.system.definition.sectors = ["bubble"];
    const installed = await refit.installShipComponent(
      actor,
      CANADENSIS_SLOT_IDS.shield,
      bubble,
    );
    const itemId = installed.id;
    actor.system.shipCombat.state.shields.allocation.bubble = 20;
    actor.system.shipCombat.state.shields.hp.bubble = 20;
    const draft = componentDraft(actor, itemId);
    draft.system.definition.topology = "directional";
    draft.system.definition.sectors = ["fore", "port", "starboard", "aft"];
    const revision = actor.system.shipCombat.state.revision;

    await refit.saveInstalledShipComponent(actor, itemId, draft, revision);

    const config = actor.system.shipCombat.config;
    const state = actor.system.shipCombat.state;
    const sectors = ["fore", "port", "starboard", "aft"];
    expect(
      config.slots.find(({ id }) => id === CANADENSIS_SLOT_IDS.shield).itemId,
    ).toBe(itemId);
    expect(actor.items.has(itemId)).toBe(true);
    expect(actor.items.size).toBe(12);
    expect(actor.items.get(itemId).system.definition.topology).toBe(
      "directional",
    );
    expect(Object.keys(state.shields.allocation).sort()).toEqual(
      [...sectors].sort(),
    );
    expect(Object.keys(state.shields.hp).sort()).toEqual([...sectors].sort());
    expect(Object.keys(state.shields.regenerationAllocation).sort()).toEqual(
      [...sectors].sort(),
    );
    expect(Object.keys(state.shields.collapse).sort()).toEqual(
      [...sectors].sort(),
    );
    expect(
      Object.values(state.shields.regenerationAllocation).reduce(
        (sum, weight) => sum + weight,
        0,
      ),
    ).toBe(100);
    const totalHp = Object.values(state.shields.hp).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(totalHp).toBe(20);
    const totalAllocation = Object.values(state.shields.allocation).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(totalAllocation).toBeLessThanOrEqual(60);
    for (const sector of sectors) {
      expect(state.shields.hp[sector]).toBeLessThanOrEqual(
        state.shields.allocation[sector],
      );
      expect(state.shields.allocation[sector]).toBeLessThanOrEqual(24);
    }
    expect(state.revision).toBe(revision + 1);

    const updateEvent = actor.events.at(-1);
    expect(updateEvent.type).toBe("update");
    expect(updateEvent.items[0]._id).toBe(itemId);
    expect(updateEvent.items[0]["system.definition"].value.topology).toBe(
      "directional",
    );

    const effective = refit.materializeActorConfig(actor);
    const route = previewDefenseRoute(effective, state, {});
    expect(route.totalAllocation).toBe(20);
    expect(route.totalHp).toBe(20);
    expect(route.capacities.fore).toBe(24);
    expect(route.regenerationAllocation).toEqual({
      fore: 25,
      port: 25,
      starboard: 25,
      aft: 25,
    });

    const back = componentDraft(actor, itemId);
    back.system.definition.topology = "bubble";
    back.system.definition.sectors = ["bubble"];

    await refit.saveInstalledShipComponent(actor, itemId, back, state.revision);

    const bubbleState = actor.system.shipCombat.state;
    expect(actor.items.has(itemId)).toBe(true);
    expect(actor.items.size).toBe(12);
    expect(actor.items.get(itemId).system.definition.topology).toBe("bubble");
    expect(bubbleState.shields.allocation).toEqual({ bubble: 20 });
    expect(bubbleState.shields.hp).toEqual({ bubble: 20 });
    expect(bubbleState.shields.regenerationAllocation).toEqual({ bubble: 100 });
    expect(bubbleState.shields.collapse).toEqual({ bubble: 0 });
    const bubbleRoute = previewDefenseRoute(
      refit.materializeActorConfig(actor),
      bubbleState,
      {},
    );
    expect(bubbleRoute.totalAllocation).toBe(20);
    expect(bubbleRoute.totalHp).toBe(20);
    expect(bubbleRoute.capacities.bubble).toBe(24);
  });

  test("re-caps allocation and clamps hp when the shield sector cap shrinks", async () => {
    const hull = clone(actor.system.shipCombat.config);
    const shieldId =
      hull.slots.find(({ id }) => id === CANADENSIS_SLOT_IDS.shield).itemId;
    const state = actor.system.shipCombat.state;
    state.shields.allocation.fore = 24;
    state.shields.hp.fore = 24;
    const draft = componentDraft(actor, shieldId);
    draft.system.definition.sectorCap = 10;
    const revision = state.revision;

    await refit.saveInstalledShipComponent(actor, shieldId, draft, revision);

    const sectors = ["fore", "port", "starboard", "aft"];
    const shields = actor.system.shipCombat.state.shields;
    expect(Object.keys(shields.allocation).sort()).toEqual([...sectors].sort());
    expect(Object.keys(shields.hp).sort()).toEqual([...sectors].sort());
    for (const sector of sectors) {
      expect(shields.allocation[sector]).toBe(10);
      expect(shields.hp[sector]).toBe(10);
      expect(shields.hp[sector]).toBeLessThanOrEqual(shields.allocation[sector]);
    }
    const totalAllocation = Object.values(shields.allocation).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(totalAllocation).toBeLessThanOrEqual(60);

    const route = previewDefenseRoute(
      refit.materializeActorConfig(actor),
      actor.system.shipCombat.state,
      {},
    );
    expect(route.totalAllocation).toBe(totalAllocation);
    expect(route.totalHp).toBe(totalAllocation);
    expect(route.capacities.fore).toBe(10);
  });

  test("clamps a lowered magazine capacity and never refills it", async () => {
    const hardpoint = actor.system.shipCombat.config.hardpoints[2];
    const weaponId = hardpoint.weaponId;
    actor.system.shipCombat.state.weapons[weaponId].readiness = 20;
    const lower = componentDraft(actor, weaponId);
    lower.system.definition.readiness = {
      ...lower.system.definition.readiness,
      capacity: 5,
    };
    let revision = actor.system.shipCombat.state.revision;

    await refit.saveInstalledShipComponent(actor, weaponId, lower, revision);

    expect(actor.items.has(weaponId)).toBe(true);
    expect(actor.items.size).toBe(12);
    expect(actor.items.get(weaponId).system.definition.readiness.capacity).toBe(
      5,
    );
    expect(actor.system.shipCombat.state.weapons[weaponId]).toMatchObject({
      readiness: 5,
      status: "online",
    });

    const raise = componentDraft(actor, weaponId);
    raise.system.definition.readiness = {
      ...raise.system.definition.readiness,
      capacity: 20,
    };
    revision = actor.system.shipCombat.state.revision;

    await refit.saveInstalledShipComponent(actor, weaponId, raise, revision);

    expect(actor.system.shipCombat.state.weapons[weaponId].readiness).toBe(5);
    expect(actor.system.shipCombat.state.revision).toBe(revision + 1);
  });

  test("keeps definition and runtime state consistent when a component edit fails to persist", async () => {
    const hardpoint = actor.system.shipCombat.config.hardpoints[2];
    const weaponId = hardpoint.weaponId;
    actor.system.shipCombat.state.weapons[weaponId].readiness = 20;
    const draft = componentDraft(actor, weaponId);
    draft.system.definition.readiness = {
      ...draft.system.definition.readiness,
      capacity: 5,
    };
    const revision = actor.system.shipCombat.state.revision;
    const before = clone(actor.system.shipCombat);
    actor.failNextUpdate = true;

    await expect(
      refit.saveInstalledShipComponent(actor, weaponId, draft, revision),
    )
      .rejects.toThrow("simulated update failure");

    expect(actor.system.shipCombat).toEqual(before);
    expect(actor.items.get(weaponId).system.definition.readiness.capacity).toBe(
      20,
    );
    expect(actor.events.map(({ type }) => type)).toEqual(["update"]);

    await refit.saveInstalledShipComponent(actor, weaponId, draft, revision);

    expect(actor.events.map(({ type }) => type)).toEqual(["update", "update"]);
    expect(actor.system.shipCombat.state.revision).toBe(revision + 1);
    expect(actor.system.shipCombat.state.weapons[weaponId].readiness).toBe(5);
    expect(actor.items.get(weaponId).system.definition.readiness.capacity).toBe(
      5,
    );
  });

  test("keeps Power valid when an edit removes tiers or lowers reactor output", async () => {
    const slots = actor.system.shipCombat.config.slots;
    const coolingId =
      slots.find(({ id }) => id === CANADENSIS_SLOT_IDS.cooling).itemId;
    actor.system.shipCombat.state.power.cooling = 3;
    const cooling = componentDraft(actor, coolingId);
    cooling.system.definition.tiers = cooling.system.definition.tiers.filter((
      { power },
    ) => power !== 3);

    await refit.saveInstalledShipComponent(
      actor,
      coolingId,
      cooling,
      actor.system.shipCombat.state.revision,
    );

    expect(actor.system.shipCombat.state.power.cooling).toBe(1);

    const reactorId =
      slots.find(({ id }) => id === CANADENSIS_SLOT_IDS.reactor).itemId;
    actor.system.shipCombat.state.power = {
      engines: 4,
      shields: 3,
      sensors: 2,
      cooling: 2,
      weapons: 3,
    };
    const reactor = componentDraft(actor, reactorId);
    reactor.system.definition.nominalOutput = 10;
    reactor.system.definition.redlineOutput = 12;

    await refit.saveInstalledShipComponent(
      actor,
      reactorId,
      reactor,
      actor.system.shipCombat.state.revision,
    );

    const effective = refit.materializeActorConfig(actor);
    const power = getPowerState(effective, actor.system.shipCombat.state);
    expect(power.committed).toBeLessThanOrEqual(12);
    expect(power.redlining).toBe(true);
    expect(power.allocation.weapons).toBeLessThan(3);
    expect(actor.items.get(reactorId).system.definition.nominalOutput).toBe(10);
  });

  test("denies combat refits and GMs who are not the active authority", async () => {
    actor.system.shipCombat.state.phase = "active";
    expect(refit.getRefitDenial(actor)).toContain("outside combat");
    await expect(
      refit.removeShipComponent(
        actor,
        actor.system.shipCombat.config.slots[0].id,
      ),
    )
      .rejects.toMatchObject({ code: "REFIT_DENIED" });

    actor.system.shipCombat.state.phase = "outsideCombat";
    globalThis.game.user = { id: "gm-inactive", isGM: true, active: true };
    expect(refit.getRefitDenial(actor)).toContain("active GM");
    await expect(refit.resetShipToCanadensis(actor)).rejects.toMatchObject({
      code: "REFIT_DENIED",
    });
    expect(actor.events).toEqual([]);
  });
});
