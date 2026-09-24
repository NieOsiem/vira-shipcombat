import { POWER_SYSTEMS, RuleViolation } from "../constants.js";

export const TRACK_STATUS = Object.freeze({
  UNDETECTED: "undetected",
  CONTACT: "contact",
  TARGETED: "targeted",
});

export const SENSOR_FAULT_EFFECTS = Object.freeze({
  none: Object.freeze({ passiveStrength: 0, rangeMultiplier: 1, activeEwModifier: 0, online: true }),
  minor: Object.freeze({ passiveStrength: -2, rangeMultiplier: 0.8, activeEwModifier: -2, online: true }),
  major: Object.freeze({ passiveStrength: -4, rangeMultiplier: 0.5, activeEwModifier: -4, online: true }),
  critical: Object.freeze({ passiveStrength: -6, rangeMultiplier: 0.25, activeEwModifier: -6, online: true }),
  destroyed: Object.freeze({ passiveStrength: 0, rangeMultiplier: 0, activeEwModifier: 0, online: false }),
});

const SIGNATURE_SPIKE = Object.freeze({
  ACTIVE_PING: -6,
});

const JAM_MODIFIER = -4;
const FIRING_SOLUTION_MODIFIER = 4;

function violation(code, message, details = {}) {
  throw new RuleViolation(code, message, details);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function requireDistance(distance) {
  const value = Number(distance);
  if (!Number.isFinite(value) || value < 0) {
    violation("SENSOR_INVALID_DISTANCE", "Sensor distance must be a finite nonnegative number", { distance });
  }
  return value;
}

function requireD20(d20) {
  const value = Number(d20);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    violation("SENSOR_INVALID_D20", "An injected d20 result must be an integer from 1 through 20", { d20 });
  }
  return value;
}

function normalizeSeverity(value) {
  if (typeof value === "number") return ["none", "minor", "major", "critical", "destroyed"][value] ?? "none";
  const normalized = String(value ?? "none").trim().toLowerCase();
  if (normalized === "catastrophic") return "destroyed";
  return Object.hasOwn(SENSOR_FAULT_EFFECTS, normalized) ? normalized : "none";
}

function objectValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function conditionMatchesSensorFault(condition, sensorId) {
  if (!condition || typeof condition !== "object") return false;
  const identity = String(
    condition.faultChannelId
      ?? condition.channelId
      ?? condition.channel
      ?? condition.type
      ?? condition.kind
      ?? condition.id
      ?? condition.name
      ?? "",
  ).replace(/[\s_-]/g, "").toLowerCase();
  if (identity !== "sensorfault") return false;
  const componentId = condition.componentId ?? condition.targetId;
  return componentId == null || sensorId == null || String(componentId) === String(sensorId);
}

function getSensorFaultSeverity(config, state) {
  const sensor = config?.components?.sensor;
  if (!sensor) return "none";
  const componentState = sensor?.id == null ? null : state?.components?.[sensor.id];
  if (componentState?.destroyed || String(componentState?.status).toLowerCase() === "destroyed") return "destroyed";
  let best = 0;
  const ranks = { none: 0, minor: 1, major: 2, critical: 3, destroyed: 4 };
  for (const condition of objectValues(state?.conditions)) {
    if (!conditionMatchesSensorFault(condition, sensor?.id)) continue;
    const severity = normalizeSeverity(condition.severity ?? condition.tier ?? condition.level);
    if (ranks[severity] > best) best = ranks[severity];
  }
  return ["none", "minor", "major", "critical", "destroyed"][best];
}

function getPowerTier(sensor, power) {
  const tiers = sensor?.powerTiers ?? sensor?.tiers;
  if (Array.isArray(tiers)) {
    return tiers.find((tier) => Number(tier?.power) === power) ?? null;
  }
  if (tiers && typeof tiers === "object") {
    return tiers[power] ?? tiers[String(power)] ?? null;
  }
  return null;
}

function committedPower(state) {
  const power = state?.power;
  if (!power || typeof power !== "object") return 0;
  if (Number.isFinite(Number(power.committed))) return Math.max(0, Number(power.committed));
  const allocations = power.allocations ?? power.allocation;
  if (allocations && typeof allocations === "object") {
    let total = 0;
    for (const value of Object.values(allocations)) total += Math.max(0, finiteNumber(value));
    return total;
  }
  let total = 0;
  for (const key of POWER_SYSTEMS) {
    const value = power[key];
    if (typeof value === "number") total += Math.max(0, value);
    else if (value && typeof value === "object") {
      if (Number.isFinite(Number(value.allocated))) total += Math.max(0, Number(value.allocated));
      else if (key === "weapons") {
        for (const allocation of Object.values(value)) total += Math.max(0, finiteNumber(allocation));
      }
    }
  }
  return total;
}

function reactorNominalOutput(config) {
  const reactor = config?.components?.reactor;
  return Math.max(0, finiteNumber(
    reactor?.base?.nominalOutput
      ?? reactor?.nominalOutput
      ?? reactor?.healthyNominalOutput
      ?? config?.reactorNominalOutput,
  ));
}

function emissionBand(used, nominal) {
  if (used === 0 || nominal <= 0) return { band: used === 0 ? "dark" : "redline", modifier: used === 0 ? 4 : -4 };
  const ratio = used / nominal;
  if (ratio <= 0.25) return { band: "dark", modifier: 4 };
  if (ratio <= 0.45) return { band: "minimal", modifier: 3 };
  if (ratio <= 0.70) return { band: "reduced", modifier: 1 };
  if (ratio <= 0.90) return { band: "normal", modifier: 0 };
  if (ratio <= 1) return { band: "high", modifier: -2 };
  return { band: "redline", modifier: -4 };
}

function thermalBand(heat, capacity) {
  if (capacity <= 0) return { band: heat > 0 ? "overflow" : "cold", modifier: heat > 0 ? -10 : 0 };
  const ratio = heat / capacity;
  if (ratio <= 0.30) return { band: "cold", modifier: 0 };
  if (ratio <= 0.65) return { band: "hot", modifier: -2 };
  if (ratio <= 1) return { band: "overheating", modifier: -5 };
  return { band: "overflow", modifier: -10 };
}

