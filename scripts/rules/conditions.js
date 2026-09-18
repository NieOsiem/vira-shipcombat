import { RuleViolation } from "../constants.js";

export const FAULT_CHANNELS = Object.freeze([
  "driveFailure",
  "maneuveringThrusterFailure",
  "sensorFault",
  "shieldEmitterDamage",
  "weaponMalfunction",
  "coolingFailure",
  "reactorFault",
]);

export const HAZARD_CHANNELS = Object.freeze([
  "fire",
  "breach",
  "electricalCascade",
  "reactorInstability",
]);

const FAULT_SEVERITIES = Object.freeze(["minor", "major", "critical", "destroyed"]);
const HAZARD_SEVERITIES = Object.freeze(["minor", "major", "critical", "catastrophic"]);
const SEVERITY_INDEX = Object.freeze({ minor: 0, major: 1, critical: 2, destroyed: 3, catastrophic: 3 });
const SECTORS = Object.freeze(["fore", "port", "starboard", "aft"]);

const FAULT_EFFECTS = Object.freeze({
  driveFailure: Object.freeze({
    healthy: { capabilityMultiplier: 1, forwardMultiplier: 1, retroMultiplier: 1, operational: true },
    minor: { capabilityMultiplier: 0.8, forwardMultiplier: 0.8, retroMultiplier: 0.8, operational: true },
    major: { capabilityMultiplier: 0.5, forwardMultiplier: 0.5, retroMultiplier: 0.5, operational: true },
    critical: { capabilityMultiplier: 0.2, forwardMultiplier: 0.2, retroMultiplier: 0.2, operational: true },
    destroyed: { capabilityMultiplier: 0, forwardMultiplier: 0, retroMultiplier: 0, operational: false },
  }),
  maneuveringThrusterFailure: Object.freeze({
    healthy: { capabilityMultiplier: 1, lateralMultiplier: 1, rotationMultiplier: 1, operational: true },
    minor: { capabilityMultiplier: 0.8, lateralMultiplier: 0.8, rotationMultiplier: 0.8, operational: true },
    major: { capabilityMultiplier: 0.5, lateralMultiplier: 0.5, rotationMultiplier: 0.5, operational: true },
    critical: { capabilityMultiplier: 0.2, lateralMultiplier: 0.2, rotationMultiplier: 0.2, operational: true },
    destroyed: { capabilityMultiplier: 0, lateralMultiplier: 0, rotationMultiplier: 0, operational: false },
  }),
  sensorFault: Object.freeze({
    healthy: { passiveModifier: 0, rangeMultiplier: 1, activeModifier: 0, ewModifier: 0, operational: true },
    minor: { passiveModifier: -2, rangeMultiplier: 0.8, activeModifier: -2, ewModifier: -2, operational: true },
    major: { passiveModifier: -4, rangeMultiplier: 0.5, activeModifier: -4, ewModifier: -4, operational: true },
    critical: { passiveModifier: -6, rangeMultiplier: 0.25, activeModifier: -6, ewModifier: -6, operational: true },
    destroyed: { passiveModifier: 0, rangeMultiplier: 0, activeModifier: 0, ewModifier: 0, operational: false },
  }),
  shieldEmitterDamage: Object.freeze({
    healthy: { capacityMultiplier: 1, regenerationMultiplier: 1, operational: true, acceptsCharge: true },
    minor: { capacityMultiplier: 0.75, regenerationMultiplier: 0.75, operational: true, acceptsCharge: true },
    major: { capacityMultiplier: 0.5, regenerationMultiplier: 0.5, operational: true, acceptsCharge: true },
    critical: { capacityMultiplier: 0.25, regenerationMultiplier: 0.25, operational: true, acceptsCharge: true },
    destroyed: { capacityMultiplier: 0, regenerationMultiplier: 0, operational: false, acceptsCharge: false },
  }),
  weaponMalfunction: Object.freeze({
    healthy: { accuracyModifier: 0, canOverclock: true, recoveryTimeMultiplier: 1, canFire: true, operational: true },
    minor: { accuracyModifier: -2, canOverclock: true, recoveryTimeMultiplier: 1, canFire: true, operational: true },
    major: { accuracyModifier: -4, canOverclock: false, recoveryTimeMultiplier: 1, canFire: true, operational: true },
    critical: { accuracyModifier: -6, canOverclock: false, recoveryTimeMultiplier: 2, canFire: true, operational: true },
    destroyed: { accuracyModifier: 0, canOverclock: false, recoveryTimeMultiplier: 1, canFire: false, operational: false },
  }),
  coolingFailure: Object.freeze({
    healthy: { coolingMultiplier: 1, ventMultiplier: 1, operational: true },
    minor: { coolingMultiplier: 0.75, ventMultiplier: 0.75, operational: true },
    major: { coolingMultiplier: 0.5, ventMultiplier: 0.5, operational: true },
    critical: { coolingMultiplier: 0.25, ventMultiplier: 0.25, operational: true },
    destroyed: { coolingMultiplier: 0, ventMultiplier: 0, operational: false },
  }),
  reactorFault: Object.freeze({
    healthy: { outputMultiplier: 1, nominalMultiplier: 1, redlineMultiplier: 1, redlineAvailable: true, redlineUsesNominal: false, operational: true },
    minor: { outputMultiplier: 0.8, nominalMultiplier: 0.8, redlineMultiplier: 0.8, redlineAvailable: true, redlineUsesNominal: false, operational: true },
    major: { outputMultiplier: 0.5, nominalMultiplier: 0.5, redlineMultiplier: 0.5, redlineAvailable: false, redlineUsesNominal: true, operational: true },
    critical: { outputMultiplier: 0.2, nominalMultiplier: 0.2, redlineMultiplier: 0.2, redlineAvailable: false, redlineUsesNominal: true, operational: true },
    destroyed: { outputMultiplier: 0, nominalMultiplier: 0, redlineMultiplier: 0, redlineAvailable: false, redlineUsesNominal: true, operational: false },
  }),
});

