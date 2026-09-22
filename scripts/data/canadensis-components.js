import { SECTORS, TRAIT_IDS } from "../constants.js";
import {
  componentSource,
  deepFreeze,
  driveTiers,
  installationSource,
} from "./component-source.js";

const BARRAGE_PROFILES = deepFreeze([
  { rounds: 1, attackPenalty: 0, maxEffectiveHits: 1 },
  { rounds: 4, attackPenalty: -2, maxEffectiveHits: 2 },
  { rounds: 6, attackPenalty: -3, maxEffectiveHits: 3 },
  { rounds: 8, attackPenalty: -4, maxEffectiveHits: 4 },
  { rounds: 10, attackPenalty: -5, maxEffectiveHits: 5 },
]);

function macrocannonDefinition() {
  return {
    category: "hardpoint",
    visualStyle: "bullet",
    coreColor: "#ff8844",
    glowColor: "#ffcc66",
    accuracy: 0,
    damage: { shield: 7, hull: 9, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 30, maximum: 60 },
    arc: 120,
    powerRating: 1,
    bootTime: 0,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -1,
    recoveryWork: 1,
    readiness: {
      type: "magazine",
      capacity: 20,
      recovery: "manualWork",
      work: 1,
    },
    traits: [{ id: TRAIT_IDS.barrage, profiles: BARRAGE_PROFILES }],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 2,
          accuracy: 1,
          firingHeat: { amount: 2, per: "physicalRound" },
        },
      },
    },
  };
}

export const CANADENSIS_REACTOR_SOURCE = componentSource({
  _id: "CanadReactor0001",
  name: "Academy Reactor",
  componentClass: "reactor",
  definition: {
    nominalOutput: 14,
    redlineOutput: 16,
    overclockHeat: 4,
    recoveryWork: 6,
  },
});

export const CANADENSIS_SHIELD_SOURCE = componentSource({
  _id: "CanadShield00001",
  name: "Training Deflector",
  componentClass: "shield",
  definition: {
    topology: "directional",
    sectors: [...SECTORS],
    totalBudget: 60,
    sectorCap: 24,
    rechargeDelay: 1,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 4 },
      { power: 3, online: true, regeneration: 8 },
      { power: 4, online: true, regeneration: 10, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 3,
  },
});

export const CANADENSIS_SENSOR_SOURCE = componentSource({
  _id: "CanadSensor00001",
  name: "Academy Sensor Array",
  componentClass: "sensor",
  definition: {
    base: {
      passiveRange: 100,
      passiveStrength: 10,
      activeRange: 150,
      activeModifier: 0,
      ewModifier: 0,
    },
    tiers: [
      { power: 0, online: false, rangeMultiplier: 0, passiveStrength: 0, activeModifier: 0 },
      { power: 1, online: true, rangeMultiplier: 0.5, passiveStrength: 8, activeModifier: -2 },
      { power: 2, online: true, rangeMultiplier: 1, passiveStrength: 10, activeModifier: 0 },
      { power: 3, online: true, rangeMultiplier: 1.25, passiveStrength: 12, activeModifier: 2, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 3,
  },
});

export const CANADENSIS_COOLING_SOURCE = componentSource({
  _id: "CanadCooling0001",
  name: "Training Cooling Array",
  componentClass: "cooling",
  definition: {
    tiers: [
      { power: 0, cooling: 2 },
      { power: 1, cooling: 4 },
      { power: 2, cooling: 6 },
      { power: 3, cooling: 8 },
    ],
    ventAmount: 10,
    ventCooldown: 2,
    recoveryWork: 3,
  },
});

export const CANADENSIS_MAIN_DRIVE_SOURCE = componentSource({
  _id: "CanadMainDrive01",
  name: "Training Main Drive",
  componentClass: "drive",
  driveRole: "main",
  definition: {
    base: { thrust: 6 },
    tiers: driveTiers(1),
    recoveryWork: 4,
  },
});

export const CANADENSIS_REVERSE_DRIVE_SOURCE = componentSource({
  _id: "CanadRevDrive001",
  name: "Training Reverse Drive",
  componentClass: "drive",
  driveRole: "reverse",
  definition: {
    base: { thrust: 3 },
    tiers: driveTiers(0),
    recoveryWork: 4,
  },
});

export const CANADENSIS_LATERAL_DRIVE_SOURCE = componentSource({
  _id: "CanadLateral0001",
  name: "Training Lateral Drive",
  componentClass: "drive",
  driveRole: "lateral",
  definition: {
    base: { thrust: 2, rotation: 30 },
    tiers: driveTiers(1),
    recoveryWork: 3,
  },
});

export const CANADENSIS_INERTIA_LIGHT_SOURCE = componentSource({
  _id: "CanadInertiaLt01",
  name: "Inertial Anchor Mk I",
  componentClass: "inertia",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 45 },
    ],
    recoveryWork: 3,
  },
});

