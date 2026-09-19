import { describe, expect, test } from "bun:test";

import { CANADENSIS_HULL_CONFIG } from "../scripts/data/canadensis.js";
import {
  PEREGRINUS_HULL_CONFIG,
  PEREGRINUS_IDS,
} from "../scripts/data/peregrinus.js";
import { PEREGRINUS_COMPONENT_SOURCES } from "../scripts/data/peregrinus-components.js";
import {
  DEFAULT_REFERENCE_BUILD_ID,
  REFERENCE_BUILDS,
  referenceBuild,
  referenceBuildChoices,
} from "../scripts/data/reference-builds.js";
import {
  createDefaultShipData,
  normalizeShipData,
} from "../scripts/model/defaults.js";
import { validateShipConfig } from "../scripts/model/validation.js";
import {
  applyConditionTiers,
  conditionKey,
} from "../scripts/rules/conditions.js";
import {
  getDriveCapabilities,
  getPivotCapability,
} from "../scripts/rules/movement.js";
import { recoverShieldEmitter } from "../scripts/rules/shields.js";
import { contributeRecoveryWork } from "../scripts/rules/repairs.js";

const clone = (value) => structuredClone(value);
const PEREGRINUS_ID = PEREGRINUS_HULL_CONFIG.id;

function peregrinusShip() {
  return createDefaultShipData(PEREGRINUS_ID);
}

function mountedReferences(hull) {
  return [
    ...(hull.slots ?? []).map((slot) => slot.itemId),
    ...(hull.hardpoints ?? []).map((hardpoint) => hardpoint.weaponId),
  ].filter(Boolean);
}

/** Pool key of one critical entry, naming its struck region. */
function emitterConditionKey(sector) {
  return conditionKey({
    kind: "fault",
    channelId: "shieldEmitterDamage",
    componentId: PEREGRINUS_IDS.shield,
    sector,
  });
}

describe("reference build registry", () => {
  test("offers every bundled build and keeps the Canadensis as the blank-ship default", () => {
    expect(referenceBuildChoices()).toEqual([
      {
        id: CANADENSIS_HULL_CONFIG.id,
        label: CANADENSIS_HULL_CONFIG.label,
      },
      { id: PEREGRINUS_ID, label: PEREGRINUS_HULL_CONFIG.label },
    ]);
    expect(DEFAULT_REFERENCE_BUILD_ID).toBe(CANADENSIS_HULL_CONFIG.id);
    expect(referenceBuild(PEREGRINUS_ID).hull).toBe(PEREGRINUS_HULL_CONFIG);
    expect(referenceBuild("not-a-build")).toBeNull();
    expect(createDefaultShipData().hull.id).toBe(CANADENSIS_HULL_CONFIG.id);
  });

  test("rejects an unknown build instead of falling back to a default hull", () => {
    expect(() => createDefaultShipData("not-a-build")).toThrow(
      "Unknown reference build 'not-a-build'.",
    );
  });

  test("every registered build installs its own complete, exact-size kit", () => {
    expect(REFERENCE_BUILDS.map(({ id }) => id)).toEqual([
      CANADENSIS_HULL_CONFIG.id,
      PEREGRINUS_ID,
    ]);
    for (const build of REFERENCE_BUILDS) {
      const { hull, items, config } = createDefaultShipData(build.id);
      expect(validateShipConfig(config, { tokenWidth: 1 })).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      });
      expect(new Set(mountedReferences(hull))).toEqual(
        new Set(build.componentSources.map((source) => source._id)),
      );
      for (const mount of [...hull.slots, ...hull.hardpoints]) {
        const reference = mount.itemId ?? mount.weaponId;
        const size = mount.mountSize ?? mount.size;
        const source = items.find((item) => item._id === reference);
        expect(source.system.size).toBe(size);
      }
    }
  });

  test("its Small blueprint catalog fills every mount of the hull", () => {
    const { hull } = peregrinusShip();
    const blueprintFor = (mount) =>
      PEREGRINUS_COMPONENT_SOURCES.filter(({ system }) => {
        if (mount.category === "hardpoint") {
          return system.componentClass === "weapon" &&
            system.size === mount.mountSize &&
            system.definition.category === mount.category;
        }
        if (system.componentClass !== mount.class || system.size !== mount.size) {
          return false;
        }
        if (mount.class !== "drive") return true;
        const role = ["portLateral", "starboardLateral"].includes(mount.driveRole)
          ? "lateral"
          : mount.driveRole;
        return system.driveRole === role;
      });

    expect(PEREGRINUS_COMPONENT_SOURCES).toHaveLength(9);
    for (const mount of [...hull.slots, ...hull.hardpoints]) {
      expect(
        blueprintFor(mount).map(({ _id }) => _id),
        `${mount.label} has no installable blueprint`,
      ).not.toHaveLength(0);
    }
  });

  test("every component copy carries a valid Foundry Item ID", () => {
    // Installed copies are created with keepId from these IDs, so they must satisfy Foundry's
    // own document-ID contract (16 alphanumeric characters) or creation fails at runtime.
    for (const build of REFERENCE_BUILDS) {
      const ids = build.componentSources.map(({ _id }) => _id);
      expect(ids.every((id) => /^[A-Za-z0-9]{16}$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        mountedReferences(build.hull).every((id) => ids.includes(id)),
      ).toBe(true);
    }
  });

  test("normalization installs the registered kit of the hull it normalizes", () => {
    const normalized = normalizeShipData({
      config: clone(PEREGRINUS_HULL_CONFIG),
    });
    expect(Object.keys(normalized.state.weapons)).toEqual([
      PEREGRINUS_IDS.prowCannon,
      PEREGRINUS_IDS.dorsalCannon,
    ]);
    expect(normalized.state.shields.hp).toEqual({ bubble: 30 });
  });
});

