import {
  COMPONENT_CLASSES,
  CORE_COMPONENT_CLASSES,
  FATE_POLICIES,
  MOUNT_SIZES,
  OPERATOR_TYPES,
  POWER_SYSTEMS,
  PROJECTILE_CLASSES,
  READINESS_RECOVERY,
  READINESS_TYPES,
  RESERVED_INCOMPLETE_TRAITS,
  SCHEMA_VERSION,
  SECTORS,
  SHIELD_TOPOLOGIES,
  SUPPORTED_TRAITS,
  TRAIT_IDS,
  WEAPON_CATEGORIES,
} from "../constants.js";

const FAULT_CHANNELS = Object.freeze({
  reactor: new Set(["reactorFault"]),
  drive: new Set(["driveFailure", "maneuveringThrusterFailure"]),
  shield: new Set(["shieldEmitterDamage"]),
  sensor: new Set(["sensorFault"]),
  cooling: new Set(["coolingFailure"]),
  weapon: new Set(["weaponMalfunction"]),
});
const HAZARD_CHANNELS = new Set(["fire", "breach", "electricalCascade", "reactorInstability"]);
const SIZES = new Set(MOUNT_SIZES);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function tierArray(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  return Object.entries(value).map(([power, tier]) => ({ power: Number(power), ...tier }));
}