function signatureEffects(state) {
  const strongest = new Map();
  for (const effect of objectValues(state?.effects)) {
    if (!effect || effect.active === false) continue;
    const isSignature = effect.type === "signature"
      || effect.kind === "signature"
      || Number.isFinite(Number(effect.signatureModifier))
      || Number.isFinite(Number(effect.scModifier));
    if (!isSignature) continue;
    const modifier = finiteNumber(effect.modifier ?? effect.signatureModifier ?? effect.scModifier);
    const rawCategory = String(effect.category ?? effect.sourceCategory ?? effect.id ?? "uncategorized");
    const compactCategory = rawCategory.replace(/[\s_.:-]/g, "").toLowerCase();
    let category = rawCategory;
    if (compactCategory.startsWith("weapon")) category = "weaponFiring";
    else if (compactCategory.includes("activeping")) category = "activePing";
    else if (compactCategory.includes("emergencyvent")) category = "emergencyVent";
    const previous = strongest.get(category);
    if (previous == null || modifier < previous) strongest.set(category, modifier);
  }
  return strongest;
}

export function getCurrentSignature(config, state) {
  const usedPower = committedPower(state);
  const nominalPower = reactorNominalOutput(config);
  const emission = emissionBand(usedPower, nominalPower);
  const heat = Math.max(0, finiteNumber(state?.heat));
  const heatCapacity = Math.max(0, finiteNumber(config?.heatCapacity ?? config?.ratedHeatCapacity));
  const thermal = thermalBand(heat, heatCapacity);
  const categories = signatureEffects(state);
  let temporaryModifier = 0;
  const temporary = {};
  for (const [category, modifier] of categories) {
    temporary[category] = modifier;
    temporaryModifier += modifier;
  }
  const base = finiteNumber(config?.baseSignature ?? config?.baseSC);
  return {
    value: base + emission.modifier + thermal.modifier + temporaryModifier,
    base,
    emission: { ...emission, usedPower, nominalPower },
    thermal: { ...thermal, heat, heatCapacity },
    temporary,
    temporaryModifier,
  };
}

export function getSensorStats(config, state) {
  const sensor = config?.components?.sensor;
  const power = Math.max(0, Math.trunc(finiteNumber(state?.power?.sensors)));
  const tier = getPowerTier(sensor, power);
  const severity = getSensorFaultSeverity(config, state);
  const fault = SENSOR_FAULT_EFFECTS[severity];
  const tierOnline = power > 0 && tier != null && tier.online !== false;
  const online = Boolean(sensor && tierOnline && fault.online);
  if (!online) {
    return {
      online: false,
      power,
      faultSeverity: severity,
      passiveRange: 0,
      activeRange: 0,
      passiveStrength: 0,
      activeModifier: 0,
      ewModifier: 0,
      overclockHeat: 0,
    };
  }
  const base = sensor.base ?? sensor;
  const rangeMultiplier = Math.max(0, finiteNumber(tier.rangeMultiplier, 1)) * fault.rangeMultiplier;
  return {
    online: true,
    power,
    faultSeverity: severity,
    passiveRange: Math.max(0, finiteNumber(base.passiveRange) * rangeMultiplier),
    activeRange: Math.max(0, finiteNumber(base.activeRange) * rangeMultiplier),
    passiveStrength: finiteNumber(tier.passiveStrength, finiteNumber(base.passiveStrength)) + fault.passiveStrength,
    activeModifier: finiteNumber(tier.activeModifier, finiteNumber(base.activeModifier)) + fault.activeEwModifier,
    ewModifier: finiteNumber(base.ewModifier) + fault.activeEwModifier,
    overclockHeat: Math.max(0, finiteNumber(tier.overclockHeat)),
  };
}

export function sensorsFunctional(config, state) {
  return getSensorStats(config, state).online;
}

function targetUuidOf(input) {
  const uuid = input?.targetUuid ?? input?.uuid ?? input?.id;
  if (uuid == null || String(uuid).length === 0) violation("SENSOR_TARGET_REQUIRED", "A stable target UUID is required");
  return String(uuid);
}
export function trackKey(targetUuid) {
  return String(targetUuid ?? "").replaceAll("%", "%25").replaceAll(".", "%2E");
}

function targetUuidForTrackEntry(key, track) {
  if (track?.targetUuid != null && String(track.targetUuid).length > 0) return String(track.targetUuid);
  return String(key).replaceAll("%2E", ".").replaceAll("%25", "%");
}

function trackAt(state, targetUuid) {
  const rawKey = String(targetUuid ?? "");
  const key = trackKey(rawKey);
  return state?.tracks?.[key] ?? (key === rawKey ? undefined : state?.tracks?.[rawKey]);
}

function ensureTracks(state) {
  if (!state.tracks || typeof state.tracks !== "object" || Array.isArray(state.tracks)) state.tracks = {};
  return state.tracks;
}

function ensureTrack(state, targetUuid) {
  const tracks = ensureTracks(state);
  const rawKey = String(targetUuid);
  const key = trackKey(rawKey);
  let track = tracks[key];
  if (key !== rawKey && Object.hasOwn(tracks, rawKey)) {
    const legacyTrack = tracks[rawKey];
    if (!track || typeof track !== "object" || Array.isArray(track)) track = legacyTrack;
    delete tracks[rawKey];
  }
  if (!track || typeof track !== "object" || Array.isArray(track)) track = {};
  tracks[key] = track;
  track.targetUuid = rawKey;
  if (!Object.values(TRACK_STATUS).includes(track.state)) track.state = TRACK_STATUS.UNDETECTED;
  if (typeof track.defensesRevealed !== "boolean") track.defensesRevealed = false;
  if (typeof track.systemsRevealed !== "boolean") track.systemsRevealed = false;
  if (typeof track.firingSolution !== "boolean") track.firingSolution = false;
  if (!Array.isArray(track.jams)) track.jams = [];
  if (!track.remembered || typeof track.remembered !== "object") track.remembered = {};
  return track;
}

