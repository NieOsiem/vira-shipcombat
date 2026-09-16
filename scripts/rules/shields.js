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
  const shield = config.components?.shield;
  if (!shield) violation("MISSING_SHIELD", "Ship has no shield configuration");
  return shield;
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

function currentCharge(state, sector) {
  const charge = state.shields?.charge?.[sector] ?? 0;
  requireNonnegativeInteger(charge, "INVALID_SHIELD_CHARGE", `${sector}.charge`);
  return charge;
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
  if (total !== 100) {
    violation("INVALID_REGENERATION_TOTAL", "Regeneration Allocation must total exactly 100", {
      total,
    });
  }
  return result;
}

function capacityProjection(config, state) {
  const shield = shieldConfig(config);
  requireNonnegativeInteger(shield.totalBudget, "INVALID_SHIELD_CAPACITY", "totalBudget");
  const sectors = sectorsFor(config);
  const charge = {};
  const capacities = {};
  const emitter = {};
  const losses = [];
  for (const sector of sectors) {
    const profile = effectiveSector(config, state, sector);
    const before = currentCharge(state, sector);
    const after = Math.min(before, profile.capacity);
    charge[sector] = after;
    capacities[sector] = profile.capacity;
    emitter[sector] = profile;
    if (after < before) losses.push({ sector, amount: before - after, reason: "sectorCapacity" });
  }
  let total = sectors.reduce((sum, sector) => sum + charge[sector], 0);
  let excess = Math.max(0, total - shield.totalBudget);
  for (const sector of [...sectors].reverse()) {
    if (excess === 0) break;
    const removed = Math.min(charge[sector], excess);
    if (removed > 0) {
      charge[sector] -= removed;
      excess -= removed;
      losses.push({ sector, amount: removed, reason: "totalBudget" });
    }
  }
  total = sectors.reduce((sum, sector) => sum + charge[sector], 0);
  return { charge, capacities, emitter, losses, total, totalBudget: shield.totalBudget };
}

function applyCapacityProjection(state, projection) {
  state.shields ??= {};
  state.shields.charge ??= {};
  for (const [sector, charge] of Object.entries(projection.charge)) {
    state.shields.charge[sector] = charge;
  }
}

function allocateToTargets(total, targets) {
  requireNonnegativeInteger(total, "INVALID_REGENERATION_BUDGET", "total");
  const order = orderedKeys(targets);
  const targetTotal = order.reduce((sum, sector) => {
    requireNonnegativeInteger(targets[sector], "INVALID_REGENERATION_GAIN", `${sector}.gain`);
    return sum + targets[sector];
  }, 0);
  const budget = Math.min(total, targetTotal);
  const allocation = Object.fromEntries(order.map((sector) => [sector, 0]));
  if (budget === 0 || targetTotal === 0) return allocation;
  const ideals = Object.fromEntries(
    order.map((sector) => [sector, (budget * targets[sector]) / targetTotal]),
  );
  for (let remaining = budget; remaining > 0; remaining -= 1) {
    let selected = null;
    let selectedDeficit = -Infinity;
    for (const sector of order) {
      if (allocation[sector] >= targets[sector]) continue;
      const deficit = ideals[sector] - allocation[sector];
      if (deficit > selectedDeficit) {
        selected = sector;
        selectedDeficit = deficit;
      }
    }
    if (selected == null) break;
    allocation[selected] += 1;
  }
  return allocation;
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
  if (weightTotal !== 100) {
    violation("INVALID_REGENERATION_TOTAL", "Regeneration Allocation must total exactly 100", {
      total: weightTotal,
    });
  }
  if (total === 0 || positive.length === 0) return allocation;
  if (total < positive.length) {
    const ranked = [...positive].sort((a, b) => weights[b] - weights[a] || order.indexOf(a) - order.indexOf(b));
    for (let index = 0; index < total; index += 1) allocation[ranked[index]] = 1;
    return allocation;
  }
  for (const sector of positive) allocation[sector] = 1;
  const ideals = Object.fromEntries(positive.map((sector) => [sector, (total * weights[sector]) / 100]));
  for (let remaining = total - positive.length; remaining > 0; remaining -= 1) {
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
  const projection = capacityProjection(config, state);
  applyCapacityProjection(state, projection);
  return {
    capacities: projection.capacities,
    charge: { ...projection.charge },
    destroyedCharge: projection.losses.reduce((sum, loss) => sum + loss.amount, 0),
    losses: projection.losses,
    total: projection.total,
  };
}

export function applyShieldRegeneration(config, state) {
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
    const capacityRemaining = Math.max(0, projection.capacities[sector] - projection.charge[sector]);
    planned[sector] = Math.min(effective, capacityRemaining);
    if (effective > planned[sector]) {
      losses.push({ sector, amount: effective - planned[sector], reason: "sectorCapacity" });
    }
  }
  const plannedTotal = sectors.reduce((sum, sector) => sum + planned[sector], 0);
  const totalRemaining = Math.max(0, shield.totalBudget - projection.total);
  const gains =
    plannedTotal > totalRemaining ? allocateToTargets(totalRemaining, planned) : { ...planned };
  for (const sector of sectors) {
    if (planned[sector] > gains[sector]) {
      losses.push({ sector, amount: planned[sector] - gains[sector], reason: "totalBudget" });
    }
    projection.charge[sector] += gains[sector];
  }
  applyCapacityProjection(state, projection);
  return {
    budget: tier.regeneration ?? 0,
    assigned,
    planned,
    gains,
    losses: [...projection.losses, ...losses],
    charge: { ...projection.charge },
    regenerated: sectors.reduce((sum, sector) => sum + gains[sector], 0),
  };
}

