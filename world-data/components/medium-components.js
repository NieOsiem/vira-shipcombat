import { SECTORS, TRAIT_IDS } from "../../scripts/constants.js";
import {
  componentSource,
  deepFreeze,
  driveTiers,
  installationSource,
} from "../../scripts/data/component-source.js";

/**
 * Medium-class hardware family for the world-only ship catalogue (waves 1-2). Every blueprint is
 * `medium`, the exact mount size of the hull slots and hardpoints the medium hulls define, and its
 * output is scaled to a two-seat corvette hull: a little more than the shipped Academy kit, priced in
 * Power and Heat rather than in coin.
 *
 * Nothing here ships inside the module. The catalogue exists for the GM client to seed the Ship
 * Components compendium; because a hull only installs a component whose size matches the mount, the
 * medium hulls in `world-data/hulls/` fit these and nothing else.
 *
 * Reading each line: `cheap` is the plain hull-of-the-line part a fit starts from, `premium` is the
 * part a crew pays for in Power, Heat, Boot Time and Signature. Two pairs are deliberately paired
 * this way — the Corvette Reactor against the Battery Reactor, and the Corvette Sensor Array against
 * the Longbow array — and the two barrage guns split the same way, at the same Power: the Escort
 * Battery trains 240° on a turret ring, the Broadside Macrocannon is a 165° casemate.
 */

/**
 * The engine's own barrage ladder (`scripts/rules/combat.js`) is keyed 1/4/6/8/10 and ignores a
 * component's declared list, but a battery still declares the rounds it is loaded for: the UI reads
 * the list, and a 4-round salvo is the narrowest one worth calling a barrage.
 */
const BARRAGE_PROFILES = deepFreeze([
  { rounds: 1, attackPenalty: 0, maxEffectiveHits: 1 },
  { rounds: 4, attackPenalty: -2, maxEffectiveHits: 2 },
  { rounds: 6, attackPenalty: -3, maxEffectiveHits: 3 },
  { rounds: 8, attackPenalty: -4, maxEffectiveHits: 4 },
  { rounds: 10, attackPenalty: -5, maxEffectiveHits: 5 },
]);

/* ------------------------------------------------------------------ *
 * Reactors
 * ------------------------------------------------------------------ */

/** Cheap: the 20-point plant that runs a standard corvette fit. */
export const MEDIUM_REACTOR_SOURCE = componentSource({
  _id: "MedReactorStd001",
  name: "Corvette Reactor",
  componentClass: "reactor",
  definition: {
    nominalOutput: 20,
    redlineOutput: 24,
    overclockHeat: 5,
    recoveryWork: 6,
  },
});

/**
 * Premium: the plant a gun battery needs. 26 nominal is what lets four barrage mounts and a heavy
 * cooling array sit behind one commit without redlining.
 */
export const MEDIUM_REACTOR_BATTERY_SOURCE = componentSource({
  _id: "MedReactorPre001",
  name: "Battery Reactor",
  componentClass: "reactor",
  definition: {
    nominalOutput: 26,
    redlineOutput: 32,
    overclockHeat: 8,
    recoveryWork: 8,
  },
});

/* ------------------------------------------------------------------ *
 * Drives
 * ------------------------------------------------------------------ */

/** Cheap: the line main drive. 6 thrust is a corvette's cruise, not a racer's. */
export const MEDIUM_MAIN_DRIVE_SOURCE = componentSource({
  _id: "MedDriveMainStd1",
  name: "Corvette Main Drive",
  componentClass: "drive",
  driveRole: "main",
  definition: {
    base: { thrust: 6 },
    tiers: driveTiers(1),
    recoveryWork: 4,
  },
});

/** Premium: 8 thrust and a hotter Overclock tier, for a hull built to run. */
export const MEDIUM_MAIN_DRIVE_FAST_SOURCE = componentSource({
  _id: "MedDriveMainFst1",
  name: "Racer Main Drive",
  componentClass: "drive",
  driveRole: "main",
  definition: {
    base: { thrust: 8 },
    tiers: driveTiers(2),
    recoveryWork: 5,
  },
});

