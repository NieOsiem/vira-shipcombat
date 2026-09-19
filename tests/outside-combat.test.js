import { beforeEach, describe, expect, test } from "bun:test";

import { CANADENSIS_IDS } from "../scripts/data/canadensis.js";
import {
  createDefaultShipData,
  createInitialState,
} from "../scripts/model/defaults.js";
import { executeShipOperation } from "../scripts/rules/operations.js";
import { cycleOutsideCombatRound } from "../scripts/rules/lifecycle.js";
import { resolveShipDocument, readShipRecord, writeShipState } from "../scripts/state/token-state.js";
import { assertPermission, advanceCooldowns } from "../scripts/state/action-queue.js";
import { createDefaultShipActorData, createDefaultShipSystemData } from "../scripts/model/defaults.js";
import { SHIP_TYPE } from "../scripts/constants.js";

const SOURCE_TOKEN = "Scene.test.Token.source";
const SOURCE_ACTOR = "Actor.test.source";

function clone(value) {
  return structuredClone(value);
}

function createTestShip(uuid = SOURCE_TOKEN, overrides = {}) {
  const data = createDefaultShipData();
  data.state = createInitialState(data.config);
  data.state.phase = "outsideCombat";
  return {
    config: data.config,
    state: data.state,
    token: uuid.startsWith("Scene.") ? { uuid, x: 100, y: 100, rotation: 0, width: 2 } : null,
    ...overrides,
  };
}

function createContext(ships, overrides = {}) {
  return {
    ships: Object.fromEntries(
      Object.entries(ships).map(([uuid, record]) => [uuid, clone(record)]),
    ),
    userId: "gm-user",
    isGM: true,
    rollD20: () => 15,
    random: () => 0,
    ...overrides,
  };
}

function createRequest(type, sourceUuid, payload = {}) {
  return {
    id: "req-test",
    type,
    sourceUuid,
    targetUuids: [],
    expectedRevisions: { [sourceUuid]: 0 },
    payload,
  };
}

describe("outside-combat lifecycle and round cycling", () => {
  test("cycleOutsideCombatRound resolves coasting, passive cooling, shield regen, and vent cooldown", () => {
    const testShip = createTestShip(SOURCE_TOKEN);
    testShip.state.position = { x: 10, y: 20 };
    testShip.state.velocity = { x: 3, y: 0 };
    testShip.state.facing = 0; // East (+x)
    testShip.state.heat = 6;
    testShip.state.ventCooldown = 2;
    testShip.state.shields = {
      ...testShip.state.shields,
      hp: { fore: 0, port: 5, starboard: 5, aft: 5 },
      regenerationAllocation: { fore: 50, port: 50, starboard: 0, aft: 0 },
    };
    testShip.state.timeline = 0.5;

    const result = cycleOutsideCombatRound(testShip.config, testShip.state, {
      input: { duration: 1, position: { x: 10, y: 20 }, facing: 0 },
      random: () => 0,
      targets: [],
    });

    expect(result.state.phase).toBe("outsideCombat");
    expect(result.state.timeline).toBe(0);
    // Coasting: velocity was 3 with 0.5 timeline remaining, so x advances by 1.5 to 11.5
    expect(result.coast.position.x).toBeCloseTo(11.5);
    expect(result.coast.position.y).toBeCloseTo(20);
    // Vent cooldown ticks down from 2 to 1
    expect(result.state.ventCooldown).toBe(1);
    // Passive cooling reduces heat
    expect(result.state.heat).toBeLessThan(6);
    // Shield regens
    expect(result.state.shields.hp.fore).toBeGreaterThan(0);
  });

  test("advanceTurn operation via executeShipOperation cycles the ship systems cleanly", () => {
    const testShip = createTestShip(SOURCE_TOKEN);
    testShip.state.heat = 4;
    testShip.state.ventCooldown = 1;
    const ctx = createContext({ [SOURCE_TOKEN]: testShip });
    const req = createRequest("advanceTurn", SOURCE_TOKEN);

    const outcome = executeShipOperation(req, ctx);
    const updated = outcome.shipStates[SOURCE_TOKEN];
    expect(updated.phase).toBe("outsideCombat");
    expect(updated.ventCooldown).toBe(0);
    expect(updated.timeline).toBe(0);
  });
});

