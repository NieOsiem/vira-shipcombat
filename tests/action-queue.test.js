import { afterEach, expect, test } from "bun:test";

import { SHIP_TYPE } from "../scripts/constants.js";
import { createDefaultShipActorData, createDefaultShipData } from "../scripts/model/defaults.js";
import { getSensorStats, trackKey } from "../scripts/rules/sensors.js";
import { submitShipOperation } from "../scripts/state/action-queue.js";

const originalGlobals = {
  foundry: globalThis.foundry,
  fromUuid: globalThis.fromUuid,
  game: globalThis.game,
};
let requestSequence = 0;

function clone(value) {
  return structuredClone(value);
}

function operation(type, sourceUuid, payload) {
  return {
    id: `action-queue-regression-${++requestSequence}`,
    type,
    sourceUuid,
    targetUuids: [],
    expectedRevisions: { [sourceUuid]: 0 },
    payload,
  };
}

function passiveRange() {
  const ship = createDefaultShipData();
  return getSensorStats(ship.config, ship.state).passiveRange;
}

function authorityScene() {
  const gm = { id: `action-queue-gm-${requestSequence}`, isGM: true, active: true };
  const users = new Map([[gm.id, gm]]);
  users.activeGM = gm;
  const scene = {
    uuid: `Scene.action-queue-${requestSequence}`,
    tokens: new Map(),
    walls: [],
    grid: { size: 100 },
  };
  const documents = new Map();

  function place(name, position) {
    const uuid = `${scene.uuid}.Token.${name}`;
    const data = createDefaultShipActorData();
    const actor = {
      uuid: `Actor.${name}-${requestSequence}`,
      type: SHIP_TYPE,
      system: clone(data.system),
      items: new Map(data.items.map((item) => [
        item._id,
        { ...clone(item), id: item._id },
      ])),
      async update(changes) {
        if (changes["system.shipCombat.state"]) {
          this.system.shipCombat.state = clone(changes["system.shipCombat.state"]);
        }
        return this;
      },
    };
    actor.system.shipCombat.state.position = clone(position);
    const token = {
      documentName: "Token",
      uuid,
      actor,
      parent: scene,
      x: (position.x * scene.grid.size) - (scene.grid.size / 2),
      y: (position.y * scene.grid.size) - (scene.grid.size / 2),
      width: 1,
      height: 1,
      rotation: 0,
      toObject() {
        return {
          x: this.x,
          y: this.y,
          width: this.width,
          height: this.height,
          rotation: this.rotation,
        };
      },
      async update(changes) {
        Object.assign(this, clone(changes));
        return this;
      },
    };
    scene.tokens.set(uuid, token);
    documents.set(uuid, token);
    return { actor, token, uuid };
  }

  globalThis.game = {
    user: gm,
    users,
    socket: { on() {} },
    journal: [],
  };
  globalThis.foundry = {
    data: {
      operators: {
        ForcedReplacement: { create: (value) => value },
      },
    },
  };
  globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;

  return { place, scene };
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("post-movement passive detection uses the draft token distance", async () => {
  const range = passiveRange();
  const { place } = authorityScene();
  const observer = place("observer", { x: 0, y: 0 });
  const mover = place("mover", { x: range * 3, y: 0 });

  const response = await submitShipOperation(operation("reposition", mover.uuid, {
    position: { x: range * 0.2, y: 0 },
    facing: 0,
    resetVelocity: true,
  }));

  expect(response.ok).toBe(true);
  expect(response.result.shipStates[observer.uuid].tracks[trackKey(mover.uuid)])
    .toMatchObject({
      state: "contact",
      lastKnown: { position: { x: range * 0.2, y: 0 }, stale: false },
    });
});

test("post-movement passive detection raycasts to the draft token position", async () => {
  const range = passiveRange();
  const { place, scene } = authorityScene();
  const observer = place("observer", { x: 0, y: 0 });
  const mover = place("mover", { x: range * 0.2, y: 0 });
  scene.walls.push({
    id: "old-position-blocker",
    c: [range * 10, -range * 10, range * 10, range * 10],
    ds: 0,
    sight: 1,
  });

  const response = await submitShipOperation(operation("reposition", mover.uuid, {
    position: { x: 0, y: range * 0.2 },
    facing: 0,
    resetVelocity: true,
  }));

  expect(response.ok).toBe(true);
  expect(response.result.shipStates[observer.uuid].tracks[trackKey(mover.uuid)])
    .toMatchObject({ state: "contact" });
});

test("passive telemetry updates do not stale a prepared spatial operation", async () => {
  const range = passiveRange();
  const { place } = authorityScene();
  const observer = place("observer", { x: 0, y: 0 });
  const mover = place("mover", { x: range * 0.2, y: 0 });
  observer.actor.system.shipCombat.state.tracks[trackKey(mover.uuid)] = {
    targetUuid: mover.uuid,
    state: "contact",
    passiveContact: true,
    remembered: {},
    jams: [],
    lastKnown: { position: { x: range * 0.2, y: 0 }, stale: false },
  };

  const first = await submitShipOperation(operation("reposition", mover.uuid, {
    position: { x: range * 0.3, y: 0 },
    facing: 0,
    resetVelocity: true,
  }));

  expect(first.ok).toBe(true);
  expect(first.result.telemetryOnlyUuids).toContain(observer.uuid);
  expect(observer.actor.system.shipCombat.state).toMatchObject({
    revision: 0,
    telemetryRevision: 1,
    tracks: {
      [trackKey(mover.uuid)]: {
        lastKnown: { position: { x: range * 0.3, y: 0 }, stale: false },
      },
    },
  });

  const prepared = await submitShipOperation(operation("reposition", observer.uuid, {
    position: { x: 1, y: 0 },
    facing: 0,
    resetVelocity: true,
  }));

  expect(prepared.ok).toBe(true);
  expect(observer.actor.system.shipCombat.state.revision).toBe(1);
  expect(observer.actor.system.shipCombat.state.telemetryRevision).toBe(1);
});
