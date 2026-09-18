import { RuleViolation, SECTORS } from "../constants.js";

const DIRECTIONAL_SECTORS = Object.freeze(["fore", "port", "starboard", "aft"]);
const EMITTER_MULTIPLIER = Object.freeze({
  healthy: 1,
  minor: 0.75,
  major: 0.5,
  critical: 0.25,
  destroyed: 0,
  catastrophic: 0,
});
const SEVERITY_RANK = Object.freeze({
  healthy: 0,
  minor: 1,
  major: 2,
  critical: 3,
  destroyed: 4,
  catastrophic: 4,
});
const BREAKTHROUGH_FLOOR = 0.4;

function violation(code, message, details = {}) {
  throw new RuleViolation(code, message, details);
}

function shieldConfig(config) {
  const shield = config?.components?.shield;
  if (!shield) violation("MISSING_SHIELD", "Ship has no shield configuration");
  return shield;
}

function hasShield(config) {
  return Boolean(config?.components?.shield);
}

function sectorsFor(config) {
  const shield = shieldConfig(config);
  if (shield.topology === "bubble") return [shield.sectors?.[0] ?? "bubble"];
  const configured = shield.sectors ?? SECTORS ?? DIRECTIONAL_SECTORS;
  return DIRECTIONAL_SECTORS.filter((sector) => configured.includes(sector));
}

function orderedKeys(weights) {
  const keys = Object.keys(weights);
  const standard = [...DIRECTIONAL_SECTORS, "bubble"];
  return [...standard.filter((key) => keys.includes(key)), ...keys.filter((key) => !standard.includes(key)).sort()];
}

function requireNonnegativeInteger(value, code, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    violation(code, `${field} must be a nonnegative integer`, { field, value });
  }
}

function severityOf(value) {
  const severity = String(value ?? "healthy").toLowerCase();
  return Object.hasOwn(SEVERITY_RANK, severity) ? severity : "healthy";
}

function conditionChannel(condition) {
  if (condition.conditionId) return condition.conditionId;
  if (condition.channel) return condition.channel;
  if (condition.type !== "fault" && condition.type !== "hazard") return condition.type;
  return condition.name ?? condition.id;
}

function emitterSeverity(config, state, sector) {
  const shield = shieldConfig(config);
  const emitterIds = (shield.emitters ?? [])
    .filter((emitter) => emitter.sector === sector)
    .map((emitter) => emitter.id);
  let result = "healthy";
  for (const condition of Object.values(state.conditions ?? {})) {
    if (!condition || conditionChannel(condition) !== "shieldEmitterDamage") continue;
    const applies =
      condition.targetId === `${shield.id}:${sector}` ||
      condition.sector === sector ||
      condition.region === sector ||
      emitterIds.includes(condition.targetId) ||
      emitterIds.includes(condition.componentId) ||
      (!condition.targetId &&
        !condition.sector &&
        !condition.region &&
        condition.componentId === shield.id);
    const severity = severityOf(condition.severity);
    if (applies && SEVERITY_RANK[severity] > SEVERITY_RANK[result]) result = severity;
  }
  return result;
}

function baseSectorCap(shield, sector) {
  const value = typeof shield.sectorCap === "object" ? shield.sectorCap[sector] : shield.sectorCap;
  const cap = value ?? (shield.topology === "bubble" ? shield.totalBudget : undefined);
  requireNonnegativeInteger(cap, "INVALID_SHIELD_CAPACITY", `${sector}.capacity`);
  return cap;
}

function effectiveSector(config, state, sector) {
  const shield = shieldConfig(config);
  const severity = emitterSeverity(config, state, sector);
  const multiplier = EMITTER_MULTIPLIER[severity];
  return {
    sector,
    severity,
    multiplier,
    destroyed: multiplier === 0,
    capacity: Math.floor(baseSectorCap(shield, sector) * multiplier),
  };
}

function shieldTier(config, state) {
  const shield = shieldConfig(config);
  const power = state.power?.shields ?? 0;
  requireNonnegativeInteger(power, "INVALID_POWER_ALLOCATION", "shields");
  const tier = shield.tiers?.find((candidate) => candidate.power === power);
  if (!tier) violation("INVALID_POWER_TIER", `Shields have no Power ${power} tier`, { power });
  return tier;
}