/** Budget: 4 thrust line cargo drive, simple civilian tractor mechanics. */
export const MEDIUM_MAIN_DRIVE_CARGO_SOURCE = componentSource({
  _id: "MedDriveMainCrg1",
  name: "Surplus Cargo Main Drive",
  componentClass: "drive",
  driveRole: "main",
  definition: {
    base: { thrust: 4 },
    tiers: driveTiers(1),
    recoveryWork: 3,
  },
});

export const MEDIUM_REVERSE_DRIVE_SOURCE = componentSource({
  _id: "MedDriveRevStd01",
  name: "Corvette Reverse Drive",
  componentClass: "drive",
  driveRole: "reverse",
  definition: {
    base: { thrust: 3 },
    tiers: driveTiers(1),
    recoveryWork: 4,
  },
});

/** One blueprint; a hull installs two independent copies, 30° of rotation each. */
export const MEDIUM_LATERAL_DRIVE_SOURCE = componentSource({
  _id: "MedDriveLatStd01",
  name: "Corvette Lateral Drive",
  componentClass: "drive",
  driveRole: "lateral",
  definition: {
    base: { thrust: 2, rotation: 30 },
    tiers: driveTiers(1),
    recoveryWork: 3,
  },
});

/* ------------------------------------------------------------------ *
 * Shields
 * ------------------------------------------------------------------ */

/** Standard: 60 points over four facets, the medium hull's default deflector. */
export const MEDIUM_SHIELD_SOURCE = componentSource({
  _id: "MedShieldDir0001",
  name: "Corvette Deflector",
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
    recoveryWork: 4,
  },
});

/**
 * Economy: one pool instead of four facets. Less total budget and a longer recharge delay buy the
 * cheaper blueprint and the simpler console — a trade hull's deflector, not a warship's.
 */
