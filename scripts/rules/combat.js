import { RuleViolation } from "../constants.js";
import { resolveAttack } from "./damage.js";
import { stableCoincidentNormal } from "./geometry.js";
import { bearingDegrees, magnitude } from "./math.js";
import { trackKey } from "./sensors.js";

const PROJECTILE_MULTIPLIERS = Object.freeze({
  instant: 0.5,
  fast: 0.75,
  medium: 1,
  slow: 1.25,
  veryslow: 1.5,
});

/** Inside Optimal Range a shot is worth +2: winning the positioning fight is a positive reward. */
const OPTIMAL_RANGE_BONUS = 2;

/** Kinetic evasion: a fast, actively jinking hull is harder to track (see getEvasionBonus). */
const EVASION_SPEED_STEPS = Object.freeze([
  Object.freeze({ min: 15, bonus: 1 }),
  Object.freeze({ min: 30, bonus: 1 }),
]);
const EVASION_JINK_THRESHOLD = 30;
const EVASION_JINK_BONUS = 1;

const BARRAGE_PROFILES = Object.freeze({
  1: Object.freeze({ rounds: 1, penalty: 0, maximumEffectiveHits: 1 }),
  4: Object.freeze({ rounds: 4, penalty: -2, maximumEffectiveHits: 2 }),
  6: Object.freeze({ rounds: 6, penalty: -3, maximumEffectiveHits: 3 }),
  8: Object.freeze({ rounds: 8, penalty: -4, maximumEffectiveHits: 4 }),
  10: Object.freeze({ rounds: 10, penalty: -5, maximumEffectiveHits: 5 }),
});

const RESERVED_TRAITS = new Set([
  "incendiary",
  "unreliable",
  "unstableoverclock",
]);
const EPSILON = 1e-9;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

const WEAPON_FAULT_LABELS = Object.freeze({
  minor: "Minor",
  major: "Major",
  critical: "Critical",
  destroyed: "Destroyed",
});

/** A modifier group stays unknown when any of its terms is unknown. */
function modifierGroupValue(items) {
  return items.every((item) => Number.isFinite(item.value))
    ? items.reduce((total, item) => total + item.value, 0)
    : null;
}

