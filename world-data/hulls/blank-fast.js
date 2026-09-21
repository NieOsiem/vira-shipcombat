import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import { deepFreeze } from "../../scripts/data/component-source.js";

/**
 * Blank Fast — the runner template: safe velocity 36, two nose mounts and no beam coverage at all.
 *
 * Design intent: speed is the armour. The drive slots are sized for the cheap 6-thrust Corvette Main
 * Drive rather than the Racer's 8 — the hull's own Safe Velocity ceiling is what makes it fast, and
 * it pays for that with 40 hull points and 3/2/2/2 armour, the thinnest plate in the class.
 *
 * Blank: nothing is installed, so the balance report's four gates are `blank, gate N/A`.
 */
const slots = Object.freeze({
  reactor: "blank-fast-slot-reactor",
  shield: "blank-fast-slot-shield",
  sensor: "blank-fast-slot-sensor",
  cooling: "blank-fast-slot-cooling",
  mainDrive: "blank-fast-slot-main-drive",
  reverseDrive: "blank-fast-slot-reverse-drive",
  portLateralDrive: "blank-fast-slot-port-lateral-drive",
  starboardLateralDrive: "blank-fast-slot-starboard-lateral-drive",
  inertia: "blank-fast-slot-inertia",
});

const ids = Object.freeze({
  foreHardpoint: "blank-fast-hardpoint-fore",
  dorsalHardpoint: "blank-fast-hardpoint-dorsal",
});

const operators = [
  { id: "blank-fast-pilot", label: "Pilot / Commander", type: "npc", ratings: { piloting: 5, gunnery: 3, sensors: 3, engineering: 2 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "blank-fast-gunner", label: "Gunner / Sensor Operator", type: "npc", ratings: { piloting: 3, gunnery: 4, sensors: 4, engineering: 2 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "blank-fast-loader", label: "Loader", type: "npc", ratings: { piloting: 2, gunnery: 3, sensors: 2, engineering: 3 }, defaultAssignment: { kind: "crew", slot: 0 } },
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
    fault(`weaponMalfunction:${ids.dorsalHardpoint}`, { hardpointId: ids.dorsalHardpoint }, "weaponMalfunction"),
    fault(`sensorFault:${slots.sensor}`, { slotId: slots.sensor }, "sensorFault"),
    fault(`driveFailure:${slots.reverseDrive}`, { slotId: slots.reverseDrive }, "driveFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:fore`, { slotId: slots.shield }, "shieldEmitterDamage", "fore"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("fire", "fore"),
    hazard("breach", "fore"),
  ],
  port: [
    fault(`shieldEmitterDamage:${slots.shield}:port`, { slotId: slots.shield }, "shieldEmitterDamage", "port"),
    fault(`maneuveringThrusterFailure:${slots.portLateralDrive}`, { slotId: slots.portLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("electricalCascade"),
    hazard("fire", "port"),
    hazard("breach", "port"),
  ],
  starboard: [
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

export const BLANK_FAST_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data only, every mount deliberately empty. */
export const BLANK_FAST_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "blank-fast",
  label: "Blank Hull — Fast",
  size: "medium",
  initiative: 0,
  ac: 15,
  baseSignature: 13,
  maxHull: 40,
  heatCapacity: 20,
  commandCapacity: 2,
  crewCapacity: 1,
  safeVelocity: 36,
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
  armor: { fore: 3, port: 2, starboard: 2, aft: 2 },
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
    { id: ids.dorsalHardpoint, label: "Dorsal", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "turret", weaponId: null },
  ],
  // A fast fit opens with more Engines and less Shield (14 committed); nothing installed resolves to zeroes.
  initialPower: { engines: 4, shields: 2, sensors: 2, cooling: 2, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [],
  operators,
  criticalPools,
});

/** Blank hulls install nothing: the crew fits them out from the catalogue. */
export const BLANK_FAST_DEFAULT_COMPONENT_SOURCES = deepFreeze([]);