function currentHp(state, sector) {
  const hp = state.shields?.hp?.[sector] ?? 0;
  requireNonnegativeInteger(hp, "INVALID_SHIELD_HP", `${sector}.hp`);
  return hp;
}

function currentAllocation(state, sector) {
  const allocation = state.shields?.allocation?.[sector] ?? 0;
  requireNonnegativeInteger(allocation, "INVALID_SHIELD_ALLOCATION", `${sector}.allocation`);
  return allocation;
}

function collapseCounter(state, sector) {
  const counter = state.shields?.collapse?.[sector] ?? 0;
  requireNonnegativeInteger(counter, "INVALID_RECHARGE_COUNTER", `${sector}.collapse`);
  return counter;
}

function validateWeights(config, weights) {
  const shield = shieldConfig(config);
  const sectors = sectorsFor(config);
  if (shield.topology === "bubble") return { [sectors[0]]: 100 };
  const result = {};
  let total = 0;
  for (const sector of sectors) {
    const weight = weights?.[sector];
    requireNonnegativeInteger(weight, "INVALID_REGENERATION_ALLOCATION", `${sector}.weight`);
    if (weight > 100) {
      violation("INVALID_REGENERATION_ALLOCATION", `${sector}.weight cannot exceed 100`, {
        sector,
        weight,
      });
    }
    result[sector] = weight;
    total += weight;
  }
  if (total > 100) {
    violation("INVALID_REGENERATION_TOTAL", "Regeneration Allocation cannot exceed 100", {
      total,
    });
  }
  return result;
}

// Projects the committed shield state onto current emitter capacities:
// allocation is clamped to the sector Max first, then hp is clamped to allocation.
function capacityProjection(config, state) {
  const shield = shieldConfig(config);
  requireNonnegativeInteger(shield.totalBudget, "INVALID_SHIELD_CAPACITY", "totalBudget");
  const sectors = sectorsFor(config);
  const capacities = {};
  const emitter = {};
  const allocation = {};
  const hp = {};
  const losses = [];
  for (const sector of sectors) {
    const profile = effectiveSector(config, state, sector);
    emitter[sector] = profile;
    capacities[sector] = profile.capacity;
    const allocationBefore = currentAllocation(state, sector);
    const allocationAfter = Math.min(allocationBefore, profile.capacity);
    allocation[sector] = allocationAfter;
    if (allocationAfter < allocationBefore) {
      losses.push({ sector, amount: allocationBefore - allocationAfter, reason: "emitterDamage" });
    }
    const hpBefore = currentHp(state, sector);
    const hpAfter = Math.min(hpBefore, allocationAfter);
    hp[sector] = hpAfter;
    if (hpAfter < hpBefore) {
      losses.push({ sector, amount: hpBefore - hpAfter, reason: "sectorCapacity" });
    }
  }
  return {
    allocation,
    hp,
    capacities,
    emitter,
    losses,
    totalAllocation: sectors.reduce((sum, sector) => sum + allocation[sector], 0),
    totalHp: sectors.reduce((sum, sector) => sum + hp[sector], 0),
  };
}

function applyCapacityProjection(state, projection) {
  state.shields ??= {};
  state.shields.allocation ??= {};
  state.shields.hp ??= {};
  for (const [sector, value] of Object.entries(projection.allocation)) {
    state.shields.allocation[sector] = value;
  }
  for (const [sector, value] of Object.entries(projection.hp)) {
    state.shields.hp[sector] = value;
  }
}

function fieldActive(config, state) {
  const tier = shieldTier(config, state);
  return (tier.online ?? tier.power > 0) && tier.power > 0;
}

function impactSector(config, requested) {
  const shield = shieldConfig(config);
  if (shield.topology === "bubble") return sectorsFor(config)[0];
  if (!sectorsFor(config).includes(requested)) {
    violation("INVALID_SHIELD_SECTOR", `Invalid shield sector: ${requested}`, { sector: requested });
  }
  return requested;
}

