import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SHIP_TYPE } from "../scripts/constants.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "../scripts/data/canadensis-components.js";
import { initializeShipActor } from "../scripts/foundry/initialization.js";
import { createDefaultShipSystemData } from "../scripts/model/defaults.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";
import { readShipRecord } from "../scripts/state/token-state.js";

const clone = (value) => structuredClone(value);

class FakeForcedReplacement {
  constructor(value) { this.value = value; }
  static create(value) { return new FakeForcedReplacement(value); }
}

let nextActorId = 0;
class FakeActor {
  constructor(shipCombat = {}, sources = []) {
    this.uuid = `Actor.initialization-${++nextActorId}`;
    this.type = SHIP_TYPE;
    this.system = { shipCombat: clone(shipCombat) };
    this._source = { system: clone(this.system) };
    this.items = new Map(sources.map((source) => [source._id, { ...clone(source), id: source._id }]));
    this.creationCalls = 0;
    this.updates = 0;
  }

  async createEmbeddedDocuments(_name, sources) {
    this.creationCalls++;
    const created = sources.map((source) => ({ ...clone(source), id: source._id }));
    for (const item of created) this.items.set(item.id, item);
    return created;
  }

  async update(changes) {
    this.updates++;
    this.system.shipCombat = clone(changes["system.shipCombat"].value);
    this._source.system = clone(this.system);
    return this;
  }
}

let previousFoundry;
let previousGame;
beforeEach(() => {
  previousFoundry = globalThis.foundry;
  previousGame = globalThis.game;
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: gm, users: { activeGM: gm } };
  globalThis.foundry = { data: { operators: { ForcedReplacement: FakeForcedReplacement } } };
});
afterEach(() => {
  globalThis.foundry = previousFoundry;
  globalThis.game = previousGame;
});

function effectiveConfig(actor) {
  return materializeShipConfig(actor.system.shipCombat.config, [...actor.items.values()]);
}

describe("current ship initialization", () => {
  test("serializes competing initialization and preserves later combat state", async () => {
    const actor = new FakeActor({ schemaVersion: 2, config: { schemaVersion: 2 }, state: { schemaVersion: 2 } });
    actor.uuid = "Scene.test.Token.synthetic.Actor.ship";
    expect(await Promise.all([initializeShipActor(actor), initializeShipActor(actor)])).toEqual([true, false]);
    const config = effectiveConfig(actor);
    expect(config.components.weapons.map(({ id }) => id).sort())
      .toEqual(Object.keys(actor.system.shipCombat.state.weapons).sort());
    expect(config.components.drives.portLateral.id).not.toBe(config.components.drives.starboardLateral.id);
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
    const custom = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES.find(({ system }) => system.componentClass === "reactor"));
    custom.name = "Custom Reactor";
    custom.system.definition.nominalOutput = 13;
    data.config.hardpoints[0].weaponId = null;
    data.state.hull = 3;
    const actor = new FakeActor(data, [custom]);
    expect(await initializeShipActor(actor)).toBe(true);
    expect(effectiveConfig(actor).components.reactor.nominalOutput).toBe(13);
    expect(effectiveConfig(actor).components.reactor.label).toBe("Custom Reactor");
    expect(effectiveConfig(actor).hardpoints[0].weaponId).toBeNull();
    expect(actor.system.shipCombat).toEqual(data);
    expect(actor.updates).toBe(0);
    expect(await initializeShipActor(actor)).toBe(false);
  });

  test("does not replace unrelated Items occupying referenced default IDs", async () => {
    const occupied = { _id: CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]._id, type: "loot", name: "Keep me" };
    const actor = new FakeActor({}, [occupied]);
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.items.get(occupied._id).name).toBe("Keep me");
    expect(actor.creationCalls).toBe(0);
    expect(actor.updates).toBe(0);
  });

  test("rejects incompatible existing components before installing defaults", async () => {
    const component = clone(CANADENSIS_DEFAULT_COMPONENT_SOURCES[0]);
    component.system.size = component.system.size === "large" ? "small" : "large";
    const actor = new FakeActor({}, [component]);
    await expect(initializeShipActor(actor)).rejects.toThrow();
    expect(actor.items.get(component._id).system.size).toBe(component.system.size);
    expect(actor.creationCalls).toBe(0);
    expect(actor.updates).toBe(0);
  });

  test("rejects obsolete persisted schema even when prepared data has current slots", async () => {
    const actor = new FakeActor(createDefaultShipSystemData(), CANADENSIS_DEFAULT_COMPONENT_SOURCES);
    actor._source.system.shipCombat.schemaVersion = 1;
    await expect(initializeShipActor(actor)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA_VERSION" });
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
    await expect(initializeShipActor(actor)).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA_VERSION" });
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
    actor.createEmbeddedDocuments = async (_name, sources) => sources.map((source, index) => ({
      ...clone(source), _id: `changed-${index}`, id: `changed-${index}`,
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