export const MEDIUM_SHIELD_BUBBLE_SOURCE = componentSource({
  _id: "MedShieldBub0001",
  name: "Trade Bubble Deflector",
  componentClass: "shield",
  definition: {
    topology: "bubble",
    sectors: ["bubble"],
    totalBudget: 50,
    sectorCap: 50,
    rechargeDelay: 2,
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

/* ------------------------------------------------------------------ *
 * Sensors
 * ------------------------------------------------------------------ */

/** Standard: 100 su passive / 160 su active, the array a corvette is built with. */
export const MEDIUM_SENSOR_SOURCE = componentSource({
  _id: "MedSensorStd0001",
  name: "Corvette Sensor Array",
  componentClass: "sensor",
  definition: {
    base: {
      passiveRange: 100,
      passiveStrength: 11,
      activeRange: 160,
      activeModifier: 0,
      ewModifier: 0,
    },
    tiers: [
      { power: 0, online: false, rangeMultiplier: 0, passiveStrength: 0, activeModifier: 0 },
      { power: 1, online: true, rangeMultiplier: 0.5, passiveStrength: 8, activeModifier: -2 },
      { power: 2, online: true, rangeMultiplier: 1, passiveStrength: 11, activeModifier: 0 },
      { power: 3, online: true, rangeMultiplier: 1.25, passiveStrength: 13, activeModifier: 2, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 4,
  },
});

/**
 * Premium: 150 su passive / 240 su active. The 100 su array covers a 90 su Optimal band only at its
 * full 100 su — no margin for a target that is itself moving — and says nothing about the 180 su a
 * long gun can still reach into, so the hull that fights at 90 su carries this array instead.
 */
export const MEDIUM_SENSOR_LONG_SOURCE = componentSource({
  _id: "MedSensorLng0001",
  name: "Longbow Sensor Array",
  componentClass: "sensor",
  definition: {
    base: {
      passiveRange: 150,
      passiveStrength: 14,
      activeRange: 240,
      activeModifier: 1,
      ewModifier: 0,
    },
    tiers: [
      { power: 0, online: false, rangeMultiplier: 0, passiveStrength: 0, activeModifier: 0 },
      { power: 1, online: true, rangeMultiplier: 0.5, passiveStrength: 9, activeModifier: -1 },
      { power: 2, online: true, rangeMultiplier: 1, passiveStrength: 14, activeModifier: 1 },
      { power: 3, online: true, rangeMultiplier: 1.25, passiveStrength: 16, activeModifier: 2, overclock: true, overclockHeat: 3 },
    ],
    recoveryWork: 5,
  },
});

/* ------------------------------------------------------------------ *
 * Cooling
 * ------------------------------------------------------------------ */

/** Standard: 12 Heat a Start at Power 3, which is a corvette's gun load. */
export const MEDIUM_COOLING_SOURCE = componentSource({
  _id: "MedCoolingStd001",
  name: "Corvette Cooling Array",
  componentClass: "cooling",
  definition: {
    tiers: [
      { power: 0, cooling: 3 },
      { power: 1, cooling: 6 },
      { power: 2, cooling: 9 },
      { power: 3, cooling: 12 },
    ],
    ventAmount: 12,
    ventCooldown: 2,
    recoveryWork: 4,
  },
});

/** Premium: 16 Heat a Start and a bigger vent, for a hull that fires a whole battery at once. */
export const MEDIUM_COOLING_HEAVY_SOURCE = componentSource({
  _id: "MedCoolingHvy001",
  name: "Battery Cooling Array",
  componentClass: "cooling",
  definition: {
    tiers: [
      { power: 0, cooling: 4 },
      { power: 1, cooling: 8 },
      { power: 2, cooling: 12 },
      { power: 3, cooling: 16 },
    ],
    ventAmount: 18,
    ventCooldown: 2,
    recoveryWork: 6,
  },
});

/** Budget: 8 Heat a Start at Power 3, smaller emergency vent. */
export const MEDIUM_COOLING_CIVILIAN_SOURCE = componentSource({
  _id: "MedCoolingCiv001",
  name: "Civilian Radiator Array",
  componentClass: "cooling",
  definition: {
    tiers: [
      { power: 0, cooling: 2 },
      { power: 1, cooling: 4 },
      { power: 2, cooling: 6 },
      { power: 3, cooling: 8 },
    ],
    ventAmount: 8,
    ventCooldown: 3,
    recoveryWork: 3,
  },
});

/* ------------------------------------------------------------------ *
 * Inertial anchors
 * ------------------------------------------------------------------ */

/** Cheap: one tier, 30° of pivot — enough to nudge a nose, not to fly a curve. */
export const MEDIUM_INERTIA_LIGHT_SOURCE = componentSource({
  _id: "MedInertiaLt0001",
  name: "Inertial Anchor Mk I",
  componentClass: "inertia",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 30 },
    ],
    recoveryWork: 3,
  },
});

/** Standard: 45° / 60°. */
export const MEDIUM_INERTIA_SOURCE = componentSource({
  _id: "MedInertiaStd001",
  name: "Inertial Anchor Mk II",
  componentClass: "inertia",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 45 },
      { power: 2, online: true, pivot: 60 },
    ],
    recoveryWork: 4,
  },
});

/** Premium: 75° at Power 3 — a heavy hull's only way to bring a short-optimal battery to bear. */
export const MEDIUM_INERTIA_HEAVY_SOURCE = componentSource({
  _id: "MedInertiaHvy001",
  name: "Inertial Anchor Mk III",
  componentClass: "inertia",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 30 },
      { power: 2, online: true, pivot: 60 },
      { power: 3, online: true, pivot: 75 },
    ],
    recoveryWork: 5,
  },
});

/* ------------------------------------------------------------------ *
 * Weapons
 * ------------------------------------------------------------------ */

/**
 * Premium sniper: the medium main gun. 90 su Optimal / 180 su Maximum, AP 4, 20 hull a hit, and the
 * cost is everything else — 5 Weapons Power for a single ready shot, 3 Boot Time, 4 Heat a shot, and
 * the loudest signature spike in the family (-4). It is the hull's whole reason to exist: a fit that
 * cannot feed it is better off with the turret.
 */
