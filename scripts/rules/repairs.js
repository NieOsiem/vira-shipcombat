import { RuleViolation } from "../constants.js";

const FAULT_TIERS = Object.freeze(["minor", "major", "critical", "destroyed"]);
const HAZARD_TIERS = Object.freeze(["minor", "major", "critical", "catastrophic"]);
export const REPAIR_DCS = Object.freeze({ minor: 10, major: 15, critical: 20, catastrophic: 20 });
export const HULL_REPAIR = Object.freeze({ dc: 16, offset: 15 });
export const VENT_SIGNATURE_PENALTY = 5;
const COOLING_MULTIPLIER = Object.freeze({ healthy: 1, minor: 0.75, major: 0.5, critical: 0.25, destroyed: 0 });

function values(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function profiles(config) {
  return Array.isArray(config?.operators) ? config.operators : [];
}

function assignmentId(assignment) {
  return typeof assignment === "string" ? assignment : assignment?.operatorId ?? assignment?.id;
}

function assignedOperator(config, draft, operatorId) {
  const profile = profiles(config).find((entry) => entry?.id === operatorId);
  if (!profile) throw new RuleViolation("UNKNOWN_OPERATOR", "The repair operator is not defined by this ship.", { operatorId });
  for (const slot of ["command", "crew"]) {
    const assignment = (draft?.roster?.[slot] ?? []).find((entry) => assignmentId(entry) === operatorId);
    if (assignment) {
      if (assignment.incapacitated || profile.incapacitated) throw new RuleViolation("OPERATOR_INCAPACITATED", "An incapacitated operator cannot act.", { operatorId });
      if (assignment.disconnected || profile.disconnected) throw new RuleViolation("OPERATOR_DISCONNECTED", "A disconnected operator cannot act.", { operatorId });
      return { profile, assignment, slot };
    }
  }
  throw new RuleViolation("OPERATOR_NOT_ASSIGNED", "Only an assigned Command or Crew operator may perform this operation.", { operatorId });
}

function profileSet(profile, field) {
  const value = profile?.[field];
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") return new Set(Object.entries(value).filter(([, enabled]) => Boolean(enabled)).map(([id]) => id));
  return new Set();
}

function validatePhysicalRepair(config, assigned, operation) {
  if (operation?.allowPhysicalRepair === true) return;
  const capabilities = profileSet(assigned.profile, "capabilities");
  const profileAllows = capabilities.has("physicalRepair") || capabilities.has("repair") || capabilities.has("repairDrone") || capabilities.has("manipulators");
  if (config?.capabilityProfile?.physicalRepair === false && !profileAllows) {
    throw new RuleViolation("PHYSICAL_REPAIR_UNAVAILABLE", "This ship profile does not support ordinary physical repair in combat.", { operatorId: assigned.profile.id });
  }
  if (["ai", "drone"].includes(assigned.profile.type) && !profileAllows) {
    throw new RuleViolation("REPAIR_CAPABILITY_REQUIRED", "An AI or drone requires suitable physical repair capability.", { operatorId: assigned.profile.id });
  }
  for (const required of values(operation?.requiredCapabilities)) {
    if (!capabilities.has(required)) throw new RuleViolation("REPAIR_CAPABILITY_REQUIRED", "The operator lacks a required repair capability.", { operatorId: assigned.profile.id, capability: required });
  }
  const access = profileSet(assigned.profile, "access");
  for (const required of values(operation?.requiredAccess)) {
    if (!access.has(required)) throw new RuleViolation("PHYSICAL_ACCESS_REQUIRED", "The operator lacks required physical access.", { operatorId: assigned.profile.id, access: required });
  }
}

function resourcePlan(draft, assigned, cost = 1) {
  const container = assigned.slot === "command" ? draft?.resources?.actions : draft?.resources?.orders;
  const remaining = Number(container?.[assigned.profile.id]);
  if (!Number.isInteger(remaining) || remaining < cost) {
    throw new RuleViolation("OPERATION_RESOURCE_EXHAUSTED", "The operator lacks an unspent Action or Order.", {
      operatorId: assigned.profile.id,
      slot: assigned.slot,
      remaining,
      cost,
    });
  }
  return { cost, remaining, resource: assigned.slot === "command" ? "action" : "order" };
}

function releaseControls(draft, operatorId) {
  const released = [];
  for (const [control, holder] of Object.entries(draft?.controls ?? {})) {
    if ((typeof holder === "string" ? holder : holder?.operatorId) === operatorId) {
      draft.controls[control] = null;
      released.push(control);
    }
  }
  return released;
}

function commitResource(draft, assigned, plan) {
  const container = assigned.slot === "command" ? draft.resources.actions : draft.resources.orders;
  container[assigned.profile.id] = plan.remaining - plan.cost;
  return releaseControls(draft, assigned.profile.id);
}

function ratingValue(profile, rating) {
  return Number(profile?.ratings?.[rating] ?? profile?.[rating] ?? 0);
}

function validateRating(assigned, rating, allowedRatings) {
  if (!allowedRatings.includes(rating)) {
    throw new RuleViolation("REPAIR_RATING_NOT_ALLOWED", "The selected rating is not allowed for this repair.", { rating, allowedRatings });
  }
  const value = ratingValue(assigned.profile, rating);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuleViolation("REPAIR_RATING_REQUIRED", "The operator does not have the selected repair rating.", { operatorId: assigned.profile.id, rating });
  }
  return value;
}

