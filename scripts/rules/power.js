import {
  POWER_SYSTEMS,
  RuleViolation,
  WEAPON_MODES,
  WEAPON_STATUSES,
} from "../constants.js";

const FALLBACK_POWER_SYSTEMS = Object.freeze([
  "engines",
  "shields",
  "sensors",
  "cooling",
  "weapons",
]);
const FALLBACK_WEAPON_STATUSES = Object.freeze(["off", "booting", "online"]);
const FALLBACK_WEAPON_MODES = Object.freeze(["nominal", "overclock"]);
const FAULT_RANK = Object.freeze({
  healthy: 0,
  minor: 1,
  major: 2,
  critical: 3,
  destroyed: 4,
  catastrophic: 4,
});
const REACTOR_MULTIPLIER = Object.freeze({
  healthy: 1,
  minor: 0.8,
  major: 0.5,
  critical: 0.2,
  destroyed: 0,
  catastrophic: 0,
});
const CASCADE_PENALTY = Object.freeze({
  healthy: 0,
  minor: 1,
  major: 2,
  critical: 4,
  destroyed: 6,
  catastrophic: 6,
});
const INSTABILITY_PENALTY = Object.freeze({
  healthy: 0,
  minor: 0,
  major: 1,
  critical: 2,
  destroyed: 3,
  catastrophic: 3,
});

function violation(code, message, details = {}) {
  throw new RuleViolation(code, message, details);
}

function severityOf(value) {
  const severity = String(value ?? "healthy").toLowerCase();
  return Object.hasOwn(FAULT_RANK, severity) ? severity : "healthy";
}

function conditionChannel(condition) {
  if (condition.conditionId) return condition.conditionId;
  if (condition.channel) return condition.channel;
  if (condition.type !== "fault" && condition.type !== "hazard") return condition.type;
  return condition.name ?? condition.id;
}

function conditionsFor(state, channel) {
  return Object.values(state.conditions ?? {}).filter(
    (condition) => condition && conditionChannel(condition) === channel,
  );
}

function highestSeverity(state, channel, predicate = () => true) {
  let result = "healthy";
  for (const condition of conditionsFor(state, channel)) {
    const severity = severityOf(condition.severity);
    if (predicate(condition) && FAULT_RANK[severity] > FAULT_RANK[result]) result = severity;
  }
  return result;
}

function flatPenalty(state, channel, table) {
  return conditionsFor(state, channel).reduce(
    (total, condition) => total + table[severityOf(condition.severity)],
    0,
  );
}

function componentForSystem(config, system) {
  if (system === "engines") return config?.powerSystems?.engines;
  const components = config?.components ?? {};
  if (system === "shields") return components.shield;
  if (system === "sensors") return components.sensor;
  if (system === "cooling") return components.cooling;
  return null;
}

function systemInstalled(config, system) {
  const components = config?.components ?? {};
  if (system === "engines") return Object.values(components.drives ?? {}).some(Boolean);
  if (system === "shields") return Boolean(components.shield);
  if (system === "sensors") return Boolean(components.sensor);
  if (system === "cooling") return Boolean(components.cooling);
  return true;
}

function missingSystem(config, system, power) {
  if (power === 0 || systemInstalled(config, system)) return false;
  const code = {
    engines: "MISSING_ENGINES",
    shields: "MISSING_SHIELD",
    sensors: "MISSING_SENSOR",
    cooling: "MISSING_COOLING",
  }[system];
  violation(code, `Ship has no installed ${system} hardware`, { system, power });
}

function systemNames() {
  return Array.isArray(POWER_SYSTEMS) && POWER_SYSTEMS.length
    ? [...POWER_SYSTEMS]
    : [...FALLBACK_POWER_SYSTEMS];
}

function weaponStatuses() {
  return Array.isArray(WEAPON_STATUSES) && WEAPON_STATUSES.length
    ? WEAPON_STATUSES
    : FALLBACK_WEAPON_STATUSES;
}