function severityIndex(severity) {
  if (!(severity in SEVERITY_INDEX)) {
    throw new RuleViolation("INVALID_CONDITION_SEVERITY", "Condition severity must be a V1 tier.", { severity });
  }
  return SEVERITY_INDEX[severity];
}

function normalizePoolEntry(entry, region) {
  const channelId = entry?.channelId ?? entry?.conditionId;
  const kind = entry?.kind ?? (FAULT_CHANNELS.includes(channelId) ? "fault" : HAZARD_CHANNELS.includes(channelId) ? "hazard" : null);
  const componentId = entry?.componentId ?? (kind === "fault" ? entry?.targetId : null);
  const sector = entry?.sector ?? null;
  const hazardRegion = entry?.region ?? (kind === "hazard" && ["fire", "breach"].includes(channelId)
    ? (entry?.targetId && entry.targetId !== "ship" ? entry.targetId : sector ?? region)
    : null);
  if (!entry || !kind || typeof channelId !== "string" || !channelId || (kind === "fault" && (typeof componentId !== "string" || !componentId))) {
    throw new RuleViolation("INVALID_CRITICAL_POOL", "Critical-pool entries require a valid kind, channelId, and Fault componentId.", { region, entry });
  }
  if (kind === "hazard" && !HAZARD_CHANNELS.includes(channelId)) {
    throw new RuleViolation("UNKNOWN_CONDITION_CHANNEL", "The Hazard channel is not part of the V1 rules.", { channelId });
  }
  if (kind === "fault" && !FAULT_CHANNELS.includes(channelId)) {
    throw new RuleViolation("UNKNOWN_CONDITION_CHANNEL", "The Fault channel is not part of the V1 rules.", { channelId });
  }
  const weight = Number(entry.weight ?? 1);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RuleViolation("INVALID_CONDITION_WEIGHT", "Critical weights must be positive finite numbers.", { region, entry });
  }
  return {
    ...entry,
    id: entry.id ?? null,
    kind,
    channelId,
    conditionId: channelId,
    componentId: kind === "fault" ? componentId : null,
    sector,
    region: hazardRegion,
    targetId: kind === "fault" ? componentId : hazardRegion ?? "ship",
    weight,
    poolRegion: region,
  };
}

function poolEntries(config, region) {
  const pool = config?.criticalPools?.[region];
  if (!Array.isArray(pool)) return [];
  return pool.map((entry) => normalizePoolEntry(entry, region));
}

function allPoolEntries(config) {
  return SECTORS.flatMap((region) => poolEntries(config, region));
}