export const MEDIUM_SPINAL_RAILGUN_SOURCE = componentSource({
  _id: "MedRailgunSpinal",
  name: "Spinal Railgun",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: -1,
    damage: { shield: 9, hull: 20, heat: 0 },
    armorPiercing: 4,
    projectileClass: "fast",
    range: { optimal: 90, maximum: 180 },
    arc: 45,
    powerRating: 5,
    bootTime: 3,
    firingHeat: { amount: 4, per: "shot" },
    signatureSpike: -4,
    recoveryWork: 3,
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
          powerRating: 6,
          accuracy: 1,
          damage: { hull: 26 },
          firingHeat: { amount: 6, per: "shot" },
        },
      },
    },
  },
});

/**
 * Cheap close-in gun: instant projectiles (the best tracking band) and a 30° window, so it only ever
 * answers something already sitting on the beam. It exists so a sniper hull has some answer at knife
 * range that does not cost it its Power budget.
 */
export const MEDIUM_CHASER_LASER_SOURCE = componentSource({
  _id: "MedChaserLaser01",
  name: "Chaser Laser",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 2,
    damage: { shield: 3, hull: 3, heat: 0 },
    armorPiercing: 0,
    projectileClass: "instant",
    range: { optimal: 45, maximum: 90 },
    arc: 30,
    powerRating: 1,
    bootTime: 1,
    firingHeat: { amount: 1, per: "shot" },
    signatureSpike: -1,
    recoveryWork: 1,
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
          powerRating: 2,
          damage: { hull: 5 },
          firingHeat: { amount: 2, per: "shot" },
        },
      },
    },
  },
});

/**
 * Cheap barrage: a casemate macrocannon that trains 165°. Four-round salvoes out of a 32-round
 * magazine, 7 shield a round with almost no armour piercing — it is a shield-stripper that a loader
 * has to keep fed, which is why its recovery is manual Work. Eight salvoes is what a battery hull
 * buys by carrying the weight: a shallower magazine spends the fight's second half dry.
 */
export const MEDIUM_MACROCANNON_SOURCE = componentSource({
  _id: "MedMacrocannon01",
  name: "Broadside Macrocannon",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 7, hull: 5, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 40, maximum: 80 },
    arc: 165,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -1,
    recoveryWork: 1,
    readiness: {
      type: "magazine",
      capacity: 32,
      recovery: "manualWork",
      work: 1,
    },
    traits: [{ id: TRAIT_IDS.barrage, profiles: BARRAGE_PROFILES }],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 3,
          accuracy: 1,
          firingHeat: { amount: 2, per: "physicalRound" },
        },
      },
    },
  },
});

/**
 * Premium barrage: the same salvo on a turret ring — 240° of train for the same 2 Weapons Power.
 * That arc, not its damage, is what an escort buys: it is the mount that makes a hull's windows
 * overlap into a full circle.
 */
export const MEDIUM_ESCORT_BATTERY_SOURCE = componentSource({
  _id: "MedEscortBtty001",
  name: "Escort Battery",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 7, hull: 5, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 40, maximum: 80 },
    arc: 240,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -1,
    recoveryWork: 1,
    readiness: {
      type: "magazine",
      capacity: 32,
      recovery: "manualWork",
      work: 1,
    },
    traits: [{ id: TRAIT_IDS.barrage, profiles: BARRAGE_PROFILES }],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 3,
          accuracy: 1,
          firingHeat: { amount: 2, per: "physicalRound" },
        },
      },
    },
  },
});

/**
 * Premium shieldBypass: listed shield damage plus hull damage that goes straight through a standing
 * field (`channels: ["hull"]`, `damageShield` left true). Moderate numbers, wide 210° train, and it
 * pays in Power, Boot Time and signature — the gun an escort points at a target it cannot out-damage.
 */