function weaponModes() {
  return Array.isArray(WEAPON_MODES) && WEAPON_MODES.length
    ? WEAPON_MODES
    : FALLBACK_WEAPON_MODES;
}

function weaponConfigs(config) {
  return config.components?.weapons ?? [];
}

function weaponConfig(config, weaponId) {
  const weapon = weaponConfigs(config).find((candidate) => candidate.id === weaponId);
  if (!weapon) violation("UNKNOWN_WEAPON", `Unknown weapon: ${weaponId}`, { weaponId });
  return weapon;
}

function weaponPowerRating(weapon, mode) {
  if (mode === "overclock") {
    const rating = weapon.modes?.overclock?.overrides?.powerRating;
    if (rating == null) {
      violation("WEAPON_OVERCLOCK_UNAVAILABLE", `Weapon ${weapon.id} has no overclock mode`, {
        weaponId: weapon.id,
      });
    }
    return rating;
  }
  return weapon.powerRating;
}

function validateNonnegativeInteger(value, code, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    violation(code, `${field} must be a nonnegative integer`, { field, value });
  }
}

function tierFor(config, system, power, { passive = false } = {}) {
  if (system === "weapons") return { power };
  if (!systemInstalled(config, system)) {
    if (power > 0 && !passive) missingSystem(config, system, power);
    return { power, online: false, overclock: false };
  }
  const component = componentForSystem(config, system);
  const tier = component?.tiers?.find((candidate) => candidate.power === power);
  if (!tier) {
    violation("INVALID_POWER_TIER", `${system} has no Power ${power} tier`, { system, power });
  }
  return tier;
}

function lowerTier(config, system, power) {
  if (system === "weapons") return power > 0 ? power - 1 : null;
  if (!systemInstalled(config, system)) return power > 0 ? 0 : null;
  const powers = (componentForSystem(config, system)?.tiers ?? [])
    .map((tier) => tier.power)
    .filter((candidate) => Number.isSafeInteger(candidate) && candidate < power)
    .sort((a, b) => b - a);
  return powers[0] ?? null;
}

function currentAllocation(state) {
  const allocation = {};
  for (const system of systemNames()) allocation[system] = state.power?.[system] ?? 0;
  return allocation;
}

function totalPower(allocation) {
  return systemNames().reduce((total, system) => total + allocation[system], 0);
}
function emissionState(config, committed) {
  const reactor = config?.components?.reactor;
  const nominal = reactor?.nominalOutput ?? 0;
  if (reactor) validateNonnegativeInteger(nominal, "INVALID_REACTOR_OUTPUT", "nominalOutput");
  const fraction = nominal === 0 ? (committed === 0 ? 0 : Infinity) : committed / nominal;
  let band;
  let signatureModifier;
  if (fraction <= 0.25) {
    band = "dark";
    signatureModifier = 4;
  } else if (fraction <= 0.45) {
    band = "minimal";
    signatureModifier = 3;
  } else if (fraction <= 0.7) {
    band = "reduced";
    signatureModifier = 1;
  } else if (fraction <= 0.9) {
    band = "normal";
    signatureModifier = 0;
  } else if (fraction <= 1) {
    band = "high";
    signatureModifier = -2;
  } else {
    band = "redline";
    signatureModifier = -4;
  }
  return {
    healthyNominal: nominal,
    fraction,
    percent: fraction * 100,
    band,
    signatureModifier,
    powerAdjustedSignature: (config?.baseSignature ?? 0) + signatureModifier,
  };
}

function currentWeaponState(state, weaponId) {
  return state.weapons?.[weaponId] ?? {
    status: "off",
    mode: "nominal",
    bootCounter: 0,
  };
}