export function tickShieldRecharge(config, state) {
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
  const sourceCharge = staged?.charge ?? staged?.shields?.charge ?? {};
  const charge = {};
  for (const sector of sectors) {
    const value = sourceCharge[sector] ?? projection.charge[sector];
    requireNonnegativeInteger(value, "INVALID_SHIELD_CHARGE", `${sector}.charge`);
    if (value > projection.capacities[sector]) {
      violation("SHIELD_SECTOR_CAP_EXCEEDED", `${sector} exceeds its shield capacity`, {
        sector,
        charge: value,
        capacity: projection.capacities[sector],
      });
    }
    const ineligible = collapseCounter(state, sector) > 0 || projection.emitter[sector].destroyed;
    if (ineligible && value > projection.charge[sector]) {
      violation("SHIELD_SECTOR_INELIGIBLE", `${sector} cannot receive transferred charge`, {
        sector,
        charge: value,
      });
    }
    charge[sector] = value;
  }
  const beforeTotal = projection.total;
  const afterTotal = sectors.reduce((sum, sector) => sum + charge[sector], 0);
  if (afterTotal !== beforeTotal) {
    violation("SHIELD_CHARGE_NOT_CONSERVED", "Defense routing must conserve surviving shield charge", {
      before: beforeTotal,
      after: afterTotal,
    });
  }
  if (afterTotal > shield.totalBudget) {
    violation("SHIELD_TOTAL_BUDGET_EXCEEDED", "Shield charge exceeds total budget", {
      charge: afterTotal,
      budget: shield.totalBudget,
    });
  }
  const weightSource =
    staged?.regenerationAllocation ??
    staged?.shields?.regenerationAllocation ??
    state.shields?.regenerationAllocation;
  const regenerationAllocation = validateWeights(config, weightSource);
  return {
    charge,
    regenerationAllocation,
    capacities: projection.capacities,
    destroyedCharge: projection.losses.reduce((sum, loss) => sum + loss.amount, 0),
    capacityLosses: projection.losses,
    totalCharge: afterTotal,
  };
}

export function commitDefenseRoute(config, state, staged) {
  const result = previewDefenseRoute(config, state, staged);
  state.shields ??= {};
  state.shields.charge ??= {};
  state.shields.regenerationAllocation ??= {};
  Object.assign(state.shields.charge, result.charge);
  Object.assign(state.shields.regenerationAllocation, result.regenerationAllocation);
  return result;
}

export function resolveShieldDamage(config, state, input = {}) {
  const requestedSector = input.sector;
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
  const shieldBefore = projection.charge[sector];
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
    projection.charge[sector] = shieldAfter;
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
  applyCapacityProjection(state, projection);
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
  state.shields.charge ??= {};
  state.shields.collapse ??= {};
  state.shields.charge[sector] = 0;
  state.shields.collapse[sector] = delay;
  return {
    recovered: true,
    conditionId: condition.conditionId ?? conditionChannel(condition),
    conditionKey,
    sector,
    from: "destroyed",
    to: "critical",
    charge: 0,
    collapsed: true,
    rechargeCounter: delay,
    capacity: Math.floor(baseSectorCap(shield, sector) * EMITTER_MULTIPLIER.critical),
  };
}