/** @returns {{valid:boolean, errors:object[], warnings:object[]}} */
export function validateShipConfig(config, { tokenWidth } = {}) {
  const errors = [];
  const warnings = [];
  const error = (code, path, message, details = undefined) => {
    const entry = { code, path, message };
    if (details !== undefined) entry.details = details;
    errors.push(entry);
  };
  const requireString = (value, path) => {
    if (typeof value !== "string" || value.trim() === "") {
      error("REQUIRED_STRING", path, "Must be a non-empty stable string.");
      return false;
    }
    return true;
  };
  const requireNumber = (value, path, { min = -Infinity, strict = false, integer = false } = {}) => {
    if (!isFiniteNumber(value) || (strict ? value <= min : value < min) || (integer && !Number.isInteger(value))) {
      const comparison = strict ? `greater than ${min}` : `at least ${min}`;
      error("INVALID_NUMBER", path, `Must be a finite${integer ? " integer" : " number"} ${comparison}.`);
      return false;
    }
    return true;
  };

  if (!isObject(config)) {
    error("CONFIG_REQUIRED", "config", "Ship configuration must be an object.");
    return { valid: false, errors, warnings };
  }

  if (config.schemaVersion !== SCHEMA_VERSION) {
    error("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion", `Expected schema version ${SCHEMA_VERSION}.`);
  }
  requireString(config.id, "id");
  requireString(config.label, "label");
  if (!SIZES.has(config.size)) error("INVALID_SIZE", "size", "Size must be a supported size class.");
  requireNumber(config.initiative, "initiative");
  requireNumber(config.ac, "ac", { min: 0, strict: true });
  requireNumber(config.baseSignature, "baseSignature");
  requireNumber(config.maxHull, "maxHull", { min: 0, strict: true });
  requireNumber(config.heatCapacity, "heatCapacity", { min: 0, strict: true });
  requireNumber(config.commandCapacity, "commandCapacity", { min: 0, integer: true });
  requireNumber(config.crewCapacity, "crewCapacity", { min: 0, integer: true });
  requireNumber(config.safeVelocity, "safeVelocity", { min: 0, strict: true });
  requireNumber(config.evasionReserve, "evasionReserve", { min: 0 });
  if (isFiniteNumber(config.evasionReserve) && config.evasionReserve > 100) {
    error("INVALID_EVASION_RESERVE", "evasionReserve", "Evasion reserve must not exceed 100 percent.");
  }
  requireNumber(config.evasionAcBonus, "evasionAcBonus");
  if (!FATE_POLICIES.includes(config.fatePolicy)) {
    error("INVALID_FATE_POLICY", "fatePolicy", "Fate policy must be disposable or important.");
  }
  if (!isObject(config.capabilityProfile)) {
    error("CAPABILITY_PROFILE_REQUIRED", "capabilityProfile", "Capability profile must be an object.");
  }
  if (!isFiniteNumber(tokenWidth) || tokenWidth <= 0) {
    error("INVALID_TOKEN_WIDTH", "tokenWidth", "Token width must be greater than zero.");
  }

  if (!isObject(config.armor)) {
    error("ARMOR_REQUIRED", "armor", "Armor must define all four sectors.");
  } else {
    for (const sector of SECTORS) requireNumber(config.armor[sector], `armor.${sector}`, { min: 0 });
  }

  const components = config.components;
  if (!isObject(components)) {
    error("COMPONENTS_REQUIRED", "components", "Components must be an object.");
    return { valid: false, errors, warnings };
  }

  const componentById = new Map();
  const registerId = (item, path, kind) => {
    if (!isObject(item) || !requireString(item.id, `${path}.id`)) return;
    if (componentById.has(item.id)) {
      error("DUPLICATE_STABLE_ID", `${path}.id`, `Stable ID '${item.id}' is duplicated.`, {
        firstPath: componentById.get(item.id).path,
      });
    } else {
      componentById.set(item.id, { item, path, kind });
    }
  };

  for (const expectedClass of CORE_COMPONENT_CLASSES) {
    const component = components[expectedClass];
    const path = `components.${expectedClass}`;
    if (!isObject(component)) {
      error("COMPONENT_CARDINALITY", path, `Exactly one ${expectedClass} component is required.`);
      continue;
    }
    if (component.class !== expectedClass || !COMPONENT_CLASSES.includes(component.class)) {
      error("INVALID_COMPONENT_CLASS", `${path}.class`, `Component class must be '${expectedClass}'.`);
    }
    registerId(component, path, expectedClass);
    validateRegions(component.regions, `${path}.regions`, error);
  }
  const allowedComponentKeys = new Set([...CORE_COMPONENT_CLASSES, "weapons"]);
  for (const key of Object.keys(components)) {
    if (!allowedComponentKeys.has(key)) {
      error(
        "UNSUPPORTED_COMPONENT_SLOT",
        `components.${key}`,
        "V1 permits exactly one core component of each class plus the weapons array.",
      );
    }
  }
  if (isObject(config.capabilityProfile)) {
    for (const flag of ["hazards", "physicalRepair", "work"]) {
      if (typeof config.capabilityProfile[flag] !== "boolean") {
        error("INVALID_CAPABILITY_FLAG", `capabilityProfile.${flag}`, "Capability flags must be boolean.");
      }
    }
    const hardware = config.capabilityProfile.evasionHardware;
    if (!Array.isArray(hardware)) {
      error("EVASION_HARDWARE_REQUIRED", "capabilityProfile.evasionHardware", "Evasion hardware must be an array.");
    } else {
      if (config.evasionReserve > 0 && hardware.length === 0) {
        error("EVASION_HARDWARE_REQUIRED", "capabilityProfile.evasionHardware", "An Evasion-capable ship must identify its hardware.");
      }
      for (const [index, entry] of hardware.entries()) {
        const path = `capabilityProfile.evasionHardware[${index}]`;
        if (!isObject(entry) || !componentById.has(entry.componentId) || typeof entry.channel !== "string" || entry.channel === "") {
          error("INVALID_EVASION_HARDWARE", path, "Evasion hardware requires a known component ID and channel.");
        }
      }
    }
  }

  const reactor = components.reactor;
  if (isObject(reactor)) {
    requireNumber(reactor.nominalOutput, "components.reactor.nominalOutput", { min: 0, strict: true, integer: true });
    requireNumber(reactor.redlineOutput, "components.reactor.redlineOutput", { min: 0, strict: true, integer: true });
    if (isFiniteNumber(reactor.nominalOutput) && isFiniteNumber(reactor.redlineOutput) && reactor.redlineOutput < reactor.nominalOutput) {
      error("INVALID_REACTOR_LIMITS", "components.reactor.redlineOutput", "Redline output cannot be below nominal output.");
    }
    requireNumber(reactor.overclockHeat, "components.reactor.overclockHeat", { min: 0 });
    validateRecoveryWork(reactor.recoveryWork, "components.reactor.recoveryWork", error);
  }

  validateTiers(components.drive, "components.drive", "drive", error);
  if (isObject(components.drive)) {
    for (const axis of ["forward", "retro", "port", "starboard", "rotation"]) {
      requireNumber(components.drive.base?.[axis], `components.drive.base.${axis}`, { min: 0 });
    }
    if (!isObject(components.drive.recoveryWork)) {
      error("RECOVERY_WORK_REQUIRED", "components.drive.recoveryWork", "Drive must define both recovery Work values.");
    } else {
      validateRecoveryWork(components.drive.recoveryWork.drive, "components.drive.recoveryWork.drive", error);
      validateRecoveryWork(components.drive.recoveryWork.maneuveringThrusters, "components.drive.recoveryWork.maneuveringThrusters", error);
    }
  }

  validateShield(components.shield, error, requireNumber);
  validateTiers(components.shield, "components.shield", "shield", error);
  validateSensor(components.sensor, error, requireNumber);
  validateTiers(components.sensor, "components.sensor", "sensor", error);
  validateCooling(components.cooling, error, requireNumber);
  validateTiers(components.cooling, "components.cooling", "cooling", error);

  const hardpoints = Array.isArray(config.hardpoints) ? config.hardpoints : [];
  if (!Array.isArray(config.hardpoints)) error("HARDPOINTS_REQUIRED", "hardpoints", "Hardpoints must be an array.");
  const hardpointById = new Map();
  hardpoints.forEach((hardpoint, index) => {
    const path = `hardpoints[${index}]`;
    if (!isObject(hardpoint)) {
      error("INVALID_HARDPOINT", path, "Hardpoint must be an object.");
      return;
    }
    if (requireString(hardpoint.id, `${path}.id`)) {
      if (hardpointById.has(hardpoint.id) || componentById.has(hardpoint.id)) {
        error("DUPLICATE_STABLE_ID", `${path}.id`, `Stable ID '${hardpoint.id}' is duplicated.`);
      } else hardpointById.set(hardpoint.id, hardpoint);
    }
    if (hardpoint.category !== "hardpoint") error("INVALID_WEAPON_CATEGORY", `${path}.category`, "Ordinary hardpoints must use category 'hardpoint'.");
    if (!MOUNT_SIZES.includes(hardpoint.mountSize)) error("INVALID_MOUNT_SIZE", `${path}.mountSize`, "Hardpoint mount size is invalid.");
    requireNumber(hardpoint.orientation, `${path}.orientation`);
  });

  const weapons = Array.isArray(components.weapons) ? components.weapons : [];
  if (!Array.isArray(components.weapons)) error("WEAPONS_REQUIRED", "components.weapons", "Weapons must be an array.");
  const weaponById = new Map();
  weapons.forEach((weapon, index) => {
    const path = `components.weapons[${index}]`;
    if (!isObject(weapon)) {
      error("INVALID_WEAPON", path, "Weapon must be an object.");
      return;
    }
    if (weapon.class !== "weapon") error("INVALID_COMPONENT_CLASS", `${path}.class`, "Weapon component class must be 'weapon'.");
    registerId(weapon, path, "weapon");
    if (typeof weapon.id === "string") weaponById.set(weapon.id, weapon);
    validateRegions(weapon.regions, `${path}.regions`, error);
    validateWeapon(weapon, path, hardpointById, error, requireNumber);
  });

  const installedWeaponIds = new Set();
  hardpoints.forEach((hardpoint, index) => {
    if (typeof hardpoint?.weaponId !== "string") return;
    if (installedWeaponIds.has(hardpoint.weaponId)) {
      error("DUPLICATE_WEAPON_INSTALLATION", `hardpoints[${index}].weaponId`, "A weapon cannot occupy more than one hardpoint.");
    }
    installedWeaponIds.add(hardpoint.weaponId);
    const weapon = weaponById.get(hardpoint.weaponId);
    if (!weapon) {
      error("UNKNOWN_INSTALLED_WEAPON", `hardpoints[${index}].weaponId`, "Hardpoint references an unknown weapon ID.");
    } else {
      if (weapon.hardpointId !== hardpoint.id) {
        error("INSTALLATION_MISMATCH", `hardpoints[${index}].weaponId`, "Hardpoint and weapon installation references disagree.");
      }
      if (weapon.category !== hardpoint.category || weapon.mountSize !== hardpoint.mountSize) {
        error("HARDPOINT_INCOMPATIBLE", `hardpoints[${index}].weaponId`, "Installed weapon category or mount size is incompatible.");
      }
    }
  });

  validatePowerConfig(config, weapons, error, requireNumber);
  validateOperators(config, componentById, hardpointById, error, requireString, requireNumber);
  validateCriticalPools(config, componentById, error, requireString, requireNumber);

  return { valid: errors.length === 0, errors, warnings };
}