function mergedWeaponStates(config, state, stagedWeapons) {
  const result = {};
  for (const weapon of weaponConfigs(config)) {
    const current = currentWeaponState(state, weapon.id);
    const staged = stagedWeapons?.[weapon.id];
    if (typeof staged === "string") {
      if (staged === "off" || staged === "booting" || staged === "online") {
        result[weapon.id] = { ...current, status: staged };
      } else {
        result[weapon.id] = { ...current, mode: staged };
      }
    } else {
      result[weapon.id] = { ...current, ...(staged ?? {}) };
    }
    if (result[weapon.id].status === "off") {
      result[weapon.id].mode = "nominal";
      result[weapon.id].bootCounter = 0;
    }
  }
  return result;
}

function weaponFaultSeverity(state, weaponId) {
  return highestSeverity(
    state,
    "weaponMalfunction",
    (condition) =>
      condition.targetId === weaponId ||
      condition.componentId === weaponId ||
      condition.weaponId === weaponId,
  );
}

function validateWeaponStates(config, state, states) {
  let reserved = 0;
  const reservations = {};
  for (const weapon of weaponConfigs(config)) {
    const weaponState = states[weapon.id];
    if (!weaponStatuses().includes(weaponState.status)) {
      violation("INVALID_WEAPON_STATUS", `Invalid status for weapon ${weapon.id}`, {
        weaponId: weapon.id,
        status: weaponState.status,
      });
    }
    if (!weaponModes().includes(weaponState.mode)) {
      violation("INVALID_WEAPON_MODE", `Invalid mode for weapon ${weapon.id}`, {
        weaponId: weapon.id,
        mode: weaponState.mode,
      });
    }
    validateNonnegativeInteger(
      weaponState.bootCounter ?? 0,
      "INVALID_BOOT_COUNTER",
      `${weapon.id}.bootCounter`,
    );
    if (weaponState.status === "booting" && weaponState.bootCounter <= 0) {
      violation("INVALID_BOOT_COUNTER", `Booting weapon ${weapon.id} needs a positive counter`, {
        weaponId: weapon.id,
        bootCounter: weaponState.bootCounter,
      });
    }
    if (weaponState.status === "online" && weaponState.bootCounter !== 0) {
      violation("INVALID_BOOT_COUNTER", `Online weapon ${weapon.id} must have counter 0`, {
        weaponId: weapon.id,
        bootCounter: weaponState.bootCounter,
      });
    }
    if (weaponState.mode === "overclock") {
      if (weaponState.status !== "online") {
        violation("WEAPON_OVERCLOCK_REQUIRES_ONLINE", `Weapon ${weapon.id} is not Online`, {
          weaponId: weapon.id,
          status: weaponState.status,
        });
      }
      if (FAULT_RANK[weaponFaultSeverity(state, weapon.id)] >= FAULT_RANK.major) {
        violation("WEAPON_OVERCLOCK_BLOCKED", `Weapon ${weapon.id} cannot Overclock`, {
          weaponId: weapon.id,
        });
      }
    }
    const rating = weaponPowerRating(weapon, weaponState.mode);
    validateNonnegativeInteger(rating, "INVALID_WEAPON_POWER", `${weapon.id}.powerRating`);
    const reservation = weaponState.status === "off" ? 0 : rating;
    reservations[weapon.id] = reservation;
    reserved += reservation;
  }
  return { reserved, reservations };
}
function validateStagedWeaponTransitions(config, state, stagedWeapons, states) {
  if (!stagedWeapons) return;
  for (const weapon of weaponConfigs(config)) {
    if (stagedWeapons[weapon.id] == null) continue;
    const before = currentWeaponState(state, weapon.id);
    const after = states[weapon.id];
    if (before.status === "off" && after.status !== "off") {
      violation(
        "WEAPON_TOGGLE_REQUIRED",
        `Route Power cannot bypass ${weapon.id}'s weapon boot sequence`,
        { weaponId: weapon.id, from: before.status, to: after.status },
      );
    }
    if (before.status === "booting" && after.status === "online") {
      violation(
        "WEAPON_BOOT_INCOMPLETE",
        `Route Power cannot complete ${weapon.id}'s boot sequence`,
        { weaponId: weapon.id, bootCounter: before.bootCounter },
      );
    }
  }
}

