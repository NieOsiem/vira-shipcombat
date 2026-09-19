import { RuleViolation } from "../constants.js";
import { advanceWeaponRecovery } from "./combat.js";
import { processHazardEnd, getFaultEffects } from "./conditions.js";
import { resolveShipFate } from "./damage.js";
import { resetEvasionAtStart, resolveCoast, getOverspeedDamage } from "./movement.js";
import { refreshResources, validateRoster } from "./operators.js";
import { applyMaintainedOverclockHeat, applyPowerShedding } from "./power.js";
import { refreshObserverTracks } from "./sensors.js";
import { applyShieldCapacityClamping, applyShieldRegeneration, tickShieldRecharge } from "./shields.js";

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function commit(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function transaction(state, operation) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new RuleViolation("INVALID_SHIP_STATE", "A caller-owned ship state is required.");
  }
  const draft = clone(state);
  const result = operation(draft);
  commit(state, draft);
  return { ...result, state };
}

function event(step, type, detail = {}) {
  return { step, type, ...detail };
}

function effectsArray(state) {
  if (Array.isArray(state.effects)) return state.effects;
  return Object.values(state.effects ?? {});
}

function expiresAt(effect, timing, key) {
  const marker = effect?.expiresAt ?? effect?.expires;
  if (marker === timing) return true;
  if (marker && typeof marker === "object") return marker.turnKey == null || marker.turnKey === key;
  return marker === key;
}

function expireEffects(state, timing, key) {
  const expired = [];
  if (Array.isArray(state.effects)) {
    state.effects = state.effects.filter((effect) => {
      const due = expiresAt(effect, timing, key);
      if (due) expired.push(clone(effect));
      return !due;
    });
  } else if (state.effects && typeof state.effects === "object") {
    for (const [id, effect] of Object.entries(state.effects)) {
      if (!expiresAt(effect, timing, key)) continue;
      expired.push(clone(effect));
      delete state.effects[id];
    }
  }
  return expired;
}

function passiveCooling(config, draft) {
  const component = config?.components?.cooling;
  const before = Math.max(0, Number(draft.heat ?? 0));
  if (!component) return { before, available: 0, removed: 0, heat: before, faultSeverity: "healthy" };
  const power = Number(draft?.power?.cooling ?? 0);
  const tier = (component.tiers ?? []).find((candidate) => Number(candidate.power) === power);
  if (!tier) throw new RuleViolation("COOLING_POWER_TIER_INVALID", "Committed Cooling Power has no installed tier.", { power });
  const fault = getFaultEffects(config, draft, { componentId: component.id, channel: "coolingFailure" });
  const healthy = Number(tier.cooling ?? tier.output ?? 0);
  if (!Number.isFinite(healthy) || healthy < 0) throw new RuleViolation("INVALID_COOLING_OUTPUT", "Cooling output must be nonnegative and finite.");
  const available = healthy > 0 && fault.coolingMultiplier > 0 ? Math.max(1, Math.floor(healthy * fault.coolingMultiplier)) : 0;
  const coolingBefore = before;
  const removed = Math.min(before, available);
  draft.heat = coolingBefore - removed;
  return { before: coolingBefore, available, removed, heat: draft.heat, faultSeverity: fault.severity };
}

function tickEntryCounters(draft, entry) {
  const result = {};
  if (Number.isInteger(entry.ventCooldown) && entry.ventCooldown > 0) {
    result.ventCooldown = { from: entry.ventCooldown, to: entry.ventCooldown - 1 };
    draft.ventCooldown = entry.ventCooldown - 1;
  }
  return result;
}

function tickEntryWeaponBoot(config, draft, entryWeapons) {
  const events = [];
  for (const weapon of config?.components?.weapons ?? []) {
    const entered = entryWeapons[weapon.id];
    const current = draft.weapons?.[weapon.id];
    if (!entered || !current || current.status !== "booting") continue;
    const from = current.bootCounter;
    if (!Number.isInteger(from) || from <= 0) {
      throw new RuleViolation("INVALID_BOOT_COUNTER", "A booting weapon needs a positive counter.", { weaponId: weapon.id, bootCounter: from });
    }
    current.bootCounter = Math.max(0, from - 1);
    if (current.bootCounter === 0) current.status = "online";
    events.push({ weaponId: weapon.id, from, to: current.bootCounter, becameOnline: current.status === "online" });
  }
  return { events };
}