function validateRegions(regions, path, error) {
  if (!Array.isArray(regions) || regions.length === 0) {
    error("REGIONS_REQUIRED", path, "Every installed component must have explicit region membership.");
    return;
  }
  const seen = new Set();
  for (const region of regions) {
    if (!SECTORS.includes(region)) error("INVALID_REGION", path, `Unknown region '${region}'.`);
    if (seen.has(region)) error("DUPLICATE_REGION", path, `Region '${region}' is duplicated.`);
    seen.add(region);
  }
}

function validateRecoveryWork(value, path, error) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value <= 0) {
    error("INVALID_RECOVERY_WORK", path, "Recovery Work must be a positive integer.");
  }
}

function validateTiers(component, path, kind, error) {
  if (!isObject(component)) return;
  const tiers = tierArray(component.tiers);
  if (tiers.length === 0) {
    error("POWER_TIERS_REQUIRED", `${path}.tiers`, "At least one Power tier is required.");
    return;
  }
  const powers = new Set();
  for (const [index, tier] of tiers.entries()) {
    const tierPath = `${path}.tiers[${index}]`;
    if (!isObject(tier) || !Number.isInteger(tier.power) || tier.power < 0) {
      error("INVALID_POWER_TIER", `${tierPath}.power`, "Power tier must be a nonnegative integer.");
      continue;
    }
    if (powers.has(tier.power)) error("DUPLICATE_POWER_TIER", `${tierPath}.power`, `Power tier ${tier.power} is duplicated.`);
    powers.add(tier.power);
    if (tier.overclockHeat !== undefined && (!isFiniteNumber(tier.overclockHeat) || tier.overclockHeat < 0)) {
      error("INVALID_COST", `${tierPath}.overclockHeat`, "Overclock Heat must be nonnegative.");
    }
    const numericByKind = {
      drive: ["multiplier"],
      shield: ["regeneration"],
      sensor: ["rangeMultiplier", "passiveStrength", "activeModifier"],
      cooling: ["cooling"],
    }[kind];
    for (const key of numericByKind) {
      if (!isFiniteNumber(tier[key]) || (key !== "activeModifier" && tier[key] < 0)) {
        error("INVALID_POWER_TIER", `${tierPath}.${key}`, `${key} must be ${key === "activeModifier" ? "finite" : "nonnegative"}.`);
      }
    }
  }
  if (!powers.has(0)) error("MISSING_ZERO_POWER_TIER", `${path}.tiers`, "Power tiers must define tier 0.");
}

