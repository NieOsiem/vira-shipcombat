/**
 * Gnat — small militia fighter (wave 2, world-side catalogue).
 *
 * Identity: the starter hull. Everything on it is the cheap shelf — Light Reactor, LH
 * Bubble Deflector, Compact Cooling Array, Cutter main and lateral drives, Inertial Anchor Mk I — behind
 * one Prow Storm Barrage Gun, the same four-round magazine gun the Wasp brawls with. It is the
 * cheapest way into the class: less hull than the Wasp (20 against 28), lighter plate, a slower
 * safe velocity, and the same 270° envelope that lets a hull with a budget anchor keep shooting
 * without turning.
 *
 * Dogfight rule (gate 1) — fails by construction, deliberately, exactly as the Wasp's does. The
 * Mk I anchor gives only ω = 45°/turn = 0.785 rad/turn, so the gun's 25 su Optimal band is holdable
 * up to 0.785 × 25 = 19.63 su, below the hull's 26 su safe velocity. 26 su is this hull's *merge*
 * speed: the station the duel harness flies sits at half the Optimal range (12.5 su, 10.4 su/turn),
 * where the band is held at any speed the hull can manage, and the gun's 270° envelope buys bearing
 * with coverage instead of the pivot authority a militia cannot afford. The §5 brawl mirror reports
 * the speed the fighter actually fights at — a mean 10.29 su/turn — and it is inside the 19.63 su
 * holdable ceiling, which is the number that matters for this gate.
 *
 * Anti-regeneration (gate 2) — out-damages. A four-round salvo is two effective hits of shield 5
 * against the 2/turn the LH Bubble Deflector funnels into its single pool.
 *
 * Power (10 of 11 nominal, 13 redline): engines 3 · shields 2 · sensors 1 · cooling 2 · inertia 1 ·
 * weapons 1. It reads `high` emission, and it does not care — a militia fighter's job is to be
 * seen. The two Cooling tiers are the barrage's price (a four-round salvo is four physical rounds
 * of Firing Heat, and the family's cooling ladder pays for it at Power 2), not a luxury.
 *
 * Sensor: the Long-Base Array, the one premium part on an otherwise cheap hull. The budget Light
 * Sensor Array reads passive 40 su at Sensors Power 1, which is blind at the 60 su opening the duel
 * harness and the encounter rules both use — a fighter that cannot form a track is not a cheaper
 * fighter, it is a target, so the array is the part a starter fit must not economise on.
 *
 * Shield: the cheap LH Bubble Deflector (20 budget, 2/4/6 regen). Single-pool protection scaled for
 * budget militia hulls under the Peregrinus standard.
 *
 * Coverage (gate 3) — 75 %. The 270° envelope leaves a 90° blind arc dead astern; nose, both beams
 * and both quarters answer.
 *
 * Work: unlike the Peregrinus this hull enables `capabilityProfile.work`, because its gun is a
 * magazine and a magazine that cannot be reloaded by its one operator is a gun that stops existing.
 * Physical repair and Hazards stay off.
 */
import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import {
  deepFreeze,
  installationSource,
} from "../../scripts/data/component-source.js";
import {
  SMALL_ANCHOR_MK1_SOURCE,
  SMALL_BARRAGE_GUN_SOURCE,
  SMALL_COOLING_COMPACT_SOURCE,
  SMALL_LATERAL_DRIVE_CUTTER_SOURCE,
  SMALL_MAIN_DRIVE_CUTTER_SOURCE,
  SMALL_REACTOR_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_SHIELD_SEGMENT_SOURCE,
} from "../components/small-components.js";

const slots = Object.freeze({
  reactor: "gnat-slot-reactor",
  shield: "gnat-slot-shield",
  sensor: "gnat-slot-sensor",
  cooling: "gnat-slot-cooling",
  mainDrive: "gnat-slot-main-drive",
  reverseDrive: "gnat-slot-reverse-drive",
  portLateralDrive: "gnat-slot-port-lateral-drive",
  starboardLateralDrive: "gnat-slot-starboard-lateral-drive",
  inertia: "gnat-slot-inertia",
});

const ids = Object.freeze({
  reactor: SMALL_REACTOR_SOURCE._id,
  shield: SMALL_SHIELD_SEGMENT_SOURCE._id,
  sensor: SMALL_SENSOR_LONG_SOURCE._id,
  cooling: SMALL_COOLING_COMPACT_SOURCE._id,
  mainDrive: SMALL_MAIN_DRIVE_CUTTER_SOURCE._id,
  reverseDrive: SMALL_REVERSE_DRIVE_SOURCE._id,
  portLateralDrive: "SmlLateralG00001",
  starboardLateralDrive: "SmlLateralH00001",
  inertia: SMALL_ANCHOR_MK1_SOURCE._id,
  prowBarrageGun: "SmlBarrageGunA01",
  prowHardpoint: "gnat-hardpoint-prow",
});

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

/**
 * Fault-only pools: the Gnat profile disables Hazards, so every entry is a Fault. The emitter Faults
 * name the struck region — the Segment Deflector's four facets are one component, but a hit still
 * lands on one of them.
 */
