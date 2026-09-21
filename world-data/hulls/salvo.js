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
  MEDIUM_REACTOR_BATTERY_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  SALVO_INSTALLATION_IDS,
} from "../components/medium-components.js";

/**
 * Salvo — medium anti-funnel corvette (two command seats).
 *
 * Decision 92's failure mode is a hull whose sustained fire is healed faster than it is applied: the
 * defender routes half its regeneration budget into the facet the fire is coming through, and the
 * attacker never gets anywhere. The Salvo is the answer to that hull, and it gives two answers.
 *
 * The barrage is the first. Two Escort Batteries on turret rings train 240° each and fire four-round
 * salvoes: the engine's own barrage table turns a four-round salvo into two effective hits, so one
 * landing salvo puts 14 Shield Damage on a facet. A Corvette Deflector regenerates 8 at Shield Power
 * 3, and its hull caps one facet at 50% of that — at most 4 a Start on the facet being hit, against
 * the 40 shield damage a turn this hull's four guns can put out (2 × 14 from the rings, 2 × 6 from
 * the lances). That is the whole anti-funnel argument in one line: the funnel's ceiling is 4, the
 * hull's is 40.
 *
 * The pincer is the second, and it is why the hull exists rather than the batteries. A Breaker Lance
 * carries `shieldBypass` on the hull channel: 11 Hull a hit arrives *through* a standing field, so
 * hull damage never waits on the shield collapse the regeneration budget is buying time for. Both
 * jaws are mounted in the forward quarters (210° of train at ±60°), so a target held ahead is inside
 * both of them at once — and unlike the rings, whose 32-round magazines are eight salvoes deep, a
 * lance recovers its charges at every Start and keeps firing after the loaders' magazines run dry.
 *
 * The rest of the fit exists to feed those four guns: the Battery Reactor is the plant two rings and
 * two lances need (10 Weapons Power behind one commit), and the Corvette Cooling Array's 12 Heat a
 * Start covers one full turn of fire exactly (2 × 4-round salvoes at 4 Heat, 2 lance shots at 2). The
 * Mk II Inertial Anchor's 60° pivot is what walks a 40 su battery onto a crossing target.
 *
 * Coverage: 100% of the circle. The two rings alone close it (240° at ±90°), and the jaws add a
 * second, shield-ignoring layer across the bow and the forward quarters.
 *
 * The one thing the hull is not built around is the turn, and the balance report says so: four mounts
 * that all bear on the bow line out-run a two-seat bridge's Actions, so the mirror runs count
 * hangfire (a bearing, loaded gun with no Action left to fire it) on the busiest turns. That is the
 * trade the class's gun batteries make as well — a turret ring is there to cover a bearing, not to
 * fire every turn — and on this hull it costs the least: the jaws never need reloading, and a ring
 * that sits out a turn is spending a magazine that holds eight salvoes anyway.
 */
const slots = Object.freeze({
  reactor: "salvo-slot-reactor",
  shield: "salvo-slot-shield",
  sensor: "salvo-slot-sensor",
  cooling: "salvo-slot-cooling",
  mainDrive: "salvo-slot-main-drive",
  reverseDrive: "salvo-slot-reverse-drive",
  portLateralDrive: "salvo-slot-port-lateral-drive",
  starboardLateralDrive: "salvo-slot-starboard-lateral-drive",
  inertia: "salvo-slot-inertia",
});

const ids = Object.freeze({
  reactor: "MedReactorPre001",
  shield: "MedShieldDir0001",
  sensor: "MedSensorStd0001",
  cooling: "MedCoolingStd001",
  mainDrive: "MedDriveMainStd1",
  reverseDrive: "MedDriveRevStd01",
  portLateralDrive: SALVO_INSTALLATION_IDS.portLateral,
  starboardLateralDrive: SALVO_INSTALLATION_IDS.starboardLateral,
  inertia: "MedInertiaStd001",
  portBattery: SALVO_INSTALLATION_IDS.portBattery,
  starboardBattery: SALVO_INSTALLATION_IDS.starboardBattery,
  portLance: SALVO_INSTALLATION_IDS.portLance,
  starboardLance: SALVO_INSTALLATION_IDS.starboardLance,
  portBatteryHardpoint: "salvo-hardpoint-port-battery",
  starboardBatteryHardpoint: "salvo-hardpoint-starboard-battery",
  portLanceHardpoint: "salvo-hardpoint-port-lance",
  starboardLanceHardpoint: "salvo-hardpoint-starboard-lance",
});