export const MEDIUM_BREAKER_LANCE_SOURCE = componentSource({
  _id: "MedBreakerLance1",
  name: "Breaker Lance",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 6, hull: 11, heat: 0 },
    armorPiercing: 1,
    projectileClass: "instant",
    range: { optimal: 45, maximum: 90 },
    arc: 210,
    powerRating: 3,
    bootTime: 2,
    firingHeat: { amount: 2, per: "shot" },
    signatureSpike: -3,
    recoveryWork: 2,
    readiness: {
      type: "charges",
      capacity: 2,
      recovery: "automaticStart",
      eligibleStarts: 1,
    },
    traits: [{ id: TRAIT_IDS.shieldBypass, channels: ["hull"] }],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 4,
          damage: { hull: 14 },
          firingHeat: { amount: 3, per: "shot" },
        },
      },
    },
  },
});

/**
 * Premium crit-fisher: 16 hull a hit, AP 2, and `vicious` upgrades a natural-20 critical from one
 * condition tier to two. One ready shot a turn means the hull trades rate of fire for the chance to
 * end a fight with a single critical; it belongs on a hull whose crew can aim.
 */
export const MEDIUM_EXECUTIONER_SOURCE = componentSource({
  _id: "MedExecutioner01",
  name: "Executioner Cannon",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 1,
    damage: { shield: 4, hull: 16, heat: 0 },
    armorPiercing: 2,
    projectileClass: "fast",
    range: { optimal: 60, maximum: 120 },
    arc: 90,
    powerRating: 3,
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
    traits: [{ id: TRAIT_IDS.vicious }],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 4,
          damage: { hull: 21 },
          firingHeat: { amount: 5, per: "shot" },
        },
      },
    },
  },
});

/** Cheap generalist: 45 su / 90 su on 120° of train. The gun a hull falls back on. */
export const MEDIUM_TURRET_LASER_SOURCE = componentSource({
  _id: "MedTurretLaser01",
  name: "Corvette Turret",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 1,
    damage: { shield: 5, hull: 6, heat: 0 },
    armorPiercing: 0,
    projectileClass: "fast",
    range: { optimal: 45, maximum: 90 },
    arc: 120,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 2, per: "shot" },
    signatureSpike: -2,
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
          damage: { shield: 6, hull: 8 },
          firingHeat: { amount: 3, per: "shot" },
        },
      },
    },
  },
});

/* ------------------------------------------------------------------ *
 * Wave 2 parts
 * ------------------------------------------------------------------ */

/**
 * The wave-2 shelf for the medium class: the tiers wave 1 left thin. Everything above is wave 1 and
 * is unchanged; the six parts below fill its ladders at both ends and in the two gaps its own notes
 * point at. Readings are relative to the entry each one sits beside.
 *
 *   reactor ladder   16/19 · 20/24 · 26/32 · 32/38   (Wave 1 shipped the middle two)
 *   shield ladder    50 bubble · 60/24 · 76/28        (Wave 1 shipped the first two)
 *   sensor ladder    100/160 · 125/190 · 150/240      (Wave 1 shipped the ends)
 *   barrage ladder   5 shield / 16 rounds · 7 / 32 · 7 / 32 wide
 */

/**
 * Wave 2: the budget plant. The Corvette Reactor is the cheap shelf part, so a militia hull or a
 * blank template paid for 20 nominal whether or not it had 20 points of systems to run. 16/19 is
 * sized to the smallest fit that is still a warship — engines 3, shields 3, sensors 2, cooling 3,
 * inertia 2 and one 3-Power gun commit exactly 16 — with a gentler Overclock (4 Heat) and a shorter
 * recovery (Work 5) than the Corvette plant's 20/24, 5 Heat, Work 6.
 */
export const MEDIUM_REACTOR_LIGHT_SOURCE = componentSource({
  _id: "MedReactorLgt001",
  name: "Corvette Light Reactor",
  componentClass: "reactor",
  definition: {
    nominalOutput: 16,
    redlineOutput: 19,
    overclockHeat: 4,
    recoveryWork: 5,
  },
});

