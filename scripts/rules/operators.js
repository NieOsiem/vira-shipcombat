import { RuleViolation } from "../constants.js";

const COMMAND_ACTIONS = 3;
const CREW_ORDERS = 1;

function asAssignment(value) {
  if (typeof value === "string") return { operatorId: value };
  if (!value || typeof value !== "object") {
    throw new RuleViolation("INVALID_ROSTER_ENTRY", "Roster entries must identify an operator.", { value });
  }
  const operatorId = value.operatorId ?? value.id;
  if (typeof operatorId !== "string" || !operatorId) {
    throw new RuleViolation("INVALID_ROSTER_ENTRY", "Roster entries require a stable operatorId.", { value });
  }
  return { ...value, operatorId };
}

function operatorProfiles(config) {
  return Array.isArray(config?.operators) ? config.operators : [];
}

function profileById(config, operatorId) {
  return operatorProfiles(config).find((profile) => profile?.id === operatorId) ?? null;
}

function assignmentIdentity(profile, assignment) {
  const actorId = assignment.actorId ?? profile.actorId ?? null;
  const userId = assignment.userId ?? profile.userId ?? null;
  if (assignment.actorId != null && profile.actorId != null && assignment.actorId !== profile.actorId) {
    throw new RuleViolation("OPERATOR_ACTOR_MISMATCH", "The roster actor identity does not match the ship-local operator profile.", {
      operatorId: profile.id,
      actorId: assignment.actorId,
      expectedActorId: profile.actorId,
    });
  }
  if (assignment.userId != null && profile.userId != null && assignment.userId !== profile.userId) {
    throw new RuleViolation("OPERATOR_USER_MISMATCH", "The roster user identity does not match the ship-local operator profile.", {
      operatorId: profile.id,
      userId: assignment.userId,
      expectedUserId: profile.userId,
    });
  }
  return { operatorId: profile.id, actorId, userId };
}

function identityTokens(identity) {
  const tokens = [`operator:${identity.operatorId}`];
  if (identity.actorId) tokens.push(`actor:${identity.actorId}`);
  if (identity.userId) tokens.push(`user:${identity.userId}`);
  return tokens;
}

function occupiedTokens(occupiedIdentities) {
  const result = new Set();
  for (const identity of occupiedIdentities ?? []) {
    if (typeof identity === "string") {
      result.add(identity.includes(":") ? identity : `operator:${identity}`);
      continue;
    }
    if (!identity || typeof identity !== "object") continue;
    for (const token of identityTokens({
      operatorId: identity.operatorId ?? identity.id,
      actorId: identity.actorId ?? null,
      userId: identity.userId ?? null,
    })) {
      if (!token.endsWith(":undefined")) result.add(token);
    }
  }
  return result;
}