function reactorCeilings(config, state) {
  const reactor = config?.components?.reactor;
  if (!reactor) {
    return {
      nominal: 0,
      redline: 0,
      maximum: 0,
      redlineAvailable: false,
      fault: "healthy",
      multiplier: 0,
      flatPenalty: 0,
    };
  }
  validateNonnegativeInteger(reactor.nominalOutput, "INVALID_REACTOR_OUTPUT", "nominalOutput");
  validateNonnegativeInteger(reactor.redlineOutput, "INVALID_REACTOR_OUTPUT", "redlineOutput");
  const fault = highestSeverity(
    state,
    "reactorFault",
    (condition) => (condition.componentId ?? condition.targetId) === reactor.id,
  );
  const multiplier = REACTOR_MULTIPLIER[fault];
  const penalty =
    flatPenalty(state, "electricalCascade", CASCADE_PENALTY) +
    flatPenalty(state, "reactorInstability", INSTABILITY_PENALTY);
  const nominal = Math.max(0, Math.floor(reactor.nominalOutput * multiplier) - penalty);
  let redline = Math.max(0, Math.floor(reactor.redlineOutput * multiplier) - penalty);
  const redlineAvailable = FAULT_RANK[fault] < FAULT_RANK.major;
  if (!redlineAvailable) redline = nominal;
  if (redline < nominal) redline = nominal;
  return { nominal, redline, maximum: redline, redlineAvailable, fault, multiplier, flatPenalty: penalty };
}

function stagedAllocation(config, state, staged) {
  const source = staged?.power ?? staged?.allocation ?? staged ?? {};
  const allocation = currentAllocation(state);
  for (const system of systemNames()) {
    if (source[system] != null && typeof source[system] !== "object") allocation[system] = source[system];
    validateNonnegativeInteger(allocation[system], "INVALID_POWER_ALLOCATION", system);
    missingSystem(config, system, allocation[system]);
    tierFor(config, system, allocation[system]);
  }
  return allocation;
}

function stagedWeaponInput(staged) {
  return (
    staged?.weaponStates ??
    staged?.weaponModes ??
    (staged?.weapons && typeof staged.weapons === "object" ? staged.weapons : null)
  );
}
function validatePriority(value, expected, field) {
  if (!Array.isArray(value) || value.length !== expected.length
    || new Set(value).size !== expected.length
    || value.some((entry) => !expected.includes(entry))) {
    violation("INVALID_POWER_PRIORITY", `${field} must contain every eligible entry exactly once`, {
      field,
      value,
      expected,
    });
  }
  return [...value];
}

function stagedPriorities(config, state, staged) {
  const systems = systemNames();
  const weaponIds = weaponConfigs(config).map((weapon) => weapon.id);
  return {
    sheddingPriority: validatePriority(
      staged?.sheddingPriority ?? state?.sheddingPriority ?? config?.sheddingPriority ?? systems,
      systems,
      "sheddingPriority",
    ),
    weaponPriority: validatePriority(
      staged?.weaponPriority ?? state?.weaponPriority ?? config?.weaponPriority ?? weaponIds,
      weaponIds,
      "weaponPriority",
    ),
  };
}

function stagedPreset(config, staged, allocation) {
  if (staged?.powerPresetId == null || staged.powerPresetId === "") return null;
  const preset = (config?.powerPresets ?? []).find((candidate) => candidate.id === staged.powerPresetId);
  if (!preset) violation("UNKNOWN_POWER_PRESET", `Unknown Power preset: ${staged.powerPresetId}`, { powerPresetId: staged.powerPresetId });
  if (systemNames().some((system) => allocation[system] !== preset.allocations?.[system])) {
    violation("POWER_PRESET_MISMATCH", "The staged allocation does not match the selected Power preset.", {
      powerPresetId: preset.id,
      allocation,
    });
  }
  return preset.id;
}