function validateShield(shield, error, requireNumber) {
  if (!isObject(shield)) return;
  if (!SHIELD_TOPOLOGIES.includes(shield.topology)) error("INVALID_SHIELD_TOPOLOGY", "components.shield.topology", "Shield topology must be directional or bubble.");
  const expected = shield.topology === "bubble" ? ["bubble"] : SECTORS;
  if (!Array.isArray(shield.sectors) || shield.sectors.length !== expected.length || expected.some((sector) => !shield.sectors.includes(sector))) {
    error("INVALID_SHIELD_SECTORS", "components.shield.sectors", `Shield sectors must be exactly ${expected.join(", ")}.`);
  }
  requireNumber(shield.totalBudget, "components.shield.totalBudget", { min: 0, strict: true, integer: true });
  requireNumber(shield.sectorCap, "components.shield.sectorCap", { min: 0, strict: true, integer: true });
  requireNumber(shield.rechargeDelay, "components.shield.rechargeDelay", { min: 0, strict: true, integer: true });
  validateRecoveryWork(shield.recoveryWork, "components.shield.recoveryWork", error);
  if (Array.isArray(shield.emitters)) {
    const ids = new Set();
    for (const [index, emitter] of shield.emitters.entries()) {
      const path = `components.shield.emitters[${index}]`;
      if (!isObject(emitter) || typeof emitter.id !== "string" || emitter.id.trim() === "") error("REQUIRED_STRING", `${path}.id`, "Emitter ID must be a stable string.");
      else if (ids.has(emitter.id)) error("DUPLICATE_STABLE_ID", `${path}.id`, "Emitter ID is duplicated.");
      else ids.add(emitter.id);
      if (!expected.includes(emitter.sector)) error("INVALID_SHIELD_SECTOR", `${path}.sector`, "Emitter sector does not belong to this shield topology.");
      if (shield.topology === "directional") validateRegions(emitter.regions, `${path}.regions`, error);
    }
    if (shield.emitters.length !== expected.length) error("INVALID_EMITTER_CARDINALITY", "components.shield.emitters", "Shield must define one emitter per sector.");
  } else {
    error("EMITTERS_REQUIRED", "components.shield.emitters", "Shield emitters must be an array.");
  }
}

function validateSensor(sensor, error, requireNumber) {
  if (!isObject(sensor)) return;
  requireNumber(sensor.base?.passiveRange, "components.sensor.base.passiveRange", { min: 0, strict: true });
  requireNumber(sensor.base?.passiveStrength, "components.sensor.base.passiveStrength");
  requireNumber(sensor.base?.activeRange, "components.sensor.base.activeRange", { min: 0, strict: true });
  requireNumber(sensor.base?.activeModifier, "components.sensor.base.activeModifier");
  requireNumber(sensor.base?.ewModifier, "components.sensor.base.ewModifier");
  validateRecoveryWork(sensor.recoveryWork, "components.sensor.recoveryWork", error);
}