function markerLive(marker) {
  return marker != null && marker !== false;
}

export function hasLiveContact(track) {
  return track != null
    && track.state !== TRACK_STATUS.UNDETECTED
    && (track.state === TRACK_STATUS.TARGETED
      || track.passiveContact === true
      || markerLive(track.activeUntilTurnKey)
      || markerLive(track.physicalUntilTurnKey));
}

function cloneValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const clone = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = cloneValue(entry);
  return clone;
}

function updateLastKnown(track, observation, stale = false) {
  if (!observation || typeof observation !== "object") {
    if (track.lastKnown) track.lastKnown.stale = stale;
    return;
  }
  const marker = {};
  if (observation.position != null) marker.position = cloneValue(observation.position);
  if (observation.facing != null) marker.facing = finiteNumber(observation.facing);
  if (observation.turnKey != null) marker.turnKey = observation.turnKey;
  if (observation.sceneId != null) marker.sceneId = String(observation.sceneId);
  marker.stale = stale;
  track.lastKnown = marker;
}

function updateTargetedTelemetry(track, telemetry) {
  if (track.state !== TRACK_STATUS.TARGETED || !telemetry) return;
  if (telemetry.velocity != null) track.knownVelocity = cloneValue(telemetry.velocity);
  if (Number.isFinite(Number(telemetry.effectiveAc))) track.effectiveAc = Number(telemetry.effectiveAc);
  if (track.defensesRevealed && telemetry.defenses != null) track.defenses = cloneValue(telemetry.defenses);
  if (track.systemsRevealed && telemetry.systems != null) track.systems = cloneValue(telemetry.systems);
  updateLastKnown(track, telemetry, false);
}

function clearTargetedKnowledge(track) {
  track.defensesRevealed = false;
  track.systemsRevealed = false;
  track.firingSolution = false;
  delete track.knownVelocity;
  delete track.effectiveAc;
  delete track.defenses;
  delete track.systems;
  delete track.outsideRangeUntilTurnKey;
}

function setUndetected(track) {
  if (track.state === TRACK_STATUS.TARGETED) clearTargetedKnowledge(track);
  track.state = TRACK_STATUS.UNDETECTED;
  track.passiveContact = false;
  delete track.activeUntilTurnKey;
  delete track.physicalUntilTurnKey;
  if (track.lastKnown) track.lastKnown.stale = true;
}

function loseSensorTrack(track, preservePhysical = true) {
  const physical = preservePhysical && markerLive(track.physicalUntilTurnKey);
  clearTargetedKnowledge(track);
  track.passiveContact = false;
  delete track.activeUntilTurnKey;
  if (physical) {
    track.state = TRACK_STATUS.CONTACT;
    if (track.lastKnown) track.lastKnown.stale = false;
  } else {
    track.state = TRACK_STATUS.UNDETECTED;
    if (track.lastKnown) track.lastKnown.stale = true;
  }
}

function activeJams(track) {
  return Array.isArray(track?.jams) ? track.jams.filter((jam) => jam && jam.active !== false) : [];
}

function jamModifierAgainst(state, targetUuid) {
  let modifier = 0;
  for (const jam of activeJams(trackAt(state, targetUuid))) {
    modifier = Math.min(modifier, finiteNumber(jam.modifier, JAM_MODIFIER));
  }
  return modifier;
}

function passiveProximityModifier(distance, range) {
  const ratio = distance / range;
  if (ratio <= 0.20) return 8;
  if (ratio <= 0.40) return 6;
  if (ratio <= 0.60) return 4;
  if (ratio <= 0.80) return 2;
  return 0;
}

function activeRangeModifier(distance, range) {
  const ratio = distance / range;
  if (ratio <= 0.20) return 0;
  if (ratio <= 0.40) return -1;
  if (ratio <= 0.60) return -2;
  if (ratio <= 0.80) return -3;
  return -4;
}

function signatureValue(config, state, explicit) {
  if (explicit != null) {
    if (typeof explicit === "object") return finiteNumber(explicit.value);
    return finiteNumber(explicit);
  }
  return getCurrentSignature(config, state).value;
}

export function passiveDetection(input) {
  const distance = requireDistance(input?.distance);
  const targetUuid = targetUuidOf(input);
  const stats = getSensorStats(input?.observerConfig, input?.observerState);
  const clear = input?.sensorLineOfSight ?? input?.lineOfSight ?? !input?.blocked;
  const signature = signatureValue(input?.targetConfig, input?.targetState, input?.targetSignature);
  if (!stats.online) {
    return { detected: false, reason: "sensorsOffline", inRange: false, blocked: false, distance, signature, stats };
  }
  if (!clear) {
    return { detected: false, reason: "blocked", inRange: distance <= stats.passiveRange, blocked: true, distance, signature, stats };
  }
  if (distance > stats.passiveRange) {
    return { detected: false, reason: "outOfRange", inRange: false, blocked: false, distance, signature, stats };
  }
  const proximityModifier = passiveProximityModifier(distance, stats.passiveRange);
  const jamModifier = jamModifierAgainst(input?.observerState, targetUuid);
  const otherModifier = finiteNumber(input?.otherModifier ?? input?.passiveModifier);
  const total = stats.passiveStrength + proximityModifier + jamModifier + otherModifier;
  return {
    detected: total >= signature,
    reason: total >= signature ? "detected" : "insufficientStrength",
    inRange: true,
    blocked: false,
    distance,
    signature,
    total,
    proximityModifier,
    jamModifier,
    otherModifier,
    stats,
  };
}

function expiryDue(marker, startKey) {
  if (!markerLive(marker)) return false;
  if (startKey == null || marker === true) return true;
  if (typeof marker === "object") return marker.turnKey == null || marker.turnKey === startKey;
  return marker === startKey;
}

function expirationMarker(expiresAt) {
  if (expiresAt == null) return true;
  return expiresAt;
}

