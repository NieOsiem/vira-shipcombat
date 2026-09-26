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

/** 1. Corsair Rotary Autocannon: High damage kinetic battery, barrage, jams on natural 1. */
export const BLACK_MARKET_REAPER_SOURCE = componentSource({
  _id: "BlkMktReaper0001",
  name: "\"Corsair\" Rotary Autocannon",
  img: "S/Items/ShipComponents/small/_component_weapon_size_3_type_Ballistic_name_11-Series_Broadsword_Cannon_.webp",
  componentClass: "weapon",
  size: "medium",
  rarity: "rare",
  price: { value: 2000, denomination: "gp" },
  weight: { value: 0, units: "lb" },
  description: {
    value: `<p><strong>"Corsair" Rotary Autocannon</strong> — <em>Overbored Kinetic Battery</em></p>
<hr>
<p><strong>Technical Specifications:</strong></p>
<ul>
  <li><strong>Mount:</strong> Medium Hardpoint</li>
  <li><strong>Firing Arc:</strong> 180° Casemate</li>
  <li><strong>Range:</strong> Optimal 35 su | Maximum 70 su</li>
  <li><strong>Damage:</strong> 8 Shield / 7 Hull per hit (AP 1)</li>
  <li><strong>Projectile Class:</strong> Medium</li>
  <li><strong>Accuracy:</strong> +1</li>
  <li><strong>Power Draw:</strong> 2 | <strong>Heat:</strong> 1 per round | <strong>Signature:</strong> -1</li>
  <li><strong>Readiness:</strong> 30-round magazine (manual loader work)</li>
  <li><strong>Trait:</strong> Barrage (salvoes of 1 to 10 rounds)</li>
  <li><strong>Drawback — Unreliable:</strong> Rolling a natural 1 on an attack roll jams the feed mechanism (weaponMalfunction), taking the weapon offline until cleared.</li>
</ul>
<p><em>Black-market modified naval autocannon with shaved cycle teeth and removed safeties. Delivers devastating kinetic volume (8 shield / 7 hull), but aggressive cycling makes it prone to catastrophic feed jams under fire.</em></p>`,
    chat: "",
  },
  definition: {
    category: "hardpoint",
    visualStyle: "bullet",
    coreColor: "#ffb020",
    glowColor: "#ff4400",
    accuracy: 1,
    damage: { shield: 8, hull: 7, heat: 0 },
    armorPiercing: 1,
    projectileClass: "medium",
    range: { optimal: 35, maximum: 70 },
    arc: 180,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 1, per: "physicalRound" },
    signatureSpike: -1,
    recoveryWork: 2,
    readiness: {
      type: "magazine",
      capacity: 30,
      recovery: "manualWork",
      work: 1,
    },
    traits: [
      { id: TRAIT_IDS.barrage, profiles: BARRAGE_PROFILES },
      { id: TRAIT_IDS.unreliable },
    ],
    modes: {
      nominal: { overrides: {} },
    },
  },
});

/** 2. "Hellfire" Spliced Plasma Lance: Massive AP & damage, ignites backfire fire on natural 1. */
export const BLACK_MARKET_HELLFIRE_SOURCE = componentSource({
  _id: "BlkMktHellfire01",
  name: "\"Hellfire\" Spliced Plasma Lance",
  img: "S/Items/ShipComponents/small/_component_weapon_size_3_type_Plasma_name_WARLORD_Cannon_.webp",
  componentClass: "weapon",
  size: "medium",
  rarity: "veryRare",
  price: { value: 2500, denomination: "gp" },
  weight: { value: 0, units: "lb" },
  description: {
    value: `<p><strong>"Hellfire" Spliced Plasma Lance</strong> — <em>Hot-Wired Thermal Projector</em></p>
<hr>
<p><strong>Technical Specifications:</strong></p>
<ul>
  <li><strong>Mount:</strong> Medium Hardpoint</li>
  <li><strong>Firing Arc:</strong> 90°</li>
  <li><strong>Range:</strong> Optimal 50 su | Maximum 100 su</li>
  <li><strong>Damage:</strong> 10 Shield / 14 Hull + 2 Heat (AP 2)</li>
  <li><strong>Projectile Class:</strong> Fast</li>
  <li><strong>Accuracy:</strong> +0</li>
  <li><strong>Power Draw:</strong> 2 | <strong>Heat:</strong> 3 per shot | <strong>Signature:</strong> -2</li>
  <li><strong>Readiness:</strong> 2 Charges (recovers 1 charge each Start phase)</li>
  <li><strong>Drawback — Incendiary Backfire:</strong> Rolling a natural 1 on an attack roll vents superheated plasma internally, igniting a fire hazard in the weapon compartment!</li>
</ul>
<p><em>Jury-rigged heavy plasma projector with bypassed magnetic restrictors. Deals ferocious shield and hull damage (10/14 with AP 2 and thermal bleed), but a containment misfire can set your own ship ablaze.</em></p>`,
    chat: "",
  },
  definition: {
    category: "hardpoint",
    visualStyle: "plasma",
    coreColor: "#ffeedd",
    glowColor: "#ff3b00",
    accuracy: 0,
    damage: { shield: 10, hull: 14, heat: 2 },
    armorPiercing: 2,
    projectileClass: "fast",
    range: { optimal: 50, maximum: 100 },
    arc: 90,
    powerRating: 2,
    bootTime: 1,
    firingHeat: { amount: 3, per: "shot" },
    signatureSpike: -2,
    recoveryWork: 2,
    readiness: {
      type: "charges",
      capacity: 2,
      recovery: "automaticStart",
      eligibleStarts: 1,
    },
    traits: [
      { id: TRAIT_IDS.incendiaryBackfire },
    ],
    modes: {
      nominal: { overrides: {} },
    },
  },
});