function normalizedRoster(config, roster, occupiedIdentities = []) {
  const command = Array.isArray(roster?.command) ? roster.command.map(asAssignment) : [];
  const crew = Array.isArray(roster?.crew) ? roster.crew.map(asAssignment) : [];
  const commandCapacity = Number(config?.commandCapacity ?? 0);
  const crewCapacity = Number(config?.crewCapacity ?? 0);
  if (!Number.isInteger(commandCapacity) || commandCapacity < 0 || command.length > commandCapacity) {
    throw new RuleViolation("COMMAND_CAPACITY_EXCEEDED", "The Command roster exceeds the ship's Command Capacity.", {
      assigned: command.length,
      capacity: commandCapacity,
    });
  }
  if (!Number.isInteger(crewCapacity) || crewCapacity < 0 || crew.length > crewCapacity) {
    throw new RuleViolation("CREW_CAPACITY_EXCEEDED", "The Crew roster exceeds the ship's Crew Capacity.", {
      assigned: crew.length,
      capacity: crewCapacity,
    });
  }

  const used = occupiedTokens(occupiedIdentities);
  const assignments = [];
  for (const [slot, entries, capacity] of [[
    "command",
    command,
    commandCapacity,
  ], [
    "crew",
    crew,
    crewCapacity,
  ]]) {
    const usedSlots = new Set();
    for (let index = 0; index < entries.length; index += 1) {
      const assignment = entries[index];
      const slotIndex = assignment.slot ?? index;
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= capacity || usedSlots.has(slotIndex)) {
        throw new RuleViolation("INVALID_ROSTER_SLOT", "Roster slot indices must be unique integers within the applicable capacity.", {
          operatorId: assignment.operatorId,
          kind: slot,
          slot: slotIndex,
          capacity,
        });
      }
      if (assignment.kind != null && assignment.kind !== slot) {
        throw new RuleViolation("ROSTER_KIND_MISMATCH", "The roster entry kind does not match its Command/Crew collection.", {
          operatorId: assignment.operatorId,
          expected: slot,
          actual: assignment.kind,
        });
      }
      usedSlots.add(slotIndex);
      assignment.slot = slotIndex;
      const profile = profileById(config, assignment.operatorId);
      if (!profile) {
        throw new RuleViolation("UNKNOWN_OPERATOR", "The roster references an operator not defined by this ship.", {
          operatorId: assignment.operatorId,
          slot,
          index,
        });
      }
      const identity = assignmentIdentity(profile, assignment);
      const duplicates = identityTokens(identity).filter((token) => used.has(token));
      if (duplicates.length) {
        throw new RuleViolation("DUPLICATE_OPERATOR", "An individual, actor, user, AI, or drone cannot occupy more than one resource-granting slot.", {
          operatorId: profile.id,
          identities: duplicates,
        });
      }
      for (const token of identityTokens(identity)) used.add(token);
      assignments.push({ slot, index: slotIndex, assignment, profile, identity });
    }
  }
  return { command, crew, assignments };
}

function assignmentFor(config, draft, operatorId) {
  const roster = normalizedRoster(config, draft?.roster);
  return roster.assignments.find((entry) => entry.profile.id === operatorId) ?? null;
}