function enteringOverclockHeat(config, beforeAllocation, afterAllocation, beforeRedlining, afterRedlining) {
  const entries = [];
  let heat = 0;
  for (const system of ["engines", "shields", "sensors", "cooling"]) {
    const before = tierFor(config, system, beforeAllocation[system], { passive: true });
    const after = tierFor(config, system, afterAllocation[system]);
    if (!before.overclock && after.overclock) {
      const amount = after.overclockHeat ?? componentForSystem(config, system)?.overclockHeat ?? 0;
      if (amount > 0) {
        heat += amount;
        entries.push({ system, heat: amount });
      }
    }
  }
  if (!beforeRedlining && afterRedlining) {
    const amount = config?.components?.reactor?.overclockHeat ?? 0;
    if (amount > 0) {
      heat += amount;
      entries.push({ system: "reactor", heat: amount });
    }
  }
  return { heat, entries };
}

export function getPowerState(config, state) {
  const allocation = currentAllocation(state);
  for (const system of systemNames()) {
    validateNonnegativeInteger(allocation[system], "INVALID_POWER_ALLOCATION", system);
    tierFor(config, system, allocation[system], { passive: true });
  }
  const ceilings = reactorCeilings(config, state);
  const weapons = mergedWeaponStates(config, state, null);
  const { reserved: weaponReserved, reservations: weaponReservations } = validateWeaponStates(
    config,
    state,
    weapons,
  );
  const committed = totalPower(allocation);
  return {
    allocation,
    committed,
    unused: Math.max(0, ceilings.maximum - committed),
    legal:
      committed <= ceilings.maximum &&
      weaponReserved <= allocation.weapons &&
      systemNames().every((system) => systemInstalled(config, system) || allocation[system] === 0),
    redlining: committed > ceilings.nominal,
    emission: emissionState(config, committed),
    ceilings,
    weaponReserved,
    weaponReservations,
  };
}

export function previewPowerRoute(config, state, staged) {
  const allocation = stagedAllocation(config, state, staged);
  const stagedWeapons = stagedWeaponInput(staged);
  const weaponStates = mergedWeaponStates(config, state, stagedWeapons);
  validateStagedWeaponTransitions(config, state, stagedWeapons, weaponStates);
  const { reserved: weaponReserved, reservations: weaponReservations } = validateWeaponStates(
    config,
    state,
    weaponStates,
  );
  if (weaponReserved > allocation.weapons) {
    violation("WEAPONS_POWER_EXCEEDED", "Weapon reservations exceed routed Weapons Power", {
      reserved: weaponReserved,
      capacity: allocation.weapons,
    });
  }
  const ceilings = reactorCeilings(config, state);
  const committed = totalPower(allocation);
  if (committed > ceilings.maximum) {
    violation("REACTOR_CAPACITY_EXCEEDED", "Committed Power exceeds current reactor capacity", {
      committed,
      maximum: ceilings.maximum,
    });
  }
  const priorities = stagedPriorities(config, state, staged);
  const powerPresetId = stagedPreset(config, staged, allocation);
  const beforeAllocation = currentAllocation(state);
  const beforeRedlining = state.power?.redlining ?? totalPower(beforeAllocation) > ceilings.nominal;
  const redlining = committed > ceilings.nominal;
  const entered = enteringOverclockHeat(
    config,
    beforeAllocation,
    allocation,
    beforeRedlining,
    redlining,
  );
  return {
    allocation,
    weaponStates,
    weaponReservations,
    weaponReserved,
    committed,
    unused: ceilings.maximum - committed,
    ceilings,
    redlining,
    emission: emissionState(config, committed),
    heatAdded: entered.heat,
    overclockEntries: entered.entries,
    powerPresetId,
    ...priorities,
    tierChanges: systemNames()
      .filter((system) => beforeAllocation[system] !== allocation[system])
      .map((system) => ({ system, from: beforeAllocation[system], to: allocation[system] })),
  };
}

