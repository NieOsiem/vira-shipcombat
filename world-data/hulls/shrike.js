/**
 * Shrike — small shield-bypass strike fighter (wave 2, world-side catalogue).
 *
 * Identity: the hull that makes a regeneration funnel stop mattering. Its one Prow Skipshot Gun
 * carries the `shieldBypass` trait with `channels: ["hull"]` and `damageShield: true`, so the
 * listed shield damage still lands on the shield while the hull damage transmits straight through a
 * standing field — a target behind a full deflector feels every shot. Wave 1 built the gun and
 * listed it as the refit part neither of its fighters installs; the Shrike is the hull that exists
 * to carry it.
 *
 * Dogfight rule (gate 1) — holds. The Mk II anchor gives ω = 60°/turn = 1.047 rad/turn, so the
 * Skipshot's 50 su Optimal band is holdable up to 1.047 × 50 = 52.4 su/turn against the hull's 36 su
 * safe velocity — a margin of +16.4 su. The single mount is fixed forward at 0° with a 90° arc, so
 * the hull is a one-window striker: it commits to a bearing and lives with it (below).
 *
 * Power (12 of 14 nominal, 16 redline): engines 3 · shields 2 · sensors 1 · cooling 1 · inertia 2 ·
 * weapons 3. Weapons 3 covers the Skipshot's Power Rating 3, which is the highest single-gun draw in
 * the small family — that gun is why the hull carries the Long-Base plant. 12/14 = 0.857 reads
 * `normal` emission, and the Deep-Core array's 3 Heat a Start already covers the gun's 2 Heat a
 * shot, so the ship runs both quiet and cold.
 *
 * Defence is the band and the hull behind it: 22 hull with light plate, and the Vector Deflector's
 * four-way regeneration spread rather than a single bubble pool. The shield is not this hull's
 * argument — ignoring the other ship's shield is.
 *
 * Anti-regeneration (gate 2) — out-damages. The bypass gun lands 4 shield damage a hit against the
 * 4/turn the Vector funnels into one facet, a static ceiling of exactly 0; measured across the §5
 * mirrors it is **+0.45** net shield damage/turn against 0.176 repaired/turn, because the mirrors
 * land 0.41 attacks/turn on facets the funnel is not covering. The trait's real effect is on the
 * other half of the ledger: the hull damage behind those shields is what ends the fight.
 *
 * Coverage (gate 3) is deliberately narrow: one fixed 90° Prow gun covers 25 % of the circle with a
 * 270° dark arc across the beams and stern. A fixed-forward gun on a single-mount striker is the
 * case the gate's own footnote exempts; the Shrike's answer to a threat off its nose is the drive
 * train (90°/turn of rotation) and a 36 su merge, not a turret.
 */
import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import {
  deepFreeze,
  installationSource,
} from "../../scripts/data/component-source.js";
import {
  SMALL_ANCHOR_MK2_SOURCE,
  SMALL_BYPASS_GUN_SOURCE,
  SMALL_COOLING_DEEP_SOURCE,
  SMALL_LATERAL_DRIVE_SOURCE,
  SMALL_MAIN_DRIVE_SOURCE,
  SMALL_REACTOR_HEAVY_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_SHIELD_VECTOR_SOURCE,
} from "../components/small-components.js";

const slots = Object.freeze({
  reactor: "shrike-slot-reactor",
  shield: "shrike-slot-shield",
  sensor: "shrike-slot-sensor",
  cooling: "shrike-slot-cooling",
  mainDrive: "shrike-slot-main-drive",
  reverseDrive: "shrike-slot-reverse-drive",
  portLateralDrive: "shrike-slot-port-lateral-drive",
  starboardLateralDrive: "shrike-slot-starboard-lateral-drive",
  inertia: "shrike-slot-inertia",
});

const ids = Object.freeze({
  reactor: SMALL_REACTOR_HEAVY_SOURCE._id,
  shield: SMALL_SHIELD_VECTOR_SOURCE._id,
  sensor: SMALL_SENSOR_LONG_SOURCE._id,
  cooling: SMALL_COOLING_DEEP_SOURCE._id,
  mainDrive: SMALL_MAIN_DRIVE_SOURCE._id,
  reverseDrive: SMALL_REVERSE_DRIVE_SOURCE._id,
  portLateralDrive: "SmlLateralE00001",
  starboardLateralDrive: "SmlLateralF00001",
  inertia: SMALL_ANCHOR_MK2_SOURCE._id,
  prowSkipshot: SMALL_BYPASS_GUN_SOURCE._id,
  prowHardpoint: "shrike-hardpoint-prow",
});

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

/**
 * Fault-only pools: the Shrike profile disables Hazards, so every entry is a Fault. The emitter
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
    id: "shrike-pilot",
    label: "Pilot",
    type: "npc",
    ratings: { piloting: 5, gunnery: 5, sensors: 3, engineering: 2 },
    defaultAssignment: { kind: "command", slot: 0 },
  },
];

export const SHRIKE_IDS = ids;

/**
 * Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. Small shield-bypass strike
 * fighter — a fast single-mount striker whose one gun ignores the field it is shot at.
 */
export const SHRIKE_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "shrike",
  label: "Shrike",
  size: "small",
  initiative: 2,
  ac: 15,
  baseSignature: 15,
  maxHull: 22,
  heatCapacity: 12,
  commandCapacity: 1,
  crewCapacity: 0,
  safeVelocity: 36,
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
    { id: ids.prowHardpoint, label: "Prow", category: "hardpoint", mountSize: "small", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.prowSkipshot },
  ],
  initialPower: { engines: 3, shields: 2, sensors: 1, cooling: 1, inertia: 2, weapons: 3 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.prowHardpoint],
  operators,
  criticalPools,
});

/** The striker's installed kit: nine system copies and the one bypass gun. */
export const SHRIKE_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  SMALL_REACTOR_HEAVY_SOURCE,
  SMALL_SHIELD_VECTOR_SOURCE,
  SMALL_SENSOR_LONG_SOURCE,
  SMALL_COOLING_DEEP_SOURCE,
  SMALL_MAIN_DRIVE_SOURCE,
  SMALL_REVERSE_DRIVE_SOURCE,
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, ids.portLateralDrive),
  installationSource(SMALL_LATERAL_DRIVE_SOURCE, ids.starboardLateralDrive),
  SMALL_ANCHOR_MK2_SOURCE,
  SMALL_BYPASS_GUN_SOURCE,
]);