function releaseOperatorControl(state, operatorUuid) {
  if (!operatorUuid || !state?.controls || typeof state.controls !== "object") return;
  const id = String(operatorUuid);
  if (state.controls.byOperator && typeof state.controls.byOperator === "object") delete state.controls.byOperator[id];
  for (const [control, holder] of Object.entries(state.controls)) {
    if (control === "byOperator" || holder == null) continue;
    if (String(holder) === id || String(holder.operatorUuid ?? holder.operatorId ?? holder.id ?? "") === id) {
      state.controls[control] = null;
    }
  }
}

function targetObservation(target) {
  return target.telemetry ?? {
    position: target.position,
    facing: target.facing,
    velocity: target.velocity ?? target.state?.velocity,
    effectiveAc: target.effectiveAc,
    defenses: target.defenses,
    systems: target.systems,
    turnKey: target.turnKey,
    sceneId: target.sceneId,
  };
}

export function refreshObserverTracks(input) {
  const state = input?.observerState ?? input?.state;
  if (!state) violation("SENSOR_OBSERVER_STATE_REQUIRED", "Observer state is required");
  const config = input?.observerConfig ?? input?.config;
  const atStart = input?.atStart === true;
  const startKey = input?.startKey ?? input?.turnKey;
  const nextStartKey = input?.nextStartKey ?? true;
  const targets = Array.from(input?.targets ?? []);
  const stats = getSensorStats(config, state);
  const tracks = ensureTracks(state);
  const updated = [];
  const acquired = [];
  const lost = [];
  const results = [];
  const expiredJams = [];
  const expiringJamSourceUuid = input?.expiringJamSourceUuid;
  if (expiringJamSourceUuid != null) {
    const sourceUuid = String(expiringJamSourceUuid);
    for (const [key, track] of Object.entries(tracks)) {
      const targetUuid = targetUuidForTrackEntry(key, track);
      if (!Array.isArray(track?.jams)) continue;
      const retained = [];
      for (const jam of track.jams) {
        if (String(jam?.sourceUuid ?? "") === sourceUuid && expiryDue(jam?.untilTurnKey, startKey)) {
          expiredJams.push({ targetUuid, sourceUuid });
        } else {
          retained.push(jam);
        }
      }
      track.jams = retained;
    }
  }

  if (!stats.online) {
    for (const [key, storedTrack] of Object.entries(tracks)) {
      const targetUuid = targetUuidForTrackEntry(key, storedTrack);
      const track = ensureTrack(state, targetUuid);
      const before = track.state;
      if (atStart && expiryDue(track.physicalUntilTurnKey, startKey)) delete track.physicalUntilTurnKey;
      loseSensorTrack(track, true);
      if (before === TRACK_STATUS.TARGETED && track.state !== TRACK_STATUS.TARGETED) lost.push(targetUuid);
      updated.push(targetUuid);
    }
    return { online: false, updated, acquired, lost, expiredJams, results };
  }

  for (const target of targets) {
    const targetUuid = targetUuidOf(target);
    let track = trackAt(state, targetUuid);
    const hadTrack = Boolean(track && typeof track === "object");
    if (hadTrack) track = ensureTrack(state, targetUuid);
    let outsideRangeExpired = false;
    if (track && atStart) {
      if (expiryDue(track.activeUntilTurnKey, startKey)) delete track.activeUntilTurnKey;
      if (expiryDue(track.physicalUntilTurnKey, startKey)) delete track.physicalUntilTurnKey;
      outsideRangeExpired = !markerLive(track.outsideRangeUntilTurnKey)
        || expiryDue(track.outsideRangeUntilTurnKey, startKey);
    }
    const detection = passiveDetection({
      ...target,
      targetUuid,
      observerConfig: config,
      observerState: state,
      targetConfig: target.targetConfig ?? target.config,
      targetState: target.targetState ?? target.state,
    });
    results.push({ targetUuid, ...detection });

    if (detection.blocked) {
      if (track) {
        const before = track.state;
        loseSensorTrack(track, true);
        if (before === TRACK_STATUS.TARGETED && track.state !== TRACK_STATUS.TARGETED) lost.push(targetUuid);
        updated.push(targetUuid);
      }
      continue;
    }

    if (!track && !detection.detected) continue;
    track ??= ensureTrack(state, targetUuid);
    const before = track.state;
    const observation = targetObservation(target);

    if (track.state === TRACK_STATUS.TARGETED) {
      if (detection.inRange) {
        delete track.outsideRangeUntilTurnKey;
        if (detection.detected) track.passiveContact = true;
        updateTargetedTelemetry(track, observation);
      } else if (atStart && outsideRangeExpired) {
        const fallback = markerLive(track.activeUntilTurnKey) || markerLive(track.physicalUntilTurnKey);
        clearTargetedKnowledge(track);
        track.state = fallback ? TRACK_STATUS.CONTACT : TRACK_STATUS.UNDETECTED;
        track.passiveContact = false;
        if (!fallback && track.lastKnown) track.lastKnown.stale = true;
      } else {
        track.outsideRangeUntilTurnKey ??= expirationMarker(nextStartKey);
        updateTargetedTelemetry(track, observation);
      }
    } else if (detection.detected) {
      track.state = TRACK_STATUS.CONTACT;
      track.passiveContact = true;
      updateLastKnown(track, observation, false);
    } else {
      track.passiveContact = false;
      if (markerLive(track.activeUntilTurnKey) || markerLive(track.physicalUntilTurnKey)) {
        track.state = TRACK_STATUS.CONTACT;
      } else {
        track.state = TRACK_STATUS.UNDETECTED;
        if (track.lastKnown) track.lastKnown.stale = true;
      }
    }

    if (before === TRACK_STATUS.UNDETECTED && track.state !== TRACK_STATUS.UNDETECTED) acquired.push(targetUuid);
    if (before === TRACK_STATUS.TARGETED && track.state !== TRACK_STATUS.TARGETED) lost.push(targetUuid);
    if (!hadTrack || before !== track.state || detection.detected) updated.push(targetUuid);
  }
  return { online: true, updated, acquired, lost, expiredJams, results };
}