function roundHalfUp(value) {
  return Math.floor(value + 0.5);
}

function armorAt(config, sector) {
  const armor = config.armor ?? 0;
  const value = typeof armor === "number" ? armor : armor[sector] ?? armor.default ?? 0;
  requireNonnegativeInteger(value, "INVALID_ARMOR", `${sector}.armor`);
  return value;
}

function bypasses(input, channel) {
  if (input?.[`bypass${channel[0].toUpperCase()}${channel.slice(1)}`] === true) return true;
  const bypass = input?.shieldBypass ?? input?.bypass;
  if (bypass === true) return true;
  if (Array.isArray(bypass)) return bypass.includes(channel);
  return bypass?.[channel] === true;
}

function resolveUnshieldedDamage(config, state, input) {
  const sector = input.sector;
  if (!DIRECTIONAL_SECTORS.includes(sector)) {
    violation("INVALID_SHIELD_SECTOR", `Invalid impact sector: ${sector}`, { sector });
  }
  const shieldDamage = input.shieldDamage ?? 0;
  const hullDamage = input.hullDamage ?? 0;
  const heatDamage = input.heatDamage ?? 0;
  const armorPiercing = input.armorPiercing ?? input.ap ?? 0;
  requireNonnegativeInteger(shieldDamage, "INVALID_DAMAGE", "shieldDamage");
  requireNonnegativeInteger(hullDamage, "INVALID_DAMAGE", "hullDamage");
  requireNonnegativeInteger(heatDamage, "INVALID_DAMAGE", "heatDamage");
  requireNonnegativeInteger(armorPiercing, "INVALID_ARMOR_PIERCING", "armorPiercing");
  if (state.hull != null) requireNonnegativeInteger(state.hull, "INVALID_HULL", "hull");
  requireNonnegativeInteger(state.heat ?? 0, "INVALID_HEAT", "heat");
  const armor = armorAt(config, sector);
  const effectiveArmor = Math.max(0, armor - armorPiercing);
  const hullDamageTaken = Math.max(0, hullDamage - effectiveArmor);
  if (state.hull != null) state.hull = Math.max(0, state.hull - hullDamageTaken);
  state.heat = (state.heat ?? 0) + heatDamage;
  return {
    sector,
    armorSector: sector,
    fieldActive: false,
    shieldBefore: 0,
    activeShield: 0,
    shieldAfter: 0,
    shieldDamageApplied: 0,
    collapsed: false,
    rechargeCounter: 0,
    penetratingFraction: 1,
    hullFraction: 1,
    heatFraction: 1,
    transmittedHull: hullDamage,
    transmittedHeat: heatDamage,
    armor,
    armorPiercing,
    effectiveArmor,
    hullDamageTaken,
    hullAfter: state.hull,
    heatAfter: state.heat,
    capacityLosses: [],
  };
}

export function allocateRegeneration(total, weights) {
  requireNonnegativeInteger(total, "INVALID_REGENERATION_BUDGET", "total");
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    violation("INVALID_REGENERATION_ALLOCATION", "Regeneration Allocation weights are required");
  }
  const order = orderedKeys(weights);
  const allocation = {};
  const positive = [];
  let weightTotal = 0;
  for (const sector of order) {
    const weight = weights[sector];
    requireNonnegativeInteger(weight, "INVALID_REGENERATION_ALLOCATION", `${sector}.weight`);
    allocation[sector] = 0;
    weightTotal += weight;
    if (weight > 0) positive.push(sector);
  }
  if (weightTotal > 100) {
    violation("INVALID_REGENERATION_TOTAL", "Regeneration Allocation cannot exceed 100", {
      total: weightTotal,
    });
  }
  const target = Math.max(0, Math.min(total, Math.round((total * weightTotal) / 100)));
  if (total === 0 || positive.length === 0 || target === 0) return allocation;
  if (target < positive.length) {
    const ranked = [...positive].sort((a, b) => weights[b] - weights[a] || order.indexOf(a) - order.indexOf(b));
    for (let index = 0; index < target; index += 1) allocation[ranked[index]] = 1;
    return allocation;
  }
  for (const sector of positive) allocation[sector] = 1;
  const ideals = Object.fromEntries(positive.map((sector) => [sector, (total * weights[sector]) / 100]));
  for (let remaining = target - positive.length; remaining > 0; remaining -= 1) {
    let selected = positive[0];
    let selectedDeficit = ideals[selected] - allocation[selected];
    for (const sector of positive.slice(1)) {
      const deficit = ideals[sector] - allocation[sector];
      if (deficit > selectedDeficit) {
        selected = sector;
        selectedDeficit = deficit;
      }
    }
    allocation[selected] += 1;
  }
  return allocation;
}