function kindFor(channelId) {
  if (FAULT_CHANNELS.includes(channelId)) return "fault";
  if (HAZARD_CHANNELS.includes(channelId)) return "hazard";
  throw new RuleViolation("UNKNOWN_CONDITION_CHANNEL", "The condition channel is not part of the V1 Fault/Hazard rules.", { channelId });
}

function supportsHazards(config) {
  const profile = config?.capabilityProfile;
  if (!profile || typeof profile !== "object") return true;
  return profile.supportsHazards !== false && profile.hazards !== false;
}

function findPoolEntry(config, key) {
  return allPoolEntries(config).find((entry) => conditionKey(entry) === key || entry.id === key) ?? null;
}

function cloneDraftForConditions(draft) {
  const conditions = Object.fromEntries(Object.entries(draft?.conditions ?? {}).map(([key, value]) => [key, { ...value }]));
  const shields = draft?.shields ? {
    ...draft.shields,
    hp: { ...(draft.shields.hp ?? {}) },
    allocation: { ...(draft.shields.allocation ?? {}) },
    collapse: { ...(draft.shields.collapse ?? {}) },
  } : undefined;
  const weapons = draft?.weapons && typeof draft.weapons === "object"
    ? Object.fromEntries(Object.entries(draft.weapons).map(([key, value]) => [key, value && typeof value === "object" ? { ...value } : value]))
    : draft?.weapons;
  return { ...draft, conditions, shields, weapons };
}

function commitConditionDraft(target, source) {
  target.conditions = source.conditions;
  if (source.shields !== undefined) target.shields = source.shields;
  if (source.weapons !== undefined) target.weapons = source.weapons;
  if (source.hull !== undefined) target.hull = source.hull;
  if (source.heat !== undefined) target.heat = source.heat;
  if (source.pendingFate !== undefined) target.pendingFate = source.pendingFate;
}

function randomAt(random, index = 0) {
  const value = typeof random === "function" ? random(index) : Array.isArray(random) ? random[index] : random;
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RuleViolation("INVALID_RANDOM_VALUE", "A deterministic random value in [0, 1) is required for this selection.", { value, index });
  }
  return value;
}

function selectWeighted(entries, random, randomIndex = 0) {
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0];
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = randomAt(random, randomIndex) * total;
  for (const entry of entries) {
    cursor -= entry.weight;
    if (cursor < 0) return entry;
  }
  return entries.at(-1);
}

function componentList(config) {
  const components = config?.components ?? {};
  const drives = Object.values(components.drives ?? {}).filter(Boolean);
  return [components.reactor, ...drives, components.shield, components.sensor, components.cooling, ...(components.weapons ?? [])].filter(Boolean);
}

function componentForTarget(config, componentId) {
  return componentList(config).find((component) => component.id === componentId) ?? null;
}

function targetSector(config, entry) {
  if (SECTORS.includes(entry.sector)) return entry.sector;
  if (entry.channelId === "shieldEmitterDamage" && SECTORS.includes(entry.componentId)) return entry.componentId;
  const shield = config?.components?.shield;
  const emitters = shield?.emitters;
  if (Array.isArray(emitters)) return emitters.find((emitter) => emitter?.id === entry.componentId)?.sector ?? null;
  if (emitters && typeof emitters === "object") {
    for (const [sector, emitter] of Object.entries(emitters)) {
      if (emitter?.id === entry.componentId || emitter === entry.componentId) return sector;
    }
  }
  return null;
}

function instanceFor(entry, existing = null) {
  const kind = entry.kind ?? kindFor(entry.channelId ?? entry.conditionId);
  const channelId = entry.channelId ?? entry.conditionId;
  const componentId = kind === "fault" ? entry.componentId ?? entry.targetId : null;
  const component = componentId ? componentForTarget(entry.config, componentId) : null;
  const sector = channelId === "shieldEmitterDamage" ? targetSector(entry.config, { ...entry, channelId, componentId }) : entry.sector ?? null;
  const region = kind === "hazard" && ["fire", "breach"].includes(channelId)
    ? entry.region ?? (entry.targetId !== "ship" ? entry.targetId : null)
    : null;
  return {
    ...(existing ?? {}),
    id: conditionKey({ ...entry, kind, channelId, componentId, sector, region }),
    kind,
    channelId,
    conditionId: channelId,
    targetId: kind === "fault" ? componentId : region ?? "ship",
    channel: channelId,
    componentId,
    sector,
    region,
    poolId: entry.id ?? existing?.poolId ?? null,
  };
}

