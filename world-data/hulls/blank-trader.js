import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import { deepFreeze } from "../../scripts/data/component-source.js";

/**
 * Blank Armed Trader — the merchant template: two mounts, one fore and one stern chaser, a reactor
 * bay sized for the premium plant, and shield Power a captain is expected to spend elsewhere.
 *
 * Design intent: few mounts, big reactor, weak shields. It is the hull that runs and talks rather
 * than the one that wins a gunnery duel: 2/2/2/2 armour, 44 hull, and a 12-point opening commit that
 * puts a single Power into its shields.
 *
 * Blank: nothing is installed, so the balance report's four gates are `blank, gate N/A`.
 */
const slots = Object.freeze({
  reactor: "blank-trader-slot-reactor",
  shield: "blank-trader-slot-shield",
  sensor: "blank-trader-slot-sensor",
  cooling: "blank-trader-slot-cooling",
  mainDrive: "blank-trader-slot-main-drive",
  reverseDrive: "blank-trader-slot-reverse-drive",
  portLateralDrive: "blank-trader-slot-port-lateral-drive",
  starboardLateralDrive: "blank-trader-slot-starboard-lateral-drive",
  inertia: "blank-trader-slot-inertia",
});

const ids = Object.freeze({
  foreHardpoint: "blank-trader-hardpoint-fore",
  aftHardpoint: "blank-trader-hardpoint-aft",
});

const operators = [
  { id: "blank-trader-captain", label: "Captain / Pilot", type: "npc", ratings: { piloting: 4, gunnery: 2, sensors: 4, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "blank-trader-gunner", label: "Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 4, sensors: 4, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "blank-trader-crew", label: "General Crew / Loader", type: "npc", ratings: { piloting: 2, gunnery: 3, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "blank-trader-engineer", label: "Engineer", type: "npc", ratings: { piloting: 1, gunnery: 1, sensors: 2, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 1 } },
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
    fault(`weaponMalfunction:${ids.aftHardpoint}`, { hardpointId: ids.aftHardpoint }, "weaponMalfunction"),
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

export const BLANK_TRADER_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data only, every mount deliberately empty. */
export const BLANK_TRADER_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "blank-trader",
  label: "Blank Hull — Armed Trader",
  size: "medium",
  initiative: 0,
  ac: 13,
  baseSignature: 15,
  maxHull: 44,
  heatCapacity: 26,
  commandCapacity: 2,
  crewCapacity: 2,
  safeVelocity: 22,
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
  armor: { fore: 2, port: 2, starboard: 2, aft: 2 },
  slots: [
    { id: slots.reactor, label: "Reactor Bay (oversized)", class: "reactor", size: "medium", regions: ["aft"], orientation: 180, itemId: null },
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
    { id: ids.aftHardpoint, label: "Stern Chaser", category: "hardpoint", mountSize: "medium", regions: ["aft"], orientation: 180, traverse: "turret", weaponId: null },
  ],
  // The trader's opening commit: one Power into shields (12 total) and everything else into running.
  initialPower: { engines: 3, shields: 1, sensors: 2, cooling: 2, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [],
  operators,
  criticalPools,
});

/** Blank hulls install nothing: the crew fits them out from the catalogue. */
export const BLANK_TRADER_DEFAULT_COMPONENT_SOURCES = deepFreeze([]);