export function applyShieldCapacityClamping(config, state) {
  if (!hasShield(config)) {
    return {
      capacities: {},
      allocation: {},
      hp: {},
      losses: [],
      totalAllocation: 0,
      totalHp: 0,
    };
  }
  const projection = capacityProjection(config, state);
  applyCapacityProjection(state, projection);
  return {
    capacities: projection.capacities,
    allocation: { ...projection.allocation },
    hp: { ...projection.hp },
    losses: projection.losses,
    totalAllocation: projection.totalAllocation,
    totalHp: projection.totalHp,
  };
}

export function applyShieldRegeneration(config, state) {
  if (!hasShield(config)) {
    return {
      budget: 0,
      assigned: {},
      planned: {},
      gains: {},
      losses: [],
      hp: {},
      allocation: {},
      regenerated: 0,
    };
  }
  const projection = capacityProjection(config, state);
  const shield = shieldConfig(config);
  const tier = shieldTier(config, state);
  requireNonnegativeInteger(
    tier.regeneration ?? 0,
    "INVALID_REGENERATION_BUDGET",
    "shieldTier.regeneration",
  );
  const sectors = sectorsFor(config);
  const weights =
    shield.topology === "bubble"
      ? { [sectors[0]]: 100 }
      : validateWeights(config, state.shields?.regenerationAllocation);
  const assigned = allocateRegeneration(tier.regeneration ?? 0, weights);
  const planned = {};
  const losses = [];
  for (const sector of sectors) {
    const profile = projection.emitter[sector];
    const share = assigned[sector] ?? 0;
    const collapsed = collapseCounter(state, sector) > 0;
    if (collapsed || profile.destroyed) {
      planned[sector] = 0;
      if (share > 0) losses.push({ sector, amount: share, reason: collapsed ? "collapsed" : "destroyed" });
      continue;
    }
    let effective = Math.floor(share * profile.multiplier);
    if (share > 0 && effective < 1) effective = 1;
    if (effective < share) losses.push({ sector, amount: share - effective, reason: "emitterDamage" });
    planned[sector] = Math.min(effective, projection.allocation[sector] - projection.hp[sector]);
    if (effective > planned[sector]) {
      losses.push({ sector, amount: effective - planned[sector], reason: "sectorCapacity" });
    }
  }
  for (const sector of sectors) projection.hp[sector] += planned[sector];
  applyCapacityProjection(state, projection);
  return {
    budget: tier.regeneration ?? 0,
    assigned,
    planned,
    gains: { ...planned },
    losses: [...projection.losses, ...losses],
    hp: { ...projection.hp },
    allocation: { ...projection.allocation },
    regenerated: sectors.reduce((sum, sector) => sum + planned[sector], 0),
  };
}

export function tickShieldRecharge(config, state) {
  if (!hasShield(config)) return { events: [] };
  const events = [];
  state.shields ??= {};
  state.shields.collapse ??= {};
  for (const sector of sectorsFor(config)) {
    const profile = effectiveSector(config, state, sector);
    const counter = collapseCounter(state, sector);
    if (counter <= 0 || profile.destroyed) continue;
    const next = Math.max(0, counter - 1);
    state.shields.collapse[sector] = next;
    events.push({ sector, from: counter, to: next, reactivated: next === 0 });
  }
  return { events };
}