function configuredShieldCapacity(config, sector) {
  const shield = config?.components?.shield ?? {};
  const candidates = [
    shield.sectorCaps?.[sector],
    shield.capacity?.[sector],
    shield.capacities?.[sector],
    shield.emitters?.[sector]?.capacity,
    shield.sectorCap,
  ];
  const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
  return value == null ? null : Number(value);
}

function faultEffect(channel, severity) {
  const table = FAULT_EFFECTS[channel];
  if (!table) throw new RuleViolation("UNKNOWN_FAULT_CHANNEL", "The requested Fault channel is not defined.", { channel });
  return table[severity ?? "healthy"];
}

function scaledInteger(healthy, multiplier) {
  if (!Number.isFinite(healthy) || healthy <= 0 || multiplier <= 0) return 0;
  return Math.max(1, Math.floor(healthy * multiplier));
}

function applyImmediateFaultConsequences(config, draft, condition) {
  if (condition.kind !== "fault") return;
  const effects = faultEffect(condition.conditionId, condition.severity);
  if (condition.conditionId === "weaponMalfunction" && condition.severity === "destroyed") {
    const weapon = draft.weapons?.[condition.componentId ?? condition.targetId];
    if (weapon && typeof weapon === "object") {
      weapon.status = "off";
      weapon.mode = "nominal";
    }
  }
  if (condition.conditionId === "shieldEmitterDamage") {
    const sector = condition.sector ?? targetSector(config, condition);
    if (!sector || !draft.shields?.hp) return;
    const healthyCapacity = configuredShieldCapacity(config, sector);
    const cap = healthyCapacity == null ? null : scaledInteger(healthyCapacity, effects.capacityMultiplier);
    draft.shields.allocation ??= {};
    if (condition.severity === "destroyed") {
      draft.shields.allocation[sector] = 0;
      draft.shields.hp[sector] = 0;
    } else if (cap != null) {
      draft.shields.allocation[sector] = Math.min(Number(draft.shields.allocation[sector] ?? 0), cap);
      draft.shields.hp[sector] = Math.min(Number(draft.shields.hp[sector] ?? 0), draft.shields.allocation[sector]);
    }
  }
}

function setSeverity(config, draft, entry, severity) {
  const key = conditionKey(entry);
  if (severity == null) {
    delete draft.conditions[key];
    return null;
  }
  const existing = draft.conditions[key];
  const instance = instanceFor({ ...entry, config }, existing);
  instance.severity = severity;
  instance.clock = instance.kind === "hazard" ? 2 : null;
  draft.conditions[key] = instance;
  applyImmediateFaultConsequences(config, draft, instance);
  return instance;
}

function fireBlockedByBreach(draft, region) {
  return Object.values(draft?.conditions ?? {}).some((condition) => (condition?.channelId ?? condition?.conditionId) === "breach"
    && (condition.region ?? condition.targetId ?? condition.sector) === region
    && severityIndex(condition.severity) >= 2);
}

function eligibleEntries(config, draft, sector, excludeIds = [], kind = null) {
  const excluded = new Set(excludeIds);
  return poolEntries(config, sector).filter((entry) => {
    const key = conditionKey(entry);
    if (excluded.has(key) || excluded.has(entry.id) || excluded.has(entry.channelId)) return false;
    const entryKind = kindFor(entry.conditionId);
    if (kind && entryKind !== kind) return false;
    if (!supportsHazards(config) && entryKind === "hazard") return false;
    if (entry.channelId === "fire" && fireBlockedByBreach(draft, entry.region)) return false;
    const existing = draft?.conditions?.[key];
    return existing == null || severityIndex(existing.severity) < 3;
  });
}

function directApply(config, draft, entry, tiers, { suppressBreach = true } = {}) {
  const key = conditionKey(entry);
  const existing = draft.conditions[key];
  const beforeIndex = existing ? severityIndex(existing.severity) : -1;
  const afterIndex = Math.min(3, beforeIndex + tiers);
  const applied = Math.max(0, afterIndex - beforeIndex);
  const severityNames = entry.kind === "hazard" ? HAZARD_SEVERITIES : FAULT_SEVERITIES;
  if (applied === 0) {
    return { key, applied: 0, overflow: tiers, before: existing?.severity ?? "healthy", after: existing?.severity ?? severityNames[3] };
  }
  const condition = setSeverity(config, draft, entry, severityNames[afterIndex]);
  if (suppressBreach && entry.channelId === "breach") suppressFireForBreach(config, draft, entry.region, beforeIndex, afterIndex);
  return {
    key,
    applied,
    overflow: tiers - applied,
    before: beforeIndex < 0 ? "healthy" : severityNames[beforeIndex],
    after: condition.severity,
  };
}

