import {
  componentSource,
  deepFreeze,
  driveTiers,
  installationSource,
} from "./component-source.js";

/**
 * Small-class hardware family for the Peregrinus Interceptor. Every blueprint is `small`, the
 * exact mount size of the hull's nine system slots and two hardpoints, and its output is scaled
 * to a single-seat airframe: less total output than the Medium Canadensis kit, but far higher
 * thrust, rotation, and Signature Class.
 */

export const PEREGRINUS_REACTOR_SOURCE = componentSource({
  _id: "PereReactor00001",
  name: "Light Reactor",
  componentClass: "reactor",
  size: "small",
  definition: {
    nominalOutput: 11,
    redlineOutput: 13,
    overclockHeat: 3,
    recoveryWork: 4,
  },
});

/** Single-pool Bubble Shield: one shared budget, one Allocation, one HP value. */
export const PEREGRINUS_SHIELD_SOURCE = componentSource({
  _id: "PereShield000001",
  name: "Bubble Deflector",
  componentClass: "shield",
  size: "small",
  definition: {
    topology: "bubble",
    sectors: ["bubble"],
    totalBudget: 30,
    sectorCap: 30,
    rechargeDelay: 1,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 3 },
      { power: 3, online: true, regeneration: 6 },
      { power: 4, online: true, regeneration: 8, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 3,
  },
});

export const PEREGRINUS_SENSOR_SOURCE = componentSource({
  _id: "PereSensor000001",
  name: "Light Sensor Array",
  componentClass: "sensor",
  size: "small",
  definition: {
    base: {
      passiveRange: 80,
      passiveStrength: 8,
      activeRange: 120,
      activeModifier: 0,
      ewModifier: 0,
    },
    tiers: [
      { power: 0, online: false, rangeMultiplier: 0, passiveStrength: 0, activeModifier: 0 },
      { power: 1, online: true, rangeMultiplier: 0.5, passiveStrength: 6, activeModifier: -2 },
      { power: 2, online: true, rangeMultiplier: 1, passiveStrength: 8, activeModifier: 0 },
      { power: 3, online: true, rangeMultiplier: 1.25, passiveStrength: 10, activeModifier: 2, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 2,
  },
});

export const PEREGRINUS_COOLING_SOURCE = componentSource({
  _id: "PereCooling00001",
  name: "Compact Cooling Array",
  componentClass: "cooling",
  size: "small",
  definition: {
    tiers: [
      { power: 0, cooling: 1 },
      { power: 1, cooling: 2 },
      { power: 2, cooling: 4 },
      { power: 3, cooling: 6 },
    ],
    ventAmount: 8,
    ventCooldown: 2,
    recoveryWork: 2,
  },
});

export const PEREGRINUS_MAIN_DRIVE_SOURCE = componentSource({
  _id: "PereMainDrive001",
  name: "Light Main Drive",
  componentClass: "drive",
  size: "small",
  driveRole: "main",
  definition: {
    base: { thrust: 8 },
    tiers: driveTiers(1),
    recoveryWork: 3,
  },
});

export const PEREGRINUS_REVERSE_DRIVE_SOURCE = componentSource({
  _id: "PereRevDrive0001",
  name: "Light Reverse Drive",
  componentClass: "drive",
  size: "small",
  driveRole: "reverse",
  definition: {
    base: { thrust: 4 },
    tiers: driveTiers(0),
    recoveryWork: 3,
  },
});

/** One lateral blueprint; the hull installs two independent copies. */
export const PEREGRINUS_LATERAL_DRIVE_SOURCE = componentSource({
  _id: "PereLateral00001",
  name: "Light Lateral Drive",
  componentClass: "drive",
  size: "small",
  driveRole: "lateral",
  definition: {
    base: { thrust: 3, rotation: 45 },
    tiers: driveTiers(1),
    recoveryWork: 2,
  },
});

/** Vector Authority only; the hull frees no Power tier above 2 for it. */
export const PEREGRINUS_INERTIA_SOURCE = componentSource({
  _id: "PereInertia00001",
  name: "Compact Inertial Anchor",
  componentClass: "inertia",
  size: "small",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 45 },
      { power: 2, online: true, pivot: 60 },
    ],
    recoveryWork: 2,
  },
});

/**
 * Forward-fixed light cannon. Charges recover automatically at Start, so a single-seat hull
 * with Work capability disabled never needs a loader to keep firing.
 */
export const PEREGRINUS_LIGHT_CANNON_SOURCE = componentSource({
  _id: "PereCannon000001",
  name: "Light Cannon",
  componentClass: "weapon",
  size: "small",
  definition: {
    category: "hardpoint",
    accuracy: 1,
    damage: { shield: 4, hull: 5, heat: 0 },
    armorPiercing: 0,
    projectileClass: "fast",
    range: { optimal: 30, maximum: 60 },
    arc: 90,
    powerRating: 1,
    bootTime: 1,
    firingHeat: { amount: 1, per: "shot" },
    signatureSpike: -1,
    recoveryWork: 1,
    readiness: {
      type: "charges",
      capacity: 2,
      recovery: "automaticStart",
      eligibleStarts: 1,
    },
    traits: [],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 2,
          damage: { shield: 5, hull: 8 },
          firingHeat: { amount: 2, per: "shot" },
        },
      },
    },
  },
});

/**
 * The Small blueprint library: what the Ship Components compendium holds for this family, one
 * reusable blueprint per mount of the reference hull. Seeded copies keep these IDs, so a GM
 * browsing a mount sees the same catalog identity the bundled hull references.
 */
export const PEREGRINUS_COMPONENT_SOURCES = deepFreeze([
  PEREGRINUS_REACTOR_SOURCE,
  PEREGRINUS_SHIELD_SOURCE,
  PEREGRINUS_SENSOR_SOURCE,
  PEREGRINUS_COOLING_SOURCE,
  PEREGRINUS_MAIN_DRIVE_SOURCE,
  PEREGRINUS_REVERSE_DRIVE_SOURCE,
  PEREGRINUS_LATERAL_DRIVE_SOURCE,
  PEREGRINUS_INERTIA_SOURCE,
  PEREGRINUS_LIGHT_CANNON_SOURCE,
]);

/** The reference fighter's installed kit: nine system copies and two hardpoint cannons. */
export const PEREGRINUS_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  PEREGRINUS_REACTOR_SOURCE,
  PEREGRINUS_SHIELD_SOURCE,
  PEREGRINUS_SENSOR_SOURCE,
  PEREGRINUS_COOLING_SOURCE,
  PEREGRINUS_MAIN_DRIVE_SOURCE,
  PEREGRINUS_REVERSE_DRIVE_SOURCE,
  installationSource(PEREGRINUS_LATERAL_DRIVE_SOURCE, "PereLateralA0001"),
  installationSource(PEREGRINUS_LATERAL_DRIVE_SOURCE, "PereLateralB0001"),
  PEREGRINUS_INERTIA_SOURCE,
  installationSource(PEREGRINUS_LIGHT_CANNON_SOURCE, "PereCannonA00001"),
  installationSource(PEREGRINUS_LIGHT_CANNON_SOURCE, "PereCannonB00001"),
]);