export function commitPowerRoute(config, state, staged) {
  const result = previewPowerRoute(config, state, staged);
  state.power ??= {};
  for (const system of systemNames()) state.power[system] = result.allocation[system];
  state.power.redlining = result.redlining;
  state.weapons ??= {};
  for (const [weaponId, next] of Object.entries(result.weaponStates)) {
    state.weapons[weaponId] ??= {};
    Object.assign(state.weapons[weaponId], next);
  }
  state.powerPresetId = result.powerPresetId;
  state.sheddingPriority = result.sheddingPriority;
  state.weaponPriority = result.weaponPriority;
  if (result.heatAdded) state.heat = Math.max(0, (state.heat ?? 0) + result.heatAdded);
  return result;
}

function orderedSheddingSystems(config, state) {
  const systems = systemNames();
  const configured = (state?.sheddingPriority ?? config?.sheddingPriority ?? []).filter((system) => systems.includes(system));
  const missing = systems.filter((system) => !configured.includes(system)).sort();
  return [...configured, ...missing].reverse();
}

function orderedWeaponIds(config, state) {
  const ids = weaponConfigs(config).map((weapon) => weapon.id);
  const configured = (state?.weaponPriority ?? config.weaponPriority ?? []).filter((id) => ids.includes(id));
  const missing = ids.filter((id) => !configured.includes(id)).sort();
  return [...configured, ...missing];
}

function shedWeaponsToCapacity(config, state, capacity, events) {
  const states = mergedWeaponStates(config, state, null);
  let details = validateWeaponStates(config, state, states);
  for (const weaponId of orderedWeaponIds(config, state).reverse()) {
    if (details.reserved <= capacity) break;
    const weaponState = states[weaponId];
    if (weaponState.status === "off") continue;
    const released = details.reservations[weaponId];
    weaponState.status = "off";
    weaponState.mode = "nominal";
    weaponState.bootCounter = 0;
    details.reserved -= released;
    details.reservations[weaponId] = 0;
    events.push({ type: "weaponShed", weaponId, released });
  }
  if (details.reserved > capacity) {
    violation("WEAPON_SHEDDING_FAILED", "Weapon reservations cannot fit available capacity", {
      reserved: details.reserved,
      capacity,
    });
  }
  state.weapons ??= {};
  for (const [weaponId, next] of Object.entries(states)) {
    state.weapons[weaponId] ??= {};
    Object.assign(state.weapons[weaponId], next);
  }
  return details.reserved;
}

export function applyPowerShedding(config, state) {
  const before = getPowerState(config, state);
  const allocation = { ...before.allocation };
  const events = [];
  let committed = before.committed;
  for (const system of systemNames()) {
    if (systemInstalled(config, system) || allocation[system] === 0) continue;
    const from = allocation[system];
    allocation[system] = 0;
    committed -= from;
    events.push({ type: "tierShed", system, from, to: 0 });
  }
  for (const system of orderedSheddingSystems(config, state)) {
    while (committed > before.ceilings.maximum) {
      const lowered = lowerTier(config, system, allocation[system]);
      if (lowered == null) break;
      const from = allocation[system];
      allocation[system] = lowered;
      committed -= from - lowered;
      events.push({ type: "tierShed", system, from, to: lowered });
    }
    if (committed <= before.ceilings.maximum) break;
  }
  if (committed > before.ceilings.maximum) {
    violation("POWER_SHEDDING_FAILED", "Power shedding could not reach the reactor ceiling", {
      committed,
      maximum: before.ceilings.maximum,
    });
  }
  state.power ??= {};
  for (const system of systemNames()) state.power[system] = allocation[system];
  const weaponReserved = shedWeaponsToCapacity(config, state, allocation.weapons, events);
  const wasRedlining = state.power.redlining ?? before.redlining;
  const redlining = committed > before.ceilings.nominal;
  let heatAdded = 0;
  if (!wasRedlining && redlining) {
    heatAdded = config?.components?.reactor?.overclockHeat ?? 0;
    if (heatAdded) state.heat = Math.max(0, (state.heat ?? 0) + heatAdded);
  }
  state.power.redlining = redlining;
  return {
    allocation,
    committed,
    weaponReserved,
    ceilings: before.ceilings,
    redlining,
    heatAdded,
    events,
  };
}