/** 3. "Bastion-X" Resonant Deflector: High budget & regen, all quadrants collapse if one is breached. */
export const BLACK_MARKET_SHIELD_SOURCE = componentSource({
  _id: "BlkMktShield0001",
  name: "\"Bastion-X\" Resonant Deflector",
  img: "S/Items/ShipComponents/small/_component_shield-generator_size_2_grade_B_name_6MA_Kozane_.webp",
  componentClass: "shield",
  size: "medium",
  rarity: "veryRare",
  price: { value: 2600, denomination: "gp" },
  weight: { value: 0, units: "lb" },
  description: {
    value: `<p><strong>"Bastion-X" Resonant Deflector</strong> — <em>High-Capacity Phased Deflector</em></p>
<hr>
<p><strong>Technical Specifications:</strong></p>
<ul>
  <li><strong>Slot:</strong> Medium Shield</li>
  <li><strong>Topology:</strong> Directional (Fore, Port, Starboard, Aft)</li>
  <li><strong>Shield Budget:</strong> 88 HP Total (Sector Cap: 32 HP)</li>
  <li><strong>Reboot Delay:</strong> 1 combat round</li>
  <li><strong>Regeneration:</strong> P1: 0 | P2: 6 | P3: 10 | P4: 14 (+3 Heat)</li>
  <li><strong>Recovery Work:</strong> 5</li>
  <li><strong>Drawback — Cascading Collapse:</strong> Harmonic resonance links all emitters. If any single sector collapses to 0 HP, ALL quadrants instantly collapse!</li>
</ul>
<p><em>Illegal over-tuned deflector grid. Boasts massive 88 HP total capacity and a generous 32 HP sector cap, but the cross-linked emitters mean that losing a single shield facing collapses the entire shield grid.</em></p>`,
    chat: "",
  },
  definition: {
    topology: "directional",
    sectors: [...SECTORS],
    totalBudget: 88,
    sectorCap: 32,
    rechargeDelay: 1,
    cascadingCollapse: true,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 6 },
      { power: 3, online: true, regeneration: 10 },
      { power: 4, online: true, regeneration: 14, overclock: true, overclockHeat: 3 },
    ],
    recoveryWork: 5,
  },
});