export function previewDefenseRoute(config, state, staged) {
  const shield = shieldConfig(config);
  const sectors = sectorsFor(config);
  const projection = capacityProjection(config, state);
  const sourceAllocation = staged?.allocation ?? {};
  const allocation = {};
  const capacityLosses = [...projection.losses];
  for (const sector of sectors) {
    const stagedValue = sourceAllocation[sector];
    const value = stagedValue ?? projection.allocation[sector];
    requireNonnegativeInteger(value, "INVALID_SHIELD_ALLOCATION", `${sector}.allocation`);
    if (value > projection.capacities[sector]) {
      violation("SHIELD_SECTOR_CAP_EXCEEDED", `${sector} exceeds its shield capacity`, {
        sector,
        allocation: value,
        capacity: projection.capacities[sector],
      });
    }
    const ineligible = collapseCounter(state, sector) > 0 || projection.emitter[sector].destroyed;
    if (stagedValue != null && ineligible && value > projection.allocation[sector]) {
      violation("SHIELD_SECTOR_INELIGIBLE", `${sector} cannot receive additional allocation`, {
        sector,
        allocation: value,
      });
    }
    allocation[sector] = value;
  }
  const totalAllocation = sectors.reduce((sum, sector) => sum + allocation[sector], 0);
  if (totalAllocation > shield.totalBudget) {
    violation("SHIELD_TOTAL_BUDGET_EXCEEDED", "Shield allocation exceeds total budget", {
      allocation: totalAllocation,
      budget: shield.totalBudget,
    });
  }
  const hp = {};
  for (const sector of sectors) {
    const before = projection.hp[sector];
    const after = Math.min(before, allocation[sector]);
    hp[sector] = after;
    if (after < before) {
      capacityLosses.push({ sector, amount: before - after, reason: "sectorCapacity" });
    }
  }
  const weightSource = staged?.regenerationAllocation ?? state.shields?.regenerationAllocation;
  const regenerationAllocation = validateWeights(config, weightSource);
  return {
    allocation,
    hp,
    regenerationAllocation,
    capacities: projection.capacities,
    capacityLosses,
    totalAllocation,
    totalHp: sectors.reduce((sum, sector) => sum + hp[sector], 0),
  };
}

export function commitDefenseRoute(config, state, staged) {
  const result = previewDefenseRoute(config, state, staged);
  state.shields ??= {};
  state.shields.allocation ??= {};
  state.shields.hp ??= {};
  state.shields.regenerationAllocation ??= {};
  Object.assign(state.shields.allocation, result.allocation);
  Object.assign(state.shields.hp, result.hp);
  Object.assign(state.shields.regenerationAllocation, result.regenerationAllocation);
  return result;
}