function vector(value) {
  return { x: finite(value?.x), y: finite(value?.y) };
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeDegrees(value) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/**
 * §10.11: coincident ship centers still need a direction, so every client derives
 * the same collision normal from the two stable token UUIDs instead of throwing.
 * The direction runs from `firstUuid` to `secondUuid`.
 */
function coincidentNormal(firstUuid, secondUuid) {
  return stableCoincidentNormal(firstUuid ?? "", secondUuid ?? "");
}

function projectileKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function traitKey(trait) {
  return String(
    typeof trait === "string" ? trait : trait?.id ?? trait?.name ?? "",
  )
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function hasTrait(traits, key) {
  return (traits ?? []).some((trait) => traitKey(trait) === key);
}

function validateTraits(traits, helpers) {
  for (const trait of traits ?? []) {
    const key = traitKey(trait);
    if (key === "shieldbypass") {
      const params = typeof trait === "object" ? trait.params ?? trait : null;
      const channels = Array.isArray(params?.channels)
        ? params.channels.map((channel) => String(channel).toLowerCase())
        : [];
      if (
        !params ||
        (!params.hull && !params.heat && !channels.includes("hull") &&
          !channels.includes("heat"))
      ) {
        throw new RuleViolation(
          "INCOMPLETE_SHIELD_BYPASS",
          "Shield Bypass must name Hull and/or Heat.",
        );
      }
    }
    if (!RESERVED_TRAITS.has(key)) continue;
    const rule = typeof trait === "object"
      ? trait.rule ?? trait.params ?? trait
      : null;
    if (!rule?.trigger || !rule?.timing || rule.result === undefined) {
      throw new RuleViolation(
        "INCOMPLETE_RESERVED_TRAIT",
        "Reserved weapon traits require trigger, timing, and result definitions.",
        {
          trait: typeof trait === "string" ? trait : trait?.id,
        },
      );
    }
    if (typeof helpers.resolveTrait !== "function") {
      throw new RuleViolation(
        "MISSING_TRAIT_RESOLVER",
        "Configured reserved traits require an injected resolver.",
      );
    }
  }
}

function mergeProfile(weapon, state) {
  const mode = state?.mode ?? "nominal";
  const modeEntry = weapon?.modes?.[mode];
  const overrides = modeEntry?.overrides ?? modeEntry ?? {};
  return {
    ...weapon,
    ...overrides,
    damage: { ...(weapon?.damage ?? {}), ...(overrides.damage ?? {}) },
    range: { ...(weapon?.range ?? {}), ...(overrides.range ?? {}) },
    firingHeat: typeof overrides.firingHeat === "object"
      ? {
        ...(typeof weapon?.firingHeat === "object" ? weapon.firingHeat : {}),
        ...overrides.firingHeat,
      }
      : overrides.firingHeat ?? weapon?.firingHeat,
    traits: overrides.traits ?? weapon?.traits ?? [],
  };
}

function weaponById(config, weaponId) {
  return config?.components?.weapons?.find((weapon) =>
    weapon.id === weaponId
  ) ?? null;
}

function hardpointById(config, hardpointId) {
  return config?.hardpoints?.find((hardpoint) =>
    hardpoint.id === hardpointId
  ) ?? null;
}

function targetTrack(state, targetId) {
  const rawKey = String(targetId ?? "");
  const key = trackKey(rawKey);
  return state?.tracks?.[key] ??
    (key === rawKey ? null : state?.tracks?.[rawKey]) ?? null;
}

function isTargeted(track) {
  return String(track?.state ?? track?.status ?? track?.level ?? "")
    .toLowerCase() === "targeted";
}

function hasFiringSolution(track) {
  return track?.firingSolution === true || track?.firingSolution === "ready" ||
    track?.firingSolution?.ready === true;
}

function assignedResource(config, state, operatorId) {
  const command = state?.roster?.command?.some((entry) =>
    (entry?.operatorId ?? entry) === operatorId
  );
  const crew = state?.roster?.crew?.some((entry) =>
    (entry?.operatorId ?? entry) === operatorId
  );
  const configured =
    config?.operators?.find((operator) =>
      operator.id === operatorId || operator.operatorId === operatorId
    ) ?? null;
  if (!command && !crew) return { configured, pool: null, remaining: 0 };
  const pool = command ? "actions" : "orders";
  return {
    configured,
    pool,
    remaining: finite(state?.resources?.[pool]?.[operatorId]),
  };
}

function gunneryRating(operator) {
  return finite(operator?.ratings?.gunnery, finite(operator?.gunnery));
}

function manualReloadActive(weaponState) {
  const work = weaponState?.reloadWork;
  if (Number.isFinite(work)) return work > 0;
  return Boolean(
    work && (work.active !== false) &&
      finite(work.current, 0) < finite(work.required, 1),
  );
}

function firingHeatCost(profile, rounds) {
  const heat = profile?.firingHeat;
  if (Number.isFinite(heat)) return heat;
  const amount = finite(heat?.amount);
  return heat?.per === "physicalRound" ? amount * rounds : amount;
}

function barrageProfile(profile, declaration) {
  const barrage = hasTrait(profile.traits, "barrage");
  const rounds = declaration.barrageRounds ?? 1;
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new RuleViolation(
      "INVALID_BARRAGE_PROFILE",
      "Barrage rounds must select a standard profile.",
    );
  }
  if (!barrage && rounds !== 1) {
    throw new RuleViolation(
      "WEAPON_NOT_BARRAGE",
      "Only a Barrage weapon may fire multiple physical rounds.",
    );
  }
  const selected = BARRAGE_PROFILES[rounds];
  if (!selected || (!barrage && rounds !== 1)) {
    throw new RuleViolation(
      "INVALID_BARRAGE_PROFILE",
      "Barrage rounds must be 1, 4, 6, 8, or 10.",
      { rounds },
    );
  }
  return selected;
}

/**
 * Kinetic evasion stack (decision: "go big, capped +4").
 * The Evasive Protocol's base +AC, plus one point per speed step reached, plus a jink point when the
 * ship actually spent Vector Authority this activation. The hull's tier selects the cap: the standard
 * protocol caps at `evasionAcBonus`, the hard protocol at `evasionHardAcCap`.
 * @param {object} config @param {object} state @returns {number}
 */
export function getEvasionBonus(config, state) {
  if (state?.evasion?.armed !== true) return 0;
  const base = finite(config?.evasionAcBonus, 2);
  const hard = state.evasion.tier === "hard";
  const cap = hard ? finite(config?.evasionHardAcCap, 4) : base;
  let bonus = base;
  const speed = magnitude(vector(state?.velocity));
  for (const step of EVASION_SPEED_STEPS) {
    if (speed >= step.min) bonus += step.bonus;
  }
  if (finite(state?.pivotSpent, 0) >= EVASION_JINK_THRESHOLD) bonus += EVASION_JINK_BONUS;
  return Math.min(cap, Math.max(0, bonus));
}

/** @param {object} config @param {object} state @returns {number} */
export function getEffectiveAttackAC(config, state) {
  return finite(config?.ac) + getEvasionBonus(config, state);
}

function knownTargetAC(track, actual) {
  return finite(track?.effectiveAc, finite(track?.ac, actual));
}

function componentById(config, componentId) {
  const components = config?.components ?? {};
  for (const value of Object.values(components)) {
    if (Array.isArray(value)) {
      const found = value.find((component) => component?.id === componentId);
      if (found) return found;
    } else if (value?.id === componentId) {
      return value;
    }
  }
  return Object.values(components.drives ?? {}).find((drive) =>
    drive?.id === componentId
  ) ?? null;
}

function componentKnown(track, componentId, declaration, helpers) {
  if (typeof helpers.isAimedComponentKnown === "function") {
    return helpers.isAimedComponentKnown(track, componentId, declaration) ===
      true;
  }
  if (
    declaration.aimedComponentKnown === true || track?.systemsRevealed === true
  ) return true;
  const remembered = track?.remembered?.identifiedSubsystems ??
    track?.remembered?.components ?? track?.identifiedComponents ??
    track?.knownComponents ?? [];
  return Array.isArray(remembered)
    ? remembered.some((entry) => (entry?.id ?? entry) === componentId)
    : Boolean(remembered?.[componentId]);
}

function componentDestroyed(state, componentId) {
  return Object.values(state?.conditions ?? {}).some((condition) =>
    (condition?.componentId === componentId ||
      condition?.targetId === componentId) &&
    String(condition?.severity ?? "").toLowerCase() === "destroyed"
  );
}
function conditionSeverity(state, channel, componentId) {
  const ranks = { healthy: 0, minor: 1, major: 2, critical: 3, destroyed: 4 };
  let selected = "healthy";
  for (const condition of Object.values(state?.conditions ?? {})) {
    const conditionChannel = condition?.conditionId ?? condition?.channelId ??
      condition?.channel;
    const target = condition?.targetId ?? condition?.componentId;
    const severity = String(condition?.severity ?? "healthy").toLowerCase();
    if (
      conditionChannel === channel && target === componentId &&
      (ranks[severity] ?? 0) > ranks[selected]
    ) {
      selected = severity;
    }
  }
  return selected;
}

function localWeaponFault(state, weaponId) {
  const severity = conditionSeverity(state, "weaponMalfunction", weaponId);
  const effects = {
    healthy: { accuracyModifier: 0, canOverclock: true, canFire: true },
    minor: { accuracyModifier: -2, canOverclock: true, canFire: true },
    major: { accuracyModifier: -4, canOverclock: false, canFire: true },
    critical: { accuracyModifier: -6, canOverclock: false, canFire: true },
    destroyed: { accuracyModifier: 0, canOverclock: false, canFire: false },
  };
  return { severity, ...effects[severity] };
}

function localSensorFault(config, state) {
  const sensorId = config?.components?.sensor?.id;
  const severity = conditionSeverity(state, "sensorFault", sensorId);
  return {
    severity,
    activeModifier: {
      healthy: 0,
      minor: -2,
      major: -4,
      critical: -6,
      destroyed: 0,
    }[severity],
  };
}

function activeJamModifier(track) {
  return (track?.jams ?? [])
    .filter((jam) => jam?.active !== false)
    .reduce(
      (modifier, jam) => Math.min(modifier, finite(jam?.modifier, -4)),
      0,
    );
}

function aimedConditionId(config, componentId, sector) {
  const pool = config?.criticalPools?.[sector] ?? [];
  const entry = pool.find((candidate) =>
    (candidate?.targetId ?? candidate?.componentId) === componentId &&
    (candidate?.kind ?? "fault") !== "hazard"
  );
  if (!entry) return null;
  const channel = entry.channelId ?? entry.conditionId;
  const target = entry.componentId ?? entry.targetId;
  if (!channel || !target) return null;
  return `${target}:${channel}${entry.sector ? `:${entry.sector}` : ""}`;
}

function componentInSector(config, component, componentId, sector) {
  if (Array.isArray(component?.regions)) {
    return component.regions.includes(sector);
  }
  return aimedConditionId(config, componentId, sector) !== null;
}

function localConsumeFiringSolution(state, targetId) {
  const track = targetTrack(state, targetId);
  if (!isTargeted(track) || !hasFiringSolution(track)) {
    throw new RuleViolation(
      "FIRING_SOLUTION_UNAVAILABLE",
      "No ready Firing Solution exists for this target.",
    );
  }
  track.firingSolution = false;
  return { targetUuid: targetId, consumed: true, modifier: 4 };
}

function localReleaseControls(state, operatorId) {
  for (const [key, holder] of Object.entries(state.controls ?? {})) {
    if ((holder?.operatorId ?? holder) === operatorId) {
      state.controls[key] = null;
    }
  }
}

function localSpend(state, operatorId, pool) {
  state.resources[pool][operatorId] -= 1;
  localReleaseControls(state, operatorId);
  return {
    operatorId,
    pool,
    spent: 1,
    remaining: state.resources[pool][operatorId],
  };
}

function setSignatureSpike(state, weaponId, modifier) {
  if (!Array.isArray(state.effects)) state.effects = [];
  const category = `weapon:${weaponId}`;
  const next = state.effects.filter((effect) =>
    !(effect?.type === "signature" && effect?.category === category)
  );
  next.push({
    id: `weapon-signature:${weaponId}`,
    type: "signature",
    category,
    sourceId: weaponId,
    modifier,
    expiresAt: "nextStart",
  });
  state.effects = next;
}

function violation(code, message, details = {}) {
  return { code, message, details };
}

function snapshotFields(state, keys) {
  return Object.fromEntries(keys.map((key) => [key, cloneValue(state[key])]));
}

function restoreFields(state, snapshot) {
  for (const [key, value] of Object.entries(snapshot)) state[key] = value;
}
function readinessDefinition(config, weaponId) {
  const weapon = weaponById(config, weaponId);
  if (!weapon) {
    throw new RuleViolation(
      "WEAPON_NOT_FOUND",
      "The selected installed weapon does not exist.",
      { weaponId },
    );
  }
  const readiness = weapon.readiness;
  if (
    !readiness || !Number.isInteger(readiness.capacity) ||
    readiness.capacity < 0
  ) {
    throw new RuleViolation(
      "INVALID_WEAPON_READINESS",
      "Weapon readiness requires a non-negative integer capacity.",
      { weaponId },
    );
  }
  return { weapon, readiness };
}

function readinessState(draft, weaponId) {
  const state = draft?.weapons?.[weaponId];
  if (!state) {
    throw new RuleViolation(
      "WEAPON_NOT_FOUND",
      "Mutable weapon state does not exist.",
      { weaponId },
    );
  }
  return state;
}

function recoveryFault(config, draft, weaponId, helpers) {
  return typeof helpers.getFaultEffects === "function"
    ? helpers.getFaultEffects(config, draft, {
      componentId: weaponId,
      channel: "weaponMalfunction",
    })
    : localWeaponFault(draft, weaponId);
}

function readinessResult(event) {
  return { public: event, gm: event };
}

/** @param {object} config @param {object} draft @param {{weaponId:string}} input @param {object} [helpers] @returns {{public:object,gm:object}} */
export function advanceWeaponRecovery(config, draft, input, helpers = {}) {
  const { readiness } = readinessDefinition(config, input.weaponId);
  const state = readinessState(draft, input.weaponId);
  if (readiness.recovery !== "automaticStart") {
    throw new RuleViolation(
      "WEAPON_NOT_AUTOMATIC_RECOVERY",
      "This weapon does not recover readiness automatically.",
      { weaponId: input.weaponId },
    );
  }
  const before = finite(state.readiness);
  const progressBefore = Math.max(0, Math.trunc(finite(state.reloadProgress)));
  if (before >= readiness.capacity) {
    state.readiness = readiness.capacity;
    state.reloadProgress = 0;
    return readinessResult({
      weaponId: input.weaponId,
      eligible: state.status === "online",
      recovered: 0,
      before,
      after: state.readiness,
      progressBefore,
      progressAfter: 0,
    });
  }
  const fault = recoveryFault(config, draft, input.weaponId, helpers);
  if (
    state.status !== "online" || fault.canFire === false ||
    fault.operational === false
  ) {
    return readinessResult({
      weaponId: input.weaponId,
      eligible: false,
      recovered: 0,
      before,
      after: before,
      progressBefore,
      progressAfter: progressBefore,
    });
  }
  const requiredStarts =
    Math.max(1, Math.trunc(finite(readiness.eligibleStarts, 1))) *
    Math.max(
      1,
      Math.trunc(
        finite(
          fault.recoveryTimeMultiplier,
          fault.severity === "critical" ? 2 : 1,
        ),
      ),
    );
  const progress = progressBefore + 1;
  const complete = progress >= requiredStarts;
  state.readiness = complete ? readiness.capacity : before;
  state.reloadProgress = complete ? 0 : progress;
  draft.revision = Math.max(0, Math.trunc(finite(draft.revision))) + 1;
  return readinessResult({
    weaponId: input.weaponId,
    eligible: true,
    recovered: complete ? readiness.capacity - before : 0,
    before,
    after: state.readiness,
    progressBefore,
    progressAfter: state.reloadProgress,
    requiredStarts,
    complete,
  });
}

/** @param {object} config @param {object} draft @param {{weaponId:string}} input @param {object} [helpers] @returns {{public:object,gm:object}} */
export function beginWeaponReload(config, draft, input, helpers = {}) {
  const { readiness } = readinessDefinition(config, input.weaponId);
  const state = readinessState(draft, input.weaponId);
  if (readiness.recovery !== "manualWork") {
    throw new RuleViolation(
      "WEAPON_NOT_MANUAL_RELOAD",
      "This weapon does not use manual reload Work.",
      { weaponId: input.weaponId },
    );
  }
  if (manualReloadActive(state)) {
    throw new RuleViolation(
      "WEAPON_ALREADY_RELOADING",
      "A manual reload is already in progress.",
      { weaponId: input.weaponId },
    );
  }
  if (finite(state.readiness) >= readiness.capacity) {
    throw new RuleViolation(
      "WEAPON_ALREADY_FULL",
      "A full weapon cannot begin a manual reload.",
      { weaponId: input.weaponId },
    );
  }
  const fault = recoveryFault(config, draft, input.weaponId, helpers);
  const baseRequired = Math.max(1, Math.trunc(finite(readiness.work, 1)));
  const multiplier = Math.max(
    1,
    Math.trunc(
      finite(
        fault.recoveryTimeMultiplier,
        fault.severity === "critical" ? 2 : 1,
      ),
    ),
  );
  state.reloadWork = {
    current: 0,
    baseRequired,
    required: baseRequired * multiplier,
  };
  if (draft.work) delete draft.work[`reload:${input.weaponId}`];
  draft.revision = Math.max(0, Math.trunc(finite(draft.revision))) + 1;
  return readinessResult({
    weaponId: input.weaponId,
    started: true,
    ...state.reloadWork,
    readiness: state.readiness,
  });
}

/** @param {object} config @param {object} draft @param {{weaponId:string,amount?:number}} input @param {object} [helpers] @returns {{public:object,gm:object}} */
export function contributeWeaponReload(config, draft, input, helpers = {}) {
  const { readiness } = readinessDefinition(config, input.weaponId);
  const state = readinessState(draft, input.weaponId);
  if (!manualReloadActive(state)) {
    throw new RuleViolation(
      "WEAPON_NOT_RELOADING",
      "No manual reload Work is in progress.",
      { weaponId: input.weaponId },
    );
  }
  const amount = input.amount ?? 1;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RuleViolation(
      "INVALID_RELOAD_WORK",
      "Reload contribution must be a positive integer.",
      { amount },
    );
  }
  const fault = recoveryFault(config, draft, input.weaponId, helpers);
  const baseRequired = Math.max(
    1,
    Math.trunc(finite(state.reloadWork.baseRequired, readiness.work ?? 1)),
  );
  const multiplier = Math.max(
    1,
    Math.trunc(
      finite(
        fault.recoveryTimeMultiplier,
        fault.severity === "critical" ? 2 : 1,
      ),
    ),
  );
  const required = baseRequired * multiplier;
  const current = Math.min(
    required,
    Math.max(0, Math.trunc(finite(state.reloadWork.current))) + amount,
  );
  const complete = current >= required;
  const before = finite(state.readiness);
  state.readiness = complete ? readiness.capacity : before;
  state.reloadProgress = 0;
  state.reloadWork = complete ? null : { current, baseRequired, required };
  if (complete && draft.work) delete draft.work[`reload:${input.weaponId}`];
  draft.revision = Math.max(0, Math.trunc(finite(draft.revision))) + 1;
  return readinessResult({
    weaponId: input.weaponId,
    amount,
    current,
    required,
    complete,
    before,
    after: state.readiness,
  });
}