/**
 * Wave 2: the premium plant, and the top of the class's output ladder. The Battery Reactor caps a
 * medium hull at 26 nominal, which is the Vanguard's four-gun battery and nothing more; 32/38 is what
 * lets a heavy fit run its guns *and* a full spread of systems — a 13-Power armament (say a Spinal
 * Railgun and four batteries) plus engines 4, shields 4, sensors 3, cooling 3 and inertia 3 already
 * spends 30, which is a redline on the 26-point plant and comfortable here. It is paid for the way
 * every premium reactor in the catalogue is: the family's highest Overclock Heat (10) and longest
 * recovery (Work 10).
 */
export const MEDIUM_REACTOR_TWIN_CORE_SOURCE = componentSource({
  _id: "MedReactorTwin01",
  name: "Twin-Core Reactor",
  componentClass: "reactor",
  definition: {
    nominalOutput: 32,
    redlineOutput: 38,
    overclockHeat: 10,
    recoveryWork: 10,
  },
});

/**
 * Wave 2: the premium directional array. The Corvette Deflector's 60 points over four facets is the
 * standard medium shield, and the Trade Bubble below it is the economy one; 76 with a 28-point sector
 * cap is the warship's: four even facets become 19 each, or the defense operator can concentrate
 * 28/28/20/0 on the two bearings the fire is actually coming through, which a 24-point cap cannot do.
 * The regeneration ladder is a step up as well (5/9/12 against 4/8/10), and the premium is fit
 * effort: Work 7 to repair or replace against the standard array's Work 4, and a 3-Heat Overclock
 * tier against its 2.
 */
export const MEDIUM_SHIELD_HEAVY_SOURCE = componentSource({
  _id: "MedShieldHvy0001",
  name: "Bastion Deflector",
  componentClass: "shield",
  definition: {
    topology: "directional",
    sectors: [...SECTORS],
    totalBudget: 76,
    sectorCap: 28,
    rechargeDelay: 1,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 5 },
      { power: 3, online: true, regeneration: 9 },
      { power: 4, online: true, regeneration: 12, overclock: true, overclockHeat: 3 },
    ],
    recoveryWork: 7,
  },
});

/**
 * Wave 2: the budget array, and the middle rung of the sensor ladder. The Corvette Array reads 100 su
 * passive / 160 su active and the Longbow 150 / 240, so a hull that needed to see past 100 su had to
 * buy the long-range part's resolution as well; the Sweep reaches 125 / 190 on the standard array's
 * Work 4. It is not a free upgrade, which is the point of it: the wider aperture resolves *less* —
 * passive strength 10 where the Corvette array reads 11, and a −1 Active Modifier where it reads 0 —
 * so a gunner trading detection for reach takes the Longbow and a hull that only wants the horizon
 * takes this.
 */
