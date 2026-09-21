import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import {
  deepFreeze,
  installationSource,
} from "../../scripts/data/component-source.js";
import {
  MEDIUM_CHASER_LASER_SOURCE,
  MEDIUM_COOLING_SOURCE,
  MEDIUM_INERTIA_SOURCE,
  MEDIUM_LATERAL_DRIVE_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_REACTOR_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  MEDIUM_SENSOR_LONG_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_SPINAL_RAILGUN_SOURCE,
} from "../components/medium-components.js";

/**
 * Ballista — medium sniper corvette (two command seats).
 *
 * The hull is built around one gun: a 90 su / 180 su Spinal Railgun, one ready shot a turn, AP 4 and
 * 20 hull a hit. Everything else gives way to it — safe velocity 24 rather than the class's 26-30, a
 * 45° spinal window, and only two 30° Chaser Lasers for anything already sitting on the beam.
 *
 * Coverage, stated plainly: the mounts cover 105° of the circle (29.2%), so the Ballista **fails the
 * 66% coverage gate by design**. That is the trade the hull makes: it is not an escort and it does not
 * pretend to be one. A target that closes or crosses into the 255° it cannot see has beaten it, which
 * is the fight the hull's own 180 su Maximum Range and the 150 su Longbow array are meant to win
 * before it happens. The class's standard 100 su array covers the 90 su Optimal band with 10 su to
 * spare and sees nothing at all of the 90-180 su band the gun can still reach into, so this hull
 * carries the Longbow instead.
 *
 * Fitting note: all three mounts are armed, but only the spinal gun carries the hull's Power. The
 * chasers are the cheap close-in answer, not a second battery.
 */
const slots = Object.freeze({
  reactor: "ballista-slot-reactor",
  shield: "ballista-slot-shield",
  sensor: "ballista-slot-sensor",
  cooling: "ballista-slot-cooling",
  mainDrive: "ballista-slot-main-drive",
  reverseDrive: "ballista-slot-reverse-drive",
  portLateralDrive: "ballista-slot-port-lateral-drive",
  starboardLateralDrive: "ballista-slot-starboard-lateral-drive",
  inertia: "ballista-slot-inertia",
});

const ids = Object.freeze({
  reactor: "MedReactorStd001",
  shield: "MedShieldDir0001",
  sensor: "MedSensorLng0001",
  cooling: "MedCoolingStd001",
  mainDrive: "MedDriveMainStd1",
  reverseDrive: "MedDriveRevStd01",
  portLateralDrive: "MedLateralBalA01",
  starboardLateralDrive: "MedLateralBalB01",
  inertia: "MedInertiaStd001",
  spinalRailgun: "MedRailgunSpinal",
  portChaser: "MedChaserLaserA1",
  starboardChaser: "MedChaserLaserB1",
  spinalHardpoint: "ballista-hardpoint-spinal",
  portChaserHardpoint: "ballista-hardpoint-port-chaser",
  starboardChaserHardpoint: "ballista-hardpoint-starboard-chaser",
});

const operators = [
  { id: "ballista-pilot-commander", label: "Pilot / Commander", type: "npc", ratings: { piloting: 5, gunnery: 2, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "ballista-gunner-sensor", label: "Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 5, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "ballista-loader", label: "Loader / Damage Control", type: "npc", ratings: { piloting: 1, gunnery: 3, sensors: 2, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 0 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

function hazard(channelId, sector = null) {
  return { id: `${channelId}:${sector ?? "ship"}`, kind: "hazard", componentId: null, channelId, sector, weight: 1 };
}

const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.spinalHardpoint}`, { hardpointId: ids.spinalHardpoint }, "weaponMalfunction"),
    fault(`sensorFault:${slots.sensor}`, { slotId: slots.sensor }, "sensorFault"),
    fault(`driveFailure:${slots.reverseDrive}`, { slotId: slots.reverseDrive }, "driveFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:fore`, { slotId: slots.shield }, "shieldEmitterDamage", "fore"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("fire", "fore"),
    hazard("breach", "fore"),
  ],
  port: [
    fault(`weaponMalfunction:${ids.portChaserHardpoint}`, { hardpointId: ids.portChaserHardpoint }, "weaponMalfunction"),
    fault(`shieldEmitterDamage:${slots.shield}:port`, { slotId: slots.shield }, "shieldEmitterDamage", "port"),
    fault(`maneuveringThrusterFailure:${slots.portLateralDrive}`, { slotId: slots.portLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("electricalCascade"),
    hazard("fire", "port"),
    hazard("breach", "port"),
  ],
  starboard: [
    fault(`weaponMalfunction:${ids.starboardChaserHardpoint}`, { hardpointId: ids.starboardChaserHardpoint }, "weaponMalfunction"),
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

export const BALLISTA_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data and embedded Item IDs only. */
export const BALLISTA_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "ballista-sniper-corvette",
  label: "Ballista Sniper Corvette",
  size: "medium",
  initiative: 0,
  ac: 13,
  baseSignature: 15,
  maxHull: 44,
  heatCapacity: 22,
  commandCapacity: 2,
  crewCapacity: 1,
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
  armor: { fore: 4, port: 3, starboard: 3, aft: 2 },
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
    { id: ids.spinalHardpoint, label: "Spinal Mount", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "fixed", weaponId: ids.spinalRailgun },
    { id: ids.portChaserHardpoint, label: "Port Chaser", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -90, traverse: "turret", weaponId: ids.portChaser },
    { id: ids.starboardChaserHardpoint, label: "Starboard Chaser", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 90, traverse: "turret", weaponId: ids.starboardChaser },
  ],
  // Power arithmetic: Spinal Railgun 5 + 2 × Chaser Laser 1 = 7 Weapons Power; engines 3 (6 thrust ×
  // 1.0), shields 3 (8 regeneration), sensors 2 (150 su passive Longbow), cooling 2 (9 Heat a Start
  // against the spinal gun's 4 Heat a shot), inertia 2 (60° pivot) = 19 of the Corvette Reactor's 20.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 2, inertia: 2, weapons: 7 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.spinalHardpoint, ids.portChaserHardpoint, ids.starboardChaserHardpoint],
  operators,
  criticalPools,
});

/** The fresh-copy kit: nine systems, the spinal gun, and the two chasers as independent copies. */
export const BALLISTA_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  MEDIUM_REACTOR_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_SENSOR_LONG_SOURCE,
  MEDIUM_COOLING_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.portLateralDrive),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.starboardLateralDrive),
  MEDIUM_INERTIA_SOURCE,
  MEDIUM_SPINAL_RAILGUN_SOURCE,
  installationSource(MEDIUM_CHASER_LASER_SOURCE, ids.portChaser),
  installationSource(MEDIUM_CHASER_LASER_SOURCE, ids.starboardChaser),
]);