function validateCooling(cooling, error, requireNumber) {
  if (!isObject(cooling)) return;
  requireNumber(cooling.ventAmount, "components.cooling.ventAmount", { min: 0, strict: true });
  requireNumber(cooling.ventCooldown, "components.cooling.ventCooldown", { min: 0, integer: true });
  validateRecoveryWork(cooling.recoveryWork, "components.cooling.recoveryWork", error);
}

function validateWeapon(weapon, path, hardpointById, error, requireNumber) {
  if (!WEAPON_CATEGORIES.includes(weapon.category)) error("INVALID_WEAPON_CATEGORY", `${path}.category`, "Weapon category is invalid.");
  if (weapon.category === "hardpoint") {
    if (!MOUNT_SIZES.includes(weapon.mountSize)) error("INVALID_MOUNT_SIZE", `${path}.mountSize`, "Hardpoint weapon requires a valid mount size.");
    const hardpoint = hardpointById.get(weapon.hardpointId);
    if (!hardpoint) {
      error("HARDPOINT_REQUIRED", `${path}.hardpointId`, "Hardpoint weapon must reference an installed hardpoint.");
    } else {
      if (hardpoint.mountSize !== weapon.mountSize) {
        error("HARDPOINT_INCOMPATIBLE", `${path}.mountSize`, "Weapon mount size does not match its hardpoint.");
      }
      if (hardpoint.weaponId !== weapon.id) {
        error("INSTALLATION_MISMATCH", `${path}.hardpointId`, "Weapon and hardpoint installation references disagree.");
      }
    }
  }
  requireNumber(weapon.accuracy, `${path}.accuracy`);
  for (const channel of ["shield", "hull", "heat"]) requireNumber(weapon.damage?.[channel], `${path}.damage.${channel}`, { min: 0 });
  requireNumber(weapon.armorPiercing, `${path}.armorPiercing`, { min: 0 });
  if (!PROJECTILE_CLASSES.includes(weapon.projectileClass)) error("INVALID_PROJECTILE_CLASS", `${path}.projectileClass`, "Projectile class is invalid.");
  requireNumber(weapon.range?.optimal, `${path}.range.optimal`, { min: 0 });
  requireNumber(weapon.range?.maximum, `${path}.range.maximum`, { min: 0 });
  if (isFiniteNumber(weapon.range?.optimal) && isFiniteNumber(weapon.range?.maximum) && weapon.range.optimal > weapon.range.maximum) {
    error("INVALID_WEAPON_RANGE", `${path}.range`, "Optimal range cannot exceed maximum range.");
  }
  requireNumber(weapon.arc, `${path}.arc`, { min: 0, strict: true });
  if (isFiniteNumber(weapon.arc) && weapon.arc > 360) error("INVALID_WEAPON_ARC", `${path}.arc`, "Weapon arc cannot exceed 360 degrees.");
  requireNumber(weapon.powerRating, `${path}.powerRating`, { min: 0, integer: true });
  requireNumber(weapon.bootTime, `${path}.bootTime`, { min: 0, integer: true });
  validateFiringHeat(weapon.firingHeat, `${path}.firingHeat`, error);
  requireNumber(weapon.signatureSpike, `${path}.signatureSpike`);
  validateRecoveryWork(weapon.recoveryWork, `${path}.recoveryWork`, error);
  validateReadiness(weapon.readiness, `${path}.readiness`, error);
  validateTraits(weapon.traits, `${path}.traits`, error);
  validateModes(weapon.modes, path, error);
}

function validateFiringHeat(value, path, error) {
  if (!isObject(value) || !isFiniteNumber(value.amount) || value.amount < 0 || !["shot", "physicalRound"].includes(value.per)) {
    error("INVALID_FIRING_HEAT", path, "Firing Heat requires a nonnegative amount and shot/physicalRound unit.");
  }
}

