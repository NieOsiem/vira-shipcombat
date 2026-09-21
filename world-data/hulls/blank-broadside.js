import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import { deepFreeze } from "../../scripts/data/component-source.js";

/**
 * Blank Broadside — the beam-fighter template: two full beam mounts at ±90° and one light fore mount.
 *
 * Design intent: a hull that wants to fight abeam — the broadsides are the armament and the fore
 * mount is there to arm with a light gun (its label says so). Note when fitting it: the wide-arc
 * guns (Escort Battery, Breaker Lance) are what make a ±90° mount cover the bow line at all; a
 * narrow casemate gun on this hull leaves it unable to answer a target held ahead.
 *
 * Blank: nothing is installed, so the balance report's four gates are `blank, gate N/A`.
 */
const slots = Object.freeze({
  reactor: "blank-broadside-slot-reactor",
  shield: "blank-broadside-slot-shield",
  sensor: "blank-broadside-slot-sensor",
  cooling: "blank-broadside-slot-cooling",
  mainDrive: "blank-broadside-slot-main-drive",
  reverseDrive: "blank-broadside-slot-reverse-drive",
  portLateralDrive: "blank-broadside-slot-port-lateral-drive",
  starboardLateralDrive: "blank-broadside-slot-starboard-lateral-drive",
  inertia: "blank-broadside-slot-inertia",
});

const ids = Object.freeze({
  portHardpoint: "blank-broadside-hardpoint-port",
  starboardHardpoint: "blank-broadside-hardpoint-starboard",
  foreHardpoint: "blank-broadside-hardpoint-fore-light",
});

const operators = [
  { id: "blank-broadside-pilot", label: "Pilot / Commander", type: "npc", ratings: { piloting: 4, gunnery: 3, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "blank-broadside-gunner", label: "Master Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 4, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "blank-broadside-loader", label: "Loader / General Crew", type: "npc", ratings: { piloting: 1, gunnery: 4, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "blank-broadside-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 1, gunnery: 2, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 1 } },
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

export const BLANK_BROADSIDE_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data only, every mount deliberately empty. */
export const BLANK_BROADSIDE_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "blank-broadside",
  label: "Blank Hull — Broadside",
  size: "medium",
  initiative: 0,
  ac: 13,
  baseSignature: 15,
  maxHull: 46,
  heatCapacity: 24,
  commandCapacity: 2,
  crewCapacity: 2,
  safeVelocity: 24,
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
  armor: { fore: 3, port: 3, starboard: 3, aft: 2 },
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
    { id: ids.portHardpoint, label: "Port Broadside", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -90, traverse: "turret", weaponId: null },
    { id: ids.starboardHardpoint, label: "Starboard Broadside", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 90, traverse: "turret", weaponId: null },
    { id: ids.foreHardpoint, label: "Fore (light)", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "turret", weaponId: null },
  ],
  // A broadside fit opens with the standard spread (14 committed); nothing installed resolves to zeroes.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 2, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [],
  operators,
  criticalPools,
});

/** Blank hulls install nothing: the crew fits them out from the catalogue. */
export const BLANK_BROADSIDE_DEFAULT_COMPONENT_SOURCES = deepFreeze([]);