/**
 * Drop every stored track whose target no longer exists. A track key is the canonical target
 * TokenDocument UUID (URL-encoded), so a deleted target would otherwise leave a permanent contact on
 * every observer that once detected it. Pure: it touches only the supplied state object, so callers
 * decide how (and through which authority) the pruned state is persisted.
 * @param {object} state observer state, mutated in place
 * @param {Iterable<string>} liveUuids TokenDocument UUIDs that still exist
 * @returns {string[]} target UUIDs whose tracks were removed
 */
export function pruneOrphanedTracks(state, liveUuids) {
  const live = liveUuids instanceof Set ? liveUuids : new Set(liveUuids ?? []);
  const tracks = ensureTracks(state);
  const removed = [];
  for (const [key, track] of Object.entries(tracks)) {
    const targetUuid = targetUuidForTrackEntry(key, track);
    if (live.has(targetUuid)) continue;
    delete tracks[key];
    removed.push(targetUuid);
  }
  return removed;
}

function upsertActivePingEffect(state, input) {
  if (!Array.isArray(state.effects)) state.effects = objectValues(state.effects);
  const sourceUuid = String(input?.observerUuid ?? input?.sourceUuid ?? "self");
  let effect = state.effects.find((candidate) => candidate?.type === "signature"
    && candidate?.category === "activePing"
    && String(candidate?.sourceUuid ?? "self") === sourceUuid);
  if (!effect) {
    effect = { id: `signature.activePing.${sourceUuid}`, type: "signature", category: "activePing", sourceUuid };
    state.effects.push(effect);
  }
  effect.modifier = SIGNATURE_SPIKE.ACTIVE_PING;
  effect.expiresAt = input?.expiresAt ?? input?.nextStartKey ?? "nextStart";
  effect.active = true;
}

function validateSensorOperation(config, state) {
  const stats = getSensorStats(config, state);
  if (!stats.online) violation("SENSORS_OFFLINE", "Functional Sensors are required");
  return stats;
}

export function activePing(state, input) {
  const stats = validateSensorOperation(input?.config ?? input?.observerConfig, state);
  const roll = requireD20(input?.d20);
  const operatorSensors = finiteNumber(input?.operatorSensors ?? input?.sensorsRating);
  const targets = Array.from(input?.targets ?? []);
  const prepared = targets.map((target) => ({
    target,
    targetUuid: targetUuidOf(target),
    distance: requireDistance(target.distance),
  }));
  upsertActivePingEffect(state, input);
  releaseOperatorControl(state, input?.operatorUuid ?? input?.operatorId);
  const detected = [];
  for (const { target, targetUuid, distance } of prepared) {
    const clear = target.sensorLineOfSight ?? target.lineOfSight ?? !target.blocked;
    if (!clear || distance > stats.activeRange) continue;
    const rangeModifier = activeRangeModifier(distance, stats.activeRange);
    const jamModifier = jamModifierAgainst(state, targetUuid);
    const otherModifier = finiteNumber(target.activeModifier ?? input?.activeModifier);
    const total = roll + operatorSensors + stats.activeModifier + rangeModifier + jamModifier + otherModifier;
    const signature = signatureValue(target.targetConfig ?? target.config, target.targetState ?? target.state, target.targetSignature);
    if (total < signature) continue;
    const track = ensureTrack(state, targetUuid);
    const previousState = track.state;
    track.activeUntilTurnKey = expirationMarker(input?.contactExpiresAt ?? input?.nextStartKey);
    if (track.state === TRACK_STATUS.UNDETECTED) track.state = TRACK_STATUS.CONTACT;
    updateLastKnown(track, targetObservation(target), false);
    if (track.state === TRACK_STATUS.TARGETED) updateTargetedTelemetry(track, targetObservation(target));
    detected.push({ targetUuid, previousState, state: track.state });
  }
  return { roll, signatureSpikeApplied: true, detected };
}

function requireInActiveRange(state, input) {
  const config = input?.config ?? input?.observerConfig ?? input?.actingConfig;
  const stats = validateSensorOperation(config, state);
  const distance = requireDistance(input?.distance);
  if (distance > stats.activeRange) {
    violation("SENSOR_TARGET_OUT_OF_RANGE", "Target is outside current Active Range", { distance, activeRange: stats.activeRange });
  }
  const clear = input?.sensorLineOfSight ?? input?.lineOfSight ?? !input?.blocked;
  if (!clear) violation("SENSOR_LOS_BLOCKED", "Sensor line of sight is blocked");
  return { stats, distance };
}

function requireTrack(state, targetUuid, requiredState) {
  const track = trackAt(state, targetUuid);
  if (!track || !hasLiveContact(track)) {
    violation("SENSOR_LIVE_CONTACT_REQUIRED", "A live Contact is required", { targetUuid });
  }
  if (requiredState && track.state !== requiredState) {
    violation("SENSOR_TARGETED_REQUIRED", "A Targeted track is required", { targetUuid });
  }
  return track;
}

export function acquireTarget(state, input) {
  const targetUuid = targetUuidOf(input);
  const { stats, distance } = requireInActiveRange(state, input);
  const track = requireTrack(state, targetUuid);
  releaseOperatorControl(state, input?.operatorUuid ?? input?.operatorId);
  let check = null;
  if (input?.dc != null) {
    const roll = requireD20(input.d20);
    const jamModifier = jamModifierAgainst(state, targetUuid);
    const total = roll
      + finiteNumber(input.operatorSensors ?? input.sensorsRating)
      + stats.activeModifier
      + jamModifier
      + finiteNumber(input.acquisitionModifier);
    check = { roll, total, dc: finiteNumber(input.dc), success: total >= finiteNumber(input.dc) };
    if (!check.success) return { targetUuid, acquired: false, check };
  }
  track.state = TRACK_STATUS.TARGETED;
  track.defensesRevealed ??= false;
  track.systemsRevealed ??= false;
  track.firingSolution ??= false;
  if (distance <= stats.passiveRange) delete track.outsideRangeUntilTurnKey;
  else track.outsideRangeUntilTurnKey = expirationMarker(input?.nextStartKey);
  updateTargetedTelemetry(track, input?.telemetry ?? targetObservation(input));
  return { targetUuid, acquired: true, state: track.state, check };
}