/** @param {object} config @param {object} draft @param {{weaponId:string}} input @returns {{public:object,gm:object}} */
export function cancelWeaponReload(config, draft, input) {
  readinessDefinition(config, input.weaponId);
  const state = readinessState(draft, input.weaponId);
  if (!manualReloadActive(state)) {
    throw new RuleViolation(
      "WEAPON_NOT_RELOADING",
      "No manual reload Work is in progress.",
      { weaponId: input.weaponId },
    );
  }
  const lostWork = Math.max(0, Math.trunc(finite(state.reloadWork?.current)));
  state.reloadWork = null;
  if (draft.work) delete draft.work[`reload:${input.weaponId}`];
  draft.revision = Math.max(0, Math.trunc(finite(draft.revision))) + 1;
  return readinessResult({
    weaponId: input.weaponId,
    canceled: true,
    lostWork,
    readiness: state.readiness,
  });
}

/** @param {number} distance @param {number} optimal @param {number} maximum @returns {object} */
export function calculateRangeBand(distance, optimal, maximum) {
  if (
    ![distance, optimal, maximum].every(Number.isFinite) || distance < 0 ||
    optimal < 0 || maximum < optimal
  ) {
    throw new RuleViolation(
      "INVALID_RANGE_PROFILE",
      "Range values must satisfy 0 <= Optimal <= Maximum and distance >= 0.",
    );
  }
  if (distance <= optimal) {
    return { valid: true, band: "optimal", modifier: OPTIMAL_RANGE_BONUS, fraction: 0 };
  }
  if (distance > maximum) {
    return {
      valid: false,
      band: "beyondMaximum",
      modifier: null,
      fraction: null,
    };
  }
  const fraction = maximum === optimal
    ? 1
    : (distance - optimal) / (maximum - optimal);
  const quarter = Math.min(4, Math.max(1, Math.ceil(fraction * 4 - EPSILON)));
  return {
    valid: true,
    band: `extended${quarter}`,
    modifier: -quarter,
    fraction,
  };
}

