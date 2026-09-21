/**
 * Small-class hardware family for wave 1: the parts the Lance long-gun sniper and the Wasp knife
 * brawler install, plus the refit blueprints either hull (or a Peregrinus) can buy.
 *
 * Nothing here ships with the module. `world-data/` is the world-side catalogue that
 * `tools/world/install-catalogue.js` seeds into the GM's Items and compendium packs; the bundled
 * `scripts/data/*-components.js` kits are untouched, so a stock Peregrinus keeps its own parts.
 *
 * Cheap/premium reading (there are no price fields by design — the shop is the GM's call):
 *   cheap    Light Reactor, Bubble Deflector, Segment Deflector, Light Sensor Array, Compact Cooling
 *            Array, Cutter Main Drive, Light Reverse Drive, Cutter Lateral Drive, Inertial Anchor
 *            Mk I, Storm Barrage Gun
 *   premium  Long-Base Reactor, Vector Deflector, Long-Base Sensor Array, Deep-Core Cooling Array,
 *            Vector Main Drive, Inertial Anchor Mk II / Mk III, Light Railgun, Skipshot Gun
 *
 * Design notes that matter at the table:
 * - The cheap Light Sensor Array reads passive 40 su at Sensors Power 1, which is blind at the 60 su
 *   opening range the duel harness and the encounter rules both use. The Long-Base Array is the part
 *   that fixes it (passive 80 / active 120 at the same single Power), and both wave-1 fighters ship
 *   with it; the cheap one stays in the catalogue as the budget refit for hulls that fight inside
 *   40 su.
 * - Both wave-1 fighters ship directional arrays (the Lance the premium Vector, the Wasp the cheap
 *   Segment) for a rules reason, not a flavour one: a Bubble Shield's single pool repairs whatever
 *   lands on it one-for-one out of its whole budget, so sustained fire below that budget is repaired
 *   exactly and the anti-regeneration measurement comes back at zero however hard the attacker hits.
 *   The bubble stays in the catalogue as the all-round refit for a hull that expects to be shot from
 *   every bearing at once — it is the tougher shield, and the one attrition maths cannot beat.
 * - The two small weapons that matter are the Lance's Light Railgun (one shot a turn, accuracy -1,
 *   AP 2, hull 9, `vicious` — the crit-fisher of the agreed weapon vocabulary, 60/120 su) and the
 *   Wasp's Storm Barrage Gun (25/75 su, 270° envelope, four-round barrage profiles, magazine 160,
 *   shield 5, hull 4, AP 1).
 * - The Skipshot Gun is the premium shield-bypass gun. Neither wave-1 hull installs it: it is a
 *   refit part for a hull that wants to shoot at hull through a shield (Power Rating 3 and a 3-turn
 *   boot are the premium it charges).
 */
import { SECTORS, TRAIT_IDS } from "../../scripts/constants.js";
import {
  componentSource,
  deepFreeze,
  driveTiers,
  installationSource,
} from "../../scripts/data/component-source.js";

/** The engine's own standard Barrage table, for the round counts this gun can declare (§9.5). */
const BARRAGE_PROFILES = deepFreeze([
  { rounds: 1, attackPenalty: 0, maxEffectiveHits: 1 },
  { rounds: 4, attackPenalty: -2, maxEffectiveHits: 2 },
  { rounds: 6, attackPenalty: -3, maxEffectiveHits: 3 },
  { rounds: 8, attackPenalty: -4, maxEffectiveHits: 4 },
]);

/* ------------------------------------------------------------------ *
 * Reactors
 * ------------------------------------------------------------------ */

