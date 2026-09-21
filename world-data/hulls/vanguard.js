import { SCHEMA_VERSION, SECTORS } from "../../scripts/constants.js";
import {
  deepFreeze,
  installationSource,
} from "../../scripts/data/component-source.js";
import {
  MEDIUM_COOLING_HEAVY_SOURCE,
  MEDIUM_INERTIA_SOURCE,
  MEDIUM_LATERAL_DRIVE_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_MACROCANNON_SOURCE,
  MEDIUM_REACTOR_BATTERY_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_TURRET_LASER_SOURCE,
} from "../components/medium-components.js";

/**
 * Vanguard — medium gun battery (two command seats).
 *
 * Four casemate Macrocannons in two pairs, trained forward-abeam on the hull's quarters, and a single
 * Corvette Turret forward. That is the whole design: a hull that carries a battery and pays for it in
 * speed, and whose fore armament is one turret against four guns. Safe velocity 18 is the class's
 * floor, armour is its ceiling (5/4/4/3, 60 hull), and it is the only hull in the wave that needs the
 * Battery Reactor.
 *
 * Why ±60° / ±80° rather than a true ±90° casemate: the mounts are trained into the forward quarters
 * so a battery can come to bear on a target held ahead. A 90° casemate with the same 165° arc would
 * reach nothing at all on the bow line, and a gun battery that cannot shoot at the ship it is chasing
 * is scenery. The price is a 35° blind cone dead astern, which is the one bearing the hull has no
 * answer for (coverage 90.3% of the circle).
 *
 * Power arithmetic, since this is the hull the grade was sized for:
 *   4 × Broadside Macrocannon (powerRating 2)  = 8
 *   1 × Corvette Turret (powerRating 2)        = 2
 *   Weapons Power committed                    = 10
 *   engines 3 + shields 3 + sensors 2 + cooling 3 + inertia 2 + weapons 10 = 23 of 26 nominal, 3 in
 *   hand for a gun swap. Cooling 3 is the Battery Cooling Array's 16 Heat a Start, which is exactly
 *   one full four-gun salvo (4 rounds × 1 Heat a gun); the fore turret's 2 Heat a shot is what the
 *   array's 18-Heat vent and the 34-point Heat Capacity are for. Inertia 2 is the 60° pivot the hull
 *   needs to walk a short-optimal battery onto a crossing target.
 */
const slots = Object.freeze({
  reactor: "vanguard-slot-reactor",
  shield: "vanguard-slot-shield",
  sensor: "vanguard-slot-sensor",
  cooling: "vanguard-slot-cooling",
  mainDrive: "vanguard-slot-main-drive",
  reverseDrive: "vanguard-slot-reverse-drive",
  portLateralDrive: "vanguard-slot-port-lateral-drive",
  starboardLateralDrive: "vanguard-slot-starboard-lateral-drive",
  inertia: "vanguard-slot-inertia",
});

const ids = Object.freeze({
  reactor: "MedReactorPre001",
  shield: "MedShieldDir0001",
  sensor: "MedSensorStd0001",
  cooling: "MedCoolingHvy001",
  mainDrive: "MedDriveMainStd1",
  reverseDrive: "MedDriveRevStd01",
  portLateralDrive: "MedLateralVanA01",
  starboardLateralDrive: "MedLateralVanB01",
  inertia: "MedInertiaStd001",
  portBatteryFore: "MedMacrocanA0001",
  portBatteryAft: "MedMacrocanB0001",
  starboardBatteryFore: "MedMacrocanC0001",
  starboardBatteryAft: "MedMacrocanD0001",
  foreTurret: "MedTurretLaser01",
  portForeHardpoint: "vanguard-hardpoint-port-fore",
  portAftHardpoint: "vanguard-hardpoint-port-aft",
  starboardForeHardpoint: "vanguard-hardpoint-starboard-fore",
  starboardAftHardpoint: "vanguard-hardpoint-starboard-aft",
  foreTurretHardpoint: "vanguard-hardpoint-fore-turret",
});

/** Three loaders because four magazines of 32 rounds are what a battery asks of a crew. */
const operators = [
  { id: "vanguard-pilot-commander", label: "Pilot / Commander", type: "npc", ratings: { piloting: 5, gunnery: 3, sensors: 3, engineering: 3 }, defaultAssignment: { kind: "command", slot: 0 } },
  { id: "vanguard-gunner-sensor", label: "Master Gunner / Sensor Operator", type: "npc", ratings: { piloting: 2, gunnery: 5, sensors: 5, engineering: 3 }, defaultAssignment: { kind: "command", slot: 1 } },
  { id: "vanguard-loader-port", label: "Port Battery Loader", type: "npc", ratings: { piloting: 1, gunnery: 4, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 0 } },
  { id: "vanguard-loader-starboard", label: "Starboard Battery Loader", type: "npc", ratings: { piloting: 1, gunnery: 4, sensors: 2, engineering: 4 }, defaultAssignment: { kind: "crew", slot: 1 } },
  { id: "vanguard-damage-control", label: "Damage-Control Crew", type: "npc", ratings: { piloting: 1, gunnery: 2, sensors: 2, engineering: 5 }, defaultAssignment: { kind: "crew", slot: 2 } },
];

function fault(id, reference, channelId, sector = null) {
  return { id, kind: "fault", ...reference, channelId, sector, weight: 1 };
}