describe("Peregrinus Interceptor reference build", () => {
  test("is a Small single-seat hull whose every mount takes Small components", () => {
    const { hull, config } = peregrinusShip();

    expect(hull).toMatchObject({
      id: PEREGRINUS_ID,
      label: "Peregrinus Interceptor",
      size: "small",
      maxHull: 25,
      heatCapacity: 12,
      ac: 15,
      baseSignature: 16,
      safeVelocity: 40,
      commandCapacity: 1,
      crewCapacity: 0,
      fatePolicy: "important",
      evasionReserve: 20,
      evasionAcBonus: 2,
      evasionHardReserve: 30,
      evasionHardAcCap: 4,
    });
    expect(hull.armor).toEqual({ fore: 2, port: 1, starboard: 1, aft: 1 });
    expect(hull.capabilityProfile).toMatchObject({
      hazards: false,
      physicalRepair: false,
      work: false,
    });
    expect(hull.operators.map(({ id }) => id)).toEqual(["peregrinus-pilot"]);
    expect(
      [...hull.slots, ...hull.hardpoints].map((mount) =>
        mount.mountSize ?? mount.size
      ),
    ).toEqual(Array.from({ length: 11 }, () => "small"));
    expect(config.components.reactor.nominalOutput).toBe(11);
  });

  test("seats exactly one pilot and loads both cannons without any crew", () => {
    const { state, config } = peregrinusShip();

    expect(state.roster).toEqual({
      command: [{ operatorId: "peregrinus-pilot", slot: 0 }],
      crew: [],
      lockedTurnKey: null,
    });
    expect(state.power).toEqual({
      engines: 3,
      shields: 2,
      sensors: 1,
      cooling: 1,
      inertia: 2,
      weapons: 2,
      redlining: false,
    });
    expect(Object.values(state.weapons)).toEqual([
      expect.objectContaining({ status: "online", readiness: 2 }),
      expect.objectContaining({ status: "online", readiness: 2 }),
    ]);
    // Charges recover automatically, so a hull with no Work capability stays loaded.
    for (const weapon of config.components.weapons) {
      expect(weapon.readiness).toMatchObject({
        recovery: "automaticStart",
        capacity: 2,
      });
    }
  });

  test("mounts only fixed forward guns, as two independent copies of one blueprint", () => {
    const { hull, config } = peregrinusShip();

    for (const hardpoint of hull.hardpoints) {
      expect(hardpoint).toMatchObject({
        category: "hardpoint",
        mountSize: "small",
        regions: ["fore"],
        orientation: 0,
        traverse: "fixed",
      });
    }
    expect(hull.hardpoints.map(({ weaponId }) => weaponId)).toEqual([
      PEREGRINUS_IDS.prowCannon,
      PEREGRINUS_IDS.dorsalCannon,
    ]);
    const [prow, dorsal] = config.components.weapons;
    expect(prow.id).not.toBe(dorsal.id);
    expect({ ...prow, id: null, hardpointId: null }).toEqual({
      ...dorsal,
      id: null,
      hardpointId: null,
    });
  });

  test("hits weaker than every Canadensis weapon while out-flying the Canadensis", () => {
    const peregrinus = peregrinusShip();
    const canadensis = createDefaultShipData();
    const cannon = peregrinus.config.components.weapons[0];

    for (const weapon of canadensis.config.components.weapons) {
      expect(cannon.damage.hull).toBeLessThan(weapon.damage.hull);
      expect(cannon.damage.shield).toBeLessThan(weapon.damage.shield);
    }

    expect(getDriveCapabilities(peregrinus.config, peregrinus.state)).toEqual({
      forward: 8,
      retro: 4,
      port: 3,
      starboard: 3,
      rotation: 90,
    });
    expect(getPivotCapability(peregrinus.config, peregrinus.state)).toBe(60);
    expect(getDriveCapabilities(peregrinus.config, peregrinus.state).forward)
      .toBeGreaterThan(
        getDriveCapabilities(canadensis.config, canadensis.state).forward,
      );
    expect(getDriveCapabilities(peregrinus.config, peregrinus.state).rotation)
      .toBeGreaterThan(
        getDriveCapabilities(canadensis.config, canadensis.state).rotation,
      );
  });

  test("fields a Bubble Shield pool that its emitter faults actually degrade", () => {
    const { config, state } = peregrinusShip();
    expect(config.components.shield).toMatchObject({
      topology: "bubble",
      totalBudget: 30,
    });
    expect(config.components.shield.emitters).toEqual([
      { id: `${PEREGRINUS_IDS.shield}:bubble`, sector: "bubble", regions: expect.any(Array) },
    ]);
    expect(state.shields).toEqual({
      hp: { bubble: 30 },
      allocation: { bubble: 30 },
      regenerationAllocation: { bubble: 100 },
      collapse: { bubble: 0 },
    });

    const major = applyConditionTiers(config, state, {
      conditionId: emitterConditionKey("fore"),
      tiers: 2,
    });
    expect(major.applications[0].after).toBe("major");
    expect(Object.values(state.conditions)).toEqual([
      expect.objectContaining({
        channelId: "shieldEmitterDamage",
        componentId: PEREGRINUS_IDS.shield,
        sector: "bubble",
      }),
    ]);
    // A Major emitter fault halves the shared pool's cap and clamps the pool to it.
    expect(state.shields.allocation).toEqual({ bubble: 15 });
    expect(state.shields.hp).toEqual({ bubble: 15 });

    const destroyed = applyConditionTiers(config, state, {
      conditionId: emitterConditionKey("fore"),
      tiers: 2,
    });
    expect(destroyed.applications[0].after).toBe("destroyed");
    expect(state.shields.allocation).toEqual({ bubble: 0 });
    expect(state.shields.hp).toEqual({ bubble: 0 });

    // Recovery restores the shared emitter, not a directional sector that does not exist.
    const recovered = recoverShieldEmitter(config, state, "fore");
    expect(recovered).toMatchObject({
      recovered: true,
      sector: "bubble",
      from: "destroyed",
      to: "critical",
    });
    expect(state.shields.collapse).toEqual({ bubble: 1 });
    expect(state.shields.hp).toEqual({ bubble: 0 });
  });

  test("resolves every struck region onto the one bubble emitter", () => {
    const { config, state } = peregrinusShip();

    for (const [index, sector] of ["fore", "port", "starboard", "aft"].entries()) {
      applyConditionTiers(config, state, {
        conditionId: emitterConditionKey(sector),
        tiers: 1,
      });
      expect(Object.keys(state.shields.allocation)).toEqual(["bubble"]);
      expect(Object.keys(state.shields.hp)).toEqual(["bubble"]);
      expect(
        Object.values(state.conditions).every((condition) =>
          ["bubble", null].includes(condition.sector)
        ),
      ).toBe(true);
      expect(Object.values(state.conditions)).toHaveLength(index + 1);
    }
  });

  test("denies its single pilot combat repair and Recovery Work (rules 3.5)", () => {
    const { config, state } = peregrinusShip();
    const sensorKey = conditionKey({
      kind: "fault",
      channelId: "sensorFault",
      componentId: PEREGRINUS_IDS.sensor,
    });
    applyConditionTiers(config, state, { conditionId: sensorKey, tiers: 4 });
    expect(state.conditions[sensorKey].severity).toBe("destroyed");

    const attempt = (operation) =>
      contributeRecoveryWork(config, state, {
        operatorId: "peregrinus-pilot",
        conditionId: sensorKey,
        operation,
      });

    expect(() => attempt({})).toThrow(
      expect.objectContaining({ code: "PHYSICAL_REPAIR_UNAVAILABLE" }),
    );
    expect(() => attempt({ allowPhysicalRepair: true })).toThrow(
      expect.objectContaining({ code: "WORK_UNAVAILABLE" }),
    );
  });
});