function validateReadiness(readiness, path, error) {
  if (!isObject(readiness)) {
    error("READINESS_REQUIRED", path, "Weapon readiness profile is required.");
    return;
  }
  if (!READINESS_TYPES.includes(readiness.type)) error("INVALID_READINESS_TYPE", `${path}.type`, "Readiness type is invalid.");
  if (!Number.isInteger(readiness.capacity) || readiness.capacity <= 0) error("INVALID_READINESS_CAPACITY", `${path}.capacity`, "Readiness capacity must be a positive integer.");
  if (!READINESS_RECOVERY.includes(readiness.recovery)) error("INVALID_READINESS_RECOVERY", `${path}.recovery`, "Readiness recovery is invalid.");
  if (readiness.recovery === "automaticStart" && (!Number.isInteger(readiness.eligibleStarts) || readiness.eligibleStarts <= 0)) {
    error("INCOMPLETE_READINESS", `${path}.eligibleStarts`, "Automatic recovery requires a positive eligible-Start count.");
  }
  if (readiness.recovery === "manualWork" && (!Number.isInteger(readiness.work) || readiness.work <= 0)) {
    error("INCOMPLETE_READINESS", `${path}.work`, "Manual recovery requires positive Work.");
  }
}

function validateModes(modes, path, error) {
  if (!isObject(modes) || !isObject(modes.nominal)) {
    error("NOMINAL_MODE_REQUIRED", `${path}.modes.nominal`, "Weapon must define its nominal mode.");
    return;
  }
  if (modes.overclock === undefined) return;
  if (!isObject(modes.overclock) || !isObject(modes.overclock.overrides)) {
    error("INVALID_OVERCLOCK_MODE", `${path}.modes.overclock`, "Overclock mode must define an overrides object.");
    return;
  }
  const overrides = modes.overclock.overrides;
  for (const key of ["powerRating", "accuracy", "armorPiercing", "bootTime"]) {
    if (overrides[key] !== undefined && (!isFiniteNumber(overrides[key]) || (["powerRating", "armorPiercing", "bootTime"].includes(key) && overrides[key] < 0))) {
      error("INVALID_MODE_VALUE", `${path}.modes.overclock.overrides.${key}`, `${key} override is invalid.`);
    }
  }
  if (overrides.damage !== undefined) {
    if (!isObject(overrides.damage)) error("INVALID_MODE_VALUE", `${path}.modes.overclock.overrides.damage`, "Damage override must be an object.");
    else for (const [channel, value] of Object.entries(overrides.damage)) {
      if (!["shield", "hull", "heat"].includes(channel) || !isFiniteNumber(value) || value < 0) error("INVALID_MODE_VALUE", `${path}.modes.overclock.overrides.damage.${channel}`, "Damage override is invalid.");
    }
  }
  if (overrides.firingHeat !== undefined) validateFiringHeat(overrides.firingHeat, `${path}.modes.overclock.overrides.firingHeat`, error);
}

function validateTraits(traits, path, error) {
  if (!Array.isArray(traits)) {
    error("TRAITS_REQUIRED", path, "Weapon traits must be an array.");
    return;
  }
  const seen = new Set();
  traits.forEach((trait, index) => {
    const traitPath = `${path}[${index}]`;
    if (!isObject(trait) || typeof trait.id !== "string" || trait.id.trim() === "") {
      error("INVALID_TRAIT", traitPath, "Trait must have a stable ID.");
      return;
    }
    if (seen.has(trait.id)) error("DUPLICATE_TRAIT", `${traitPath}.id`, `Trait '${trait.id}' is duplicated.`);
    seen.add(trait.id);
    if (RESERVED_INCOMPLETE_TRAITS.includes(trait.id)) {
      error("RESERVED_INCOMPLETE_TRAIT", `${traitPath}.id`, `Trait '${trait.id}' has no complete V1 rule and cannot be active.`);
      return;
    }
    if (!SUPPORTED_TRAITS.includes(trait.id)) {
      error("UNSUPPORTED_TRAIT", `${traitPath}.id`, `Trait '${trait.id}' is not supported for automated play.`);
      return;
    }
    if (trait.id === TRAIT_IDS.shieldBypass) {
      if (!Array.isArray(trait.channels) || trait.channels.length === 0 || trait.channels.some((channel) => !["hull", "heat"].includes(channel))) {
        error("INCOMPLETE_TRAIT_PARAMETERS", `${traitPath}.channels`, "Shield Bypass must name one or more Hull/Heat channels.");
      }
    }
    if (trait.id === TRAIT_IDS.barrage) validateBarrageProfiles(trait.profiles, `${traitPath}.profiles`, error);
  });
}

function validateBarrageProfiles(profiles, path, error) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    error("INCOMPLETE_TRAIT_PARAMETERS", path, "Barrage requires at least one complete profile.");
    return;
  }
  const rounds = new Set();
  profiles.forEach((profile, index) => {
    const profilePath = `${path}[${index}]`;
    if (!isObject(profile) || !Number.isInteger(profile.rounds) || profile.rounds <= 0 || !isFiniteNumber(profile.attackPenalty) || !Number.isInteger(profile.maxEffectiveHits) || profile.maxEffectiveHits <= 0) {
      error("INCOMPLETE_TRAIT_PARAMETERS", profilePath, "Barrage profile requires positive rounds/hit cap and a finite attack penalty.");
      return;
    }
    if (rounds.has(profile.rounds)) error("DUPLICATE_BARRAGE_PROFILE", `${profilePath}.rounds`, "Barrage round count is duplicated.");
    rounds.add(profile.rounds);
  });
}

