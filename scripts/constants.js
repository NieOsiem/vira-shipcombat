export const MODULE_ID = "vira-shipcombat";
export const SHIP_TYPE = `${MODULE_ID}.ship`;
export const COMPONENT_ITEM_TYPE = `${MODULE_ID}.component`;
export const SCHEMA_VERSION = 2;
export const INTERNAL_UPDATE_OPTION = "viraShipCombatInternal";
export const INTERNAL_REFIT_OPTION = "viraShipCombatRefit";

export const SECTORS = Object.freeze(["fore", "port", "starboard", "aft"]);
export const COMPONENT_CLASSES = Object.freeze([
  "reactor",
  "drive",
  "shield",
  "sensor",
  "cooling",
  "inertia",
  "weapon",
]);
export const DRIVE_ROLES = Object.freeze(["", "main", "reverse", "lateral"]);
export const CORE_COMPONENT_CLASSES = Object.freeze([
  "reactor",
  "drive",
  "shield",
  "sensor",
  "cooling",
  "inertia",
]);
export const POWER_SYSTEMS = Object.freeze([
  "engines",
  "shields",
  "sensors",
  "cooling",
  "inertia",
  "weapons",
]);
export const WEAPON_CATEGORIES = Object.freeze(["hardpoint"]);
export const MOUNT_SIZES = Object.freeze([
  "tiny",
  "small",
  "medium",
  "large",
  "huge",
  "gargantuan",
]);
export const PROJECTILE_CLASSES = Object.freeze([
  "instant",
  "fast",
  "medium",
  "slow",
  "verySlow",
]);
export const WEAPON_STATUSES = Object.freeze(["off", "booting", "online"]);
export const WEAPON_MODES = Object.freeze(["nominal", "overclock"]);
export const READINESS_TYPES = Object.freeze(["readyShot", "charges", "magazine"]);
export const READINESS_RECOVERY = Object.freeze(["automaticStart", "manualWork"]);
export const CONDITION_TIERS = Object.freeze([
  "minor",
  "major",
  "critical",
  "destroyed",
]);
export const HAZARD_TIERS = Object.freeze([
  "minor",
  "major",
  "critical",
  "catastrophic",
]);
export const TRACK_STATES = Object.freeze(["undetected", "contact", "targeted"]);
export const TURN_PHASES = Object.freeze(["start", "active", "coast", "end"]);
export const OPERATOR_TYPES = Object.freeze(["pc", "npc", "ai", "drone"]);
export const ROSTER_KINDS = Object.freeze(["command", "crew"]);
export const SHIELD_TOPOLOGIES = Object.freeze(["directional", "bubble"]);
export const FATE_POLICIES = Object.freeze(["disposable", "important"]);

export const COMPONENT_IDS = Object.freeze({
  reactor: "reactor",
  drive: "drive",
  shield: "shield",
  sensor: "sensor",
  cooling: "cooling",
});

export const TRAIT_IDS = Object.freeze({
  nonLethal: "nonLethal",
  shieldBypass: "shieldBypass",
  barrage: "barrage",
  vicious: "vicious",
  unreliable: "unreliable",
  incendiary: "incendiary",
  unstableOverclock: "unstableOverclock",
});

export const SUPPORTED_TRAITS = Object.freeze([
  TRAIT_IDS.nonLethal,
  TRAIT_IDS.shieldBypass,
  TRAIT_IDS.barrage,
  TRAIT_IDS.vicious,
]);

export const RESERVED_INCOMPLETE_TRAITS = Object.freeze([
  TRAIT_IDS.unreliable,
  TRAIT_IDS.incendiary,
  TRAIT_IDS.unstableOverclock,
]);

export class RuleViolation extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RuleViolation";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