function performReveal(state, input, kind) {
  const targetUuid = targetUuidOf(input);
  requireInActiveRange(state, input);
  const track = requireTrack(state, targetUuid, TRACK_STATUS.TARGETED);
  releaseOperatorControl(state, input?.operatorUuid ?? input?.operatorId);
  track[kind] = true;
  updateTargetedTelemetry(track, input?.telemetry);
  return { targetUuid, [kind]: true };
}

export function analyzeDefenses(state, input) {
  return performReveal(state, input, "defensesRevealed");
}

export function deepScan(state, input) {
  const result = performReveal(state, input, "systemsRevealed");
  const track = trackAt(state, result.targetUuid);
  const identified = input?.identifiedSubsystems
    ?? input?.telemetry?.systems?.identifiedSubsystems
    ?? [];
  const subsystems = new Map();
  for (const subsystem of [...(track.remembered.identifiedSubsystems ?? []), ...Array.from(identified)]) {
    const id = subsystem?.id ?? subsystem?.componentId ?? subsystem;
    if (id == null || typeof id === "object" || !String(id)) continue;
    const key = String(id);
    if (typeof subsystem === "object") {
      subsystems.set(key, { ...pick(subsystem, ["label", "name", "class", "regions"]), id: key });
    } else if (!subsystems.has(key)) {
      subsystems.set(key, key);
    }
  }
  const identifiedSubsystems = Array.from(subsystems.values());
  if (identifiedSubsystems.length) track.remembered.identifiedSubsystems = identifiedSubsystems;
  return { ...result, identifiedSubsystems };
}

export function calculateFiringSolution(state, input) {
  const targetUuid = targetUuidOf(input);
  requireInActiveRange(state, input);
  const track = requireTrack(state, targetUuid, TRACK_STATUS.TARGETED);
  releaseOperatorControl(state, input?.operatorUuid ?? input?.operatorId);
  const alreadyReady = track.firingSolution === true;
  track.firingSolution = true;
  return { targetUuid, ready: true, alreadyReady, modifier: FIRING_SOLUTION_MODIFIER };
}

export function consumeFiringSolution(state, targetUuid) {
  const id = String(targetUuid ?? "");
  const track = trackAt(state, id);
  if (!track || track.state !== TRACK_STATUS.TARGETED || track.firingSolution !== true) {
    violation("SENSOR_FIRING_SOLUTION_NOT_READY", "No ready Firing Solution exists for this Targeted track", { targetUuid: id });
  }
  track.firingSolution = false;
  return { targetUuid: id, consumed: true, modifier: FIRING_SOLUTION_MODIFIER };
}

export function fadeTrack(input) {
  const actingState = input?.actingState ?? input?.state;
  const actingConfig = input?.actingConfig ?? input?.config;
  validateSensorOperation(actingConfig, actingState);
  const actingUuid = String(input?.actingUuid ?? input?.sourceUuid ?? "");
  if (!actingUuid) violation("SENSOR_SOURCE_REQUIRED", "The acting ship UUID is required");
  const evaluated = [];
  for (const observer of Array.from(input?.observers ?? [])) {
    const observerState = observer.observerState ?? observer.state;
    const track = trackAt(observerState, actingUuid);
    if (!track || !hasLiveContact(track)) continue;
    const detection = passiveDetection({
      ...observer,
      targetUuid: actingUuid,
      observerConfig: observer.observerConfig ?? observer.config,
      observerState,
      targetConfig: actingConfig,
      targetState: actingState,
      targetSignature: input?.targetSignature,
    });
    evaluated.push({ observer, observerState, track, detection });
  }
  releaseOperatorControl(actingState, input?.operatorUuid ?? input?.operatorId);
  const lostBy = [];
  const sustainedBy = [];
  for (const item of evaluated) {
    const observerUuid = String(item.observer.observerUuid ?? item.observer.uuid ?? item.observer.id ?? "");
    if (item.detection.detected) {
      sustainedBy.push(observerUuid);
      continue;
    }
    setUndetected(item.track);
    lostBy.push(observerUuid);
  }
  return { actingUuid, lostBy, sustainedBy };
}

function assignedOperators(config, state) {
  const definitions = new Map();
  for (const operator of Array.from(config?.operators ?? [])) {
    const id = operator?.id ?? operator?.uuid;
    if (id != null) definitions.set(String(id), operator);
  }
  const assigned = [];
  for (const slotType of ["command", "crew"]) {
    for (const slot of Array.from(state?.roster?.[slotType] ?? [])) {
      const id = slot?.operatorId ?? slot?.operatorUuid ?? slot?.id ?? slot;
      const definition = definitions.get(String(id)) ?? (slot && typeof slot === "object" ? slot : null);
      if (!definition) continue;
      assigned.push({ ...definition, ...((slot && typeof slot === "object") ? slot : {}), slotType });
    }
  }
  return assigned;
}

function operatorEligibleForSensors(operator) {
  if (!operator) return false;
  if (operator.active === false || operator.eligible === false || operator.sensorEligible === false) return false;
  if (operator.incapacitated === true || operator.disconnected === true) return false;
  const rating = Number(operator.sensors ?? operator.ratings?.sensors);
  return Number.isFinite(rating) && rating >= 0;
}

