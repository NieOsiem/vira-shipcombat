import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import {
  deepFreeze,
  installationSource,
} from "../../scripts/data/component-source.js";
import {
  MEDIUM_BREAKER_LANCE_SOURCE,
  MEDIUM_COOLING_SOURCE,
  MEDIUM_ESCORT_BATTERY_SOURCE,
  MEDIUM_INERTIA_SOURCE,
  MEDIUM_LATERAL_DRIVE_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_REACTOR_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_SHIELD_SOURCE,
} from "../components/medium-components.js";

/**
 * Aegis — medium escort (two command seats).
 *
 * The no-blind-arc hull. Three wide mounts — a 210° Breaker Lance forward and a 240° Escort Battery
 * on each beam — overlap into the whole circle, so there is no bearing a threat can sit on that the
 * hull cannot answer, and no stern arc for a pursuer to hide in.
 *
 * Its damage is deliberately moderate: this is not the hull that out-shoots a gun battery. What the
 * Aegis pressures with is the Breaker Lance's `shieldBypass` — shield damage as listed **plus** hull
 * damage that transmits straight through a standing field — so an enemy's regeneration funnel never
 * gets to be the whole story, and any escort can make a bigger ship's shields irrelevant for a turn.
 * The batteries are there for arcs and volume, not for weight of fire.
 *
 * Coverage: 100% of the circle (three windows whose union is the full 360°).
 */
const slots = Object.freeze({
  reactor: "aegis-slot-reactor",
  shield: "aegis-slot-shield",
  sensor: "aegis-slot-sensor",
  cooling: "aegis-slot-cooling",
  mainDrive: "aegis-slot-main-drive",
  reverseDrive: "aegis-slot-reverse-drive",
  portLateralDrive: "aegis-slot-port-lateral-drive",
  starboardLateralDrive: "aegis-slot-starboard-lateral-drive",
  inertia: "aegis-slot-inertia",
});

const ids = Object.freeze({
  reactor: "MedReactorStd001",
  shield: "MedShieldDir0001",
  sensor: "MedSensorStd0001",
  cooling: "MedCoolingStd001",
  mainDrive: "MedDriveMainStd1",
  reverseDrive: "MedDriveRevStd01",
  portLateralDrive: "MedLateralAegA01",
  starboardLateralDrive: "MedLateralAegB01",
  inertia: "MedInertiaStd001",
  breakerLance: "MedBreakerLance1",
  portBattery: "MedEscortBttyA01",
  starboardBattery: "MedEscortBttyB01",
  breakerHardpoint: "aegis-hardpoint-breaker",
  portBatteryHardpoint: "aegis-hardpoint-port-battery",
  starboardBatteryHardpoint: "aegis-hardpoint-starboard-battery",
});

const operators = [
  { id: "aegis-pilot-commander", label: "Pilot / Commander", type: "npc", ratings: { piloting: 5, gunnery: 3, sensors: 4, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "aegis-gunner-sensor", label: "Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 5, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "aegis-loader", label: "Loader / General Crew", type: "npc", ratings: { piloting: 1, gunnery: 4, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "aegis-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 2, gunnery: 2, sensors: 3, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 1 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

function hazard(channelId, sector = null) {
  return { id: `${channelId}:${sector ?? "ship"}`, kind: "hazard", componentId: null, channelId, sector, weight: 1 };
}

const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.breakerHardpoint}`, { hardpointId: ids.breakerHardpoint }, "weaponMalfunction"),
    fault(`sensorFault:${slots.sensor}`, { slotId: slots.sensor }, "sensorFault"),
    fault(`driveFailure:${slots.reverseDrive}`, { slotId: slots.reverseDrive }, "driveFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:fore`, { slotId: slots.shield }, "shieldEmitterDamage", "fore"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("fire", "fore"),
    hazard("breach", "fore"),
  ],
  port: [
    fault(`weaponMalfunction:${ids.portBatteryHardpoint}`, { hardpointId: ids.portBatteryHardpoint }, "weaponMalfunction"),
    fault(`shieldEmitterDamage:${slots.shield}:port`, { slotId: slots.shield }, "shieldEmitterDamage", "port"),
    fault(`maneuveringThrusterFailure:${slots.portLateralDrive}`, { slotId: slots.portLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("electricalCascade"),
    hazard("fire", "port"),
    hazard("breach", "port"),
  ],
  starboard: [
    fault(`weaponMalfunction:${ids.starboardBatteryHardpoint}`, { hardpointId: ids.starboardBatteryHardpoint }, "weaponMalfunction"),
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

export const AEGIS_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data and independent embedded Item IDs only. */
export const AEGIS_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "aegis-escort",
  label: "Aegis Escort",
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
  armor: { fore: 3, port: 4, starboard: 4, aft: 3 },
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
    { id: ids.breakerHardpoint, label: "Breaker Lance", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "turret", weaponId: ids.breakerLance },
    { id: ids.portBatteryHardpoint, label: "Port Battery", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -90, traverse: "turret", weaponId: ids.portBattery },
    { id: ids.starboardBatteryHardpoint, label: "Starboard Battery", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 90, traverse: "turret", weaponId: ids.starboardBattery },
  ],
  // Power arithmetic: Breaker Lance 3 + 2 × Escort Battery 2 = 7 Weapons Power; engines 3 (6 thrust ×
  // 1.0), shields 3 (8 regeneration), sensors 2 (100 su passive), cooling 2 (9 Heat a Start against
  // 2 × 4-round salvoes at 4 Heat a salvo plus the Lance's 2 a shot), inertia 2 (60° pivot) = 19 of the
  // Corvette Reactor's 20.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 2, inertia: 2, weapons: 7 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.breakerHardpoint, ids.portBatteryHardpoint, ids.starboardBatteryHardpoint],
  operators,
  criticalPools,
});

/** The fresh-copy kit: nine systems, the Lance, and two independent battery copies. */
export const AEGIS_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  MEDIUM_REACTOR_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_COOLING_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.portLateralDrive),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.starboardLateralDrive),
  MEDIUM_INERTIA_SOURCE,
  MEDIUM_BREAKER_LANCE_SOURCE,
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, ids.portBattery),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, ids.starboardBattery),
]);
