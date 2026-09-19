import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { INTERNAL_UPDATE_OPTION, SHIP_TYPE } from "../scripts/constants.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "../scripts/data/canadensis-components.js";
import { PEREGRINUS_HULL_CONFIG } from "../scripts/data/peregrinus.js";
import { PEREGRINUS_DEFAULT_COMPONENT_SOURCES } from "../scripts/data/peregrinus-components.js";
import { initializeShipActor } from "../scripts/foundry/initialization.js";
import { createDefaultShipSystemData } from "../scripts/model/defaults.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";
import { trackKey } from "../scripts/rules/sensors.js";
import {
  readShipRecord,
  writeShipState,
} from "../scripts/state/token-state.js";

const clone = (value) => structuredClone(value);

class FakeForcedReplacement {
  constructor(value) {
    this.value = value;
  }
  static create(value) {
    return new FakeForcedReplacement(value);
  }
}

class FakeForcedDeletion {
  static create() {
    return new FakeForcedDeletion();
  }
}

function setPath(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = clone(value);
}

let nextActorId = 0;
class FakeActor {
  constructor(shipCombat = {}, sources = []) {
    this.uuid = `Actor.initialization-${++nextActorId}`;
    this.type = SHIP_TYPE;
    this.system = { shipCombat: clone(shipCombat) };
    this._source = { system: clone(this.system) };
    this.items = new Map(
      sources.map((
        source,
      ) => [source._id, { ...clone(source), id: source._id }]),
    );
    this.creationCalls = 0;
    this.updates = 0;
  }

  async createEmbeddedDocuments(_name, sources) {
    this.creationCalls++;
    const created = sources.map((source) => ({
      ...clone(source),
      id: source._id,
    }));
    for (const item of created) this.items.set(item.id, item);
    return created;
  }

  async update(changes, options = {}) {
    this.updates++;
    for (const [path, supplied] of Object.entries(changes)) {
      setPath(
        this,
        path,
        supplied instanceof FakeForcedReplacement ? supplied.value : supplied,
      );
    }
    this._source.system = clone(this.system);
    this.onUpdate?.(changes, options);
    return this;
  }
}

let previousFoundry;
let previousGame;
let previousItem;
beforeEach(() => {
  previousFoundry = globalThis.foundry;
  previousGame = globalThis.game;
  previousItem = globalThis.Item;
  // Foundry exposes Actor/Item as globals; sheet registration dereferences them.
  globalThis.Item = class Item {};
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: gm, users: { activeGM: gm } };
  globalThis.foundry = {
    applications: { apps: { DocumentSheetConfig: { registerSheet() {} } } },
    data: {
      operators: {
        ForcedReplacement: FakeForcedReplacement,
        ForcedDeletion: FakeForcedDeletion,
      },
    },
  };
});
afterEach(() => {
  globalThis.foundry = previousFoundry;
  globalThis.game = previousGame;
  globalThis.Item = previousItem;
});

function effectiveConfig(actor) {
  return materializeShipConfig(actor.system.shipCombat.config, [
    ...actor.items.values(),
  ]);
}