export function resolveShieldDamage(config, state, input = {}) {
  const requestedSector = input.sector;
  if (!hasShield(config)) return resolveUnshieldedDamage(config, state, input);
  const sector = impactSector(config, requestedSector);
  const armorSector =
    shieldConfig(config).topology === "bubble" && DIRECTIONAL_SECTORS.includes(requestedSector)
      ? requestedSector
      : sector;
  const shieldDamage = input.shieldDamage ?? 0;
  const hullDamage = input.hullDamage ?? 0;
  const heatDamage = input.heatDamage ?? 0;
  const armorPiercing = input.armorPiercing ?? input.ap ?? 0;
  requireNonnegativeInteger(shieldDamage, "INVALID_DAMAGE", "shieldDamage");
  requireNonnegativeInteger(hullDamage, "INVALID_DAMAGE", "hullDamage");
  requireNonnegativeInteger(heatDamage, "INVALID_DAMAGE", "heatDamage");
  requireNonnegativeInteger(armorPiercing, "INVALID_ARMOR_PIERCING", "armorPiercing");
  if (state.hull != null) requireNonnegativeInteger(state.hull, "INVALID_HULL", "hull");
  requireNonnegativeInteger(state.heat ?? 0, "INVALID_HEAT", "heat");
  const delay = shieldConfig(config).rechargeDelay;
  requireNonnegativeInteger(delay, "INVALID_RECHARGE_DELAY", "rechargeDelay");
  const projection = capacityProjection(config, state);
  const profile = projection.emitter[sector];
  const active = fieldActive(config, state) && !profile.destroyed && collapseCounter(state, sector) === 0;
  const shieldBefore = projection.hp[sector];
  const activeShield = active ? shieldBefore : 0;
  let shieldAfter = shieldBefore;
  let penetratingFraction;
  let collapsed = false;
  if (activeShield <= 0) {
    penetratingFraction = 1;
  } else if (shieldDamage <= 0) {
    penetratingFraction = 0;
  } else {
    shieldAfter = Math.max(0, activeShield - shieldDamage);
    if (shieldAfter > 0) {
      penetratingFraction = 0;
    } else {
      const rawFraction = Math.max(0, Math.min(1, 1 - activeShield / shieldDamage));
      penetratingFraction = Math.max(BREAKTHROUGH_FLOOR, rawFraction);
      collapsed = true;
    }
  }
  const hullFraction = bypasses(input, "hull") ? 1 : penetratingFraction;
  const heatFraction = bypasses(input, "heat") ? 1 : penetratingFraction;
  const transmittedHull = roundHalfUp(hullDamage * hullFraction);
  const transmittedHeat = roundHalfUp(heatDamage * heatFraction);
  const armor = armorAt(config, armorSector);
  const effectiveArmor = Math.max(0, armor - armorPiercing);
  const hullDamageTaken = Math.max(0, transmittedHull - effectiveArmor);
  if (state.hull != null) state.hull = Math.max(0, state.hull - hullDamageTaken);
  state.heat = (state.heat ?? 0) + transmittedHeat;
  state.shields ??= {};
  state.shields.hp ??= {};
  state.shields.hp[sector] = shieldAfter;
  if (collapsed) {
    state.shields.collapse ??= {};
    state.shields.collapse[sector] = delay;
  }
  return {
    sector,
    armorSector,
    fieldActive: active,
    shieldBefore,
    activeShield,
    shieldAfter,
    shieldDamageApplied: active ? Math.min(activeShield, shieldDamage) : 0,
    collapsed,
    rechargeCounter: state.shields?.collapse?.[sector] ?? 0,
    penetratingFraction,
    hullFraction,
    heatFraction,
    transmittedHull,
    transmittedHeat,
    armor,
    armorPiercing,
    effectiveArmor,
    hullDamageTaken,
    hullAfter: state.hull,
    heatAfter: state.heat,
    capacityLosses: projection.losses,
  };
}

export function recoverShieldEmitter(config, state, sectorInput) {
  const sector = impactSector(config, sectorInput);
  const shield = shieldConfig(config);
  const emitterIds = (shield.emitters ?? [])
    .filter((emitter) => emitter.sector === sector)
    .map((emitter) => emitter.id);
  const candidates = Object.entries(state.conditions ?? {}).filter(([, condition]) => {
    if (!condition || conditionChannel(condition) !== "shieldEmitterDamage") return false;
    const applies =
      condition.targetId === `${shield.id}:${sector}` ||
      condition.sector === sector ||
      condition.region === sector ||
      emitterIds.includes(condition.targetId) ||
      emitterIds.includes(condition.componentId) ||
      (!condition.targetId &&
        !condition.sector &&
        !condition.region &&
        condition.componentId === shield.id);
    return applies && severityOf(condition.severity) === "destroyed";
  });
  if (candidates.length === 0) {
    violation("SHIELD_EMITTER_NOT_DESTROYED", `${sector} emitter is not Destroyed`, { sector });
  }
  candidates.sort(([left], [right]) => left.localeCompare(right));
  const [conditionKey, condition] = candidates[0];
  const delay = shield.rechargeDelay;
  requireNonnegativeInteger(delay, "INVALID_RECHARGE_DELAY", "rechargeDelay");
  condition.severity = "critical";
  state.shields ??= {};
  state.shields.hp ??= {};
  state.shields.collapse ??= {};
  state.shields.hp[sector] = 0;
  state.shields.collapse[sector] = delay;
  return {
    recovered: true,
    conditionId: condition.conditionId ?? conditionChannel(condition),
    conditionKey,
    sector,
    from: "destroyed",
    to: "critical",
    hp: 0,
    collapsed: true,
    rechargeCounter: delay,
    capacity: Math.floor(baseSectorCap(shield, sector) * EMITTER_MULTIPLIER.critical),
  };
}