/** @param {object} input @returns {object} */
export function calculateRelativeMotion(input) {
  const shooterPosition = vector(input.shooterPosition);
  const targetPosition = vector(input.targetPosition);
  const shooterVelocity = vector(input.shooterVelocity);
  const targetVelocity = vector(input.targetVelocity);
  const relativeVelocity = {
    x: targetVelocity.x - shooterVelocity.x,
    y: targetVelocity.y - shooterVelocity.y,
  };
  const line = {
    x: targetPosition.x - shooterPosition.x,
    y: targetPosition.y - shooterPosition.y,
  };
  const distance = Math.hypot(line.x, line.y);
  let radialSpeed = 0;
  let transverseSpeed = Math.hypot(relativeVelocity.x, relativeVelocity.y);
  if (distance > EPSILON) {
    const ux = line.x / distance;
    const uy = line.y / distance;
    const radial = relativeVelocity.x * ux + relativeVelocity.y * uy;
    radialSpeed = Math.abs(radial);
    const transverseX = relativeVelocity.x - radial * ux;
    const transverseY = relativeVelocity.y - radial * uy;
    transverseSpeed = Math.hypot(transverseX, transverseY);
  }
  const key = projectileKey(input.projectileClass);
  const multiplier = PROJECTILE_MULTIPLIERS[key];
  if (!Number.isFinite(multiplier)) {
    throw new RuleViolation(
      "INVALID_PROJECTILE_CLASS",
      "Projectile class must be Instant, Fast, Medium, Slow, or Very Slow.",
      {
        projectileClass: input.projectileClass,
      },
    );
  }
  const rawMotion = transverseSpeed + 0.25 * radialSpeed;
  const effectiveMotion = rawMotion * multiplier;
  // Standing still is neutral, not rewarded: the low bands carry no bonus, and penalties only
  // start once a target is genuinely crossing (decision: "kinetic evasion" rework).
  let modifier;
  let band;
  if (effectiveMotion <= 2 + EPSILON) [modifier, band] = [0, "0-2"];
  else if (effectiveMotion <= 4 + EPSILON) [modifier, band] = [0, ">2-4"];
  else if (effectiveMotion <= 6 + EPSILON) [modifier, band] = [0, ">4-6"];
  else if (effectiveMotion <= 8 + EPSILON) [modifier, band] = [-2, ">6-8"];
  else if (effectiveMotion <= 10 + EPSILON) [modifier, band] = [-4, ">8-10"];
  else if (effectiveMotion <= 12 + EPSILON) [modifier, band] = [-6, ">10-12"];
  else [modifier, band] = [-8, ">12"];
  return {
    relativeVelocity,
    transverseSpeed,
    radialSpeed,
    rawMotion,
    projectileMultiplier: multiplier,
    effectiveMotion,
    band,
    modifier,
  };
}