function validatePowerConfig(config, weapons, error, requireNumber) {
  const presetIds = new Set();
  if (!Array.isArray(config.powerPresets)) error("POWER_PRESETS_REQUIRED", "powerPresets", "Power presets must be an array.");
  else config.powerPresets.forEach((preset, index) => {
    const path = `powerPresets[${index}]`;
    if (!isObject(preset)) {
      error("INVALID_POWER_PRESET", path, "Power preset must be an object.");
      return;
    }
    if (typeof preset.id !== "string" || preset.id.trim() === "") {
      error("REQUIRED_STRING", `${path}.id`, "Preset ID must be stable.");
    } else if (presetIds.has(preset.id)) {
      error("DUPLICATE_STABLE_ID", `${path}.id`, `Preset ID '${preset.id}' is duplicated.`);
    } else {
      presetIds.add(preset.id);
    }
    if (typeof preset.label !== "string" || preset.label.trim() === "") error("REQUIRED_STRING", `${path}.label`, "Preset label is required.");
    let total = 0;
    for (const system of POWER_SYSTEMS) {
      const value = preset.allocations?.[system];
      requireNumber(value, `${path}.allocations.${system}`, { min: 0, integer: true });
      if (isFiniteNumber(value)) total += value;
      if (system !== "weapons" && Number.isInteger(value)) {
        const componentName = { engines: "drive", shields: "shield", sensors: "sensor", cooling: "cooling" }[system];
        const powers = new Set(tierArray(config.components?.[componentName]?.tiers).map((tier) => tier.power));
        if (!powers.has(value)) error("UNSUPPORTED_POWER_TIER", `${path}.allocations.${system}`, `No ${system} tier exists at Power ${value}.`);
      }
    }
    const redline = config.components?.reactor?.redlineOutput;
    if (isFiniteNumber(redline) && total > redline) error("POWER_PRESET_EXCEEDS_REACTOR", `${path}.allocations`, "Preset exceeds reactor Redline output.");
    const maxWeapons = weapons.reduce((sum, weapon) => {
      const overclock = weapon.modes?.overclock?.overrides?.powerRating;
      return sum + Math.max(weapon.powerRating ?? 0, overclock ?? 0);
    }, 0);
    if (isFiniteNumber(preset.allocations?.weapons) && preset.allocations.weapons > maxWeapons) {
      error("WEAPONS_POWER_EXCEEDS_LOADOUT", `${path}.allocations.weapons`, "Weapons allocation exceeds all supported weapon reservations.");
    }
  });

  validatePriority(config.sheddingPriority, POWER_SYSTEMS, "sheddingPriority", error);
  validatePriority(config.weaponPriority, weapons.map((weapon) => weapon.id), "weaponPriority", error);
}

function validatePriority(priority, expected, path, error) {
  if (!Array.isArray(priority) || priority.length !== expected.length || new Set(priority).size !== expected.length || expected.some((id) => !priority.includes(id))) {
    error("INVALID_PRIORITY", path, "Priority must contain every eligible stable ID exactly once.");
  }
}

