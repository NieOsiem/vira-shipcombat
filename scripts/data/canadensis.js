import { SCHEMA_VERSION, SECTORS } from "../constants.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "./canadensis-components.js";
import { deepFreeze } from "./component-source.js";
import { materializeShipConfig } from "../model/equipment.js";

const slots = Object.freeze({
  reactor: "canadensis-slot-reactor",
  shield: "canadensis-slot-shield",
  sensor: "canadensis-slot-sensor",
  cooling: "canadensis-slot-cooling",
  mainDrive: "canadensis-slot-main-drive",
  reverseDrive: "canadensis-slot-reverse-drive",
  portLateralDrive: "canadensis-slot-port-lateral-drive",
  starboardLateralDrive: "canadensis-slot-starboard-lateral-drive",
  inertia: "canadensis-slot-inertia",
});

const ids = Object.freeze({
  reactor: "CanadReactor0001",
  shield: "CanadShield00001",
  sensor: "CanadSensor00001",
  cooling: "CanadCooling0001",
  drive: "CanadMainDrive01",
  mainDrive: "CanadMainDrive01",
  reverseDrive: "CanadRevDrive001",
  portLateralDrive: "CanadLateralA001",
  starboardLateralDrive: "CanadLateralB001",
  inertia: "CanadInertia0001",
  railgun: "CanadRailgun0001",
  laser: "CanadLaser000001",
  portMacrocannon: "CanadMacrocanA01",
  starboardMacrocannon: "CanadMacrocanB01",
  prowHardpoint: "canadensis-hardpoint-prow",
  dorsalHardpoint: "canadensis-hardpoint-dorsal",
  portHardpoint: "canadensis-hardpoint-port",
  starboardHardpoint: "canadensis-hardpoint-starboard",
});

const operators = [
  { id: "canadensis-pilot-commander", label: "Pilot / Commander", type: "npc", ratings: { piloting: 5, gunnery: 3, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "canadensis-gunner-sensor", label: "Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 5, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "canadensis-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 1, gunnery: 2, sensors: 2, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "canadensis-loader-general", label: "Loader / General Crew", type: "npc", ratings: { piloting: 2, gunnery: 4, sensors: 2, engineering: 3 }, defaultAssignment: { kind: "crew", slot: 1 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

function hazard(channelId, sector = null) {
  return { id: `${channelId}:${sector ?? "ship"}`, kind: "hazard", componentId: null, channelId, sector, weight: 1 };
}

const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.prowHardpoint}`, { hardpointId: ids.prowHardpoint }, "weaponMalfunction"),
    fault(`weaponMalfunction:${ids.dorsalHardpoint}`, { hardpointId: ids.dorsalHardpoint }, "weaponMalfunction"),
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

export const CANADENSIS_IDS = ids;
export const CANADENSIS_SLOT_IDS = slots;

/** Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. */
export const CANADENSIS_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "canadensis-training-corvette",
  label: "Canadensis Training Corvette",
  size: "medium",
  initiative: 0,
  ac: 14,
  baseSignature: 14,
  maxHull: 50,
  heatCapacity: 20,
  commandCapacity: 2,
  crewCapacity: 2,
  safeVelocity: 30,
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
    { id: slots.reactor, label: "Reactor", class: "reactor", size: "medium", regions: ["aft"], orientation: 180, itemId: ids.reactor },
    { id: slots.shield, label: "Shield", class: "shield", size: "medium", regions: [...SECTORS], orientation: 0, itemId: ids.shield },
    { id: slots.sensor, label: "Sensor", class: "sensor", size: "medium", regions: ["fore"], orientation: 0, itemId: ids.sensor },
    { id: slots.cooling, label: "Cooling", class: "cooling", size: "medium", regions: ["aft"], orientation: 180, itemId: ids.cooling },
    { id: slots.mainDrive, label: "Main Drive", class: "drive", driveRole: "main", size: "medium", regions: ["aft"], orientation: 0, itemId: ids.mainDrive },
    { id: slots.reverseDrive, label: "Reverse Drive", class: "drive", driveRole: "reverse", size: "medium", regions: ["fore"], orientation: 180, itemId: ids.reverseDrive },
    { id: slots.portLateralDrive, label: "Port Lateral Drive", class: "drive", driveRole: "portLateral", size: "medium", regions: ["port", "aft"], orientation: -90, itemId: ids.portLateralDrive },
    { id: slots.starboardLateralDrive, label: "Starboard Lateral Drive", class: "drive", driveRole: "starboardLateral", size: "medium", regions: ["starboard", "aft"], orientation: 90, itemId: ids.starboardLateralDrive },
    { id: slots.inertia, label: "Inertial Anchor", class: "inertia", size: "medium", regions: [...SECTORS], orientation: 0, itemId: ids.inertia },
  ],
  hardpoints: [
    { id: ids.prowHardpoint, label: "Prow", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.railgun },
    { id: ids.dorsalHardpoint, label: "Dorsal", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.laser },
    { id: ids.portHardpoint, label: "Port", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -90, traverse: "fixed", weaponId: ids.portMacrocannon },
    { id: ids.starboardHardpoint, label: "Starboard", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 90, traverse: "fixed", weaponId: ids.starboardMacrocannon },
  ],
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 1, inertia: 2, weapons: 3 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.prowHardpoint, ids.dorsalHardpoint, ids.portHardpoint, ids.starboardHardpoint],
  operators,
  criticalPools,
});

/** Detached effective reference retained for pure rules/public compatibility. */
export const CANADENSIS_CONFIG = deepFreeze(materializeShipConfig(
  CANADENSIS_HULL_CONFIG,
  CANADENSIS_DEFAULT_COMPONENT_SOURCES,
));

export const CANADENSIS_ENCOUNTER_DEFAULTS = deepFreeze({
  hull: 50,
  heat: 0,
  power: { engines: 3, shields: 3, sensors: 2, cooling: 1, inertia: 2, weapons: 3 },
  shields: {
    hp: { fore: 15, port: 15, starboard: 15, aft: 15 },
    allocation: { fore: 15, port: 15, starboard: 15, aft: 15 },
    regenerationAllocation: { fore: 25, port: 25, starboard: 25, aft: 25 },
    collapse: { fore: 0, port: 0, starboard: 0, aft: 0 },
  },
  weaponConfiguration: "anti-armor",
  weapons: {
    [ids.railgun]: { status: "online", mode: "nominal", bootCounter: 0, readiness: 1, reloadProgress: 0, reloadWork: null },
    [ids.laser]: { status: "off", mode: "nominal", bootCounter: 0, readiness: 3, reloadProgress: 0, reloadWork: null },
    [ids.portMacrocannon]: { status: "online", mode: "nominal", bootCounter: 0, readiness: 20, reloadProgress: 0, reloadWork: null },
    [ids.starboardMacrocannon]: { status: "off", mode: "nominal", bootCounter: 0, readiness: 20, reloadProgress: 0, reloadWork: null },
  },
  work: {}, conditions: {}, timeline: 0, rotationSpent: 0, pivotSpent: 0,
  velocity: { x: 0, y: 0 }, evasion: { armed: false, reserved: 0 }, ventCooldown: 0,
});