function suppressFireForBreach(config, draft, region, beforeIndex, afterIndex) {
  const fireEntry = allPoolEntries(config).find((entry) => entry.channelId === "fire" && entry.region === region)
    ?? normalizePoolEntry({ kind: "hazard", channelId: "fire", sector: region, weight: 1 }, region);
  const fireKey = conditionKey(fireEntry);
  const fire = draft.conditions[fireKey];
  if (!fire) return null;
  if (afterIndex >= 2) {
    delete draft.conditions[fireKey];
    return { extinguished: true, reduced: severityIndex(fire.severity) + 1 };
  }
  const escalations = Math.max(0, afterIndex - Math.max(beforeIndex, 0));
  if (escalations <= 0) return null;
  const current = severityIndex(fire.severity);
  const next = current - escalations;
  if (next < 0) delete draft.conditions[fireKey];
  else setSeverity(config, draft, fireEntry, HAZARD_SEVERITIES[next]);
  return { extinguished: next < 0, reduced: Math.min(escalations, current + 1) };
}

function resolveEntry(config, draft, key) {
  const configured = findPoolEntry(config, key);
  if (configured) return configured;
  const existing = draft?.conditions?.[key];
  if (existing?.channelId || existing?.conditionId) {
    return normalizePoolEntry({
      id: existing.poolId,
      kind: existing.kind,
      channelId: existing.channelId ?? existing.conditionId,
      componentId: existing.componentId ?? (existing.kind === "fault" ? existing.targetId : null),
      sector: existing.sector ?? existing.region,
      weight: 1,
    }, existing.region ?? existing.sector);
  }
  return null;
}

function selectFaultConversion(config, draft, sector, random, randomIndex = 0) {
  return selectWeighted(eligibleEntries(config, draft, sector, [], "fault"), random, randomIndex);
}

function applyConditionTiersCore(config, draft, { conditionId, tiers, sector, random, selector }) {
  let entry = resolveEntry(config, draft, conditionId);
  if (!entry) throw new RuleViolation("UNKNOWN_CONDITION_TARGET", "The condition target is not present in the ship's critical manifest.", { conditionId, sector });
  const applications = [];
  let randomIndex = 0;
  let remaining = tiers;

  if (entry.channelId === "fire" && fireBlockedByBreach(draft, entry.region)) {
    return { applications, discarded: remaining, blockedByBreach: true, convertedHazard: false };
  }
  if (entry.kind === "hazard" && !supportsHazards(config)) {
    entry = selectFaultConversion(config, draft, sector ?? entry.poolRegion ?? entry.region, random, randomIndex);
    if (!entry) return { applications, discarded: remaining, convertedHazard: true };
    if (eligibleEntries(config, draft, sector ?? entry.poolRegion, [], "fault").length > 1) randomIndex += 1;
  }

  let application = directApply(config, draft, entry, remaining);
  applications.push(application);
  remaining = application.overflow;

  while (remaining > 0) {
    const excludedIds = applications.map((item) => item.key);
    const spillRegion = sector ?? entry.poolRegion ?? entry.region ?? entry.sector;
    const candidates = eligibleEntries(config, draft, spillRegion, excludedIds);
    const selected = selector
      ? selector(config, draft, { sector: spillRegion, excludeIds, random: Array.isArray(random) ? random[randomIndex] : random })
      : selectWeighted(candidates, random, randomIndex);
    const chosenKey = typeof selected === "string" ? selected : selected ? conditionKey(selected) : null;
    if (!chosenKey) break;
    const spillEntry = resolveEntry(config, draft, chosenKey);
    if (!spillEntry) throw new RuleViolation("UNKNOWN_CONDITION_TARGET", "The condition selector returned an unknown target.", { conditionId: chosenKey });
    if (candidates.length > 1) randomIndex += 1;
    application = directApply(config, draft, spillEntry, remaining);
    applications.push(application);
    remaining = application.overflow;
  }
  return {
    applications,
    discarded: remaining,
    convertedHazard: (resolveEntry(config, draft, conditionId)?.kind === "hazard") && !supportsHazards(config),
  };
}