describe("current ship initialization", () => {
  test("serializes competing initialization and preserves later combat state", async () => {
    const actor = new FakeActor({
      schemaVersion: 2,
      config: { schemaVersion: 2 },
      state: { schemaVersion: 2 },
    });
    actor.uuid = "Scene.test.Token.synthetic.Actor.ship";
    expect(
      await Promise.all([
        initializeShipActor(actor),
        initializeShipActor(actor),
      ]),
    ).toEqual([true, false]);
    const config = effectiveConfig(actor);
    expect(config.components.weapons.map(({ id }) => id).sort())
      .toEqual(Object.keys(actor.system.shipCombat.state.weapons).sort());
    expect(config.components.drives.portLateral.id).not.toBe(
      config.components.drives.starboardLateral.id,
    );
    expect(actor.creationCalls).toBe(1);
    expect(actor.updates).toBe(1);
    actor.system.shipCombat.state.hull = 1;
    actor.system.shipCombat.state.phase = "active";
    const before = clone(actor.system.shipCombat);
    expect(await initializeShipActor(actor)).toBe(false);
    expect(actor.system.shipCombat).toEqual(before);
    expect(actor.updates).toBe(1);
  });

  test("retains custom installed components and deliberately empty mounts while filling missing defaults", async () => {
    const data = createDefaultShipSystemData();
    const custom = clone(
      CANADENSIS_DEFAULT_COMPONENT_SOURCES.find(({ system }) =>
        system.componentClass === "reactor"
      ),
    );
    custom.name = "Custom Reactor";
    custom.system.definition.nominalOutput = 13;
    data.config.hardpoints[0].weaponId = null;
    data.state.hull = 3;
    const actor = new FakeActor(data, [custom]);
    expect(await initializeShipActor(actor)).toBe(true);
    expect(effectiveConfig(actor).components.reactor.nominalOutput).toBe(13);
    expect(effectiveConfig(actor).components.reactor.label).toBe(
      "Custom Reactor",
    );
    expect(effectiveConfig(actor).hardpoints[0].weaponId).toBeNull();
    expect(actor.system.shipCombat).toEqual(data);
    expect(actor.updates).toBe(0);
    expect(await initializeShipActor(actor)).toBe(false);
  });

  test("installs the Small kit for a non-default reference build hull", async () => {
    const data = createDefaultShipSystemData(PEREGRINUS_HULL_CONFIG.id);
    const actor = new FakeActor(data);

    expect(await initializeShipActor(actor)).toBe(true);
    expect(actor.creationCalls).toBe(1);
    expect(effectiveConfig(actor).id).toBe(PEREGRINUS_HULL_CONFIG.id);
    expect(effectiveConfig(actor).components.shield.topology).toBe("bubble");
    expect(effectiveConfig(actor).components.weapons).toHaveLength(2);
    // Every copy is created under its bundled catalog ID, which Foundry accepts as a document ID.
    expect([...actor.items.keys()].sort()).toEqual(
      PEREGRINUS_DEFAULT_COMPONENT_SOURCES.map(({ _id }) => _id).sort(),
    );
    expect(
      [...actor.items.values()].every((item) => item.system.size === "small"),
    ).toBe(true);
  });

  test("does not replace unrelated Items occupying referenced default IDs", async () => {
    const occupied = {
      _id: CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]._id,
      type: "loot",
      name: "Keep me",
    };
    const actor = new FakeActor({}, [occupied]);
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.items.get(occupied._id).name).toBe("Keep me");
    expect(actor.creationCalls).toBe(0);
    expect(actor.updates).toBe(0);
  });

  test("rejects incompatible existing components before installing defaults", async () => {
    const component = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]);
    component.system.size = component.system.size === "large"
      ? "small"
      : "large";
    const actor = new FakeActor({}, [component]);
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.items.get(component._id).system.size).toBe(
      component.system.size,
    );
    expect(actor.creationCalls).toBe(0);
    expect(actor.updates).toBe(0);
  });

  test("rejects obsolete persisted schema even when prepared data has current slots", async () => {
    const actor = new FakeActor(
      createDefaultShipSystemData(),
      CANADENSIS_DEFAULT_COMPONENT_SOURCES,
    );
    actor._source.system.shipCombat.schemaVersion = 1;
    await expect(initializeShipActor(actor)).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
    try {
      readShipRecord({ actor, uuid: "Scene.test.Token.ship" });
      throw new Error("Obsolete ship was accepted.");
    } catch (error) {
      expect(error.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    }
    expect(actor.creationCalls).toBe(0);
    expect(actor.updates).toBe(0);
  });

  test("rejects inline components rather than using inherited current slots", async () => {
    const data = createDefaultShipSystemData();
    data.config.components = {};
    const actor = new FakeActor(data);
    await expect(initializeShipActor(actor)).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
    expect(actor.creationCalls).toBe(0);
    expect(actor.updates).toBe(0);
  });

  test("does not write an initialized ship when Item creation is cancelled", async () => {
    const actor = new FakeActor();
    actor.createEmbeddedDocuments = async () => [];
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.system.shipCombat).toEqual({});
    expect(actor.updates).toBe(0);
  });

  test("does not persist dangling references if Item creation changes IDs", async () => {
    const actor = new FakeActor();
    actor.createEmbeddedDocuments = async (_name, sources) =>
      sources.map((source, index) => ({
        ...clone(source),
        _id: `changed-${index}`,
        id: `changed-${index}`,
      }));
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.updates).toBe(0);
    expect(actor.system.shipCombat).toEqual({});
  });

  test("reports a cancelled Actor update and can retry without duplicating components", async () => {
    const actor = new FakeActor();
    const update = actor.update.bind(actor);
    actor.update = async () => undefined;
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.system.shipCombat).toEqual({});
    const ids = [...actor.items.keys()];
    actor.update = update;
    expect(await initializeShipActor(actor)).toBe(true);
    expect([...actor.items.keys()]).toEqual(ids);
    expect(actor.creationCalls).toBe(1);
    expect(effectiveConfig(actor).components.weapons.map(({ id }) => id).sort())
      .toEqual(Object.keys(actor.system.shipCombat.state.weapons).sort());
  });

  test("only the active GM initializes ships", async () => {
    const actor = new FakeActor();
    globalThis.game.user = { id: "other-gm", isGM: true };
    expect(await initializeShipActor(actor)).toBe(false);
    expect(actor.items.size).toBe(0);
    expect(actor.system.shipCombat).toEqual({});
  });
});