describe("operations outside combat", () => {
  test("routePower, toggleWeapon, and routeDefense succeed outside combat without holding controls", () => {
    const testShip = createTestShip(SOURCE_TOKEN);
    const ctx = createContext({ [SOURCE_TOKEN]: testShip });

    // Route power (Weapons needs >= reserved, which is 4)
    const powerReq = createRequest("routePower", SOURCE_TOKEN, {
      allocation: {
        engines: 2,
        shields: 3,
        sensors: 1,
        weapons: 4,
        cooling: 2,
        inertia: 1,
      },
    });
    const powerResult = executeShipOperation(powerReq, ctx);
    const powerState = powerResult.shipStates[SOURCE_TOKEN];
    expect(powerState.power.engines).toBe(2);
    expect(powerState.power.shields).toBe(3);

    // Toggle weapon
    const weaponId = testShip.config.components.weapons[0].id;
    const weaponReq = createRequest("toggleWeapon", SOURCE_TOKEN, {
      weaponId,
      status: "online",
      mode: "nominal",
    });
    const weaponResult = executeShipOperation(weaponReq, ctx);
    expect(weaponResult.shipStates[SOURCE_TOKEN].weapons[weaponId].status).toBe("online");

    // Route defense
    const defenseReq = createRequest("routeDefense", SOURCE_TOKEN, {
      allocation: { fore: 6, port: 4, starboard: 4, aft: 4 },
      regenerationAllocation: { fore: 40, port: 20, starboard: 20, aft: 20 },
    });
    const defenseResult = executeShipOperation(defenseReq, ctx);
    const defenseState = defenseResult.shipStates[SOURCE_TOKEN];
    expect(defenseState.shields.allocation.fore).toBe(6);
    expect(defenseState.shields.regenerationAllocation.fore).toBe(40);
  });

  test("repairs and cooling succeed outside combat without operator or order deductions", () => {
    const testShip = createTestShip(SOURCE_TOKEN);
    testShip.state.heat = 5;
    testShip.state.hull = 30; // Damaged
    const ctx = createContext({ [SOURCE_TOKEN]: testShip });

    // Active cooling
    const coolReq = createRequest("cooling", SOURCE_TOKEN);
    const coolResult = executeShipOperation(coolReq, ctx);
    expect(coolResult.shipStates[SOURCE_TOKEN].heat).toBeLessThan(5);

    // Field patch hull
    const hullReq = createRequest("hullRepair", SOURCE_TOKEN);
    const hullResult = executeShipOperation(hullReq, ctx);
    expect(hullResult.shipStates[SOURCE_TOKEN].hull).toBeGreaterThanOrEqual(30);
  });

  test("spatial operations require a placed canvas token", () => {
    const unplacedShip = createTestShip(SOURCE_ACTOR, { token: null });
    const ctx = createContext({ [SOURCE_ACTOR]: unplacedShip });

    const maneuverReq = createRequest("maneuver", SOURCE_ACTOR, {
      deltaV: { forward: 1, lateral: 0 },
    });

    expect(() => executeShipOperation(maneuverReq, ctx)).toThrow("Maneuver requires a placed token on the canvas.");

    const rotateReq = createRequest("rotate", SOURCE_ACTOR, {
      rotation: 30,
    });
    expect(() => executeShipOperation(rotateReq, ctx)).toThrow("Rotation requires a placed token on the canvas.");
  });

  test("maneuver and rotate succeed outside combat when placed on canvas", () => {
    const placedShip = createTestShip(SOURCE_TOKEN);
    const ctx = createContext({ [SOURCE_TOKEN]: placedShip });

    const maneuverReq = createRequest("maneuver", SOURCE_TOKEN, {
      deltaV: { forward: 2, lateral: 0 },
      rotation: 0,
      pivot: 0,
    });
    const maneuverResult = executeShipOperation(maneuverReq, ctx);
    const vel = maneuverResult.shipStates[SOURCE_TOKEN].velocity;
    expect(Math.hypot(vel.x, vel.y)).toBeGreaterThan(0);

    const rotateReq = createRequest("rotate", SOURCE_TOKEN, {
      rotation: 45,
    });
    const rotateResult = executeShipOperation(rotateReq, ctx);
    expect(rotateResult.shipStates[SOURCE_TOKEN].facing).toBe(45);
  });

  test("in-combat operations like attack fail outside combat", () => {
    const testShip = createTestShip(SOURCE_TOKEN);
    const ctx = createContext({ [SOURCE_TOKEN]: testShip });

    const attackReq = createRequest("attack", SOURCE_TOKEN, {
      gmOverride: true,
      operatorId: "canadensis-gunner-sensor",
      weaponId: testShip.config.components.weapons[0].id,
    });
    expect(() => executeShipOperation(attackReq, ctx)).toThrow("This operation is only legal during the ship's Active Phase.");
  });
});