const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.prowHardpoint}`, { hardpointId: ids.prowHardpoint }, "weaponMalfunction"),
    fault(`sensorFault:${slots.sensor}`, { slotId: slots.sensor }, "sensorFault"),
    fault(`driveFailure:${slots.reverseDrive}`, { slotId: slots.reverseDrive }, "driveFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:fore`, { slotId: slots.shield }, "shieldEmitterDamage", "fore"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
  ],
  port: [
    fault(`shieldEmitterDamage:${slots.shield}:port`, { slotId: slots.shield }, "shieldEmitterDamage", "port"),
    fault(`maneuveringThrusterFailure:${slots.portLateralDrive}`, { slotId: slots.portLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
  ],
  starboard: [
    fault(`shieldEmitterDamage:${slots.shield}:starboard`, { slotId: slots.shield }, "shieldEmitterDamage", "starboard"),
    fault(`maneuveringThrusterFailure:${slots.starboardLateralDrive}`, { slotId: slots.starboardLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
  ],
  aft: [
    fault(`driveFailure:${slots.mainDrive}`, { slotId: slots.mainDrive }, "driveFailure"),
    fault(`reactorFault:${slots.reactor}`, { slotId: slots.reactor }, "reactorFault"),
    fault(`coolingFailure:${slots.cooling}`, { slotId: slots.cooling }, "coolingFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:aft`, { slotId: slots.shield }, "shieldEmitterDamage", "aft"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
  ],
};

/** One pilot is the whole crew: Command Capacity 1, Crew Capacity 0 (rules §3.5). */
const operators = [
  {
    id: "gnat-pilot",
    label: "Pilot",
    type: "npc",
    ratings: { piloting: 4, gunnery: 4, sensors: 3, engineering: 3 },
    defaultAssignment: { kind: "command", slot: 0 },
  },
];

export const GNAT_IDS = ids;

/**
 * Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. Small militia fighter — the
 * cheap drive train, the cheap shield, one wide-arc magazine gun, and the one array a fighter
 * cannot do without.
 */
export const GNAT_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "gnat",
  label: "Gnat",
  size: "small",
  initiative: 2,
  ac: 14,
  baseSignature: 17,
  maxHull: 20,
  heatCapacity: 12,
  commandCapacity: 1,
  crewCapacity: 0,
  safeVelocity: 26,
  evasionReserve: 20,
  evasionAcBonus: 2,
  evasionHardReserve: 30,
  evasionHardAcCap: 4,
  regenerationWeightCap: 100,
  fatePolicy: "important",
  capabilityProfile: {
    hazards: false,
    physicalRepair: false,
    work: true,
    evasionHardware: [
      { slotId: slots.inertia, channel: "inertiaFailure" },
    ],
  },
  armor: { fore: 2, port: 1, starboard: 1, aft: 1 },
  slots: [
    { id: slots.reactor, label: "Reactor", class: "reactor", size: "small", regions: ["aft"], orientation: 180, itemId: ids.reactor },
    { id: slots.shield, label: "Shield", class: "shield", size: "small", regions: [...SECTORS], orientation: 0, itemId: ids.shield },
    { id: slots.sensor, label: "Sensor", class: "sensor", size: "small", regions: ["fore"], orientation: 0, itemId: ids.sensor },
    { id: slots.cooling, label: "Cooling", class: "cooling", size: "small", regions: ["aft"], orientation: 180, itemId: ids.cooling },
    { id: slots.mainDrive, label: "Main Drive", class: "drive", driveRole: "main", size: "small", regions: ["aft"], orientation: 0, itemId: ids.mainDrive },
    { id: slots.reverseDrive, label: "Reverse Drive", class: "drive", driveRole: "reverse", size: "small", regions: ["fore"], orientation: 180, itemId: ids.reverseDrive },
    { id: slots.portLateralDrive, label: "Port Lateral Drive", class: "drive", driveRole: "portLateral", size: "small", regions: ["port", "aft"], orientation: -90, itemId: ids.portLateralDrive },
    { id: slots.starboardLateralDrive, label: "Starboard Lateral Drive", class: "drive", driveRole: "starboardLateral", size: "small", regions: ["starboard", "aft"], orientation: 90, itemId: ids.starboardLateralDrive },
    { id: slots.inertia, label: "Inertial Anchor", class: "inertia", size: "small", regions: [...SECTORS], orientation: 0, itemId: ids.inertia },
  ],
  hardpoints: [
    { id: ids.prowHardpoint, label: "Prow", category: "hardpoint", mountSize: "small", regions: ["fore"], orientation: 0, traverse: "turret", weaponId: ids.prowBarrageGun },
  ],
  initialPower: { engines: 3, shields: 2, sensors: 1, cooling: 2, inertia: 1, weapons: 1 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.prowHardpoint],
  operators,
  criticalPools,
});

/** The militia fighter's installed kit: nine system copies and the one magazine gun. */
export const GNAT_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  SMALL_REACTOR_SOURCE,
  SMALL_SHIELD_SEGMENT_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_COOLING_COMPACT_SOURCE,
  SMALL_MAIN_DRIVE_CUTTER_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, ids.portLateralDrive),
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, ids.starboardLateralDrive),
  SMALL_ANCHOR_MK1_SOURCE,
  installationSource(SMALL_BARRAGE_GUN_SOURCE, ids.prowBarrageGun),
]);