/** @param {{shooterPosition:object,targetPosition:object,shooterFacing:number,hardpointOrientation:number,arcWidth:number,coincidentNormal?:object}} input @returns {boolean} */
export function isWithinFiringArc(input) {
  const width = finite(input.arcWidth, NaN);
  if (!Number.isFinite(width) || width < 0 || width > 360) {
    throw new RuleViolation(
      "INVALID_FIRING_ARC",
      "Firing arc width must be between 0 and 360 degrees.",
    );
  }
  if (width >= 360) return true;
  const bearing = bearingDegrees(
    vector(input.shooterPosition),
    vector(input.targetPosition),
    vector(input.coincidentNormal),
  );
  const center = normalizeDegrees(
    finite(input.shooterFacing) + finite(input.hardpointOrientation),
  );
  return Math.abs(normalizeDegrees(bearing - center)) <= width / 2 + EPSILON;
}

/** @param {{attackerPosition:object,targetPosition:object,targetFacing:number,coincidentNormal?:object}} input @returns {'fore'|'port'|'starboard'|'aft'} */
export function calculateStruckSector(input) {
  const bearing = bearingDegrees(
    vector(input.targetPosition),
    vector(input.attackerPosition),
    vector(input.coincidentNormal),
  );
  const relative = normalizeDegrees(bearing - finite(input.targetFacing));
  if (relative >= -45 && relative < 45) return "fore";
  if (relative >= 45 && relative < 135) return "starboard";
  if (relative >= -135 && relative < -45) return "port";
  return "aft";
}

/** @param {number} naturalRoll @param {number} total @param {number} ac @param {object} profile @returns {number} */
export function calculateEffectiveHits(
  naturalRoll,
  total,
  ac,
  profile = BARRAGE_PROFILES[1],
) {
  if (naturalRoll === 1) return 0;
  const margin = total - ac;
  const normalHits = margin < 0
    ? 0
    : Math.max(1, Math.min(5, Math.floor(margin)));
  const hits = naturalRoll === 20 ? Math.max(1, normalHits) : normalHits;
  return Math.min(profile.maximumEffectiveHits, hits);
}