function checkTotal(profile, rating, { roll, total, modifier = 0 }) {
  const ratingScore = ratingValue(profile, rating);
  if (total != null) {
    if (!Number.isFinite(Number(total))) throw new RuleViolation("INVALID_CHECK_TOTAL", "An injected check total must be finite.", { total });
    return { roll: null, rating: ratingScore, modifier: Number(modifier), total: Number(total) };
  }
  if (!Number.isInteger(roll) || roll < 1 || roll > 20 || !Number.isFinite(Number(modifier))) {
    throw new RuleViolation("INVALID_CHECK_ROLL", "A repair check requires an injected d20 result from 1 through 20.", { roll, modifier });
  }
  return { roll, rating: ratingScore, modifier: Number(modifier), total: roll + ratingScore + Number(modifier) };
}

function conditionAt(draft, conditionId) {
  if (draft?.conditions?.[conditionId]) return { key: conditionId, condition: draft.conditions[conditionId] };
  for (const [key, condition] of Object.entries(draft?.conditions ?? {})) {
    if (condition?.id === conditionId || condition?.poolId === conditionId) return { key, condition };
  }
  throw new RuleViolation("CONDITION_NOT_FOUND", "The named condition is not present on this ship.", { conditionId });
}

function conditionKind(condition) {
  if (condition?.kind) return condition.kind;
  return condition?.clock == null ? "fault" : "hazard";
}

function reduceCondition(draft, key, condition, tiers) {
  const names = conditionKind(condition) === "hazard" ? HAZARD_TIERS : FAULT_TIERS;
  const beforeIndex = names.indexOf(condition.severity);
  if (beforeIndex < 0) throw new RuleViolation("INVALID_CONDITION_SEVERITY", "The condition has an invalid severity.", { conditionId: key, severity: condition.severity });
  const afterIndex = beforeIndex - tiers;
  if (afterIndex < 0) {
    delete draft.conditions[key];
    return { before: condition.severity, after: "healthy", removed: true, tiersReduced: beforeIndex + 1 };
  }
  condition.severity = names[afterIndex];
  if (conditionKind(condition) === "hazard") condition.clock = 2;
  return { before: names[beforeIndex], after: condition.severity, removed: false, tiersReduced: tiers };
}

function componentList(config) {
  const components = config?.components ?? {};
  const drives = Object.values(components.drives ?? {}).filter(Boolean);
  return [components.reactor, ...drives, components.shield, components.sensor, components.cooling, ...(components.weapons ?? [])].filter(Boolean);
}

function componentForCondition(config, condition) {
  const componentId = condition.componentId ?? (condition.kind === "fault" ? condition.targetId : null);
  return componentList(config).find((component) => component.id === componentId) ?? null;
}

function recoveryRequirement(config, condition) {
  if (Number.isInteger(condition.recoveryWork) && condition.recoveryWork > 0) return condition.recoveryWork;
  const component = componentForCondition(config, condition);
  const configured = component?.recoveryWork;
  if (Number.isInteger(configured) && configured > 0) return configured;
  const channel = condition.channelId ?? condition.conditionId ?? condition.channel;
  throw new RuleViolation("RECOVERY_WORK_UNDEFINED", "The destroyed component does not define its Recovery Work requirement.", {
    conditionId: condition.id,
    componentId: component?.id,
    channel,
  });
}