function values(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function profileValues(profile, key) {
  const value = profile?.[key];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.entries(value).filter(([, enabled]) => Boolean(enabled)).map(([id]) => id);
  return [];
}

function componentEntries(config) {
  const components = config?.components ?? {};
  const drives = Object.values(components.drives ?? {}).filter(Boolean);
  return [components.reactor, ...drives, components.shield, components.sensor, components.cooling, ...(components.weapons ?? [])].filter(Boolean);
}

function requiredSystem(config, requirement) {
  if (typeof requirement === "string") {
    const component = componentEntries(config).find((entry) => entry.id === requirement || entry.class === requirement || entry.type === requirement);
    return { requirement, component };
  }
  const component = componentEntries(config).find((entry) => entry.id === requirement?.id || entry.class === requirement?.class || entry.type === requirement?.class);
  return { requirement, component };
}

function faultDestroysSystem(draft, component, requirement) {
  if (!component) return false;
  const faults = Object.values(draft?.conditions ?? {}).filter((condition) => condition?.kind === "fault"
    && condition.componentId === component.id
    && condition.severity === "destroyed");
  const requiredChannel = typeof requirement === "object" ? requirement.channelId ?? requirement.faultChannel : null;
  const requiredSector = typeof requirement === "object" ? requirement.sector : null;
  if (requiredChannel) {
    return faults.some((condition) => (condition.channelId ?? condition.conditionId) === requiredChannel
      && (requiredSector == null || condition.sector === requiredSector));
  }
  const wholeComponentChannel = {
    reactor: "reactorFault",
    sensor: "sensorFault",
    cooling: "coolingFailure",
    weapon: "weaponMalfunction",
    drive: ["portLateral", "starboardLateral"].includes(component.driveRole) ? "maneuveringThrusterFailure" : "driveFailure",
  }[component.class ?? component.type];
  if (wholeComponentChannel && faults.some((condition) => (condition.channelId ?? condition.conditionId) === wholeComponentChannel)) return true;
  if ((component.class ?? component.type) === "shield") {
    const sectors = Array.isArray(component.emitters) ? component.emitters.map((emitter) => emitter.sector) : Object.keys(component.emitters ?? {});
    return sectors.length > 0 && sectors.every((sector) => faults.some((condition) => (condition.channelId ?? condition.conditionId) === "shieldEmitterDamage" && condition.sector === sector));
  }
  return false;
}

function operationMetadata(operation) {
  return operation?.eligibility && typeof operation.eligibility === "object"
    ? { ...operation, ...operation.eligibility }
    : (operation ?? {});
}

function requirementRatings(metadata) {
  const raw = metadata.requiredRatings ?? metadata.requiredRating ?? metadata.rating;
  return values(raw).map((entry) => typeof entry === "string" ? { id: entry, minimum: 1 } : {
    id: entry?.id ?? entry?.rating,
    minimum: Number(entry?.minimum ?? entry?.min ?? 1),
  });
}

function resourceRemaining(draft, slot, operatorId) {
  return Number(slot === "command" ? draft?.resources?.actions?.[operatorId] : draft?.resources?.orders?.[operatorId]);
}

function setResourceRemaining(draft, slot, operatorId, amount) {
  draft.resources ??= {};
  if (slot === "command") {
    draft.resources.actions ??= {};
    draft.resources.actions[operatorId] = amount;
  } else {
    draft.resources.orders ??= {};
    draft.resources.orders[operatorId] = amount;
  }
}

function releaseOperatorControls(draft, operatorId) {
  const released = [];
  for (const [control, holder] of Object.entries(draft?.controls ?? {})) {
    const holderId = typeof holder === "string" ? holder : holder?.operatorId;
    if (holderId === operatorId) {
      draft.controls[control] = null;
      released.push(control);
    }
  }
  return released;
}

export function validateRoster(config, roster, { occupiedIdentities = [] } = {}) {
  const normalized = normalizedRoster(config, roster, occupiedIdentities);
  return {
    valid: true,
    command: normalized.command,
    crew: normalized.crew,
    identities: normalized.assignments.map(({ slot, index, identity }) => ({ slot, index, ...identity })),
  };
}

export function refreshResources(config, draft, { turnKey = draft?.turnKey, roster = null, occupiedIdentities = [] } = {}) {
  const nextRoster = roster ?? draft?.roster ?? { command: [], crew: [] };
  const normalized = normalizedRoster(config, nextRoster, occupiedIdentities);
  const actions = {};
  const orders = {};
  for (const entry of normalized.assignments) {
    if (entry.slot === "command") actions[entry.profile.id] = COMMAND_ACTIONS;
    else orders[entry.profile.id] = CREW_ORDERS;
  }

  draft.roster = {
    ...(draft.roster ?? {}),
    command: normalized.command,
    crew: normalized.crew,
    lockedTurnKey: turnKey ?? null,
  };
  draft.resources ??= {};
  draft.resources.actions = actions;
  draft.resources.orders = orders;
  draft.controls ??= {};
  for (const control of Object.keys(draft.controls)) draft.controls[control] = null;
  draft.repairAttemptUsed = false;
  return { turnKey: turnKey ?? null, actions: { ...actions }, orders: { ...orders } };
}

export function checkEligibility(config, draft, { operatorId, operation }) {
  const reasons = [];
  let assigned;
  try {
    assigned = assignmentFor(config, draft, operatorId);
  } catch (error) {
    if (error instanceof RuleViolation) return { eligible: false, code: error.code, reasons: [{ code: error.code, details: error.details }] };
    throw error;
  }
  if (!assigned) reasons.push({ code: "OPERATOR_NOT_ASSIGNED", operatorId });
  if (!assigned) return { eligible: false, code: reasons[0].code, reasons };

  const metadata = operationMetadata(operation);
  const profile = assigned.profile;
  if (assigned.assignment.incapacitated || profile.incapacitated) reasons.push({ code: "OPERATOR_INCAPACITATED" });
  if (assigned.assignment.disconnected || profile.disconnected) reasons.push({ code: "OPERATOR_DISCONNECTED" });
  if (assigned.slot === "command" && metadata.commandAllowed === false) reasons.push({ code: "COMMAND_NOT_ALLOWED" });
  if (assigned.slot === "crew" && metadata.crewAllowed === false) reasons.push({ code: "CREW_NOT_ALLOWED" });

  const ratings = profile.ratings ?? {};
  for (const requirement of requirementRatings(metadata)) {
    const rating = Number(ratings[requirement.id] ?? profile[requirement.id] ?? 0);
    if (!requirement.id || rating < requirement.minimum) {
      reasons.push({ code: "RATING_REQUIRED", rating: requirement.id, minimum: requirement.minimum, actual: rating });
    }
  }

  const access = new Set(profileValues(profile, "access"));
  for (const required of values(metadata.requiredAccess ?? metadata.access)) {
    if (!access.has(required)) reasons.push({ code: "PHYSICAL_ACCESS_REQUIRED", access: required });
  }

  const capabilities = new Set(profileValues(profile, "capabilities"));
  for (const required of values(metadata.requiredCapabilities ?? metadata.capability)) {
    if (!capabilities.has(required)) reasons.push({ code: "CAPABILITY_REQUIRED", capability: required });
  }

  for (const requirement of values(metadata.requiredSubsystems ?? metadata.requiredSubsystem)) {
    const { component } = requiredSystem(config, requirement);
    if (!component) {
      reasons.push({ code: "SUBSYSTEM_REQUIRED", subsystem: requirement });
      continue;
    }
    if (faultDestroysSystem(draft, component, requirement)) {
      reasons.push({ code: "SUBSYSTEM_DESTROYED", subsystem: component.id });
      continue;
    }
    if (typeof requirement === "object" && requirement.powered) {
      const classKey = component.class ?? component.type;
      const defaultPowerKey = { drive: "engines", shield: "shields", sensor: "sensors", cooling: "cooling", weapon: "weapons" }[classKey];
      const powerKey = requirement.powerKey ?? defaultPowerKey ?? classKey;
      const allocation = draft?.power?.allocation?.[powerKey] ?? draft?.power?.[powerKey] ?? 0;
      if (Number(allocation) <= 0) reasons.push({ code: "SUBSYSTEM_UNPOWERED", subsystem: component.id });
    }
  }

  return {
    eligible: reasons.length === 0,
    code: reasons[0]?.code ?? null,
    reasons,
    operator: profile,
    assignment: assigned.assignment,
    slot: assigned.slot,
    resource: assigned.slot === "command" ? "action" : "order",
    remaining: resourceRemaining(draft, assigned.slot, operatorId),
    requirements: metadata,
  };
}

export function releaseControlsForPaidAction(draft, operatorId) {
  return { operatorId, released: releaseOperatorControls(draft, operatorId) };
}

export function spendOperationResource(config, draft, { operatorId, operation, cost = 1, free = false }) {
  const eligibility = checkEligibility(config, draft, { operatorId, operation });
  if (!eligibility.eligible) {
    throw new RuleViolation("OPERATION_INELIGIBLE", "The assigned operator is not eligible for this operation.", eligibility);
  }
  if (free || operationMetadata(operation).free === true) {
    return { operatorId, slot: eligibility.slot, resource: null, spent: 0, remaining: eligibility.remaining, released: [] };
  }
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new RuleViolation("INVALID_RESOURCE_COST", "A paid operation must have a positive integer resource cost.", { cost });
  }
  const remaining = eligibility.remaining;
  if (!Number.isInteger(remaining) || remaining < cost) {
    throw new RuleViolation("OPERATION_RESOURCE_EXHAUSTED", "The operator does not have enough Actions or Orders remaining.", {
      operatorId,
      resource: eligibility.resource,
      remaining,
      cost,
    });
  }

  const released = releaseOperatorControls(draft, operatorId);
  setResourceRemaining(draft, eligibility.slot, operatorId, remaining - cost);
  return {
    operatorId,
    slot: eligibility.slot,
    resource: eligibility.resource,
    spent: cost,
    remaining: remaining - cost,
    released,
  };
}