/** 4. "Siphon" Conductive Bubble Shield: High capacity, 25% absorbed damage shunted as heat. */
export const BLACK_MARKET_BUBBLE_SOURCE = componentSource({
  _id: "BlkMktBubble0001",
  name: "\"Siphon\" Conductive Bubble Shield",
  img: "S/Items/ShipComponents/small/_component_shield-generator_size_2_grade_C_name_Aspis_.webp",
  componentClass: "shield",
  size: "medium",
  rarity: "rare",
  price: { value: 1500, denomination: "gp" },
  weight: { value: 0, units: "lb" },
  description: {
    value: `<p><strong>"Siphon" Conductive Bubble Shield</strong> — <em>Thermal-Shunt Omnidirectional Barrier</em></p>
<hr>
<p><strong>Technical Specifications:</strong></p>
<ul>
  <li><strong>Slot:</strong> Medium Shield</li>
  <li><strong>Topology:</strong> Omnidirectional Bubble (single pool)</li>
  <li><strong>Shield Budget:</strong> 65 HP (Sector Cap: 65 HP)</li>
  <li><strong>Reboot Delay:</strong> 1 combat round</li>
  <li><strong>Regeneration:</strong> P1: 0 | P2: 5 | P3: 8 | P4: 11 (+2 Heat)</li>
  <li><strong>Recovery Work:</strong> 4</li>
  <li><strong>Drawback — Thermal Bleed (25%):</strong> 25% of all shield damage absorbed by the bubble is bled directly into internal ship heat!</li>
</ul>
<p><em>Advanced omnidirectional defense grid that shunts absorbed kinetic impact into the hull's thermal sinks. Far tougher (65 HP) and reboots in half the time of civilian bubble shields, but absorbing heavy fire will rapidly overheat the ship.</em></p>`,
    chat: "",
  },
  definition: {
    topology: "bubble",
    sectors: ["bubble"],
    totalBudget: 65,
    sectorCap: 65,
    rechargeDelay: 1,
    thermalBleedFraction: 0.25,
    tiers: [
      { power: 0, online: false, regeneration: 0 },
      { power: 1, online: true, regeneration: 0 },
      { power: 2, online: true, regeneration: 5 },
      { power: 3, online: true, regeneration: 8 },
      { power: 4, online: true, regeneration: 11, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 4,
  },
});

/** 5. "Rad-Spike" Fission Reactor: +8 Power above standard, risks reactor instability at End Phase. */
export const BLACK_MARKET_REACTOR_SOURCE = componentSource({
  _id: "BlkMktReactor001",
  name: "\"Rad-Spike\" Fission Reactor",
  img: "S/Items/ShipComponents/small/_component_power-plant_size_2_grade_B_name_IonSurge_.webp",
  componentClass: "reactor",
  size: "medium",
  rarity: "rare",
  price: { value: 2200, denomination: "gp" },
  weight: { value: 0, units: "lb" },
  description: {
    value: `<p><strong>"Rad-Spike" Fission Reactor</strong> — <em>Unregulated Breeder Plant</em></p>
<hr>
<p><strong>Technical Specifications:</strong></p>
<ul>
  <li><strong>Slot:</strong> Medium Reactor</li>
  <li><strong>Nominal Power Output:</strong> 28</li>
  <li><strong>Redline Power Output:</strong> 34</li>
  <li><strong>Overclock Heat:</strong> 7</li>
  <li><strong>Recovery Work:</strong> 8</li>
  <li><strong>Drawback — Dirty Core:</strong> At the end of each combat round (End Phase), roll 1d20. On a 1–2 (10%), radioactive containment slips, inflicting Reactor Instability.</li>
</ul>
<p><em>Hot-running isotope core salvaged from decommissioned military hardware. Outputs an impressive 28 nominal power at a fraction of the price of commercial plants, but unstable neutron moderation can trigger sudden reactor spikes.</em></p>`,
    chat: "",
  },
  definition: {
    nominalOutput: 28,
    redlineOutput: 34,
    overclockHeat: 7,
    recoveryWork: 8,
    dirtyCore: true,
  },
});

/** 6. "Afterburner" Injected Main Drive: High thrust, risks gasket blowout (driveFailure) on Overclock. */
export const BLACK_MARKET_MAIN_DRIVE_SOURCE = componentSource({
  _id: "BlkMktDrive00001",
  name: "\"Afterburner\" Injected Main Drive",
  img: "S/Items/ShipComponents/small/_component_thruster_size_2_class_main_type_liquid_name_LV-T91_Cheetah_Liquid_Fuel_Engine_.webp",
  componentClass: "drive",
  driveRole: "main",
  size: "medium",
  rarity: "rare",
  price: { value: 1900, denomination: "gp" },
  weight: { value: 0, units: "lb" },
  description: {
    value: `<p><strong>"Afterburner" Injected Main Drive</strong> — <em>Modified Booster Thruster</em></p>
<hr>
<p><strong>Technical Specifications:</strong></p>
<ul>
  <li><strong>Slot:</strong> Medium Main Drive (Aft)</li>
  <li><strong>Base Thrust:</strong> 7</li>
  <li><strong>Thrust by Power:</strong> P0: 0 | P1: 3 | P2: 7 | P3: 8 | Overclock: 11 (+2 Heat)</li>
  <li><strong>Recovery Work:</strong> 5</li>
  <li><strong>Drawback — Gasket Blowout:</strong> Maintaining Overclock across rounds strains the injectors. At the Start Phase of each round while overclocked, roll 1d6: on a 1, the manifold gasket blows (Drive Failure), disabling propulsion until repaired.</li>
</ul>
<p><em>Aggressively tuned main thruster fitted with high-flow fuel injectors. Delivers blistering sprint speeds (Thrust 11 on Overclock), but redlining the manifold for more than a brief burst risks blowing the seals entirely.</em></p>`,
    chat: "",
  },
  definition: {
    base: { thrust: 7 },
    gasketBlowout: true,
    tiers: [
      { power: 0, multiplier: 0, online: false },
      { power: 1, multiplier: 0.5, online: true },
      { power: 2, multiplier: 1, online: true },
      { power: 3, multiplier: 1.25, online: true },
      { power: 4, multiplier: 1.6, online: true, overclock: true, overclockHeat: 2 },
    ],
    recoveryWork: 5,
  },
});

export const BLACK_MARKET_COMPONENT_SOURCES = deepFreeze([
  BLACK_MARKET_REAPER_SOURCE,
  BLACK_MARKET_HELLFIRE_SOURCE,
  BLACK_MARKET_SHIELD_SOURCE,
  BLACK_MARKET_BUBBLE_SOURCE,
  BLACK_MARKET_REACTOR_SOURCE,
  BLACK_MARKET_MAIN_DRIVE_SOURCE,
]);
