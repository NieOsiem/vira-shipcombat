/**
 * Wasp — small single-seat knife brawler (wave 1, world-side catalogue).
 *
 * Identity: close, cheap, and hard to knock over. One Prow Storm Barrage Gun throws a four-round
 * barrage a turn from a 25 su Optimal envelope with a 270° firing arc, so the brawler never has to
 * point its hull at anything to keep shooting. Tougher than the Peregrinus interceptor it is priced
 * under: 28 hull against 25, and 3/2/2/2 armour against 2/1/1/1.
 *
 * Dogfight rule (gate 1) — fails by construction, and deliberately. The Mk I anchor gives only
 * ω = 45°/turn = 0.785 rad/turn, so the gun's Optimal band is holdable up to 0.785 × 25 = 19.6 su,
 * below the hull's 30 su safe velocity. 30 su is this hull's *merge* speed: the brawl station the
 * duel harness flies sits at half the Optimal range (12.5 su) where the band is held at any speed
 * the hull can manage, and the gun's 270° envelope means bearing is bought with coverage instead of
 * the pivot authority a budget anchor cannot pay for. The §5 brawl mirror reports the speed the
 * brawler actually fights at, and it is inside the band.
 *
 * Power (10 of 11 nominal, 13 redline): engines 3 · shields 2 · sensors 1 · cooling 2 · inertia 1 ·
 * weapons 1. It reads `high` emission, and it does not care: a hull whose job is to be at knife
 * range spends its reactor on drives, the shield and the 4-per-Start cooling that pays for a
 * four-round volley, not on a quiet signature.
 *
 * Shield: the cheap Segment Deflector, not the cheaper Bubble Deflector. A bubble's single pool
 * repairs whatever lands on it one-for-one out of its whole 3-per-Start budget, so no knife gun can
 * ever out-damage it — the attrition measurement comes back at exactly zero however hard the brawler
 * hits. A directional array spreads regeneration across four weights and leaves the bearing it is
 * not repairing to accumulate damage, which is the difference between a brawler that can win an
 * exchange and one that can only survive it.
 *
 * Coverage (gate 3) — 75 %. The 270° envelope leaves a 90° blind arc dead astern; nose, both beams
 * and both quarters are covered.
 *
 * Work: unlike the Peregrinus this hull enables `capabilityProfile.work`, because its gun is a
 * magazine (20 rounds, five full volleys) and a magazine that cannot be reloaded by its one
 * operator is a gun that stops existing after five turns. Physical repair and Hazards stay off.
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
  reactor: "wasp-slot-reactor",
  shield: "wasp-slot-shield",
  sensor: "wasp-slot-sensor",
  cooling: "wasp-slot-cooling",
  mainDrive: "wasp-slot-main-drive",
  reverseDrive: "wasp-slot-reverse-drive",
  portLateralDrive: "wasp-slot-port-lateral-drive",
  starboardLateralDrive: "wasp-slot-starboard-lateral-drive",
  inertia: "wasp-slot-inertia",
});

const ids = Object.freeze({
  reactor: SMALL_REACTOR_SOURCE._id,
  shield: SMALL_SHIELD_SEGMENT_SOURCE._id,
  sensor: SMALL_SENSOR_LONG_SOURCE._id,
  cooling: SMALL_COOLING_COMPACT_SOURCE._id,
  mainDrive: SMALL_MAIN_DRIVE_CUTTER_SOURCE._id,
  reverseDrive: SMALL_REVERSE_DRIVE_SOURCE._id,
  portLateralDrive: "SmlLateralC00001",
  starboardLateralDrive: "SmlLateralD00001",
  inertia: SMALL_ANCHOR_MK1_SOURCE._id,
  prowBarrageGun: SMALL_BARRAGE_GUN_SOURCE._id,
  prowHardpoint: "wasp-hardpoint-prow",
});

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

/**
 * Fault-only pools: the Wasp profile disables Hazards, so every entry is a Fault. The emitter Faults
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
    id: "wasp-pilot",
    label: "Pilot",
    type: "npc",
    ratings: { piloting: 4, gunnery: 4, sensors: 3, engineering: 3 },
    defaultAssignment: { kind: "command", slot: 0 },
  },
];

export const WASP_IDS = ids;

/**
 * Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. Small knife brawler —
 * heavy plate for its class, a Bubble Shield, a slow cheap drive train, and one wide-arc magazine
 * gun.
 */
export const WASP_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "wasp",
  label: "Wasp",
  size: "small",
  initiative: 2,
  ac: 14,
  baseSignature: 17,
  maxHull: 28,
  heatCapacity: 14,
  commandCapacity: 1,
  crewCapacity: 0,
  safeVelocity: 30,
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
  armor: { fore: 3, port: 2, starboard: 2, aft: 2 },
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
    { id: ids.prowHardpoint, label: "Prow", category: "hardpoint", mountSize: "small", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.prowBarrageGun },
  ],
  initialPower: { engines: 3, shields: 2, sensors: 1, cooling: 2, inertia: 1, weapons: 1 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.prowHardpoint],
  operators,
  criticalPools,
});

/** The brawler's installed kit: nine system copies and the one magazine gun. */
export const WASP_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  SMALL_REACTOR_SOURCE,
  SMALL_SHIELD_SEGMENT_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_COOLING_COMPACT_SOURCE,
  SMALL_MAIN_DRIVE_CUTTER_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, ids.portLateralDrive),
  installationSource(SMALL_LATERAL_DRIVE_CUTTER_SOURCE, ids.starboardLateralDrive),
  SMALL_ANCHOR_MK1_SOURCE,
  SMALL_BARRAGE_GUN_SOURCE,
]);