function validateOperators(config, componentById, hardpointById, error, requireString, requireNumber) {
  if (!Array.isArray(config.operators)) {
    error("OPERATORS_REQUIRED", "operators", "Operators must be an array.");
    return;
  }
  const ids = new Set([...componentById.keys(), ...hardpointById.keys()]);
  const assignments = { command: new Set(), crew: new Set() };
  config.operators.forEach((operator, index) => {
    const path = `operators[${index}]`;
    if (!isObject(operator)) {
      error("INVALID_OPERATOR", path, "Operator must be an object.");
      return;
    }
    if (requireString(operator.id, `${path}.id`)) {
      if (ids.has(operator.id)) error("DUPLICATE_STABLE_ID", `${path}.id`, `Stable ID '${operator.id}' is duplicated.`);
      ids.add(operator.id);
    }
    requireString(operator.label, `${path}.label`);
    if (!OPERATOR_TYPES.includes(operator.type)) error("INVALID_OPERATOR_TYPE", `${path}.type`, "Operator type is invalid.");
    for (const rating of ["piloting", "gunnery", "sensors", "engineering"]) {
      requireNumber(operator.ratings?.[rating], `${path}.ratings.${rating}`, { min: 1, integer: true });
      if (isFiniteNumber(operator.ratings?.[rating]) && operator.ratings[rating] > 10) error("INVALID_OPERATOR_RATING", `${path}.ratings.${rating}`, "Operator ratings cannot exceed 10.");
    }
    const assignment = operator.defaultAssignment;
    if (assignment !== undefined) {
      if (!isObject(assignment) || !["command", "crew"].includes(assignment.kind) || !Number.isInteger(assignment.slot) || assignment.slot < 0) {
        error("INVALID_DEFAULT_ASSIGNMENT", `${path}.defaultAssignment`, "Default assignment requires command/crew kind and a nonnegative slot.");
      } else {
        const capacity = assignment.kind === "command" ? config.commandCapacity : config.crewCapacity;
        if (assignment.slot >= capacity) error("DEFAULT_ASSIGNMENT_EXCEEDS_CAPACITY", `${path}.defaultAssignment.slot`, "Default assignment exceeds ship capacity.");
        if (assignments[assignment.kind].has(assignment.slot)) error("DUPLICATE_DEFAULT_ASSIGNMENT", `${path}.defaultAssignment.slot`, "Default assignment slot is occupied twice.");
        assignments[assignment.kind].add(assignment.slot);
      }
    }
  });
}

function validateCriticalPools(config, componentById, error, requireString, requireNumber) {
  if (!isObject(config.criticalPools)) {
    error("CRITICAL_POOLS_REQUIRED", "criticalPools", "Critical pools must define all four regions.");
    return;
  }
  for (const region of SECTORS) {
    const pool = config.criticalPools[region];
    const path = `criticalPools.${region}`;
    if (!Array.isArray(pool) || pool.length === 0) {
      error("CRITICAL_POOL_REQUIRED", path, "Each region requires a non-empty critical pool.");
      continue;
    }
    const ids = new Set();
    for (const [index, entry] of pool.entries()) {
      const entryPath = `${path}[${index}]`;
      if (!isObject(entry)) {
        error("INVALID_CRITICAL_ENTRY", entryPath, "Critical entry must be an object.");
        continue;
      }
      if (requireString(entry.id, `${entryPath}.id`)) {
        if (ids.has(entry.id)) error("DUPLICATE_CRITICAL_ENTRY", `${entryPath}.id`, "Critical entry is duplicated within its region.");
        ids.add(entry.id);
      }
      requireNumber(entry.weight, `${entryPath}.weight`, { min: 0, strict: true });
      if (entry.kind === "fault") {
        const target = componentById.get(entry.componentId);
        if (!target) {
          error("UNKNOWN_CRITICAL_COMPONENT", `${entryPath}.componentId`, "Fault entry references an unknown component.");
        } else {
          if (!FAULT_CHANNELS[target.kind]?.has(entry.channelId)) {
            error("INVALID_FAULT_CHANNEL", `${entryPath}.channelId`, "Fault channel is incompatible with its component class.");
          }
          if (!target.item.regions?.includes(region)) {
            error("CRITICAL_REGION_MISMATCH", `${entryPath}.componentId`, "Fault target is not a member of this region.");
          }
        }
        if (entry.channelId === "shieldEmitterDamage") {
          if (entry.sector !== region) error("INVALID_CRITICAL_SECTOR", `${entryPath}.sector`, "Shield-emitter Fault must name its struck region.");
        } else if (entry.sector !== null) error("INVALID_CRITICAL_SECTOR", `${entryPath}.sector`, "This Fault is shared and must not have a sector identity.");
      } else if (entry.kind === "hazard") {
        if (entry.componentId !== null) error("INVALID_HAZARD_COMPONENT", `${entryPath}.componentId`, "Hazards are not component-owned.");
        if (!HAZARD_CHANNELS.has(entry.channelId)) error("INVALID_HAZARD_CHANNEL", `${entryPath}.channelId`, "Hazard channel is invalid.");
        if (["fire", "breach"].includes(entry.channelId)) {
          if (entry.sector !== region) error("INVALID_CRITICAL_SECTOR", `${entryPath}.sector`, "Regional Hazard must name its pool region.");
        } else if (entry.sector !== null) error("INVALID_CRITICAL_SECTOR", `${entryPath}.sector`, "Ship-wide Hazard must have null sector identity.");
      } else {
        error("INVALID_CRITICAL_KIND", `${entryPath}.kind`, "Critical entry kind must be fault or hazard.");
      }
    }
  }
}