function hazard(channelId, sector = null) {
  return { id: `${channelId}:${sector ?? "ship"}`, kind: "hazard", componentId: null, channelId, sector, weight: 1 };
}

const criticalPools = {
  fore: [
    fault(`weaponMalfunction:${ids.foreTurretHardpoint}`, { hardpointId: ids.foreTurretHardpoint }, "weaponMalfunction"),
    fault(`sensorFault:${slots.sensor}`, { slotId: slots.sensor }, "sensorFault"),
    fault(`driveFailure:${slots.reverseDrive}`, { slotId: slots.reverseDrive }, "driveFailure"),
    fault(`shieldEmitterDamage:${slots.shield}:fore`, { slotId: slots.shield }, "shieldEmitterDamage", "fore"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("fire", "fore"),
    hazard("breach", "fore"),
  ],
  port: [
    fault(`weaponMalfunction:${ids.portForeHardpoint}`, { hardpointId: ids.portForeHardpoint }, "weaponMalfunction"),
    fault(`weaponMalfunction:${ids.portAftHardpoint}`, { hardpointId: ids.portAftHardpoint }, "weaponMalfunction"),
    fault(`shieldEmitterDamage:${slots.shield}:port`, { slotId: slots.shield }, "shieldEmitterDamage", "port"),
    fault(`maneuveringThrusterFailure:${slots.portLateralDrive}`, { slotId: slots.portLateralDrive }, "maneuveringThrusterFailure"),
    fault(`inertiaFailure:${slots.inertia}`, { slotId: slots.inertia }, "inertiaFailure"),
    hazard("electricalCascade"),
    hazard("fire", "port"),
    hazard("breach", "port"),
  ],
  starboard: [
    fault(`weaponMalfunction:${ids.starboardForeHardpoint}`, { hardpointId: ids.starboardForeHardpoint }, "weaponMalfunction"),
    fault(`weaponMalfunction:${ids.starboardAftHardpoint}`, { hardpointId: ids.starboardAftHardpoint }, "weaponMalfunction"),
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

export const VANGUARD_IDS = ids;

/** Schema-v2 Actor-persisted hull: hull data and independent embedded Item IDs only. */
export const VANGUARD_HULL_CONFIG = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: "vanguard-gun-battery",
  label: "Vanguard Gun Battery",
  size: "medium",
  initiative: 0,
  ac: 12,
  baseSignature: 17,
  maxHull: 60,
  heatCapacity: 34,
  commandCapacity: 2,
  crewCapacity: 3,
  safeVelocity: 18,
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
    { id: ids.portForeHardpoint, label: "Port Battery (Fore)", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -60, traverse: "turret", weaponId: ids.portBatteryFore },
    { id: ids.portAftHardpoint, label: "Port Battery (Aft)", category: "hardpoint", mountSize: "medium", regions: ["port"], orientation: -80, traverse: "turret", weaponId: ids.portBatteryAft },
    { id: ids.starboardForeHardpoint, label: "Starboard Battery (Fore)", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 60, traverse: "turret", weaponId: ids.starboardBatteryFore },
    { id: ids.starboardAftHardpoint, label: "Starboard Battery (Aft)", category: "hardpoint", mountSize: "medium", regions: ["starboard"], orientation: 80, traverse: "turret", weaponId: ids.starboardBatteryAft },
    { id: ids.foreTurretHardpoint, label: "Fore Turret", category: "hardpoint", mountSize: "medium", regions: ["fore"], orientation: 0, traverse: "turret", weaponId: ids.foreTurret },
  ],
  // See the header: 10 Weapons Power for the battery, 23 of 26 committed in total.
  initialPower: { engines: 3, shields: 3, sensors: 2, cooling: 3, inertia: 2, weapons: 10 },
  sheddingPriority: ["sensors", "engines", "inertia", "shields", "cooling", "weapons"],
  weaponPriority: [ids.portForeHardpoint, ids.starboardForeHardpoint, ids.portAftHardpoint, ids.starboardAftHardpoint, ids.foreTurretHardpoint],
  operators,
  criticalPools,
});

/** The fresh-copy kit: nine systems, four independent macrocannons, one fore turret. */
export const VANGUARD_DEFAULT_COMPONENT_SOURCES = deepFreeze([
  MEDIUM_REACTOR_BATTERY_SOURCE,
  MEDIUM_SHIELD_SOURCE,
  MEDIUM_SENSOR_SOURCE,
  MEDIUM_COOLING_HEAVY_SOURCE,
  MEDIUM_MAIN_DRIVE_SOURCE,
  MEDIUM_REVERSE_DRIVE_SOURCE,
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.portLateralDrive),
  installationSource(MEDIUM_LATERAL_DRIVE_SOURCE, ids.starboardLateralDrive),
  MEDIUM_INERTIA_SOURCE,
  installationSource(MEDIUM_MACROCANNON_SOURCE, ids.portBatteryFore),
  installationSource(MEDIUM_MACROCANNON_SOURCE, ids.portBatteryAft),
  installationSource(MEDIUM_MACROCANNON_SOURCE, ids.starboardBatteryFore),
  installationSource(MEDIUM_MACROCANNON_SOURCE, ids.starboardBatteryAft),
  MEDIUM_TURRET_LASER_SOURCE,
]);