function coolingCondition(config, draft) {
  const coolingId = config?.components?.cooling?.id;
  return Object.values(draft?.conditions ?? {}).find((condition) => (condition?.channelId ?? condition?.conditionId) === "coolingFailure"
    && (condition.componentId ?? condition.targetId) === coolingId) ?? null;
}

function effectiveCooling(config, draft) {
  const component = config?.components?.cooling;
  if (!component) throw new RuleViolation("COOLING_COMPONENT_REQUIRED", "The ship has no Cooling component.");
  const fault = coolingCondition(config, draft);
  const severity = fault?.severity ?? "healthy";
  const multiplier = COOLING_MULTIPLIER[severity];
  if (multiplier == null) throw new RuleViolation("INVALID_CONDITION_SEVERITY", "Cooling Failure has an invalid severity.", { severity });
  if (multiplier === 0) throw new RuleViolation("COOLING_DESTROYED", "The destroyed Cooling component cannot cool or vent.", { componentId: component.id });
  const power = Number(draft?.power?.cooling ?? 0);
  const tier = (component.tiers ?? []).find((entry) => Number(entry.power) === power);
  if (!tier) throw new RuleViolation("COOLING_POWER_TIER_INVALID", "The committed Cooling Power does not match an installed tier.", { power });
  const healthy = Number(tier.cooling ?? tier.output ?? 0);
  const output = healthy > 0 ? Math.max(1, Math.floor(healthy * multiplier)) : 0;
  const baseVent = Number(component.ventAmount ?? 0);
  const vent = baseVent > 0 ? Math.max(1, Math.floor(baseVent * multiplier)) : 0;
  return { component, severity, multiplier, power, healthy, output, baseVent, vent };
}

function addVentEffect(draft, componentId) {
  const id = `emergencyVent:${componentId}`;
  const effect = { id, sourceId: componentId, type: "signature", scModifier: -VENT_SIGNATURE_PENALTY, expires: "nextStart" };
  if (Array.isArray(draft.effects)) {
    const index = draft.effects.findIndex((entry) => entry?.id === id && entry?.sourceId === componentId);
    if (index >= 0) draft.effects[index] = effect;
    else draft.effects.push(effect);
  } else {
    draft.effects ??= {};
    draft.effects[id] = effect;
  }
  return effect;
}

function validateRepairAttempt(draft, assigned) {
  if (assigned.slot === "command" && draft.repairAttemptUsed) {
    throw new RuleViolation("COMMAND_REPAIR_ATTEMPT_USED", "The ship has already committed its one Command Standard/Hull Repair attempt this turn.");
  }
}

export function standardRepair(config, draft, {
  operatorId,
  conditionId,
  rating = "engineering",
  allowedRatings = ["engineering"],
  roll,
  total,
  modifier = 0,
  operation = {},
}) {
  const target = conditionAt(draft, conditionId);
  const kind = conditionKind(target.condition);
  if (kind === "fault" && target.condition.severity === "destroyed") {
    throw new RuleViolation("DESTROYED_REQUIRES_RECOVERY_WORK", "A Destroyed Fault can only recover through Work.", { conditionId: target.key });
  }
  const dc = REPAIR_DCS[target.condition.severity];
  if (!dc) throw new RuleViolation("INVALID_CONDITION_SEVERITY", "The condition cannot receive a Standard Repair.", { conditionId: target.key, severity: target.condition.severity });

  const assigned = assignedOperator(config, draft, operatorId);
  validatePhysicalRepair(config, assigned, operation);
  validateRating(assigned, rating, allowedRatings);
  validateRepairAttempt(draft, assigned);
  const check = checkTotal(assigned.profile, rating, { roll, total, modifier });
  const resource = resourcePlan(draft, assigned, 1);

  const released = commitResource(draft, assigned, resource);
  if (assigned.slot === "command") draft.repairAttemptUsed = true;
  const success = check.total >= dc;
  const tiers = success ? (check.total >= dc + 5 ? 2 : 1) : 0;
  const change = success ? reduceCondition(draft, target.key, target.condition, tiers) : null;
  return {
    operation: "standardRepair",
    operatorId,
    conditionId: target.key,
    slot: assigned.slot,
    resource: resource.resource,
    spent: 1,
    remaining: resource.remaining - 1,
    released,
    check: { ...check, dc, success },
    change,
  };
}