function automaticReadiness(config, draft) {
  const events = [];
  for (const weapon of config?.components?.weapons ?? []) {
    if (weapon?.readiness?.recovery !== "automaticStart") continue;
    const result = advanceWeaponRecovery(config, draft, { weaponId: weapon.id }, { getFaultEffects });
    events.push(result.public);
  }
  return events;
}

export function enterCombat(config, state, { turnKey = state?.turnKey } = {}) {
  void config;
  return transaction(state, (draft) => {
    draft.phase = "start";
    draft.turnKey = turnKey ?? null;
    return { events: [event("combat", "enteredCombat", { turnKey: draft.turnKey })] };
  });
}

export function leaveCombat(config, state) {
  void config;
  return transaction(state, (draft) => {
    draft.phase = "outsideCombat";
    draft.turnKey = null;
    return { events: [event("combat", "leftCombat")] };
  });
}

export function assertActivePhase(state) {
  if (state?.phase !== "active") {
    throw new RuleViolation("SHIP_NOT_ACTIVE", "This operation is only legal during the ship's Active Phase.", { phase: state?.phase });
  }
  return true;
}

export function runStartPhase(config, state, {
  turnKey = state?.turnKey,
  roster = state?.roster,
  occupiedIdentities = [],
  conflictPolicy = "advisory",
  targets = [],
  nextStartKey = true,
  expiringJamSourceUuid,
} = {}) {
  return transaction(state, (draft) => {
    const events = [];
    const entryWeapons = Object.fromEntries(Object.entries(draft.weapons ?? {})
      .filter(([, weapon]) => weapon?.status === "booting" && Number.isInteger(weapon.bootCounter) && weapon.bootCounter > 0)
      .map(([weaponId]) => [weaponId, true]));
    const entryCounters = { ventCooldown: Number.isInteger(draft.ventCooldown) ? draft.ventCooldown : null };

    if (draft.phase !== "start") {
      throw new RuleViolation("SHIP_NOT_STARTING", "Start Phase may resolve only once after combat entry or the previous End Phase.", {
        phase: draft.phase,
      });
    }
    draft.phase = "start";
    draft.turnKey = turnKey ?? null;
    const expired = expireEffects(draft, "nextStart", draft.turnKey);
    resetEvasionAtStart(draft);
    const rosterValidation = validateRoster(config, roster ?? { command: [], crew: [] }, { occupiedIdentities, conflictPolicy });
    draft.roster = { ...(draft.roster ?? {}), command: rosterValidation.command, crew: rosterValidation.crew };
    const shedding = applyPowerShedding(config, draft);
    events.push(event(0, "openingHousekeeping", { expired, roster: rosterValidation, shedding }));

    events.push(event(1, "passiveCooling", passiveCooling(config, draft)));
    events.push(event(2, "maintainedOverclockHeat", applyMaintainedOverclockHeat(config, draft)));
    events.push(event(3, "shieldRecharge", tickShieldRecharge(config, draft)));
    const clamping = applyShieldCapacityClamping(config, draft);
    events.push(event(4, "shieldRegeneration", { clamping, regeneration: applyShieldRegeneration(config, draft) }));
    events.push(event(5, "weaponBoot", tickEntryWeaponBoot(config, draft, entryWeapons)));
    events.push(event(6, "weaponReadiness", { events: automaticReadiness(config, draft) }));
    events.push(event(7, "beneficialSystems", { counters: tickEntryCounters(draft, entryCounters) }));

    const resources = refreshResources(config, draft, { turnKey: draft.turnKey, roster: draft.roster, occupiedIdentities, conflictPolicy });
    draft.timeline = 0;
    draft.rotationSpent = 0;
    resetEvasionAtStart(draft);
    events.push(event(8, "turnReset", { resources, timeline: 0, rotationSpent: 0, evasion: clone(draft.evasion) }));

    const tracks = refreshObserverTracks({ observerConfig: config, observerState: draft, targets, atStart: true, startKey: draft.turnKey, nextStartKey, expiringJamSourceUuid });
    const deferredPassiveNotices = [
      ...tracks.acquired.map((targetUuid) => ({ type: "passiveContactAcquired", targetUuid })),
      ...tracks.lost.map((targetUuid) => ({ type: "trackLost", targetUuid })),
    ];
    events.push(event(9, "trackRefresh", { tracks, deferredPassiveNotices }));
    draft.phase = "active";
    return { events, deferredPassiveNotices };
  });
}

