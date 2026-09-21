import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import { deepFreeze } from "../../scripts/data/component-source.js";

/**
 * Blank Heavy — the line-of-battle template: three hardpoints trained into the forward quarters,
 * 60 hull, 5/4/4/3 armour, and safe velocity 20.
 *
 * Design intent: a hull built to take the first exchange and answer it. Its three mounts sit at 0°
 * and ±70° so a battery can come to bear on a target held ahead — the same forward-abeam train the
 * Vanguard's casemates use — and it pays for the plate with speed, initiative and a 17 signature.
 *
 * Blank: nothing is installed, so the balance report's four gates are `blank, gate N/A`.
 */
const slots = Object.freeze({
  reactor: "blank-heavy-slot-reactor",
  shield: "blank-heavy-slot-shield",
  sensor: "blank-heavy-slot-sensor",
  cooling: "blank-heavy-slot-cooling",
  mainDrive: "blank-heavy-slot-main-drive",
  reverseDrive: "blank-heavy-slot-reverse-drive",
  portLateralDrive: "blank-heavy-slot-port-lateral-drive",
  starboardLateralDrive: "blank-heavy-slot-starboard-lateral-drive",
  inertia: "blank-heavy-slot-inertia",
});

const ids = Object.freeze({
  foreHardpoint: "blank-heavy-hardpoint-fore",
  portHardpoint: "blank-heavy-hardpoint-port",
  starboardHardpoint: "blank-heavy-hardpoint-starboard",
});

const operators = [
  { id: "blank-heavy-pilot", label: "Pilot / Commander", type: "npc", ratings: { piloting: 4, gunnery: 3, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "blank-heavy-gunner", label: "Master Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 4, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "blank-heavy-loader-port", label: "Port Loader", type: "npc", ratings: { piloting: 1, gunnery: 4, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "blank-heavy-loader-starboard", label: "Starboard Loader", type: "npc", ratings: { piloting: 1, gunnery: 4, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 1 } },
  { id: "blank-heavy-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 1, gunnery: 2, sensors: 2, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 2 } },
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

export const BLANK_HEAVY_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data only, every mount deliberately empty. */
export const BLANK_HEAVY_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "blank-heavy",
  label: "Blank Hull — Heavy",
  size: "medium",
  initiative: 0,
  ac: 12,
  baseSignature: 17,
  maxHull: 60,
  heatCapacity: 32,
  commandCapacity: 2,
  crewCapacity: 3,
  safeVelocity: 20,
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
  armor: { fore: 5, port: 4, starboard: 4, aft: 3 },
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
    { id: ids.portHardpoint, label: "Port Casemate", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -70, traverse: "turret", weaponId: null },
    { id: ids.starboardHardpoint, label: "Starboard Casemate", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 70, traverse: "turret", weaponId: null },
  ],
  // A heavy fit opens with Cooling 3 (15 committed); nothing installed resolves to zeroes.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 3, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [],
  operators,
  criticalPools,
});

/** Blank hulls install nothing: the crew fits them out from the catalogue. */
export const BLANK_HEAVY_DEFAULT_COMPONENT_SOURCES = deepFreeze([]);