export function contributeRecoveryWork(config, draft, { operatorId, conditionId, operation = {} }) {
  const target = conditionAt(draft, conditionId);
  if (conditionKind(target.condition) !== "fault" || target.condition.severity !== "destroyed") {
    throw new RuleViolation("RECOVERY_WORK_REQUIRES_DESTROYED_FAULT", "Recovery Work only applies to a currently Destroyed Fault.", { conditionId: target.key });
  }
  const assigned = assignedOperator(config, draft, operatorId);
  validatePhysicalRepair(config, assigned, operation);
  if (config?.capabilityProfile?.work === false && operation.allowWork !== true) {
    const capabilities = profileSet(assigned.profile, "capabilities");
    if (!capabilities.has("work") && !capabilities.has("repairDrone") && !capabilities.has("selfRepair")) {
      throw new RuleViolation("WORK_UNAVAILABLE", "This ship/operator profile cannot contribute Recovery Work in combat.", { operatorId });
    }
  }
  const required = recoveryRequirement(config, target.condition);
  const cost = assigned.slot === "command" ? 3 : 1;
  const resource = resourcePlan(draft, assigned, cost);
  if (assigned.slot === "command" && resource.remaining !== 3) {
    throw new RuleViolation("WORK_RESOURCE_UNAVAILABLE", "Command Recovery Work requires all 3 current Ship Actions unspent.", { operatorId, remaining: resource.remaining });
  }
  const jobId = `recovery:${target.key}`;
  const existing = draft?.work?.[jobId];
  if (existing && Number(existing.required) !== required) {
    throw new RuleViolation("WORK_REQUIREMENT_MISMATCH", "Recovery Work cannot change its persistent requirement.", { jobId, existingRequired: existing.required, required });
  }

  const before = Math.max(0, Number(existing?.current ?? 0));
  const current = Math.min(required, before + 1);
  const complete = current >= required;
  const recoveryChannel = target.condition.channelId ?? target.condition.conditionId;
  const recoverySector = target.condition.sector;
  const rechargeDelay = Number(config?.components?.shield?.rechargeDelay ?? 0);
  if (complete && recoveryChannel === "shieldEmitterDamage" && !recoverySector) {
    throw new RuleViolation("SHIELD_EMITTER_SECTOR_REQUIRED", "Recovered Shield Emitter Damage requires a sector identity.", { conditionId: target.key });
  }
  if (complete && recoveryChannel === "shieldEmitterDamage" && (!Number.isInteger(rechargeDelay) || rechargeDelay < 0)) {
    throw new RuleViolation("INVALID_RECHARGE_DELAY", "The Shield component requires a nonnegative integer Recharge Delay.", { rechargeDelay });
  }
  const released = commitResource(draft, assigned, resource);
  const events = [];
  if (complete) {
    // A finished job leaves no durable entry: a zeroed one would surface as a stale
    // "0 / N" progress line. The returned result still reports the completion.
    if (draft.work) delete draft.work[jobId];
    target.condition.severity = "critical";
    target.condition.clock = null;
    if (recoveryChannel === "shieldEmitterDamage") {
      draft.shields ??= {};
      draft.shields.hp ??= {};
      draft.shields.collapse ??= {};
      draft.shields.hp[recoverySector] = 0;
      draft.shields.collapse[recoverySector] = rechargeDelay;
      events.push({ type: "shieldEmitterRecovered", conditionId: target.key, sector: recoverySector, hp: 0, collapse: rechargeDelay });
    }
    events.push({ type: "faultRecovered", conditionId: target.key, severity: "critical" });
  } else {
    draft.work ??= {};
    draft.work[jobId] = { ...(existing ?? {}), id: jobId, targetId: target.key, current, required };
  }
  return {
    operation: "recoveryWork",
    operatorId,
    conditionId: target.key,
    jobId,
    contributed: 1,
    current: complete ? 0 : current,
    required,
    complete,
    discarded: before + 1 > required ? before + 1 - required : 0,
    slot: assigned.slot,
    resource: resource.resource,
    spent: cost,
    remaining: resource.remaining - cost,
    released,
    events,
  };
}