/** Cheap: the Peregrinus-grade plant. Runs a single gun, four drives and a light array. */
export const SMALL_REACTOR_SOURCE = componentSource({
  _id: "SmlReactor000001",
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

/**
 * Premium: the long gun's plant. 14 nominal is the number that matters — the Lance commits 12, so
 * it reads `normal` emission (0.857 of nominal) instead of the `high` band a plant running past
 * 90 % would give away.
 */
export const SMALL_REACTOR_HEAVY_SOURCE = componentSource({
  _id: "SmlReactor000002",
  name: "Long-Base Reactor",
  componentClass: "reactor",
  size: "small",
  definition: {
    nominalOutput: 14,
    redlineOutput: 16,
    overclockHeat: 4,
    recoveryWork: 5,
  },
});

/**
 * Wave 2: the budget plant. The Light Reactor is already the cheap shelf part, so the class had no
 * *low-cost* option below it and no output choice at all: a militia hull pays for 11 nominal whether
 * it needs 8 or not. 8/10 is sized to the smallest fit that is still a warship — engines, shields,
 * one cooling tier, one pivot tier and one Power-1 gun commit exactly 8 — with the gentlest
 * Overclock the family has (2 Heat) and the shortest recovery (Work 3).
 */
export const SMALL_REACTOR_SHORT_BASE_SOURCE = componentSource({
  _id: "SmlReactor000003",
  name: "Short-Base Reactor",
  componentClass: "reactor",
  size: "small",
  definition: {
    nominalOutput: 8,
    redlineOutput: 10,
    overclockHeat: 2,
    recoveryWork: 3,
  },
});

/**
 * Wave 2: the premium plant, and the top of the class's output ladder. The Long-Base Reactor caps a
 * small hull at 14 nominal, which is a single heavy gun's fit (the Shrike's Skipshot, three Shields
 * Tiers and a Mk III pivot already spend 14); 18/21 is what lets a small hull run two expensive
 * mounts or a full Shields-and-pivot spread without leaving the nominal band. It is paid for the way
 * every premium reactor in the catalogue is: the highest Overclock Heat (6) and the longest
 * recovery (Work 6) in the family.
 */
export const SMALL_REACTOR_TWIN_CORE_SOURCE = componentSource({
  _id: "SmlReactor000004",
  name: "Twin-Core Reactor",
  componentClass: "reactor",
  size: "small",
  definition: {
    nominalOutput: 18,
    redlineOutput: 21,
    overclockHeat: 6,
    recoveryWork: 6,
  },
});

/* ------------------------------------------------------------------ *
 * Shields
 * ------------------------------------------------------------------ */

/**
 * Cheap: one pool, one Allocation, one HP value (rules §7.6). 30 points all round is the tough
 * option on a small frame because nothing can be stripped: it is what the Wasp buys.
 */
export const SMALL_SHIELD_BUBBLE_SOURCE = componentSource({
  _id: "SmlShieldBubble1",
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

/**
 * Premium: 48 points over four facets (12 each) with a better regeneration ladder than the bubble.
 * The trade is deliberate — a directional array never has 30 points of cushion on the bearing it is
 * being shot from, so one stripped facet takes hull hits, but the regeneration funnel is thinner and
 * sustained fire can out-damage it.
 */
export const SMALL_SHIELD_VECTOR_SOURCE = componentSource({
  _id: "SmlShieldVector1",
  name: "Vector Deflector",
  componentClass: "shield",
  size: "small",
  definition: {
    topology: "directional",
    sectors: [...SECTORS],
    totalBudget: 48,
    sectorCap: 14,
    rechargeDelay: 1,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 4 },
      { power: 3, online: true, regeneration: 7 },
      { power: 4, online: true, regeneration: 9, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 3,
  },
});

/**
 * Cheap: the budget directional array. 36 points, 9 a facet, and the same reason to exist as the
 * Vector — a segmented shield spreads its regeneration across four weights, so sustained fire is not
 * repaired one-for-one the way a single bubble pool repairs it. It is what the Wasp buys: less
 * cushion per bearing than the bubble, and the only small shield under the Vector that a knife gun
 * can actually beat.
 */
export const SMALL_SHIELD_SEGMENT_SOURCE = componentSource({
  _id: "SmlShieldSegmen1",
  name: "Segment Deflector",
  componentClass: "shield",
  size: "small",
  definition: {
    topology: "directional",
    sectors: [...SECTORS],
    totalBudget: 36,
    sectorCap: 12,
    rechargeDelay: 1,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 3 },
      { power: 3, online: true, regeneration: 5 },
      { power: 4, online: true, regeneration: 7, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 3,
  },
});

/* ------------------------------------------------------------------ *
 * Sensors
 * ------------------------------------------------------------------ */

/**
 * Cheap: the budget array. Base 80 with the family's 0.5 range multiplier at Sensors Power 1 reads
 * passive 40 / active 60 — inside the 60 su opening the fight starts at, so a hull carrying one
 * starts blind and has to close. See the file note above: that is the trap this wave fixes.
 */
export const SMALL_SENSOR_LIGHT_SOURCE = componentSource({
  _id: "SmlSensorLight01",
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

/**
 * Premium: the long-range small array. Passive 80 su at a single Sensors Power — the 60 su opening
 * range is inside it, so a one-seat hull can Acquire and shoot on turn 1 instead of burning Actions
 * on a track it cannot form.
 */
export const SMALL_SENSOR_LONG_SOURCE = componentSource({
  _id: "SmlSensorLong001",
  name: "Long-Base Sensor Array",
  componentClass: "sensor",
  size: "small",
  definition: {
    base: {
      passiveRange: 160,
      passiveStrength: 10,
      activeRange: 240,
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

/* ------------------------------------------------------------------ *
 * Cooling
 * ------------------------------------------------------------------ */

/** Cheap: enough for one shot a turn or one four-round barrage every other turn. */
export const SMALL_COOLING_COMPACT_SOURCE = componentSource({
  _id: "SmlCoolingArray1",
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

/** Premium: the railgun's radiator. Two Heat a shot is sustained at Cooling 2 with room to vent. */
export const SMALL_COOLING_DEEP_SOURCE = componentSource({
  _id: "SmlCoolingDeep01",
  name: "Deep-Core Cooling Array",
  componentClass: "cooling",
  size: "small",
  definition: {
    tiers: [
      { power: 0, cooling: 2 },
      { power: 1, cooling: 3 },
      { power: 2, cooling: 6 },
      { power: 3, cooling: 8 },
    ],
    ventAmount: 10,
    ventCooldown: 2,
    recoveryWork: 3,
  },
});

/* ------------------------------------------------------------------ *
 * Drives
 * ------------------------------------------------------------------ */

/**
 * Premium: the sniper's drive. Main 7 is one step under the Peregrinus interceptor's 8 — a long gun
 * does not need the sprint, it needs to arrive on station with its Optimal band intact.
 */
export const SMALL_MAIN_DRIVE_SOURCE = componentSource({
  _id: "SmlMainDrive0001",
  name: "Vector Main Drive",
  componentClass: "drive",
  size: "small",
  driveRole: "main",
  definition: {
    base: { thrust: 7 },
    tiers: driveTiers(1),
    recoveryWork: 3,
  },
});

/** Cheap: the brawler's drive. Main 6 trades 4 su/turn of top speed for a smaller plant to feed. */
export const SMALL_MAIN_DRIVE_CUTTER_SOURCE = componentSource({
  _id: "SmlMainDrive0002",
  name: "Cutter Main Drive",
  componentClass: "drive",
  size: "small",
  driveRole: "main",
  definition: {
    base: { thrust: 6 },
    tiers: driveTiers(1),
    recoveryWork: 3,
  },
});

/** One blueprint; every wave-1 small hull carries one reverse drive. */
export const SMALL_REVERSE_DRIVE_SOURCE = componentSource({
  _id: "SmlRevDrive00001",
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

/**
 * Premium: 45° of rotation per lateral drive, so a pair flies 90°/turn and a parallel pass comes
 * back around in two turns. One blueprint, installed twice.
 */
export const SMALL_LATERAL_DRIVE_SOURCE = componentSource({
  _id: "SmlLateralDrive1",
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

/** Cheap: 30° per drive (60°/turn a pair). The budget hull's turning circle is its own cost. */
export const SMALL_LATERAL_DRIVE_CUTTER_SOURCE = componentSource({
  _id: "SmlLateralDrive2",
  name: "Cutter Lateral Drive",
  componentClass: "drive",
  size: "small",
  driveRole: "lateral",
  definition: {
    base: { thrust: 2, rotation: 30 },
    tiers: driveTiers(1),
    recoveryWork: 2,
  },
});

/* ------------------------------------------------------------------ *
 * Inertial Anchors
 * ------------------------------------------------------------------ */

/**
 * Cheap: the 45° anchor. With a 25 su Optimal gun that is not enough to hold the band at 30 su —
 * which is exactly why the Wasp buys coverage (a 270° envelope) instead of pivot authority.
 */
export const SMALL_ANCHOR_MK1_SOURCE = componentSource({
  _id: "SmlAnchorMk10001",
  name: "Inertial Anchor Mk I",
  componentClass: "inertia",
  size: "small",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 45 },
    ],
    recoveryWork: 2,
  },
});

/** The Lance's anchor: 60° at Power 2 holds a 60 su Optimal band up to 62.8 su/turn. */
export const SMALL_ANCHOR_MK2_SOURCE = componentSource({
  _id: "SmlAnchorMk20001",
  name: "Inertial Anchor Mk II",
  componentClass: "inertia",
  size: "small",
  definition: {
    tiers: [
      { power: 0, online: false, pivot: 0 },
      { power: 1, online: true, pivot: 30 },
      { power: 2, online: true, pivot: 60 },
    ],
    recoveryWork: 2,
  },
});

/** Premium: the 75° ceiling, mirroring the medium Mk III ladder for hulls that can spare 3 Power. */
export const SMALL_ANCHOR_MK3_SOURCE = componentSource({
  _id: "SmlAnchorMk30001",
  name: "Inertial Anchor Mk III",
  componentClass: "inertia",
  size: "small",
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

/* ------------------------------------------------------------------ *
 * Weapons
 * ------------------------------------------------------------------ */

/**
 * Premium: the Lance's long gun. Single barrel version of the medium Twin Railgun — accuracy -1,
 * AP 2, hull 9 on one shot a turn at a 60 / 120 su envelope, with `vicious` so a critical carries
 * two condition tiers instead of one. Power Rating 2 and a 3-turn boot are what "heavy" means on a
 * small mount: the gun is cheap to keep loaded and expensive to bring up.
 */
export const SMALL_RAILGUN_SOURCE = componentSource({
  _id: "SmlRailgun000001",
  name: "Light Railgun",
  componentClass: "weapon",
  size: "small",
  definition: {
    category: "hardpoint",
    accuracy: -1,
    damage: { shield: 5, hull: 9, heat: 0 },
    armorPiercing: 2,
    projectileClass: "fast",
    range: { optimal: 60, maximum: 120 },
    arc: 90,
    powerRating: 2,
    bootTime: 3,
    firingHeat: { amount: 2, per: "shot" },
    signatureSpike: -3,
    recoveryWork: 3,
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
          powerRating: 3,
          damage: { shield: 7, hull: 13 },
          firingHeat: { amount: 3, per: "shot" },
        },
      },
    },
  },
});

/**
 * Cheap: the Wasp's knife gun. One attack a turn that fires a physical-round Barrage — the profile
 * the attacker declares caps the effective hits, so a full four-round volley is two hits of shield 5
 * with no accuracy bonus at all. The 270° envelope is the brawler's real feature: with a 45° Mk I
 * anchor it cannot pivot, so it buys coverage instead (rules §9.2 — arc is a width centred on the
 * mount, and a spare 90° of stern stays blind).
 *
 * Magazine 160 at the four-round volley a barrage declaration costs is forty volleys — an entire
 * 40-turn engagement's worth of fire. That depth is not decoration, it is the whole difference
 * between a brawler that can win and one that can only survive: the duel harness's own 40-round
 * clock measures a magazine-fed hull by how long its gun keeps firing, and a shallow magazine
 * (20 rounds, five volleys) leaves it silent for 34 of those turns. Damage resolved per turn rises
 * almost linearly with the magazine until the doctrine's own once-a-turn firing rate caps it, which
 * is where 160 lands. Reloading it is manual Work 1, which is why the Wasp enables the `work`
 * capability its one-seat Peregrinus cousin forgoes.
 *
 * AP 1 and hull 4 are "low AP" as agreed — enough to chip plate (4 − (3 − 1) = 2 a hit through
 * armour 3, more against lighter hulls), nowhere near the railgun's AP 2 and hull 9.
 */
export const SMALL_BARRAGE_GUN_SOURCE = componentSource({
  _id: "SmlBarrageGun001",
  name: "Storm Barrage Gun",
  componentClass: "weapon",
  size: "small",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 5, hull: 4, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 25, maximum: 75 },
    arc: 270,
    powerRating: 1,
    bootTime: 1,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -1,
    recoveryWork: 2,
    readiness: {
      type: "magazine",
      capacity: 160,
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
 * Premium: the shield-bypass gun. Hull damage takes the bypass channel while the listed shield
 * damage still lands on the shield, so the hull behind a full shield feels every hit. The premium
 * is paid in Power Rating 3, a 3-turn boot, and charges that take a Start to come back.
 */
export const SMALL_BYPASS_GUN_SOURCE = componentSource({
  _id: "SmlBypassGun0001",
  name: "Skipshot Gun",
  componentClass: "weapon",
  size: "small",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 4, hull: 7, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 50, maximum: 100 },
    arc: 90,
    powerRating: 3,
    bootTime: 3,
    firingHeat: { amount: 2, per: "shot" },
    signatureSpike: -2,
    recoveryWork: 3,
    readiness: {
      type: "charges",
      capacity: 2,
      recovery: "automaticStart",
      eligibleStarts: 1,
    },
    traits: [{ id: TRAIT_IDS.shieldBypass, channels: ["hull"], damageShield: true }],
    modes: {
      nominal: { overrides: {} },
      overclock: {
        overrides: {
          powerRating: 4,
          damage: { shield: 6, hull: 10 },
          firingHeat: { amount: 3, per: "shot" },
        },
      },
    },
  },
});

/**
 * Wave 2: the barrage gun with reach. The Storm Barrage Gun is the knife — 25 su Optimal, a 270°
 * envelope, 5 shield a hit out of a 160-round magazine — and it was the class's only barrage entry,
 * so "barrage" meant "brawl" by definition. The Tempest is the other end of that choice: 40 su
 * Optimal / 100 su Maximum, so it holds the band the Storm can only reach into at Maximum, and it
 * pays for the reach in every currency the Storm is cheap in — 2 Power instead of 1, a 180° train
 * instead of 270°, 3 shield a hit instead of 5, and a 12-round magazine (three declared four-round
 * salvoes) instead of 160 that a loader has to keep feeding. Same 4-round barrage profile, same
 * AP 1 and 1 Heat a physical round: it is the same weapon philosophy pointed down a longer lane.
 */
export const SMALL_BARRAGE_GUN_LONG_SOURCE = componentSource({
  _id: "SmlBarrageGun002",
  name: "Tempest Barrage Gun",
  componentClass: "weapon",
  size: "small",
  definition: {
    category: "hardpoint",
    accuracy: 0,
    damage: { shield: 3, hull: 4, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 40, maximum: 100 },
    arc: 180,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -2,
    recoveryWork: 2,
    readiness: {
      type: "magazine",
      capacity: 12,
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
 * The two independent lateral-drive copies a hull installs share one blueprint but carry their own
 * Item IDs, exactly as the bundled kits build their twin drives and twin guns. They are listed here
 * as well as in the per-hull kits because `--components-file` is what `tools/sim/duel.mjs` and
 * `tools/balance/hull-report.mjs` materialize a catalogue hull from: a hull file plus a catalogue
 * that lacks its installed copies fails with `DANGLING_INSTALLATION`.
 */
export const SMALL_LATERAL_INSTALLATION_IDS = deepFreeze([
  "SmlLateralA00001",
  "SmlLateralB00001",
  "SmlLateralC00001",
  "SmlLateralD00001",
]);

/**
 * Wave-2 installed copies: the Shrike's and the Gnat's lateral pairs, plus the Gnat's barrage gun.
 * As above, a mount that carries a blueprint another hull already installs needs its own Item ID, so
 * the mounted gun's readiness, magazine and faults never alias the Wasp's copy. The Shrike's
 * Skipshot carries the catalogue blueprint directly, exactly as the Lance and the Wasp carry theirs:
 * it is the only hull that installs one.
 */
export const SMALL_WAVE_2_INSTALLATION_IDS = deepFreeze({
  shrikePortLateral: "SmlLateralE00001",
  shrikeStarboardLateral: "SmlLateralF00001",
  gnatPortLateral: "SmlLateralG00001",
  gnatStarboardLateral: "SmlLateralH00001",
  gnatBarrageGun: "SmlBarrageGunA01",
});

/**
 * The Small blueprint library: one reusable blueprint per part, seeded into the world compendium so
 * a mount can be refitted to the same catalog identity a hull already carries — plus the four
 * lateral-drive copies the two wave-1 hulls install.
 */
export const SMALL_COMPONENT_SOURCES = deepFreeze([
  SMALL_REACTOR_SOURCE,
  SMALL_REACTOR_HEAVY_SOURCE,
  SMALL_REACTOR_SHORT_BASE_SOURCE,
  SMALL_REACTOR_TWIN_CORE_SOURCE,
  SMALL_SHIELD_BUBBLE_SOURCE,
  SMALL_SHIELD_VECTOR_SOURCE,
  SMALL_SHIELD_SEGMENT_SOURCE,
  SMALL_SENSOR_LIGHT_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_COOLING_COMPACT_SOURCE,
  SMALL_COOLING_DEEP_SOURCE,
  SMALL_MAIN_DRIVE_SOURCE,
  SMALL_MAIN_DRIVE_CUTTER_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  SMALL_LATERAL_DRIVE_SOURCE,
  SMALL_LATERAL_DRIVE_CUTTER_SOURCE,
  SMALL_ANCHOR_MK1_SOURCE,
  SMALL_ANCHOR_MK2_SOURCE,
  SMALL_ANCHOR_MK3_SOURCE,
  SMALL_RAILGUN_SOURCE,
  SMALL_BARRAGE_GUN_SOURCE,
  SMALL_BYPASS_GUN_SOURCE,
  SMALL_BARRAGE_GUN_LONG_SOURCE,
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, SMALL_LATERAL_INSTALLATION_IDS[0]),
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, SMALL_LATERAL_INSTALLATION_IDS[1]),
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, SMALL_LATERAL_INSTALLATION_IDS[2]),
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, SMALL_LATERAL_INSTALLATION_IDS[3]),
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, SMALL_WAVE_2_INSTALLATION_IDS.shrikePortLateral),
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, SMALL_WAVE_2_INSTALLATION_IDS.shrikeStarboardLateral),
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, SMALL_WAVE_2_INSTALLATION_IDS.gnatPortLateral),
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, SMALL_WAVE_2_INSTALLATION_IDS.gnatStarboardLateral),
  installationSource(SMALL_BARRAGE_GUN_SOURCE, SMALL_WAVE_2_INSTALLATION_IDS.gnatBarrageGun),
]);