function makePreview(context) {
  const {
    attackerConfig,
    attackerState,
    targetConfig,
    targetState,
    declaration,
    helpers = {},
  } = context;
  const violations = [];
  const targetId = declaration.targetUuid ?? declaration.targetId;
  const attackerToTarget = coincidentNormal(declaration.attackerUuid, targetId);
  const targetToAttacker = coincidentNormal(targetId, declaration.attackerUuid);
  const operatorId = declaration.operatorId;
  const track = targetTrack(attackerState, targetId);
  const weapon = weaponById(attackerConfig, declaration.weaponId);
  const weaponState = attackerState?.weapons?.[declaration.weaponId];
  const assigned = assignedResource(attackerConfig, attackerState, operatorId);

  if (
    attackerState?.pendingFate?.status === "pending" ||
    finite(attackerState?.hull) <= 0
  ) {
    violations.push(
      violation(
        "ATTACKER_INACTIVE",
        "A ship awaiting or resolved fate cannot begin a deliberate attack.",
      ),
    );
  }
  if (
    targetState?.pendingFate?.status === "pending" ||
    finite(targetState?.hull) <= 0
  ) {
    violations.push(
      violation(
        "TARGET_INACTIVE",
        "The target cannot receive a new deliberate attack.",
      ),
    );
  }
  if (
    declaration.expectedAttackerRevision !== undefined &&
    declaration.expectedAttackerRevision !== attackerState?.revision
  ) {
    violations.push(
      violation(
        "STALE_ATTACK_PREVIEW",
        "Attacker state changed after preview.",
      ),
    );
  }
  if (
    declaration.expectedTargetRevision !== undefined &&
    declaration.expectedTargetRevision !== targetState?.revision
  ) {
    violations.push(
      violation("STALE_ATTACK_PREVIEW", "Target state changed after preview."),
    );
  }
  if (!isTargeted(track)) {
    violations.push(
      violation("TARGET_NOT_TARGETED", "An attack requires a Targeted track."),
    );
  }
  if (!weapon || !weaponState) {
    violations.push(
      violation(
        "WEAPON_NOT_FOUND",
        "The selected installed weapon does not exist.",
      ),
    );
  }
  if (!assigned.pool) {
    violations.push(
      violation(
        "OPERATOR_NOT_ASSIGNED",
        "The operator is not assigned to a Command or Crew slot.",
      ),
    );
  }
  if (assigned.pool && assigned.remaining < 1) {
    violations.push(
      violation(
        "INSUFFICIENT_OPERATION_RESOURCE",
        "The operator has no remaining Action or Order.",
      ),
    );
  }
  if (assigned.configured && gunneryRating(assigned.configured) <= 0) {
    violations.push(
      violation(
        "OPERATOR_INELIGIBLE",
        "The operator lacks a usable Gunnery rating.",
      ),
    );
  }

  if (!weapon || !weaponState) return { legal: false, violations };
  const profile = mergeProfile(weapon, weaponState);
  validateTraits(profile.traits, helpers);
  let selectedBarrage;
  try {
    selectedBarrage = barrageProfile(profile, declaration);
  } catch (error) {
    if (!(error instanceof RuleViolation)) throw error;
    violations.push(violation(error.code, error.message, error.details));
    selectedBarrage = BARRAGE_PROFILES[1];
  }
  const weaponFault = typeof helpers.getFaultEffects === "function"
    ? helpers.getFaultEffects(attackerConfig, attackerState, {
      componentId: weapon.id,
      channel: "weaponMalfunction",
    })
    : localWeaponFault(attackerState, weapon.id);

  if (weaponState.status !== "online") {
    violations.push(violation("WEAPON_OFFLINE", "The weapon must be Online."));
  }
  if (weaponFault.canFire === false || weaponFault.operational === false) {
    violations.push(
      violation("WEAPON_DESTROYED", "A Destroyed weapon cannot fire."),
    );
  }
  if (weaponState.mode === "overclock" && weaponFault.canOverclock === false) {
    violations.push(
      violation(
        "WEAPON_OVERCLOCK_BLOCKED",
        "The current Weapon Malfunction prevents Overclock fire.",
      ),
    );
  }
  const powered = typeof helpers.isWeaponPowered === "function"
    ? helpers.isWeaponPowered(attackerConfig, attackerState, {
      weapon,
      profile,
    }) === true
    : finite(attackerState?.power?.weapons) >= finite(profile.powerRating);
  if (!powered) {
    violations.push(
      violation(
        "WEAPON_UNPOWERED",
        "The weapon lacks sufficient Weapons Power.",
      ),
    );
  }
  if (manualReloadActive(weaponState)) {
    violations.push(
      violation(
        "WEAPON_RELOADING",
        "A weapon undergoing manual reload cannot fire.",
      ),
    );
  }
  if (finite(weaponState.readiness) < selectedBarrage.rounds) {
    violations.push(
      violation(
        "WEAPON_NOT_READY",
        "The weapon lacks the required ready shots, charges, or ammunition.",
        {
          required: selectedBarrage.rounds,
          available: finite(weaponState.readiness),
        },
      ),
    );
  }

  const shooterPosition = vector(
    declaration.attackerPosition ?? attackerState?.position,
  );
  const targetPosition = vector(
    declaration.targetPosition ?? targetState?.position,
  );
  const shooterVelocity = vector(
    declaration.attackerVelocity ?? attackerState?.velocity,
  );
  const targetVelocity = vector(
    declaration.targetVelocity ?? targetState?.velocity,
  );
  const distance = Math.hypot(
    targetPosition.x - shooterPosition.x,
    targetPosition.y - shooterPosition.y,
  );
  const range = calculateRangeBand(
    distance,
    finite(profile?.range?.optimal),
    finite(profile?.range?.maximum),
  );
  if (!range.valid) {
    violations.push(
      violation("TARGET_OUT_OF_RANGE", "The target is beyond Maximum Range."),
    );
  }

  const hardpoint = hardpointById(attackerConfig, weapon.hardpointId);
  const hardpointOrientation = finite(
    declaration.hardpointOrientation,
    finite(hardpoint?.orientation),
  );
  const arcInput = {
    origin: shooterPosition,
    target: targetPosition,
    facing: finite(declaration.attackerFacing, finite(attackerState?.facing)),
    arcCenter: hardpointOrientation,
    arcWidth: finite(profile.arc),
    coincidentNormal: attackerToTarget,
  };
  const arcValid = typeof helpers.isInFiringArc === "function"
    ? helpers.isInFiringArc(arcInput) === true
    : isWithinFiringArc({
      shooterPosition: arcInput.origin,
      targetPosition: arcInput.target,
      shooterFacing: arcInput.facing,
      hardpointOrientation: arcInput.arcCenter,
      arcWidth: arcInput.arcWidth,
      coincidentNormal: attackerToTarget,
    });
  if (!arcValid) {
    violations.push(
      violation(
        "TARGET_OUT_OF_ARC",
        "The target is outside the installed firing arc.",
      ),
    );
  }
  const lineOfSightValid = declaration.lineOfSight === true;
  if (!lineOfSightValid) {
    violations.push(
      violation(
        "WEAPON_LINE_OF_SIGHT_BLOCKED",
        "Unblocked weapon line of sight is required.",
      ),
    );
  }

  const sectorInput = {
    target: targetPosition,
    source: shooterPosition,
    facing: finite(declaration.targetFacing, finite(targetState?.facing)),
    coincidentNormal: targetToAttacker,
  };
  const sector = typeof helpers.struckSector === "function"
    ? helpers.struckSector(sectorInput)
    : calculateStruckSector({
      attackerPosition: sectorInput.source,
      targetPosition: sectorInput.target,
      targetFacing: sectorInput.facing,
      coincidentNormal: targetToAttacker,
    });
  const relativeMotion = calculateRelativeMotion({
    shooterPosition,
    targetPosition,
    shooterVelocity,
    targetVelocity,
    projectileClass: profile.projectileClass,
  });

  const solutionReady = hasFiringSolution(track);
  let aimedCondition = null;
  if (declaration.aimedComponentId) {
    if (!solutionReady) {
      violations.push(
        violation(
          "AIMED_SHOT_REQUIRES_SOLUTION",
          "An aimed shot requires a ready Firing Solution.",
        ),
      );
    }
    const component = componentById(targetConfig, declaration.aimedComponentId);
    if (!component) {
      violations.push(
        violation(
          "INVALID_AIMED_COMPONENT",
          "The aimed target must be an installed subsystem.",
        ),
      );
    } else {
      if (!componentKnown(track, component.id, declaration, helpers)) {
        violations.push(
          violation(
            "AIMED_COMPONENT_UNKNOWN",
            "The aimed subsystem has not been identified.",
          ),
        );
      }
      aimedCondition = aimedConditionId(targetConfig, component.id, sector);
      if (
        !componentInSector(targetConfig, component, component.id, sector) ||
        !aimedCondition
      ) {
        violations.push(
          violation(
            "AIMED_COMPONENT_OUT_OF_REGION",
            "The aimed subsystem has no condition target in the struck region.",
          ),
        );
      }
      if (componentDestroyed(targetState, component.id)) {
        violations.push(
          violation(
            "AIMED_COMPONENT_DESTROYED",
            "A Destroyed subsystem cannot be selected for an aimed shot.",
          ),
        );
      }
    }
  }

  if (typeof helpers.isOperatorEligible === "function") {
    const eligibility = helpers.isOperatorEligible(
      attackerConfig,
      attackerState,
      {
        operatorId,
        operation: "attack",
        weaponId: weapon.id,
      },
    );
    if (eligibility !== true && eligibility?.eligible !== true) {
      violations.push(
        violation(
          "OPERATOR_INELIGIBLE",
          "The assigned operator is not eligible to fire this weapon.",
        ),
      );
    }
  }
  const sensorFault = typeof helpers.getFaultEffects === "function"
    ? helpers.getFaultEffects(attackerConfig, attackerState, {
      componentId: attackerConfig?.components?.sensor?.id,
      channel: "sensorFault",
    })
    : localSensorFault(attackerConfig, attackerState);
  const jamModifier = activeJamModifier(track);

  const targetAc = getEffectiveAttackAC(targetConfig, targetState);
  const sensorFaultModifier = finite(
    sensorFault.activeModifier,
    finite(sensorFault.ewModifier),
  );
  // Itemized beside the group totals so the console can show where each point
  // comes from instead of re-deriving the arithmetic from the totals.
  const weaponItems = [
    { id: "weaponAccuracy", label: "Weapon accuracy", value: finite(profile.accuracy) },
  ];
  if (finite(weaponFault.accuracyModifier)) {
    weaponItems.push({
      id: "weaponMalfunction",
      label: `${WEAPON_FAULT_LABELS[weaponFault.severity] ?? "Weapon malfunction"} malfunction`,
      value: finite(weaponFault.accuracyModifier),
    });
  }
  if (finite(declaration.weaponModifier)) {
    weaponItems.push({
      id: "weaponDeclared",
      label: "Declared weapon modifier",
      value: finite(declaration.weaponModifier),
    });
  }
  const sensorItems = [];
  if (solutionReady) {
    sensorItems.push({ id: "firingSolution", label: "Firing solution", value: 4 });
  }
  if (finite(jamModifier)) {
    sensorItems.push({ id: "jamming", label: "Jamming", value: finite(jamModifier) });
  }
  if (finite(declaration.jammingModifier)) {
    sensorItems.push({
      id: "jammingDeclared",
      label: "Declared jamming",
      value: finite(declaration.jammingModifier),
    });
  }
  if (sensorFaultModifier) {
    sensorItems.push({
      id: "sensorFault",
      label: "Sensor fault",
      value: sensorFaultModifier,
    });
  }
  if (finite(declaration.sensorModifier)) {
    sensorItems.push({
      id: "sensorDeclared",
      label: "Declared sensor modifier",
      value: finite(declaration.sensorModifier),
    });
  }
  const specialItems = [];
  if (selectedBarrage.rounds > 1) {
    specialItems.push({
      id: "barrage",
      label: `Barrage ×${selectedBarrage.rounds}`,
      value: selectedBarrage.penalty,
    });
  }
  if (declaration.aimedComponentId) {
    specialItems.push({ id: "aimedShot", label: "Aimed shot", value: -4 });
  }
  if (finite(declaration.specialModifier)) {
    specialItems.push({
      id: "specialDeclared",
      label: "Declared special modifier",
      value: finite(declaration.specialModifier),
    });
  }
  const modifierGroups = [
    {
      id: "gunnery",
      label: "Gunnery",
      items: [{
        id: "gunneryRating",
        label: "Gunnery rating",
        value: finite(
          declaration.gunneryModifier,
          gunneryRating(assigned.configured),
        ),
      }],
    },
    { id: "weapon", label: "Weapon", items: weaponItems },
    {
      id: "range",
      label: "Range",
      items: [{
        id: "rangeBand",
        label: "Range band",
        detail: range.band,
        value: range.modifier,
      }],
    },
    {
      id: "relativeMotion",
      label: "Motion",
      items: [{
        id: "motionBand",
        label: "Relative motion",
        detail: relativeMotion.band,
        value: relativeMotion.modifier,
      }],
    },
    { id: "sensors", label: "Sensors", items: sensorItems },
    { id: "special", label: "Special", items: specialItems },
  ];
  const categories = Object.fromEntries(
    modifierGroups.map((group) => [group.id, modifierGroupValue(group.items)]),
  );
  const knownModifierTotal = Object.values(categories).every(Number.isFinite)
    ? Object.values(categories).reduce((sum, value) => sum + value, 0)
    : null;
  const costs = {
    operation: {
      operatorId,
      pool: assigned.pool,
      amount: 1,
      before: assigned.remaining,
      after: assigned.remaining - 1,
    },
    readiness: {
      weaponId: weapon.id,
      amount: selectedBarrage.rounds,
      before: finite(weaponState.readiness),
      after: finite(weaponState.readiness) - selectedBarrage.rounds,
    },
    firingHeat: {
      before: finite(attackerState.heat),
      amount: firingHeatCost(profile, selectedBarrage.rounds),
      after: finite(attackerState.heat) +
        firingHeatCost(profile, selectedBarrage.rounds),
    },
    firingSolution: { targetId, ready: solutionReady, consumed: solutionReady },
    signature: {
      weaponId: weapon.id,
      modifier: finite(profile.signatureSpike),
    },
  };
  const geometry = {
    shooterPosition,
    targetPosition,
    shooterVelocity,
    targetVelocity,
    shooterFacing: arcInput.facing,
    targetFacing: sectorInput.facing,
    hardpointOrientation,
    distance,
    arcValid,
    rangeValid: range.valid,
    lineOfSightValid,
    sector,
  };
  const attack = {
    targetId,
    targetUuid: targetId,
    weaponId: weapon.id,
    operatorId,
    attackerRevision: attackerState?.revision,
    targetRevision: targetState?.revision,
    targetAc,
    categories,
    knownModifierTotal,
    geometry,
    range,
    relativeMotion,
    barrage: selectedBarrage,
    profile: {
      accuracy: finite(profile.accuracy),
      damage: {
        shield: finite(profile?.damage?.shield),
        hull: finite(profile?.damage?.hull),
        heat: finite(profile?.damage?.heat),
      },
      armorPiercing: finite(profile.armorPiercing),
      projectileClass: profile.projectileClass,
      firingHeat: cloneValue(profile.firingHeat),
      signatureSpike: finite(profile.signatureSpike),
      traits: cloneValue(profile.traits),
    },
    aimedComponentId: declaration.aimedComponentId ?? null,
    aimedConditionId: aimedCondition,
    costs,
  };

  const defensesRevealed = track?.defensesRevealed === true ||
    declaration.gmKnowledge === true;
  const publicPreview = {
    finalAc: knownTargetAC(track, targetAc),
    categories,
    modifiers: modifierGroups,
    knownModifierTotal,
    arcValid,
    rangeValid: range.valid,
    lineOfSightValid,
    struckSector: sector,
    distance,
    relativeBearing: (normalizeDegrees(
      bearingDegrees(shooterPosition, targetPosition, attackerToTarget) -
        arcInput.facing,
    ) + 360) % 360,
    range,
    relativeMotion,
    costs,
    ...(defensesRevealed
      ? {
        damageProfile: attack.profile.damage,
        armorPiercing: attack.profile.armorPiercing,
      }
      : {}),
  };
  return {
    legal: violations.length === 0,
    violations,
    public: publicPreview,
    gm: { ...publicPreview, actualTargetAc: targetAc, geometry, attack },
    commitment: violations.length === 0 ? deepFreeze(attack) : null,
  };
}