export function repairHull(config, draft, {
  operatorId,
  rating = "engineering",
  allowedRatings = ["engineering"],
  roll,
  total,
  modifier = 0,
  operation = {},
}) {
  const maxHull = Number(config?.maxHull);
  const hull = Number(draft?.hull);
  if (!Number.isFinite(maxHull) || maxHull <= 0 || !Number.isFinite(hull) || hull <= 0) {
    throw new RuleViolation("HULL_REPAIR_UNAVAILABLE", "Hull Repair requires a valid ship still above 0 Hull.", { hull, maxHull });
  }
  if (hull >= maxHull) throw new RuleViolation("HULL_ALREADY_FULL", "Hull Repair cannot raise Hull above Maximum Hull.", { hull, maxHull });
  const assigned = assignedOperator(config, draft, operatorId);
  validatePhysicalRepair(config, assigned, operation);
  validateRating(assigned, rating, allowedRatings);
  validateRepairAttempt(draft, assigned);
  const check = checkTotal(assigned.profile, rating, { roll, total, modifier });
  const resource = resourcePlan(draft, assigned, 1);

  const released = commitResource(draft, assigned, resource);
  if (assigned.slot === "command") draft.repairAttemptUsed = true;
  const success = check.total >= HULL_REPAIR.dc;
  const requested = success ? check.total - HULL_REPAIR.offset : 0;
  const repaired = Math.min(maxHull - hull, requested);
  draft.hull = hull + repaired;
  return {
    operation: "hullRepair",
    operatorId,
    slot: assigned.slot,
    resource: resource.resource,
    spent: 1,
    remaining: resource.remaining - 1,
    released,
    check: { ...check, dc: HULL_REPAIR.dc, success },
    requested,
    repaired,
    hull: draft.hull,
  };
}

export function activeCooling(config, draft, { operatorId, operation = {} }) {
  const cooling = effectiveCooling(config, draft);
  const assigned = assignedOperator(config, draft, operatorId);
  validatePhysicalRepair(config, assigned, { ...operation, allowPhysicalRepair: operation.allowPhysicalRepair ?? true });
  const resource = resourcePlan(draft, assigned, 1);
  const heat = Math.max(0, Number(draft?.heat ?? 0));
  const removed = Math.min(heat, cooling.output);
  const released = commitResource(draft, assigned, resource);
  draft.heat = heat - removed;
  return {
    operation: "activeCooling",
    operatorId,
    slot: assigned.slot,
    resource: resource.resource,
    spent: 1,
    remaining: resource.remaining - 1,
    released,
    coolingPower: cooling.power,
    faultSeverity: cooling.severity,
    available: cooling.output,
    removed,
    heat: draft.heat,
  };
}

export function emergencyVent(config, draft, { operatorId, operation = {} }) {
  const cooldown = Number(draft?.ventCooldown ?? 0);
  if (!Number.isInteger(cooldown) || cooldown < 0) {
    throw new RuleViolation("INVALID_VENT_COOLDOWN", "Vent Cooldown must be a nonnegative integer.", { cooldown });
  }
  if (cooldown !== 0) throw new RuleViolation("VENT_COOLDOWN_ACTIVE", "Emergency Vent is still cooling down.", { cooldown });
  const cooling = effectiveCooling(config, draft);
  const installedCooldown = Number(cooling.component.ventCooldown ?? 0);
  if (!Number.isInteger(installedCooldown) || installedCooldown < 0) {
    throw new RuleViolation("INVALID_VENT_COOLDOWN", "The Cooling component must define a nonnegative Vent Cooldown.", { installedCooldown });
  }
  const assigned = assignedOperator(config, draft, operatorId);
  validatePhysicalRepair(config, assigned, { ...operation, allowPhysicalRepair: operation.allowPhysicalRepair ?? true });
  const resource = resourcePlan(draft, assigned, 1);
  const heat = Math.max(0, Number(draft?.heat ?? 0));
  const removed = Math.min(heat, cooling.vent);

  const released = commitResource(draft, assigned, resource);
  draft.heat = heat - removed;
  draft.ventCooldown = installedCooldown;
  const effect = addVentEffect(draft, cooling.component.id);
  return {
    operation: "emergencyVent",
    operatorId,
    slot: assigned.slot,
    resource: resource.resource,
    spent: 1,
    remaining: resource.remaining - 1,
    released,
    faultSeverity: cooling.severity,
    available: cooling.vent,
    removed,
    heat: draft.heat,
    ventCooldown: draft.ventCooldown,
    effect,
  };
}