export const MEDIUM_SENSOR_SWEEP_SOURCE = componentSource({
  _id: "MedSensorMid0001",
  name: "Sweep Sensor Array",
  componentClass: "sensor",
  definition: {
    base: {
      passiveRange: 125,
      passiveStrength: 10,
      activeRange: 190,
      activeModifier: -1,
      ewModifier: 0,
    },
    tiers: [
      { power: 0, online: false, rangeMultiplier: 0, passiveStrength: 0, activeModifier: 0 },
      { power: 1, online: true, rangeMultiplier: 0.5, passiveStrength: 8, activeModifier: -3 },
      { power: 2, online: true, rangeMultiplier: 1, passiveStrength: 10, activeModifier: -1 },
      { power: 3, online: true, rangeMultiplier: 1.25, passiveStrength: 12, activeModifier: 1, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 4,
  },
});

/**
 * Wave 2: the budget barrage gun. The Broadside Macrocannon and the Escort Battery are the same
 * seven-shield salvo on different mounts, and both are 2 Weapons Power with a 32-round magazine — so
 * "barrage" cost a militia hull two Power a mount and eight salvoes of depth to feed. The Militia gun
 * is the cheap half of that: five shield a round instead of seven (ten a salvo instead of fourteen), a
 * 30 su Optimal instead of 40, a 16-round magazine (four declared salvoes) instead of 32, and one
 * Weapons Power instead of two, so a 16-point plant can carry two of them and a gun swap.
 */
export const MEDIUM_BARRAGE_MILITIA_SOURCE = componentSource({
  _id: "MedBarrageMilt01",
  name: "Militia Barrage Gun",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 5, hull: 4, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 30, maximum: 60 },
    arc: 165,
    powerRating: 1,
    bootTime: 1,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -1,
    recoveryWork: 1,
    readiness: {
      type: "magazine",
      capacity: 16,
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
  },
});

/**
 * Wave 2: the premium wide-arc gun. Coverage on a medium hull used to mean one of two mounts — the
 * Escort Battery's 240° barrage ring, or the Corvette Turret's cheap 120° — so every "no blind arc"
 * fit in the class converges on the same gun. The Enfilade is the third answer: 270° of train (the
 * widest mount in the catalogue: 90° of stern stays blind, and nothing else does), instant
 * projectiles, so it shoots in the best tracking band at any range it can reach, and charges that
 * come back at every Start, so it keeps firing after a magazine-fed ring has emptied. It costs what a
 * premium mount costs here — 3 Weapons Power, a 2-turn boot, 2 Heat a shot and the family's -2
 * signature spike — and it pays for the arc in weight of fire: one shot a turn at 7 shield / 6 hull
 * against the Escort Battery's fourteen-shield salvo, for more Power.
 */
export const MEDIUM_ENFILADE_LASER_SOURCE = componentSource({
  _id: "MedEnfiladeLaser",
  name: "Enfilade Laser",
  componentClass: "weapon",
  definition: {
    category: "hardpoint",
    accuracy: 1,
    damage: { shield: 7, hull: 6, heat: 0 },
    armorPiercing: 0,
    projectileClass: "instant",
    range: { optimal: 50, maximum: 100 },
    arc: 270,
    powerRating: 3,
    bootTime: 2,
    firingHeat: { amount: 2, per: "shot" },
    signatureSpike: -2,
    recoveryWork: 3,
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
          powerRating: 4,
          damage: { shield: 8, hull: 8 },
          firingHeat: { amount: 3, per: "shot" },
        },
      },
    },
  },
});

/* ------------------------------------------------------------------ *
 * Installed copies
 * ------------------------------------------------------------------ */

/**
 * A hull installs one Item per mount, so every mount that carries a blueprint twice — the twin
 * laterals on all three hulls, the Ballista's chase-gun pair, the Aegis's battery pair, the
 * Vanguard's four macrocannons — needs its own 16-character ID. These copies are listed here as well
 * as in each hull's own kit because `--components-file` is what the balance tool materializes a
 * catalogue hull from: a hull file plus a catalogue that lacks its installed copies fails with
 * `DANGLING_INSTALLATION`.
 */
export const MEDIUM_INSTALLATION_IDS = deepFreeze({
  ballistaPortLateral: "MedLateralBalA01",
  ballistaStarboardLateral: "MedLateralBalB01",
  ballistaPortChaser: "MedChaserLaserA1",
  ballistaStarboardChaser: "MedChaserLaserB1",
  aegisPortLateral: "MedLateralAegA01",
  aegisStarboardLateral: "MedLateralAegB01",
  aegisPortBattery: "MedEscortBttyA01",
  aegisStarboardBattery: "MedEscortBttyB01",
  vanguardPortLateral: "MedLateralVanA01",
  vanguardStarboardLateral: "MedLateralVanB01",
  vanguardPortBatteryFore: "MedMacrocanA0001",
  vanguardPortBatteryAft: "MedMacrocanB0001",
  vanguardStarboardBatteryFore: "MedMacrocanC0001",
  vanguardStarboardBatteryAft: "MedMacrocanD0001",
});

/**
 * The Salvo's mounts (wave 2). The hull carries both barrage rings and both pincer lances, and each
 * mount is its own Item: a unit's readiness, magazine and faults must never alias another ship's.
 */