function hazardDamage(channel, severity) {
  const index = severityIndex(severity);
  if (channel === "fire") return [2, 4, 8, 12][index];
  if (channel === "breach") return [2, 5, 10, 15][index];
  return 0;
}

function hazardHeat(channel, severity) {
  const index = severityIndex(severity);
  if (channel === "electricalCascade") return [1, 2, 3, 4][index];
  if (channel === "reactorInstability") return [2, 4, 6, 10][index];
  return 0;
}

function reactorDestroyed(config, draft) {
  const reactorId = config?.components?.reactor?.id;
  if (!reactorId) return false;
  return draft.conditions?.[conditionKey("reactorFault", reactorId)]?.severity === "destroyed";
}

function selectFireFault(config, draft, region, random, randomIndex) {
  const valid = eligibleEntries(config, draft, region, [], "fault");
  const existing = valid.filter((entry) => draft.conditions[conditionKey(entry)]);
  return selectWeighted(existing.length ? existing : valid, random, randomIndex);
}

export function conditionKey(conditionOrId, targetId = null, sector = null) {
  if (typeof conditionOrId === "object" && conditionOrId) {
    const channelId = conditionOrId.channelId ?? conditionOrId.conditionId ?? conditionOrId.channel;
    const kind = conditionOrId.kind ?? kindFor(channelId);
    if (kind === "fault") {
      const componentId = conditionOrId.componentId ?? conditionOrId.targetId;
      const faultSector = conditionOrId.sector;
      return `${componentId}:${channelId}${faultSector ? `:${faultSector}` : ""}`;
    }
    const region = conditionOrId.region ?? (conditionOrId.targetId !== "ship" ? conditionOrId.targetId : null);
    return region ? `${channelId}:${region}` : channelId;
  }
  const kind = kindFor(conditionOrId);
  if (kind === "fault") return `${targetId}:${conditionOrId}${sector ? `:${sector}` : ""}`;
  return targetId && targetId !== "ship" ? `${conditionOrId}:${targetId}` : conditionOrId;
}

export function selectCondition(config, draft, { sector, excludeIds = [], random }) {
  if (!SECTORS.includes(sector)) {
    throw new RuleViolation("INVALID_CONDITION_SECTOR", "Condition selection requires a valid struck sector.", { sector });
  }
  const chosen = selectWeighted(eligibleEntries(config, draft, sector, excludeIds), random);
  return chosen ? conditionKey(chosen) : null;
}

export function applyConditionTiers(config, draft, { conditionId, tiers = 1, sector, random, selectCondition: selector = null }) {
  if (!Number.isInteger(tiers) || tiers <= 0) {
    throw new RuleViolation("INVALID_CONDITION_TIERS", "Condition escalation must apply a positive integer number of tiers.", { tiers });
  }
  if (sector != null && !SECTORS.includes(sector)) {
    throw new RuleViolation("INVALID_CONDITION_SECTOR", "Condition application requires a valid sector.", { sector });
  }
  const working = cloneDraftForConditions(draft);
  const result = applyConditionTiersCore(config, working, { conditionId, tiers, sector, random, selector });
  commitConditionDraft(draft, working);
  return result;
}

export function getFaultEffects(config, draft, { componentId = null, targetId = componentId, channel = null, conditionId = channel, sector = null } = {}) {
  if (!conditionId || !FAULT_CHANNELS.includes(conditionId)) {
    throw new RuleViolation("UNKNOWN_FAULT_CHANNEL", "Fault effects require a defined V1 Fault channel.", { conditionId });
  }
  const candidates = Object.values(draft?.conditions ?? {}).filter((condition) => (condition?.channelId ?? condition?.conditionId) === conditionId
    && (targetId == null || condition.targetId === targetId || condition.componentId === targetId)
    && (sector == null || condition.sector === sector || condition.targetId === sector));
  const condition = candidates.sort((a, b) => severityIndex(b.severity) - severityIndex(a.severity))[0] ?? null;
  const severity = condition?.severity ?? "healthy";
  return { channel: conditionId, targetId, sector, severity, ...faultEffect(conditionId, severity) };
}

