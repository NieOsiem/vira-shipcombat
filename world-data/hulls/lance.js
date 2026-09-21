/**
 * Lance — small single-seat long-gun sniper (wave 1, world-side catalogue).
 *
 * Identity: one Prow Light Railgun with a 60 su Optimal / 120 su Maximum envelope, and a hull built
 * to sit in that band and pick at range. Nothing else is mounted, so the ship is a single-mount
 * silhouette by design.
 *
 * Dogfight rule (gate 1) — holds. The Mk II anchor gives ω = 60°/turn = 1.047 rad/turn, so the
 * gun's Optimal band is holdable up to ω·optimal = 1.047 × 60 = 62.8 su/turn, comfortably above the
 * hull's 32 su safe velocity. This is the difference between the Lance and the hulls that cannot
 * hold their own band: the pivot is sized to the gun, not the other way round.
 *
 * Power (12 of 14 nominal, 16 redline): engines 3 · shields 2 · sensors 1 · cooling 2 · inertia 2 ·
 * weapons 2. The Long-Base Reactor is the reason a small hull can run this: 12/14 = 0.857 reads
 * `normal` emission. Weapons 2 exactly covers the railgun's Power Rating 2, so the single gun is
 * online at the shipped commit.
 *
 * Defence is the band, not the plate: 22 hull and 1 armour on every face. The Vector Deflector is
 * the premium directional array (48 total, 12 per facet) — it spreads the regeneration funnel
 * thinner than one pool, which is what makes the anti-regeneration gate reachable, and it pays for
 * that with a facet that can be stripped.
 *
 * Coverage (gate 3) is deliberately narrow: one fixed 90° Prow gun covers 25 % of the circle with a
 * 270° dark arc across the sides and stern. A single-mount fixed-forward fighter is the case the
 * gate's own footnote exempts; the wave's wide-arc hulls carry coverage as a mission, not this one.
 */
import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import {
  deepFreeze,
  installationSource,
} from "../../scripts/data/component-source.js";
import {
  SMALL_ANCHOR_MK2_SOURCE,
  SMALL_COOLING_DEEP_SOURCE,
  SMALL_LATERAL_DRIVE_SOURCE,
  SMALL_MAIN_DRIVE_SOURCE,
  SMALL_RAILGUN_SOURCE,
  SMALL_REACTOR_HEAVY_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_SHIELD_VECTOR_SOURCE,
} from "../components/small-components.js";

const slots = Object.freeze({
  reactor: "lance-slot-reactor",
  shield: "lance-slot-shield",
  sensor: "lance-slot-sensor",
  cooling: "lance-slot-cooling",
  mainDrive: "lance-slot-main-drive",
  reverseDrive: "lance-slot-reverse-drive",
  portLateralDrive: "lance-slot-port-lateral-drive",
  starboardLateralDrive: "lance-slot-starboard-lateral-drive",
  inertia: "lance-slot-inertia",
});

const ids = Object.freeze({
  reactor: SMALL_REACTOR_HEAVY_SOURCE._id,
  shield: SMALL_SHIELD_VECTOR_SOURCE._id,
  sensor: SMALL_SENSOR_LONG_SOURCE._id,
  cooling: SMALL_COOLING_DEEP_SOURCE._id,
  mainDrive: SMALL_MAIN_DRIVE_SOURCE._id,
  reverseDrive: SMALL_REVERSE_DRIVE_SOURCE._id,
  portLateralDrive: "SmlLateralA00001",
  starboardLateralDrive: "SmlLateralB00001",
  inertia: SMALL_ANCHOR_MK2_SOURCE._id,
  prowRailgun: SMALL_RAILGUN_SOURCE._id,
  prowHardpoint: "lance-hardpoint-prow",
});

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

/**
 * Fault-only pools: the Lance profile disables Hazards, so every entry is a Fault. The emitter
 * entries name the struck region; every other Fault is shared and carries no sector.
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
    id: "lance-pilot",
    label: "Pilot",
    type: "npc",
    ratings: { piloting: 5, gunnery: 5, sensors: 4, engineering: 2 },
    defaultAssignment: { kind: "command", slot: 0 },
  },
];

export const LANCE_IDS = ids;

/**
 * Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. Small long-gun sniper —
 * fragile framework, minimal armour, one railgun, and the reactor and pivot a 60 su band demands.
 */
export const LANCE_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "lance",
  label: "Lance",
  size: "small",
  initiative: 2,
  ac: 15,
  baseSignature: 15,
  maxHull: 22,
  heatCapacity: 12,
  commandCapacity: 1,
  crewCapacity: 0,
  safeVelocity: 32,
  evasionReserve: 20,
  evasionAcBonus: 2,
  evasionHardReserve: 30,
  evasionHardAcCap: 4,
  regenerationWeightCap: 100,
  fatePolicy: "important",
  capabilityProfile: {
    hazards: false,
    physicalRepair: false,
    work: false,
    evasionHardware: [
      { slotId: slots.inertia, channel: "inertiaFailure" },
    ],
  },
  armor: { fore: 1, port: 1, starboard: 1, aft: 1 },
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
    { id: ids.prowHardpoint, label: "Prow", category: "hardpoint", mountSize: "small", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.prowRailgun },
  ],
  initialPower: { engines: 3, shields: 2, sensors: 1, cooling: 2, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.prowHardpoint],
  operators,
  criticalPools,
});

/** The sniper's installed kit: nine system copies and the one gun. */
export const LANCE_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  SMALL_REACTOR_HEAVY_SOURCE,
  SMALL_SHIELD_VECTOR_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_COOLING_DEEP_SOURCE,
  SMALL_MAIN_DRIVE_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, ids.portLateralDrive),
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, ids.starboardLateralDrive),
  SMALL_ANCHOR_MK2_SOURCE,
  SMALL_RAILGUN_SOURCE,
]);