export function toggleWeapon(config, state, input) {
  const weaponId = input?.weaponId ?? input?.id;
  const weapon = weaponConfig(config, weaponId);
  const current = currentWeaponState(state, weaponId);
  const before = {
    status: current.status,
    mode: current.mode,
    bootCounter: current.bootCounter ?? 0,
  };
  const candidate = mergedWeaponStates(config, state, null);
  const next = { ...candidate[weaponId] };
  const turnOn = input.on === true || input.status === "online" || input.status === "booting";
  const turnOff = input.on === false || input.status === "off";
  if (turnOff) {
    next.status = "off";
    next.mode = "nominal";
    next.bootCounter = 0;
  } else if (current.status === "off" && turnOn) {
    next.mode = "nominal";
    next.bootCounter = weapon.bootTime ?? 0;
    validateNonnegativeInteger(next.bootCounter, "INVALID_BOOT_TIME", `${weaponId}.bootTime`);
    next.status = next.bootCounter > 0 ? "booting" : "online";
  }
  if (input.mode != null) next.mode = input.mode;
  candidate[weaponId] = next;
  const details = validateWeaponStates(config, state, candidate);
  const capacity = state.power?.weapons ?? 0;
  if (details.reserved > capacity) {
    violation("WEAPONS_POWER_EXCEEDED", "Weapon reservations exceed routed Weapons Power", {
      weaponId,
      reserved: details.reserved,
      capacity,
    });
  }
  state.weapons ??= {};
  state.weapons[weaponId] ??= {};
  Object.assign(state.weapons[weaponId], next);
  return {
    weaponId,
    from: before,
    to: { status: next.status, mode: next.mode, bootCounter: next.bootCounter },
    reservation: details.reservations[weaponId],
    totalReserved: details.reserved,
    capacity,
  };
}

export function tickWeaponBoot(config, state) {
  const events = [];
  for (const weapon of weaponConfigs(config)) {
    const weaponState = state.weapons?.[weapon.id];
    if (!weaponState || weaponState.status !== "booting") continue;
    validateNonnegativeInteger(
      weaponState.bootCounter,
      "INVALID_BOOT_COUNTER",
      `${weapon.id}.bootCounter`,
    );
    if (weaponState.bootCounter <= 0) {
      violation("INVALID_BOOT_COUNTER", `Booting weapon ${weapon.id} needs a positive counter`, {
        weaponId: weapon.id,
      });
    }
    const from = weaponState.bootCounter;
    weaponState.bootCounter = Math.max(0, from - 1);
    if (weaponState.bootCounter === 0) weaponState.status = "online";
    events.push({
      weaponId: weapon.id,
      from,
      to: weaponState.bootCounter,
      becameOnline: weaponState.status === "online",
    });
  }
  return { events };
}

export function applyMaintainedOverclockHeat(config, state) {
  const power = getPowerState(config, state);
  const sources = [];
  let heatAdded = 0;
  for (const system of ["engines", "shields", "sensors", "cooling"]) {
    const tier = tierFor(config, system, power.allocation[system], { passive: true });
    if (!tier.overclock) continue;
    const amount = tier.overclockHeat ?? componentForSystem(config, system)?.overclockHeat ?? 0;
    if (amount > 0) {
      heatAdded += amount;
      sources.push({ system, heat: amount });
    }
  }
  if (power.redlining) {
    const amount = config?.components?.reactor?.overclockHeat ?? 0;
    if (amount > 0) {
      heatAdded += amount;
      sources.push({ system: "reactor", heat: amount });
    }
  }
  if (heatAdded) state.heat = Math.max(0, (state.heat ?? 0) + heatAdded);
  state.power ??= {};
  state.power.redlining = power.redlining;
  return { heatAdded, sources, redlining: power.redlining };
}