export function processHazardEnd(config, draft, { random = [], endKey = draft?.turnKey } = {}) {
  const working = cloneDraftForConditions(draft);
  const events = [];
  let randomIndex = 0;

  if (reactorDestroyed(config, working)) {
    for (const [key, condition] of Object.entries(working.conditions)) {
      if ((condition?.channelId ?? condition?.conditionId) === "reactorInstability") {
        delete working.conditions[key];
        events.push({ type: "hazardEnded", conditionId: key, reason: "reactorDestroyed" });
      }
    }
  }

  const snapshot = Object.values(working.conditions)
    .filter((condition) => condition?.kind === "hazard" || HAZARD_CHANNELS.includes(condition?.channelId ?? condition?.conditionId))
    .map((condition) => ({ ...condition }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const byChannel = (channel) => snapshot.filter((condition) => (condition.channelId ?? condition.conditionId) === channel);
  for (const channel of ["electricalCascade", "reactorInstability"]) {
    for (const hazard of byChannel(channel)) {
      const heat = hazardHeat(channel, hazard.severity);
      working.heat = Math.max(0, Number(working.heat ?? 0)) + heat;
      events.push({ type: "hazardHeat", conditionId: hazard.id, channel, severity: hazard.severity, heat });
    }
  }

  for (const fire of byChannel("fire")) {
    const componentEvents = fire.severity === "critical" ? 1 : fire.severity === "catastrophic" ? 2 : 0;
    for (let index = 0; index < componentEvents; index += 1) {
      const candidates = eligibleEntries(config, working, fire.targetId, [], "fault");
      const existing = candidates.filter((entry) => working.conditions[conditionKey(entry)]);
      const candidateCount = (existing.length ? existing : candidates).length;
      const target = selectFireFault(config, working, fire.targetId, random, randomIndex);
      if (candidateCount > 1) randomIndex += 1;
      if (!target) {
        events.push({ type: "fireFault", conditionId: fire.id, targetId: null, applied: false });
        continue;
      }
      const applied = directApply(config, working, target, 1);
      events.push({ type: "fireFault", conditionId: fire.id, targetId: applied.key, applied: true, severity: applied.after });
    }
    const hullDamage = hazardDamage("fire", fire.severity);
    const beforeHull = Math.max(0, Number(working.hull ?? 0));
    working.hull = Math.max(0, beforeHull - hullDamage);
    events.push({ type: "fireHullDamage", conditionId: fire.id, severity: fire.severity, hullDamage, beforeHull, hull: working.hull });
  }

  for (const breach of byChannel("breach")) {
    events.push({
      type: "breachReminder",
      conditionId: breach.id,
      region: breach.targetId,
      severity: breach.severity,
      occupantDamage: hazardDamage("breach", breach.severity),
    });
  }

  const known = new Set(["electricalCascade", "reactorInstability", "fire", "breach"]);
  for (const hazard of snapshot.filter((condition) => !known.has(condition.channelId ?? condition.conditionId))) {
    const channel = hazard.channelId ?? hazard.conditionId;
    events.push({ type: "hazardEnd", conditionId: hazard.id, channel, severity: hazard.severity });
  }

  const escalating = [];
  for (const original of snapshot) {
    const current = working.conditions[original.id];
    if (!current || current.severity !== original.severity || current.clock !== original.clock || severityIndex(current.severity) >= 3) continue;
    const nextClock = Math.max(0, Number(current.clock ?? 2) - 1);
    if (nextClock === 0) escalating.push({ original, entry: resolveEntry(config, working, original.id) });
    else current.clock = nextClock;
  }

  const breachEscalations = [];
  for (const escalation of escalating) {
    if (!escalation.entry) continue;
    const beforeIndex = severityIndex(escalation.original.severity);
    const applied = directApply(config, working, escalation.entry, 1, { suppressBreach: false });
    events.push({ type: "hazardEscalation", conditionId: escalation.original.id, before: applied.before, after: applied.after, clock: 2 });
    if (escalation.entry.channelId === "breach" && applied.applied > 0) {
      breachEscalations.push({ region: escalation.entry.region, beforeIndex, afterIndex: beforeIndex + applied.applied });
    }
  }

  for (const escalation of breachEscalations) {
    const result = suppressFireForBreach(config, working, escalation.region, escalation.beforeIndex, escalation.afterIndex);
    if (result) events.push({ type: "breachFireSuppression", region: escalation.region, ...result });
  }

  commitConditionDraft(draft, working);
  return { endKey, events, hull: draft.hull, heat: draft.heat };
}