/** Two loaders because two magazines of 32 rounds are what two barrage rings ask of a crew. */
const operators = [
  { id: "salvo-pilot-commander", label: "Pilot / Commander", type: "npc", ratings: { piloting: 5, gunnery: 4, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "salvo-master-gunner", label: "Master Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 5, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "salvo-loader-port", label: "Port Ring Loader", type: "npc", ratings: { piloting: 1, gunnery: 3, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "salvo-loader-starboard", label: "Starboard Ring Loader", type: "npc", ratings: { piloting: 1, gunnery: 3, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 1 } },
  { id: "salvo-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 1, gunnery: 2, sensors: 2, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 2 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

function hazard(channelId, sector = null) {
  return { id: `${channelId}:${sector ?? "ship"}`, kind: "hazard", componentId: null, channelId, sector, weight: 1 };
}

const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.portLanceHardpoint}`, { hardpointId: ids.portLanceHardpoint }, "weaponMalfunction"),
    fault(`weaponMalfunction:${ids.starboardLanceHardpoint}`, { hardpointId: ids.starboardLanceHardpoint }, "weaponMalfunction"),
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

export const SALVO_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data and independent embedded Item IDs only. */
export const SALVO_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "salvo-barrage-corvette",
  label: "Salvo Barrage Corvette",
  size: "medium",
  initiative: 0,
  ac: 14,
  baseSignature: 16,
  maxHull: 50,
  heatCapacity: 30,
  commandCapacity: 2,
  crewCapacity: 3,
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
    { id: ids.portLanceHardpoint, label: "Port Pincer Lance", category: "hardpoint", mountSize: "medium", regions: ["fore", "port"], orientation: -60, traverse: "turret", weaponId: ids.portLance },
    { id: ids.starboardLanceHardpoint, label: "Starboard Pincer Lance", category: "hardpoint", mountSize: "medium", regions: ["fore", "starboard"], orientation: 60, traverse: "turret", weaponId: ids.starboardLance },
    { id: ids.portBatteryHardpoint, label: "Port Barrage Ring", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -90, traverse: "turret", weaponId: ids.portBattery },
    { id: ids.starboardBatteryHardpoint, label: "Starboard Barrage Ring", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 90, traverse: "turret", weaponId: ids.starboardBattery },
  ],
  // Power arithmetic: 2 × Breaker Lance (3) + 2 × Escort Battery (2) = 10 Weapons Power; engines 3
  // (6 thrust × 1.0 = 6 / 3 / 2 su and 60° of rotation), shields 3 (8 regeneration), sensors 2 (100
  // su passive), cooling 3 (12 Heat a Start, exactly one turn of fire), inertia 2 (60° pivot) = 23 of
  // the Battery Reactor's 26.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 3, inertia: 2, weapons: 10 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  // The pincer leads. Priority is the order the engine brings guns online while it reserves Weapons
  // Power, and on this hull the guns that ignore shields are the last ones it would ever shed — the
  // rings are volume, the jaws are the thesis.
  weaponPriority: [ids.portLanceHardpoint, ids.starboardLanceHardpoint, ids.portBatteryHardpoint, ids.starboardBatteryHardpoint],
  operators,
  criticalPools,
});

/** The fresh-copy kit: nine systems, two mounted barrage rings, two mounted pincer lances. */
export const SALVO_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  MEDIUM_REACTOR_BATTERY_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_COOLING_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.portLateralDrive),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.starboardLateralDrive),
  MEDIUM_INERTIA_SOURCE,
  installationSource(MEDIUM_BREAKER_LANCE_SOURCE, ids.portLance),
  installationSource(MEDIUM_BREAKER_LANCE_SOURCE, ids.starboardLance),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, ids.portBattery),
  installationSource(MEDIUM_ESCORT_BATTERY_SOURCE, ids.starboardBattery),
]);
