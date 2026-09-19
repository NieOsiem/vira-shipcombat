import { SCHEMA_VERSION, SECTORS } from "../constants.js";
import { deepFreeze } from "./component-source.js";
import { PEREGRINUS_DEFAULT_COMPONENT_SOURCES } from "./peregrinus-components.js";
import { materializeShipConfig } from "../model/equipment.js";

const slots = Object.freeze({
  reactor: "peregrinus-slot-reactor",
  shield: "peregrinus-slot-shield",
  sensor: "peregrinus-slot-sensor",
  cooling: "peregrinus-slot-cooling",
  mainDrive: "peregrinus-slot-main-drive",
  reverseDrive: "peregrinus-slot-reverse-drive",
  portLateralDrive: "peregrinus-slot-port-lateral-drive",
  starboardLateralDrive: "peregrinus-slot-starboard-lateral-drive",
  inertia: "peregrinus-slot-inertia",
});

const ids = Object.freeze({
  reactor: "PereReactor00001",
  shield: "PereShield000001",
  sensor: "PereSensor000001",
  cooling: "PereCooling00001",
  mainDrive: "PereMainDrive001",
  reverseDrive: "PereRevDrive0001",
  portLateralDrive: "PereLateralA0001",
  starboardLateralDrive: "PereLateralB0001",
  inertia: "PereInertia00001",
  prowCannon: "PereCannonA00001",
  dorsalCannon: "PereCannonB00001",
  prowHardpoint: "peregrinus-hardpoint-prow",
  dorsalHardpoint: "peregrinus-hardpoint-dorsal",
});

/** One pilot is the whole crew: Command Capacity 1, Crew Capacity 0 (rules 3.5). */
const operators = [
  { id: "peregrinus-pilot", label: "Pilot", type: "npc", ratings: { piloting: 5, gunnery: 4, sensors: 3, engineering: 2 }, defaultAssignment: { kind: "command", slot: 0 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

/**
 * Fault-only pools: the profile disables Hazards, so every entry is a Fault. Shield-emitter entries
 * name the struck pool region even though the Bubble Shield projects them onto its single emitter.
 */
const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.prowHardpoint}`, { hardpointId: ids.prowHardpoint }, "weaponMalfunction"),
    fault(`weaponMalfunction:${ids.dorsalHardpoint}`, { hardpointId: ids.dorsalHardpoint }, "weaponMalfunction"),
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

export const PEREGRINUS_IDS = ids;

/**
 * Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. Small single-seat
 * interceptor — fast, fragile, forward-fixed guns, one Bubble Shield, no Hazards or combat Work.
 */
export const PEREGRINUS_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "peregrinus-interceptor",
  label: "Peregrinus Interceptor",
  size: "small",
  initiative: 2,
  ac: 15,
  baseSignature: 16,
  maxHull: 25,
  heatCapacity: 12,
  commandCapacity: 1,
  crewCapacity: 0,
  safeVelocity: 40,
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
    { id: ids.prowHardpoint, label: "Prow", category: "hardpoint", mountSize: "small", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.prowCannon },
    { id: ids.dorsalHardpoint, label: "Dorsal", category: "hardpoint", mountSize: "small", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.dorsalCannon },
  ],
  initialPower: { engines: 3, shields: 2, sensors: 1, cooling: 1, inertia: 2, weapons: 2 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.prowHardpoint, ids.dorsalHardpoint],
  operators,
  criticalPools,
});

/** Detached effective reference retained for pure rules/public compatibility. */
export const PEREGRINUS_CONFIG = deepFreeze(materializeShipConfig(
  PEREGRINUS_HULL_CONFIG,
  PEREGRINUS_DEFAULT_COMPONENT_SOURCES,
));