export function takeControl(config, draft, { operatorId, control, operation }) {
  if (typeof control !== "string" || !control) {
    throw new RuleViolation("INVALID_CONTROL", "Control Actions require a stable subsystem control identifier.", { control });
  }
  const eligibility = checkEligibility(config, draft, { operatorId, operation });
  if (!eligibility.eligible) {
    throw new RuleViolation("OPERATION_INELIGIBLE", "The assigned operator is not eligible to take this control.", eligibility);
  }
  const holder = draft?.controls?.[control];
  const holderId = typeof holder === "string" ? holder : holder?.operatorId;
  if (holderId && holderId !== operatorId) {
    throw new RuleViolation("CONTROL_HELD", "The subsystem control is already held by another operator.", { control, holderId });
  }
  const remaining = eligibility.remaining;
  if (!Number.isInteger(remaining) || remaining < 1) {
    throw new RuleViolation("OPERATION_RESOURCE_EXHAUSTED", "The operator cannot pay for this Control Action.", {
      operatorId,
      resource: eligibility.resource,
      remaining,
    });
  }

  const released = releaseOperatorControls(draft, operatorId).filter((releasedControl) => releasedControl !== control);
  setResourceRemaining(draft, eligibility.slot, operatorId, remaining - 1);
  draft.controls ??= {};
  draft.controls[control] = { operatorId, operationId: operation?.id ?? control };
  return {
    operatorId,
    control,
    slot: eligibility.slot,
    resource: eligibility.resource,
    spent: 1,
    remaining: remaining - 1,
    released,
  };
}