export function highestEligiblePassiveEwDefense(config, state, input = {}) {
  const stats = getSensorStats(config, state);
  if (!stats.online) return { defense: 10, operatorUuid: null, sensorsRating: 0, hardwareModifier: 0, modifiers: 0 };
  let best = null;
  for (const operator of input.operators ?? assignedOperators(config, state)) {
    if (!operatorEligibleForSensors(operator)) continue;
    const rating = Number(operator.sensors ?? operator.ratings?.sensors);
    const id = String(operator.operatorUuid ?? operator.operatorId ?? operator.uuid ?? operator.id ?? "");
    if (!best || rating > best.rating || (rating === best.rating && id < best.id)) best = { rating, id };
  }
  if (!best) return { defense: 10, operatorUuid: null, sensorsRating: 0, hardwareModifier: 0, modifiers: 0 };
  const jamModifier = input.againstUuid ? jamModifierAgainst(state, String(input.againstUuid)) : 0;
  const explicitModifier = finiteNumber(input.ewModifier ?? input.defenseModifier);
  const modifiers = stats.ewModifier + jamModifier + explicitModifier;
  return {
    defense: 10 + best.rating + modifiers,
    operatorUuid: best.id,
    sensorsRating: best.rating,
    hardwareModifier: stats.ewModifier,
    jamModifier,
    explicitModifier,
    modifiers,
  };
}

function prepareHostileEw(input) {
  const actingState = input?.actingState;
  const targetState = input?.targetState;
  const actingConfig = input?.actingConfig;
  const targetConfig = input?.targetConfig;
  const actingUuid = String(input?.actingUuid ?? "");
  const targetUuid = targetUuidOf(input);
  if (!actingState || !targetState || !actingUuid) violation("SENSOR_EW_PARTICIPANTS_REQUIRED", "Both EW participant states and UUIDs are required");
  const { stats } = requireInActiveRange(actingState, {
    ...input,
    config: actingConfig,
  });
  requireTrack(actingState, targetUuid);
  const roll = requireD20(input?.d20);
  const jamModifier = jamModifierAgainst(actingState, targetUuid);
  const explicitModifier = finiteNumber(input?.ewModifier ?? input?.attackerModifier);
  const attackerTotal = roll
    + finiteNumber(input?.operatorSensors ?? input?.sensorsRating)
    + stats.ewModifier
    + jamModifier
    + explicitModifier;
  const defense = highestEligiblePassiveEwDefense(targetConfig, targetState, {
    againstUuid: actingUuid,
    operators: input?.defendingOperators,
    defenseModifier: input?.defenseModifier,
  });
  return { actingState, targetState, actingConfig, targetConfig, actingUuid, targetUuid, stats, roll, attackerTotal, defense };
}

export function jamTarget(input) {
  const contest = prepareHostileEw(input);
  const success = contest.attackerTotal >= contest.defense.defense;
  releaseOperatorControl(contest.actingState, input?.operatorUuid ?? input?.operatorId);
  if (success) {
    const track = ensureTrack(contest.targetState, contest.actingUuid);
    const untilTurnKey = input?.untilTurnKey ?? input?.expiresAt ?? input?.jamExpiresAt ?? true;
    const existing = activeJams(track).find((jam) => String(jam.sourceUuid) === contest.actingUuid);
    if (existing) {
      existing.modifier = JAM_MODIFIER;
      existing.untilTurnKey = untilTurnKey;
      existing.active = true;
    } else {
      track.jams.push({
        sourceUuid: contest.actingUuid,
        modifier: JAM_MODIFIER,
        untilTurnKey,
        active: true,
      });
    }
  }
  return {
    targetUuid: contest.targetUuid,
    success,
    roll: contest.roll,
    attackerTotal: contest.attackerTotal,
    defense: contest.defense.defense,
    defendingOperatorUuid: contest.defense.operatorUuid,
  };
}

function downgradeAfterBrokenLock(track, passiveSupported) {
  clearTargetedKnowledge(track);
  track.passiveContact = passiveSupported === true;
  if (passiveSupported || markerLive(track.activeUntilTurnKey) || markerLive(track.physicalUntilTurnKey)) {
    track.state = TRACK_STATUS.CONTACT;
  } else {
    track.state = TRACK_STATUS.UNDETECTED;
    if (track.lastKnown) track.lastKnown.stale = true;
  }
}

export function breakLock(input) {
  const contest = prepareHostileEw(input);
  const recipientTrack = trackAt(contest.targetState, contest.actingUuid);
  const hadTargetedTrack = recipientTrack?.state === TRACK_STATUS.TARGETED;
  const success = contest.attackerTotal >= contest.defense.defense;
  let broken = false;
  let passiveSupported = false;
  if (success && hadTargetedTrack) {
    if (input?.passiveSupported != null) {
      passiveSupported = Boolean(input.passiveSupported);
    } else if (input?.recipientDistance != null) {
      passiveSupported = passiveDetection({
        targetUuid: contest.actingUuid,
        observerConfig: contest.targetConfig,
        observerState: contest.targetState,
        targetConfig: contest.actingConfig,
        targetState: contest.actingState,
        targetSignature: input?.actingSignature,
        distance: input.recipientDistance,
        sensorLineOfSight: input?.recipientSensorLineOfSight ?? input?.sensorLineOfSight,
        otherModifier: input?.recipientPassiveModifier,
      }).detected;
    }
    downgradeAfterBrokenLock(recipientTrack, passiveSupported);
    broken = true;
  }
  releaseOperatorControl(contest.actingState, input?.operatorUuid ?? input?.operatorId);
  return {
    targetUuid: contest.targetUuid,
    success,
    broken,
    hadTargetedTrack,
    resultingState: recipientTrack?.state ?? TRACK_STATUS.UNDETECTED,
    roll: contest.roll,
    attackerTotal: contest.attackerTotal,
    defense: contest.defense.defense,
  };
}

