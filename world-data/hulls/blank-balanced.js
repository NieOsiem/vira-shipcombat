import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import { deepFreeze } from "../../scripts/data/component-source.js";

/**
 * Blank Balanced — the generalist medium template: three mounts on the standard spread (fore and
 * both beams), class-average hull, armour and safe velocity, and no components installed.
 *
 * Design intent: the hull a GM hands a crew that has not decided what it wants to be yet — it fits
 * any of the medium catalogue's parts and has no built-in answer to any of them.
 *
 * Blank: nothing is installed, so the balance report's four gates are `blank, gate N/A`. The mount
 * geometry is still reported (§3) and the hull still materializes; it simply has no reactor to
 * commit, no drive to move it and no gun to fire.
 */
const slots = Object.freeze({
  reactor: "blank-balanced-slot-reactor",
  shield: "blank-balanced-slot-shield",
  sensor: "blank-balanced-slot-sensor",
  cooling: "blank-balanced-slot-cooling",
  mainDrive: "blank-balanced-slot-main-drive",
  reverseDrive: "blank-balanced-slot-reverse-drive",
  portLateralDrive: "blank-balanced-slot-port-lateral-drive",
  starboardLateralDrive: "blank-balanced-slot-starboard-lateral-drive",
  inertia: "blank-balanced-slot-inertia",
});

const ids = Object.freeze({
  foreHardpoint: "blank-balanced-hardpoint-fore",
  portHardpoint: "blank-balanced-hardpoint-port",
  starboardHardpoint: "blank-balanced-hardpoint-starboard",
});

const operators = [
  { id: "blank-balanced-pilot", label: "Pilot / Commander", type: "npc", ratings: { piloting: 4, gunnery: 3, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "blank-balanced-gunner", label: "Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 4, sensors: 4, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "blank-balanced-loader", label: "Loader / General Crew", type: "npc", ratings: { piloting: 1, gunnery: 3, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "blank-balanced-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 1, gunnery: 2, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 1 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

function hazard(channelId, sector = null) {
  return { id: `${channelId}:${sector ?? "ship"}`, kind: "hazard", componentId: null, channelId, sector, weight: 1 };
}

const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.foreHardpoint}`, { hardpointId: ids.foreHardpoint }, "weaponMalfunction"),
    fault(`sensorFault:${slots.sensor}`, { slotId: slots.sensor }, "sensorFault"),
    fault(`driveFailure:${slots.reverseDrive}`, { slotId: slots.reverseDrive }, "driveFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:fore`, { slotId: slots.shield }, "shieldEmitterDamage", "fore"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("fire", "fore"),
    hazard("breach", "fore"),
  ],
  port: [
    fault(`weaponMalfunction:${ids.portHardpoint}`, { hardpointId: ids.portHardpoint }, "weaponMalfunction"),
    fault(`shieldEmitterDamage:${slots.shield}:port`, { slotId: slots.shield }, "shieldEmitterDamage", "port"),
    fault(`maneuveringThrusterFailure:${slots.portLateralDrive}`, { slotId: slots.portLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("electricalCascade"),
    hazard("fire", "port"),
    hazard("breach", "port"),
  ],
  starboard: [
    fault(`weaponMalfunction:${ids.starboardHardpoint}`, { hardpointId: ids.starboardHardpoint }, "weaponMalfunction"),
    fault(`shieldEmitterDamage:${slots.shield}:starboard`, { slotId: slots.shield }, "shieldEmitterDamage", "starboard"),
    fault(`maneuveringThrusterFailure:${slots.starboardLateralDrive}`, { slotId: slots.starboardLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("electricalCascade"),
    hazard("fire", "starboard"),
    hazard("breach", "starboard"),
  ],
  aft: [
    fault(`driveFailure:${slots.mainDrive}`, { slotId: slots.mainDrive }, "driveFailure"),
    fault(`reactorFault:${slots.reactor}`, { slotId: slots.reactor }, "reactorFault"),
    fault(`coolingFailure:${slots.cooling}`, { slotId: slots.cooling }, "coolingFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:aft`, { slotId: slots.shield }, "shieldEmitterDamage", "aft"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("reactorInstability"),
    hazard("fire", "aft"),
    hazard("breach", "aft"),
  ],
};

export const BLANK_BALANCED_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data only, every mount deliberately empty. */
export const BLANK_BALANCED_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "blank-balanced",
  label: "Blank Hull — Balanced",
  size: "medium",
  initiative: 0,
  ac: 14,
  baseSignature: 14,
  maxHull: 48,
  heatCapacity: 24,
  commandCapacity: 2,
  crewCapacity: 2,
  safeVelocity: 26,
  evasionReserve: 20,
  evasionAcBonus: 2,
  evasionHardReserve: 30,
  evasionHardAcCap: 4,
  regenerationWeightCap: 50,
  fatePolicy: "important",
  capabilityProfile: {
    hazards: true,
    physicalRepair: true,
    work: true,
    evasionHardware: [
      { slotId: slots.inertia, channel: "inertiaFailure" },
    ],
  },
  armor: { fore: 3, port: 3, starboard: 3, aft: 3 },
  slots: [
    { id: slots.reactor, label: "Reactor", class: "reactor", size: "medium", regions: ["aft"], orientation: 180, itemId: null },
    { id: slots.shield, label: "Shield", class: "shield", size: "medium", regions: [...SECTORS], orientation: 0, itemId: null },
    { id: slots.sensor, label: "Sensor", class: "sensor", size: "medium", regions: ["fore"], orientation: 0, itemId: null },
    { id: slots.cooling, label: "Cooling", class: "cooling", size: "medium", regions: ["aft"], orientation: 180, itemId: null },
    { id: slots.mainDrive, label: "Main Drive", class: "drive", driveRole: "main", size: "medium", regions: ["aft"], orientation: 0, itemId: null },
    { id: slots.reverseDrive, label: "Reverse Drive", class: "drive", driveRole: "reverse", size: "medium", regions: ["fore"], orientation: 180, itemId: null },
    { id: slots.portLateralDrive, label: "Port Lateral Drive", class: "drive", driveRole: "portLateral", size: "medium", regions: ["port", "aft"], orientation: -90, itemId: null },
    { id: slots.starboardLateralDrive, label: "Starboard Lateral Drive", class: "drive", driveRole: "starboardLateral", size: "medium", regions: ["starboard", "aft"], orientation: 90, itemId: null },
    { id: slots.inertia, label: "Inertial Anchor", class: "inertia", size: "medium", regions: [...SECTORS], orientation: 0, itemId: null },
  ],
  hardpoints: [
    { id: ids.foreHardpoint, label: "Fore", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "turret", weaponId: null },
    { id: ids.portHardpoint, label: "Port", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -90, traverse: "turret", weaponId: null },
    { id: ids.starboardHardpoint, label: "Starboard", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 90, traverse: "turret", weaponId: null },
  ],
  // The commit a balanced fit would open with (14 of the Corvette Reactor's 20); with nothing
  // installed it resolves to zeroes, but the hull still names all six systems.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 2, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [],
  operators,
  criticalPools,
});

/** Blank hulls install nothing: the crew fits them out from the catalogue. */
export const BLANK_BALANCED_DEFAULT_COMPONENT_SOURCES = deepFreeze([]);