export function runEndActiveCoast(config, state, input = {}) {
  void config;
  return transaction(state, (draft) => {
    assertActivePhase(draft);
    draft.controls ??= {};
    const released = [];
    for (const [control, holder] of Object.entries(draft.controls)) {
      if (holder != null) released.push({ control, holder: clone(holder) });
      if (control === "byOperator" && holder && typeof holder === "object") draft.controls[control] = {};
      else draft.controls[control] = null;
    }
    const coast = resolveCoast(draft, { ...input, automatic: true });
    draft.phase = "end";
    return { coast, released, events: [event("endActive", "controlsReleased", { released }), event("endActive", "coastResolved", coast)] };
  });
}

export function runEndPhase(config, state, { random = [], endKey = state?.turnKey } = {}) {
  return transaction(state, (draft) => {
    if (draft.phase !== "end") {
      throw new RuleViolation("COAST_REQUIRED", "End Phase requires the mandatory End-of-Active coast to resolve first.", {
        phase: draft.phase,
      });
    }
    const events = [];

    const overspeed = getOverspeedDamage(draft.velocity ?? { x: 0, y: 0 }, Number(config?.safeVelocity ?? 0));
    const overspeedBefore = Math.max(0, Number(draft.hull ?? 0));
    draft.hull = Math.max(0, overspeedBefore - overspeed.hullDamage);
    events.push(event(1, "overspeedDamage", { ...overspeed, beforeHull: overspeedBefore, hull: draft.hull }));

    const hazards = processHazardEnd(config, draft, { random, endKey });
    const heatEvents = hazards.events.filter((entry) => entry.type === "hazardHeat" || entry.type === "hazardEnded");
    const damageEvents = hazards.events.filter((entry) => ["fireFault", "fireHullDamage", "breachReminder", "hazardEnd"].includes(entry.type));
    const clockEvents = hazards.events.filter((entry) => ["hazardEscalation", "breachFireSuppression"].includes(entry.type));
    const shedding = applyPowerShedding(config, draft);
    events.push(event(2, "hazardHeatPower", { events: heatEvents, shedding }));
    events.push(event(3, "hazardDamage", { events: damageEvents }));
    events.push(event(4, "hazardClocks", { events: clockEvents }));

    const capacity = Number(config?.heatCapacity ?? config?.ratedHeatCapacity ?? 0);
    const overflow = Math.max(0, Number(draft.heat ?? 0) - capacity);
    const overflowDamage = Math.ceil(overflow / 2);
    const overflowBefore = Math.max(0, Number(draft.hull ?? 0));
    draft.hull = Math.max(0, overflowBefore - overflowDamage);
    events.push(event(5, "heatOverflow", { capacity, heat: draft.heat, overflow, hullDamage: overflowDamage, beforeHull: overflowBefore, hull: draft.hull }));

    const harmful = effectsArray(draft).filter((effect) => effect?.timing === "end" && (effect.harmful === true || Number(effect.hullDamage) > 0 || Number(effect.heat) > 0));
    const applied = [];
    for (const effect of harmful.sort((left, right) => String(left.id ?? "").localeCompare(String(right.id ?? "")))) {
      const hullDamage = Math.max(0, Number(effect.hullDamage ?? 0));
      const heat = Math.max(0, Number(effect.heat ?? 0));
      draft.hull = Math.max(0, Number(draft.hull ?? 0) - hullDamage);
      draft.heat = Math.max(0, Number(draft.heat ?? 0) + heat);
      applied.push({ id: effect.id ?? null, hullDamage, heat });
    }
    const expired = expireEffects(draft, "end", endKey);
    events.push(event(6, "persistentEffects", { applied, expired }));

    draft.hull = Math.max(0, Number(draft.hull ?? 0));
    const fate = resolveShipFate(config, draft);
    if (fate.public) events.push(event("afterEnd", "shipFate", { public: fate.public, gm: fate.gm }));
    draft.phase = "start";
    // A rewind to Start must invalidate the finished turn: beginTurn recomputes the same
    // `${combatId}:${round}:${combatantId}` key, so a retained turnKey would make the
    // phase.start guard treat the new Start as a duplicate and deadlock the ship.
    draft.turnKey = null;
    return { events, fate };
  });
}