describe("unplaced actor document persistence and token state", () => {
  test("resolveShipDocument resolves both Token and Actor documents", async () => {
    const fakeActor = {
      documentName: "Actor",
      uuid: "Actor.12345",
      type: SHIP_TYPE,
      system: { shipCombat: { state: { revision: 1 } } },
    };
    const fakeToken = {
      documentName: "Token",
      uuid: "Scene.s1.Token.t1",
      actor: fakeActor,
    };

    const previousFromUuid = globalThis.fromUuid;
    globalThis.fromUuid = async (uuid) => {
      if (uuid === "Actor.12345") return fakeActor;
      if (uuid === "Scene.s1.Token.t1") return fakeToken;
      return null;
    };

    try {
      const resolvedActor = await resolveShipDocument("Actor.12345");
      expect(resolvedActor).toBe(fakeActor);

      const resolvedToken = await resolveShipDocument("Scene.s1.Token.t1");
      expect(resolvedToken).toBe(fakeToken);
    } finally {
      globalThis.fromUuid = previousFromUuid;
    }
  });

  test("readShipRecord and writeShipState correctly read and write directly to an unplaced Actor", async () => {
    let updatedSystem = null;
    const defaultActorData = createDefaultShipActorData();
    const fakeActor = {
      documentName: "Actor",
      uuid: "Actor.sidebar123",
      type: SHIP_TYPE,
      name: "Corvette",
      system: clone(defaultActorData.system),
      items: new Map(defaultActorData.items.map((i) => [i._id, { ...clone(i), id: i._id }])),
      update: async (changes) => {
        updatedSystem = changes["system.shipCombat.state"];
      },
    };

    const previousFoundry = globalThis.foundry;
    globalThis.foundry = {
      data: {
        operators: {
          ForcedReplacement: { create: (value) => value },
        },
      },
    };

    try {
      const record = await readShipRecord(fakeActor);
      expect(record.tokenDocument).toBeNull();
      expect(record.actorDocument).toBe(fakeActor);
      expect(record.state.phase).toBe("outsideCombat");

      record.state.power.engines = 4;
      await writeShipState(record.actorDocument, record.state);
      expect(updatedSystem).not.toBeNull();
      expect(updatedSystem.power.engines).toBe(4);
    } finally {
      globalThis.foundry = previousFoundry;
    }
  });
});

describe("player permissions and advance cooldown outside combat", () => {
  beforeEach(() => {
    advanceCooldowns.clear();
  });

  test("player with OBSERVER permission can operate ship outside combat", () => {
    const player = { id: "p1", isGM: false };
    const fakeActor = {
      testUserPermission: (_user, level) => level <= 2, // Has OBSERVER (2)
    };
    const source = {
      uuid: SOURCE_TOKEN,
      state: { phase: "outsideCombat" },
      tokenDocument: { actor: fakeActor },
    };
    const req = createRequest("routePower", SOURCE_TOKEN, { allocation: {} });

    expect(() => assertPermission(player, req, source)).not.toThrow();
  });

  test("player without OBSERVER permission is rejected outside combat", () => {
    const player = { id: "p2", isGM: false };
    const fakeActor = {
      testUserPermission: (_user, level) => false,
    };
    const source = {
      uuid: SOURCE_TOKEN,
      state: { phase: "outsideCombat" },
      tokenDocument: { actor: fakeActor },
    };
    const req = createRequest("routePower", SOURCE_TOKEN, { allocation: {} });

    expect(() => assertPermission(player, req, source)).toThrow("Observer permission on the ship is required");
  });

  test("player advancing turn triggers 12-second cooldown on subsequent advances", () => {
    const player = { id: "p1", isGM: false };
    const fakeActor = {
      testUserPermission: () => true,
    };
    const source = {
      uuid: SOURCE_TOKEN,
      state: { phase: "outsideCombat" },
      tokenDocument: { actor: fakeActor },
    };
    const req = createRequest("advanceTurn", SOURCE_TOKEN);

    // First advance succeeds
    expect(() => assertPermission(player, req, source)).not.toThrow();

    // Second advance immediately afterwards fails with ADVANCE_COOLDOWN
    expect(() => assertPermission(player, req, source)).toThrow("Advance Turn is on cooldown");
  });

  test("GM is not subject to advance cooldown", () => {
    const gm = { id: "gm", isGM: true };
    const source = {
      uuid: SOURCE_TOKEN,
      state: { phase: "outsideCombat" },
    };
    const req = createRequest("advanceTurn", SOURCE_TOKEN);

    expect(() => assertPermission(gm, req, source)).not.toThrow();
    expect(() => assertPermission(gm, req, source)).not.toThrow();
  });
});