/** @param {object} context @returns {{legal: boolean, violations: object[], public?: object, gm?: object, commitment?: object}} */
export function previewAttack(context) {
  try {
    return makePreview(context);
  } catch (error) {
    if (!(error instanceof RuleViolation)) throw error;
    return {
      legal: false,
      violations: [violation(error.code, error.message, error.details)],
      commitment: null,
    };
  }
}

/** @param {object} context @returns {object} */
export function projectAttackCommit(context) {
  const preview = previewAttack(context);
  if (!preview.legal) {
    throw new RuleViolation(
      "ILLEGAL_ATTACK_DECLARATION",
      "Attack declaration is illegal and spent nothing.",
      {
        violations: preview.violations,
      },
    );
  }
  return preview.commitment;
}

/** @param {object} context @returns {{public: object, gm: object}} */
export function commitAttack(context) {
  const {
    attackerConfig,
    attackerDraft,
    targetConfig,
    targetDraft,
    declaration,
    helpers = {},
    rollD20,
  } = context;
  if (typeof rollD20 !== "function") {
    throw new RuleViolation(
      "MISSING_ROLL_SOURCE",
      "Attack commitment requires an injected d20 roll function.",
    );
  }
  const preview = previewAttack({
    attackerConfig,
    attackerState: attackerDraft,
    targetConfig,
    targetState: targetDraft,
    declaration,
    helpers,
  });
  if (!preview.legal) {
    throw new RuleViolation(
      "ILLEGAL_ATTACK_DECLARATION",
      "Attack declaration is illegal and spent nothing.",
      {
        violations: preview.violations,
      },
    );
  }
  const commitment = preview.commitment;
  const attackerSnapshot = snapshotFields(attackerDraft, [
    "resources",
    "controls",
    "weapons",
    "heat",
    "effects",
    "tracks",
    "revision",
  ]);
  const targetSnapshot = snapshotFields(targetDraft, [
    "shields",
    "weapons",
    "hull",
    "heat",
    "conditions",
    "pendingFate",
    "effects",
    "revision",
  ]);

  try {
    const operationSpend = typeof helpers.spendOperationResource === "function"
      ? helpers.spendOperationResource(attackerConfig, attackerDraft, {
        operatorId: commitment.operatorId,
        operation: "attack",
        cost: 1,
      })
      : localSpend(
        attackerDraft,
        commitment.operatorId,
        commitment.costs.operation.pool,
      );

    let solutionSpend = null;
    if (commitment.costs.firingSolution.consumed) {
      solutionSpend = typeof helpers.consumeFiringSolution === "function"
        ? helpers.consumeFiringSolution(attackerDraft, commitment.targetId)
        : localConsumeFiringSolution(attackerDraft, commitment.targetId);
    }
    attackerDraft.weapons[commitment.weaponId].readiness =
      commitment.costs.readiness.after;
    attackerDraft.weapons[commitment.weaponId].reloadProgress = 0;
    attackerDraft.heat = commitment.costs.firingHeat.after;
    setSignatureSpike(
      attackerDraft,
      commitment.weaponId,
      commitment.costs.signature.modifier,
    );

    const naturalRoll = rollD20();
    if (!Number.isInteger(naturalRoll) || naturalRoll < 1 || naturalRoll > 20) {
      throw new RuleViolation(
        "INVALID_D20",
        "Injected d20 roll must return an integer from 1 through 20.",
      );
    }
    const total = naturalRoll + commitment.knownModifierTotal;
    const effectiveHits = calculateEffectiveHits(
      naturalRoll,
      total,
      commitment.targetAc,
      commitment.barrage,
    );
    const damage = resolveAttack(targetConfig, targetDraft, {
      effectiveHits,
      naturalRoll,
      sector: commitment.geometry.sector,
      damage: commitment.profile.damage,
      armorPiercing: commitment.profile.armorPiercing,
      traits: commitment.profile.traits,
      aimedComponentId: commitment.aimedComponentId,
      aimedConditionId: commitment.aimedConditionId,
      random: context.random,
      revealDamage: preview.public.damageProfile !== undefined,
      incrementRevision: false,
    }, helpers);

    attackerDraft.revision =
      Math.max(0, Math.trunc(finite(attackerDraft.revision))) + 1;
    targetDraft.revision =
      Math.max(0, Math.trunc(finite(targetDraft.revision))) + 1;
    const margin = total - commitment.targetAc;
    const roll = {
      natural: naturalRoll,
      total,
      ac: commitment.targetAc,
      margin,
      hit: effectiveHits > 0,
      critical: naturalRoll === 20 && damage.gm.totals.hullDamage > 0,
      effectiveHits,
    };
    return {
      public: {
        committed: true,
        roll,
        costs: commitment.costs,
        damage: damage.public,
      },
      gm: {
        committed: true,
        commitment,
        roll,
        spending: { operation: operationSpend, firingSolution: solutionSpend },
        damage: damage.gm,
      },
    };
  } catch (error) {
    restoreFields(attackerDraft, attackerSnapshot);
    restoreFields(targetDraft, targetSnapshot);
    throw error;
  }
}

export {
  BARRAGE_PROFILES,
  mergeProfile,
  PROJECTILE_MULTIPLIERS,
  resolveAttack,
};