export function burnThrough(input) {
  const actingState = input?.actingState ?? input?.state;
  const actingConfig = input?.actingConfig ?? input?.config;
  const jammerState = input?.jammerState ?? input?.targetState;
  const jammerConfig = input?.jammerConfig ?? input?.targetConfig;
  const actingUuid = String(input?.actingUuid ?? "");
  const jammerUuid = String(input?.jammerUuid ?? input?.targetUuid ?? "");
  if (!actingState || !jammerState || !actingUuid || !jammerUuid) {
    violation("SENSOR_EW_PARTICIPANTS_REQUIRED", "Burn Through requires acting and jammer states and UUIDs");
  }
  const jamTrack = trackAt(actingState, jammerUuid);
  const jam = activeJams(jamTrack).find((candidate) => String(candidate.sourceUuid) === jammerUuid);
  if (!jam) violation("SENSOR_JAM_NOT_FOUND", "The selected active Jam does not exist", { jammerUuid });
  const { stats } = requireInActiveRange(actingState, { ...input, config: actingConfig });
  const roll = requireD20(input?.d20);
  const jamModifier = finiteNumber(jam.modifier, JAM_MODIFIER);
  const attackerTotal = roll
    + finiteNumber(input?.operatorSensors ?? input?.sensorsRating)
    + stats.ewModifier
    + jamModifier
    + finiteNumber(input?.ewModifier ?? input?.attackerModifier);
  const defense = highestEligiblePassiveEwDefense(jammerConfig, jammerState, {
    againstUuid: actingUuid,
    operators: input?.defendingOperators,
    defenseModifier: input?.defenseModifier,
  });
  const success = attackerTotal >= defense.defense;
  releaseOperatorControl(actingState, input?.operatorUuid ?? input?.operatorId);
  if (success) jamTrack.jams = jamTrack.jams.filter((candidate) => candidate !== jam);
  return {
    jammerUuid,
    success,
    removed: success,
    roll,
    attackerTotal,
    defense: defense.defense,
    defendingOperatorUuid: defense.operatorUuid,
  };
}

export function addPhysicalContact(state, input) {
  const targetUuid = targetUuidOf(input);
  const track = ensureTrack(state, targetUuid);
  const previousState = track.state;
  track.physicalUntilTurnKey = expirationMarker(
    input?.physicalUntilTurnKey ?? input?.expiresAt ?? input?.nextStartKey,
  );
  if (track.state === TRACK_STATUS.UNDETECTED) track.state = TRACK_STATUS.CONTACT;
  updateLastKnown(track, input?.observation ?? input, false);
  return { targetUuid, previousState, state: track.state, physical: true };
}

function pick(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = cloneValue(source[key]);
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizedRemembered(remembered) {
  if (!remembered || typeof remembered !== "object") return undefined;
  const result = pick(remembered, ["label", "size", "shipClass"]) ?? {};
  if (remembered.identity != null && typeof remembered.identity !== "object") {
    result.identity = remembered.identity;
  } else {
    const identity = pick(remembered.identity, ["id", "uuid", "label", "name"]);
    if (identity) result.identity = identity;
  }
  if (Array.isArray(remembered.componentIds)) {
    result.componentIds = remembered.componentIds.map(String);
  }
  if (Array.isArray(remembered.identifiedSubsystems)) {
    result.identifiedSubsystems = remembered.identifiedSubsystems.map((subsystem) => {
      if (subsystem == null || typeof subsystem !== "object") return String(subsystem);
      return pick(subsystem, ["id", "componentId", "label", "name", "class", "regions"]);
    }).filter(Boolean);
  }
  return Object.keys(result).length ? result : undefined;
}

export function sanitizeTrack(input) {
  const observerState = input?.observerState ?? input?.state;
  const track = input?.track ?? trackAt(observerState, input?.targetUuid);
  const targetUuid = String(track?.targetUuid ?? input?.targetUuid ?? "");
  if (!track) return { targetUuid, state: TRACK_STATUS.UNDETECTED };
  const state = Object.values(TRACK_STATUS).includes(track.state) ? track.state : TRACK_STATUS.UNDETECTED;
  const sanitized = { targetUuid, state };
  const remembered = sanitizedRemembered(track.remembered);
  if (remembered) sanitized.remembered = remembered;
  if (track.lastKnown) {
    sanitized.lastKnown = pick(track.lastKnown, ["position", "facing", "sceneId", "turnKey", "stale"]);
  }
  for (const key of ["activeUntilTurnKey", "physicalUntilTurnKey", "outsideRangeUntilTurnKey"]) {
    if (markerLive(track[key])) sanitized[key] = cloneValue(track[key]);
  }
  const jams = activeJams(track);
  if (jams.length) {
    sanitized.jams = jams.map((jam) => pick(jam, ["sourceUuid", "modifier", "untilTurnKey"]));
  }
  if (state !== TRACK_STATUS.TARGETED) return sanitized;

  const live = input?.telemetry ?? input?.targetTelemetry ?? {};
  const velocity = live.velocity ?? track.knownVelocity;
  const effectiveAc = live.effectiveAc ?? track.effectiveAc;
  if (velocity != null) sanitized.knownVelocity = cloneValue(velocity);
  if (Number.isFinite(Number(effectiveAc))) sanitized.effectiveAc = Number(effectiveAc);
  sanitized.defensesRevealed = track.defensesRevealed === true;
  sanitized.systemsRevealed = track.systemsRevealed === true;
  sanitized.firingSolution = track.firingSolution === true;
  if (sanitized.defensesRevealed) {
    const defenses = live.defenses ?? track.defenses;
    const defenseProjection = pick(defenses, [
      "currentShields",
      "maxShields",
      "shieldDistribution",
      "armor",
      "hullState",
      "defensiveProtocols",
    ]) ?? {};
    const shields = pick(defenses?.shields, [
      "current",
      "max",
      "hp",
      "allocation",
      "capacity",
      "distribution",
      "topology",
    ]);
    if (shields) defenseProjection.shields = shields;
    sanitized.defenses = Object.keys(defenseProjection).length ? defenseProjection : undefined;
  }
  if (sanitized.systemsRevealed) {
    const systems = live.systems ?? track.systems;
    sanitized.systems = pick(systems, [
      "damagedSystems",
      "offlineSystems",
      "installedWeapons",
      "weapons",
      "weaponArcs",
      "heat",
      "engineCapability",
      "faults",
      "hazards",
    ]);
  }
  return sanitized;
}