describe("native vehicle edits through registered Actor hooks", () => {
  let actor;
  let callbacks;
  let notifications;
  let errors;
  let previousGlobals;
  let updateOptions;
  let updateChanges;

  // Hook work is queued on promises; yielding to a timer drains that queue and
  // the console-refresh timer before assertions or restoration of Foundry globals.
  async function settleHooks() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.mock.calls).toEqual([]);
  }

  // The console refresh coalescer rebuilds on an 80 ms trailing debounce and every hook event
  // restarts it, so restoring these Foundry globals without waiting leaves a timer behind that fires
  // after `Hooks` is gone (a cross-file failure). Wait the window out before the restore.
  async function drainConsoleRefresh() {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  beforeEach(async () => {
    previousGlobals = {
      Hooks: globalThis.Hooks,
      ui: globalThis.ui,
      CONST: globalThis.CONST,
    };
    errors = spyOn(console, "error").mockImplementation(() => {});
    callbacks = new Map();
    notifications = [];
    globalThis.Hooks = {
      on(name, callback) {
        const listeners = callbacks.get(name) ?? [];
        listeners.push(callback);
        callbacks.set(name, listeners);
      },
      callAll(name, ...args) {
        for (const callback of callbacks.get(name) ?? []) callback(...args);
      },
    };
    globalThis.ui = {
      notifications: { error: (message) => notifications.push(message) },
    };
    globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 } };
    Object.assign(game, { actors: [], scenes: [], combats: [] });
    game.users.get = (id) => id === game.user.id ? game.user : undefined;
    foundry.utils = {
      deepClone: clone,
      getProperty: (object, path) =>
        path.split(".").reduce((value, key) => value?.[key], object),
    };
    actor = new FakeActor(
      createDefaultShipSystemData(),
      CANADENSIS_DEFAULT_COMPONENT_SOURCES,
    );
    actor.id = actor.uuid.split(".").at(-1);
    actor.documentName = "Actor";
    const { config, state } = actor.system.shipCombat;
    actor.system.attributes = {
      ac: { calc: "flat", flat: config.ac },
      hp: { value: state.hull, max: config.maxHull },
    };
    actor.system.traits = { size: "med" };
    actor.system.details = { type: "space" };
    actor._source.system = clone(actor.system);
    updateOptions = [];
    updateChanges = [];
    actor.onUpdate = (changes, options) => {
      updateOptions.push(options);
      updateChanges.push(changes);
      Hooks.callAll("updateActor", actor, changes, options, game.user.id);
    };
    // The module owns a registration guard and queue; isolate them from other
    // hook fixtures without mocking the actual updateActor implementation.
    const { registerShipHooks } = await import(
      `../scripts/foundry/hooks.js?native-integration=${actor.id}`
    );
    registerShipHooks();
    await settleHooks();
  });

  afterEach(async () => {
    try {
      await settleHooks();
      await drainConsoleRefresh();
    } finally {
      errors.mockRestore();
      Object.assign(globalThis, previousGlobals);
    }
  });

  test("current HP edits retain phase, turn identity and spent actions/orders", async () => {
    Object.assign(actor.system.shipCombat.state, {
      phase: "active",
      turnKey: "combat:4:0",
      revision: 17,
      resources: { actions: { pilot: 0, gunner: 1 }, orders: { engineer: 0 } },
    });
    const before = clone(actor.system.shipCombat);

    await actor.update({ "system.attributes.hp.value": 13 });
    await settleHooks();

    expect(actor.system.shipCombat).toEqual({
      ...before,
      state: { ...before.state, hull: 13, revision: 18 },
    });
    expect(actor.system.attributes.hp).toEqual({
      value: 13,
      max: before.config.maxHull,
    });
    expect(notifications).toEqual([]);
  });

  test("combat blocks structural native edits but clamps current HP to the unchanged maximum", async () => {
    Object.assign(actor.system.shipCombat.state, {
      phase: "active",
      turnKey: "combat:4:0",
      revision: 17,
      hull: 10,
      resources: { actions: { pilot: 0 }, orders: { engineer: 0 } },
    });
    const before = clone(actor.system.shipCombat);

    await actor.update({
      "system.attributes.ac.flat": 18,
      "system.attributes.hp.max": 80,
      "system.attributes.hp.value": 70,
      "system.traits.size": "lg",
    });
    await settleHooks();

    expect(actor.system.shipCombat).toEqual({
      ...before,
      state: { ...before.state, hull: before.config.maxHull, revision: 18 },
    });
    expect(actor.system.attributes).toEqual({
      ac: { calc: "flat", flat: before.config.ac },
      hp: { value: before.config.maxHull, max: before.config.maxHull },
    });
    expect(actor.system.traits.size).toBe("med");
    expect(notifications).toHaveLength(1);
    // One user write, one sparse ship write and one corrected native mirror.
    // A missing INTERNAL_UPDATE guard would schedule additional reconciliation.
    expect(
      updateOptions.map((options) => options[INTERNAL_UPDATE_OPTION] === true),
    ).toEqual([false, true, true]);
  });

  test("outside combat accepts structural edits, clamps on reduction and does not heal on increase", async () => {
    const before = clone(actor.system.shipCombat);
    await actor.update({
      "system.attributes.ac.flat": 18,
      "system.attributes.hp.max": 20,
      "system.traits.size": "lg",
    });
    await settleHooks();
    expect(actor.system.shipCombat).toEqual({
      ...before,
      config: { ...before.config, ac: 18, maxHull: 20, size: "large" },
      state: { ...before.state, hull: 20, revision: 1 },
    });
    expect(actor.system.attributes.hp).toEqual({ value: 20, max: 20 });
    expect(actor.system.attributes.ac.flat).toBe(18);
    expect(actor.system.traits.size).toBe("lg");

    await actor.update({ "system.attributes.hp.max": 80 });
    await settleHooks();
    expect(actor.system.shipCombat.config.maxHull).toBe(80);
    expect(actor.system.shipCombat.state).toEqual({
      ...before.state,
      hull: 20,
      revision: 2,
    });
    expect(actor.system.attributes.hp).toEqual({ value: 20, max: 80 });
    expect(notifications).toEqual([]);
  });

  test("authoritative state writes mirror native HP without another writer or combat reset", async () => {
    const state = {
      ...clone(actor.system.shipCombat.state),
      hull: 7,
      phase: "end",
      turnKey: "combat:4:0",
      revision: 31,
      resources: { actions: { pilot: 0 }, orders: { engineer: 0 } },
    };
    await writeShipState({ actor }, state);
    await settleHooks();

    expect(actor.system.shipCombat.state).toEqual(state);
    expect(actor.system.attributes.hp).toEqual({
      value: 7,
      max: actor.system.shipCombat.config.maxHull,
    });
    expect(actor.updates).toBe(1);
    expect(updateOptions[0][INTERNAL_UPDATE_OPTION]).toBe(true);
    expect(notifications).toEqual([]);
  });

  test("drops state keys a delta-backed token no longer carries", async () => {
    const state = clone(actor.system.shipCombat.state);
    // Stored delta carries a Work entry the new state has dropped (a finished recovery job).
    actor.system.shipCombat.state.work = {
      "recovery:cooling": { current: 2, required: 2 },
    };
    actor._source.system = clone(actor.system);

    // A TokenDocument delta merges deeply, so a key the incoming payload omits survives; the harness's
    // FakeActor replaces the path outright, which would hide the bug this test pins.
    const mergeDeep = (base, patch) => {
      const out = { ...base };
      for (const [key, value] of Object.entries(patch ?? {})) {
        const nested = value && typeof value === "object" && !Array.isArray(value)
          && base?.[key] && typeof base[key] === "object" && !Array.isArray(base[key]);
        out[key] = nested ? mergeDeep(base[key], value) : clone(value);
      }
      return out;
    };
    actor.update = async (changes, options = {}) => {
      actor.updates += 1;
      updateChanges.push(changes);
      updateOptions.push(options);
      for (const [path, supplied] of Object.entries(changes)) {
        if (supplied instanceof FakeForcedDeletion) {
          const parts = path.split(".");
          const key = parts.pop();
          let parent = actor;
          for (const part of parts) parent = parent?.[part];
          if (parent) delete parent[key];
        } else if (path === "system.shipCombat.state") {
          actor.system.shipCombat.state = mergeDeep(
            actor.system.shipCombat.state,
            supplied.value,
          );
        } else {
          const parts = path.split(".");
          let cursor = actor;
          for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
          cursor[parts.at(-1)] = clone(supplied);
        }
      }
      actor._source.system = clone(actor.system);
      return actor;
    };

    await writeShipState({ actor, actorLink: false }, state);
    await settleHooks();

    expect(updateChanges).toHaveLength(2);
    expect(actor.system.shipCombat.state.work).toEqual({});
  });

  test("writes once for a linked actor whose path is replaced outright", async () => {
    const state = clone(actor.system.shipCombat.state);
    actor.system.shipCombat.state.work = {
      "recovery:cooling": { current: 2, required: 2 },
    };
    actor._source.system = clone(actor.system);

    await writeShipState({ actor, actorLink: true }, state);
    await settleHooks();

    expect(updateChanges).toHaveLength(1);
    expect(actor.system.shipCombat.state).toEqual(state);
  });

  /** A ship TokenDocument, synthetic (unlinked) unless the caller links it to a world Actor. */
  function shipToken(id, tokenScene, shipActor, { actorLink = false } = {}) {
    shipActor.id = `ship-${id}`;
    shipActor.uuid = `${tokenScene.uuid}.Token.${id}.Actor.ship`;
    shipActor.isToken = actorLink !== true;
    const token = {
      id,
      uuid: `${tokenScene.uuid}.Token.${id}`,
      documentName: "Token",
      name: `Ship ${id}`,
      actorId: shipActor.id,
      actorLink,
      actor: shipActor,
      parent: tokenScene,
    };
    shipActor.token = token;
    return token;
  }

  function unlinkedCopy(id, tokenScene) {
    const copy = new FakeActor(
      createDefaultShipSystemData(),
      CANADENSIS_DEFAULT_COMPONENT_SOURCES,
    );
    Object.assign(copy.system.shipCombat.state, {
      phase: "active",
      turnKey: "combat-1:3:cb-1",
      revision: 9,
      hull: 2,
      resources: { actions: { "canadensis-pilot-commander": 0 } },
    });
    copy._source.system = clone(copy.system);
    return shipToken(id, tokenScene, copy);
  }

  test("a synthetic copy no combat references is reset to a fresh outside-combat state", async () => {
    const scene = { id: "scene-1", uuid: "Scene.scene-1", tokens: [] };
    const token = unlinkedCopy("copy", scene);
    scene.tokens = [token];
    Object.assign(game, { scenes: [scene], combats: [] });
    const config = clone(token.actor.system.shipCombat.config);

    Hooks.callAll("createToken", token);
    await settleHooks();

    const { state, config: kept } = token.actor.system.shipCombat;
    expect(state.phase).toBe("outsideCombat");
    expect(state.turnKey).toBeNull();
    expect(state.revision).toBe(0);
    expect(state.hull).toBe(config.maxHull);
    expect(state.resources).toEqual({ actions: {}, orders: {} });
    expect(kept).toEqual(config);
    expect(notifications).toEqual([]);
  });

  test("a synthetic copy a combat references keeps the phase it is playing", async () => {
    const scene = { id: "scene-1", uuid: "Scene.scene-1", tokens: [] };
    const token = unlinkedCopy("referenced", scene);
    scene.tokens = [token];
    Object.assign(game, {
      scenes: [scene],
      combats: [{
        id: "combat-1",
        round: 3,
        scene,
        combatants: [{ id: "cb-1", tokenId: token.id, token }],
      }],
    });

    Hooks.callAll("createToken", token);
    await settleHooks();

    const { state } = token.actor.system.shipCombat;
    expect(state.phase).toBe("active");
    expect(state.turnKey).toBe("combat-1:3:cb-1");
    expect(state.hull).toBe(2);
    expect(notifications).toEqual([]);
  });

  /** Model core's deletion: the copy keeps neither its Actor context nor, when detached, its Scene. */
  function deleteShipToken(token, { detachScene = false } = {}) {
    token.actor = null;
    token.delta = { type: SHIP_TYPE };
    if (detachScene) delete token.parent;
    Hooks.callAll("deleteToken", token);
  }

  /** Install one linked survivor on `scene`, tracking itself and every token in `deadTokens`. */
  function shipScene(scene, deadTokens, combatTokens = []) {
    const survivor = shipToken(
      "survivor",
      scene,
      new FakeActor(
        createDefaultShipSystemData(),
        CANADENSIS_DEFAULT_COMPONENT_SOURCES,
      ),
      { actorLink: true },
    );
    scene.tokens = [survivor];
    game.scenes = [scene];
    // The Scene lookup is the fallback for a deleted copy that no longer reports its parent.
    game.scenes.get = (id) => (id === scene.id ? scene : undefined);
    game.combats = combatTokens.map((token) => ({
      id: `combat-${token.id}`,
      round: 1,
      scene,
      combatants: [{ id: `cb-${token.id}`, tokenId: token.id, token }],
    }));
    const tracks = {
      [trackKey(survivor.uuid)]: { targetUuid: survivor.uuid, state: "contact" },
    };
    for (const token of deadTokens) {
      tracks[trackKey(token.uuid)] = { targetUuid: token.uuid, state: "contact" };
    }
    Object.assign(survivor.actor.system.shipCombat.state, { tracks });
    survivor.actor._source.system = clone(survivor.actor.system);
    return { survivor, tracks };
  }

  test("a deleted ship token prunes the tracks it left on surviving ships, through the authority", async () => {
    const scene = { id: "scene-1", uuid: "Scene.scene-1", tokens: [] };
    const doomed = unlinkedCopy("doomed", scene);
    const { survivor, tracks } = shipScene(scene, [doomed], [doomed]);

    deleteShipToken(doomed);
    expect(survivor.actor.system.shipCombat.state.tracks).toEqual(tracks);

    await settleHooks();

    expect(Object.keys(survivor.actor.system.shipCombat.state.tracks))
      .toEqual([trackKey(survivor.uuid)]);
    expect(survivor.actor.updates).toBe(1);
    expect(notifications).toEqual([]);
  });

  test("a deleted copy that no longer reports its Scene still prunes on that Scene", async () => {
    const scene = { id: "scene-1", uuid: "Scene.scene-1", tokens: [] };
    const doomed = unlinkedCopy("detached", scene);
    const { survivor } = shipScene(scene, [doomed]);

    deleteShipToken(doomed, { detachScene: true });
    await settleHooks();

    expect(Object.keys(survivor.actor.system.shipCombat.state.tracks))
      .toEqual([trackKey(survivor.uuid)]);
    expect(notifications).toEqual([]);
  });

  test("a world actor update reconciles its linked token, never an unlinked copy", async () => {
    const sceneA = { id: "scene-a", uuid: "Scene.scene-a", tokens: [] };
    const sceneB = { id: "scene-b", uuid: "Scene.scene-b", tokens: [] };
    const linked = shipToken("linked", sceneA, actor, { actorLink: true });
    linked.actorId = actor.id;
    sceneA.tokens = [linked];
    const copy = new FakeActor(
      clone(actor.system.shipCombat),
      [...actor.items.values()],
    );
    // Copy-pasting a token keeps the base Actor id; only the link makes the copy authoritative.
    const copyToken = shipToken("copy", sceneB, copy);
    copyToken.actorId = actor.id;
    delete copy.system.shipCombat.state.schemaVersion;
    sceneB.tokens = [copyToken];
    Object.assign(game, { scenes: [sceneA, sceneB], combats: [] });

    await actor.update({ "system.attributes.hp.value": 11 });
    await settleHooks();

    expect(copy.updates).toBe(0);
    expect(copy.system.shipCombat.state.schemaVersion).toBeUndefined();
    expect(actor.system.attributes.hp.value).toBe(11);
    expect(notifications).toEqual([]);
  });
});