export const SALVO_INSTALLATION_IDS = deepFreeze({
  portLateral: "MedLateralSalA01",
  starboardLateral: "MedLateralSalB01",
  portBattery: "MedEscortSalA001",
  starboardBattery: "MedEscortSalB001",
  portLance: "MedBreakerSalA01",
  starboardLance: "MedBreakerSalB01",
});

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

/** Every medium blueprint the wave can install: the part library, then the installed copies. */
export const MEDIUM_COMPONENT_SOURCES = deepFreeze([
  MEDIUM_REACTOR_SOURCE,
  MEDIUM_REACTOR_BATTERY_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_MAIN_DRIVE_FAST_SOURCE,
  MEDIUM_MAIN_DRIVE_CARGO_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  MEDIUM_LATERAL_DRIVE_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_SHIELD_BUBBLE_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_SENSOR_LONG_SOURCE,
  MEDIUM_COOLING_SOURCE,
  MEDIUM_COOLING_HEAVY_SOURCE,
  MEDIUM_COOLING_CIVILIAN_SOURCE,
  MEDIUM_INERTIA_LIGHT_SOURCE,
  MEDIUM_INERTIA_SOURCE,
  MEDIUM_INERTIA_HEAVY_SOURCE,
  MEDIUM_SPINAL_RAILGUN_SOURCE,
  MEDIUM_CHASER_LASER_SOURCE,
  MEDIUM_MACROCANNON_SOURCE,
  MEDIUM_ESCORT_BATTERY_SOURCE,
  MEDIUM_BREAKER_LANCE_SOURCE,
  MEDIUM_EXECUTIONER_SOURCE,
  MEDIUM_TURRET_LASER_SOURCE,
  MEDIUM_REACTOR_LIGHT_SOURCE,
  MEDIUM_REACTOR_TWIN_CORE_SOURCE,
  MEDIUM_SHIELD_HEAVY_SOURCE,
  MEDIUM_SENSOR_SWEEP_SOURCE,
  MEDIUM_BARRAGE_MILITIA_SOURCE,
  MEDIUM_ENFILADE_LASER_SOURCE,
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, MEDIUM_INSTALLATION_IDS.ballistaPortLateral),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, MEDIUM_INSTALLATION_IDS.ballistaStarboardLateral),
  installationSource(MEDIUM_CHASER_LASER_SOURCE, MEDIUM_INSTALLATION_IDS.ballistaPortChaser),
  installationSource(MEDIUM_CHASER_LASER_SOURCE, MEDIUM_INSTALLATION_IDS.ballistaStarboardChaser),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, MEDIUM_INSTALLATION_IDS.aegisPortLateral),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, MEDIUM_INSTALLATION_IDS.aegisStarboardLateral),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, MEDIUM_INSTALLATION_IDS.aegisPortBattery),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, MEDIUM_INSTALLATION_IDS.aegisStarboardBattery),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, MEDIUM_INSTALLATION_IDS.vanguardPortLateral),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, MEDIUM_INSTALLATION_IDS.vanguardStarboardLateral),
  installationSource(MEDIUM_MACROCANNON_SOURCE, MEDIUM_INSTALLATION_IDS.vanguardPortBatteryFore),
  installationSource(MEDIUM_MACROCANNON_SOURCE, MEDIUM_INSTALLATION_IDS.vanguardPortBatteryAft),
  installationSource(MEDIUM_MACROCANNON_SOURCE, MEDIUM_INSTALLATION_IDS.vanguardStarboardBatteryFore),
  installationSource(MEDIUM_MACROCANNON_SOURCE, MEDIUM_INSTALLATION_IDS.vanguardStarboardBatteryAft),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, SALVO_INSTALLATION_IDS.portLateral),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, SALVO_INSTALLATION_IDS.starboardLateral),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, SALVO_INSTALLATION_IDS.portBattery),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, SALVO_INSTALLATION_IDS.starboardBattery),
  installationSource(MEDIUM_BREAKER_LANCE_SOURCE, SALVO_INSTALLATION_IDS.portLance),
  installationSource(MEDIUM_BREAKER_LANCE_SOURCE, SALVO_INSTALLATION_IDS.starboardLance),
]);