export const CANADENSIS_INERTIA_SOURCE = componentSource({
  _id: "CanadInertia0001",
  name: "Inertial Anchor Mk II",
  componentClass: "inertia",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 30 },
      { power: 2, online: true, pivot: 60 },
    ],
    recoveryWork: 3,
  },
});

export const CANADENSIS_INERTIA_HEAVY_SOURCE = componentSource({
  _id: "CanadInertiaHv01",
  name: "Inertial Anchor Mk III",
  componentClass: "inertia",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 10 },
      { power: 2, online: true, pivot: 40 },
      { power: 3, online: true, pivot: 75 },
    ],
    recoveryWork: 3,
  },
});

export const CANADENSIS_RAILGUN_SOURCE = componentSource({
  _id: "CanadRailgun0001",
  name: "Twin Railgun",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    visualStyle: "railgun",
    coreColor: "#44ddff",
    glowColor: "#88eeff",
    accuracy: -1,
    damage: { shield: 6, hull: 12, heat: 0 },
    armorPiercing: 3,
    projectileClass: "fast",
    range: { optimal: 60, maximum: 120 },
    arc: 90,
    powerRating: 2,
    bootTime: 2,
    firingHeat: { amount: 3, per: "shot" },
    signatureSpike: -2,
    recoveryWork: 2,
    readiness: {
      type: "readyShot",
      capacity: 1,
      recovery: "automaticStart",
      eligibleStarts: 1,
    },
    traits: [],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 3,
          damage: { hull: 16 },
          firingHeat: { amount: 5, per: "shot" },
        },
      },
    },
  },
});

export const CANADENSIS_LASER_SOURCE = componentSource({
  _id: "CanadLaser000001",
  name: "Pulse Laser",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    visualStyle: "laser",
    coreColor: "#44ff88",
    glowColor: "#88ffaa",
    accuracy: 2,
    damage: { shield: 12, hull: 6, heat: 2 },
    armorPiercing: 0,
    projectileClass: "instant",
    range: { optimal: 40, maximum: 80 },
    arc: 180,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 2, per: "shot" },
    signatureSpike: -3,
    recoveryWork: 2,
    readiness: {
      type: "charges",
      capacity: 3,
      recovery: "automaticStart",
      eligibleStarts: 1,
    },
    traits: [],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 3,
          damage: { shield: 15, heat: 3 },
          firingHeat: { amount: 3, per: "shot" },
        },
      },
    },
  },
});

export const CANADENSIS_MACROCANNON_SOURCE = componentSource({
  _id: "CanadMacrocan001",
  name: "Training Macrocannon",
  componentClass: "weapon",
  definition: macrocannonDefinition(),
});

export const CANADENSIS_COMPONENT_SOURCES = deepFreeze([
  CANADENSIS_REACTOR_SOURCE,
  CANADENSIS_SHIELD_SOURCE,
  CANADENSIS_SENSOR_SOURCE,
  CANADENSIS_COOLING_SOURCE,
  CANADENSIS_MAIN_DRIVE_SOURCE,
  CANADENSIS_REVERSE_DRIVE_SOURCE,
  CANADENSIS_LATERAL_DRIVE_SOURCE,
  CANADENSIS_RAILGUN_SOURCE,
  CANADENSIS_LASER_SOURCE,
  CANADENSIS_MACROCANNON_SOURCE,
  CANADENSIS_INERTIA_LIGHT_SOURCE,
  CANADENSIS_INERTIA_SOURCE,
  CANADENSIS_INERTIA_HEAVY_SOURCE,
]);

export const CANADENSIS_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  CANADENSIS_REACTOR_SOURCE,
  CANADENSIS_SHIELD_SOURCE,
  CANADENSIS_SENSOR_SOURCE,
  CANADENSIS_COOLING_SOURCE,
  CANADENSIS_MAIN_DRIVE_SOURCE,
  CANADENSIS_REVERSE_DRIVE_SOURCE,
  installationSource(CANADENSIS_LATERAL_DRIVE_SOURCE, "CanadLateralA001"),
  installationSource(CANADENSIS_LATERAL_DRIVE_SOURCE, "CanadLateralB001"),
  CANADENSIS_INERTIA_SOURCE,
  CANADENSIS_RAILGUN_SOURCE,
  CANADENSIS_LASER_SOURCE,
  installationSource(CANADENSIS_MACROCANNON_SOURCE, "CanadMacrocanA01"),
  installationSource(CANADENSIS_MACROCANNON_SOURCE, "CanadMacrocanB01"),
]);