export function contributeWork(config, draft, { operatorId, jobId, required, operation = {} }) {
  if (typeof jobId !== "string" || !jobId || !Number.isInteger(required) || required <= 0) {
    throw new RuleViolation("INVALID_WORK_JOB", "Work requires a stable jobId and a positive integer requirement.", { jobId, required });
  }
  const eligibility = checkEligibility(config, draft, { operatorId, operation });
  if (!eligibility.eligible) {
    throw new RuleViolation("OPERATION_INELIGIBLE", "The assigned operator is not eligible to contribute Work.", eligibility);
  }
  if (config?.capabilityProfile?.work === false && operation.allowWork !== true) {
    const capabilities = new Set(profileValues(eligibility.operator, "capabilities"));
    if (!capabilities.has("work") && !capabilities.has("repairDrone") && !capabilities.has("selfRepair")) {
      throw new RuleViolation("WORK_UNAVAILABLE", "This ship/operator profile cannot contribute Work in combat.", { operatorId });
    }
  }
  const existing = draft?.work?.[jobId];
  if (existing && Number(existing.required) !== required) {
    throw new RuleViolation("WORK_REQUIREMENT_MISMATCH", "A persistent Work job cannot change its requirement.", {
      jobId,
      required,
      existingRequired: existing.required,
    });
  }
  if (existing && Number(existing.current) >= required) {
    throw new RuleViolation("WORK_ALREADY_COMPLETE", "No Work may be contributed to a completed job.", { jobId, required });
  }
  const cost = eligibility.slot === "command" ? COMMAND_ACTIONS : CREW_ORDERS;
  const remaining = eligibility.remaining;
  if (!Number.isInteger(remaining) || (eligibility.slot === "command" ? remaining !== COMMAND_ACTIONS : remaining < CREW_ORDERS)) {
    throw new RuleViolation("WORK_RESOURCE_UNAVAILABLE", "Command Work requires all 3 unspent Actions; Crew Work requires the unspent Crew Order.", {
      operatorId,
      slot: eligibility.slot,
      remaining,
    });
  }

  const current = Math.max(0, Number(existing?.current ?? 0));
  const next = Math.min(required, current + 1);
  const released = releaseOperatorControls(draft, operatorId);
  setResourceRemaining(draft, eligibility.slot, operatorId, remaining - cost);
  draft.work ??= {};
  draft.work[jobId] = { ...(existing ?? {}), id: jobId, current: next, required };
  return {
    operatorId,
    jobId,
    contributed: 1,
    current: next,
    required,
    complete: next >= required,
    discarded: current + 1 > required ? current + 1 - required : 0,
    spent: cost,
    resource: eligibility.resource,
    released,
  };
}
