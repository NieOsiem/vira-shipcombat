import { RuleViolation } from "../constants.js";

const BREAKTHROUGH_FLOOR = 0.4;
const COMPLETE_CUSTOM_TRAITS = new Set(["incendiary", "unreliable", "unstableoverclock"]);

function number(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RuleViolation("INVALID_DAMAGE_PROFILE", `${label} must be a non-negative number.`, { label, value });
  }
  return value;
}

function roundHalfUp(value) {
  return Math.floor(value + 0.5);
}

function traitKey(trait) {
  return String(typeof trait === "string" ? trait : trait?.id ?? trait?.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function traitByKey(traits, key) {
  return (traits ?? []).find((trait) => traitKey(trait) === key) ?? null;
}

function shieldBypass(traits) {
  const trait = traitByKey(traits, "shieldbypass");
  if (!trait) return { hull: false, heat: false, damageShield: true };
  if (typeof trait === "string") {
    throw new RuleViolation("INCOMPLETE_SHIELD_BYPASS", "Shield Bypass must name its bypass channels.");
  }

  const params = trait.params ?? trait;
  const channels = Array.isArray(params.channels)
    ? params.channels.map((channel) => String(channel).toLowerCase())
    : [];
  const hull = params.hull === true || channels.includes("hull");
  const heat = params.heat === true || channels.includes("heat");
  if (!hull && !heat) {
    throw new RuleViolation("INCOMPLETE_SHIELD_BYPASS", "Shield Bypass must name Hull and/or Heat.");
  }
  return {
    hull,
    heat,
    damageShield: params.damageShield !== false && params.shieldDamage !== false,
  };
}

function shieldDefinition(config) {
  return config?.components?.shield ?? config?.shield ?? null;
}

function isBubbleShield(config) {
  const shield = shieldDefinition(config);
  return shield?.topology === "bubble" || shield?.type === "bubble";
}

function shieldSlot(config, sector) {
  if (isBubbleShield(config)) return "bubble";
  return sector;
}

function shieldHp(state, slot) {
  return number(state?.shields?.hp?.[slot], 0);
}

function setShieldHp(state, slot, value) {
  state.shields.hp[slot] = value;
}

function collapseCounter(state, slot) {
  const collapse = state?.shields?.collapse;
  if (typeof collapse === "number") return collapse;
  return number(collapse?.[slot], 0);
}

function setCollapseCounter(config, state, slot) {
  const delay = Math.max(0, Math.trunc(number(shieldDefinition(config)?.rechargeDelay, 0)));
  if (typeof state.shields.collapse === "number") {
    state.shields.collapse = delay;
    return;
  }
  state.shields.collapse[slot] = delay;
}

function defaultShieldActive(config, state, slot) {
  if (!state?.shields || !shieldDefinition(config)) return false;
  if (number(state?.power?.shields, 0) < 1) return false;
  return collapseCounter(state, slot) <= 0;
}

function armorAt(config, sector) {
  const armor = config?.armor;
  if (Number.isFinite(armor)) return Math.max(0, armor);
  return Math.max(0, number(armor?.[sector], 0));
}

function pendingFate(config, nonLethal) {
  if (nonLethal) {
    return { status: "resolved", outcome: "disabled", reason: "nonLethal" };
  }
  if (config?.fatePolicy === "disposable") {
    return { status: "resolved", outcome: "destroyed", reason: "fatePolicy" };
  }
  return { status: "pending", outcome: null, reason: "important" };
}

function validateConditionHelpers(input, helpers) {
  if (!input.aimedComponentId && input.naturalRoll !== 20) return;
  if (typeof helpers.applyConditionTiers !== "function") {
    throw new RuleViolation("MISSING_CONDITION_HELPER", "Condition escalation requires applyConditionTiers.");
  }
  if (!input.aimedComponentId && typeof helpers.selectCondition !== "function") {
    throw new RuleViolation("MISSING_CONDITION_HELPER", "A normal critical requires selectCondition.");
  }
  if (input.naturalRoll === 20 && typeof input.random !== "function") {
    throw new RuleViolation("MISSING_RANDOM_SOURCE", "Critical condition selection requires injected randomness.");
  }
}

function validateCustomTraits(traits, helpers) {
  const custom = (traits ?? []).filter((trait) => COMPLETE_CUSTOM_TRAITS.has(traitKey(trait)));
  for (const trait of custom) {
    const rule = typeof trait === "object" ? trait.rule ?? trait.params ?? trait : null;
    if (!rule?.trigger || !rule?.timing || rule.result === undefined) {
      throw new RuleViolation("INCOMPLETE_RESERVED_TRAIT", "Reserved weapon traits require trigger, timing, and result definitions.", {
        trait: typeof trait === "string" ? trait : trait?.id,
      });
    }
  }
  if (custom.length && typeof helpers.resolveTrait !== "function") {
    throw new RuleViolation("MISSING_TRAIT_RESOLVER", "Configured reserved traits require an injected resolver.");
  }
  return custom;
}

/** @param {object} config @param {object} draft @param {object} input @param {object} [helpers] @returns {{public: object, gm: object}} */
export function resolveProjectile(config, draft, input, helpers = {}) {
  const sector = input.sector;
  const damage = input.damage ?? {};
  const shieldDamage = nonNegative(number(damage.shield, 0), "Shield Damage");
  const hullDamage = nonNegative(number(damage.hull, 0), "Hull Damage");
  const heatDamage = nonNegative(number(damage.heat, 0), "Heat Damage");
  const armorPiercing = nonNegative(number(input.armorPiercing, 0), "Armor Piercing");
  const bypass = input.bypass ?? shieldBypass(input.traits);
  if (typeof helpers.resolveShieldDamage === "function") {
    const hullBefore = Math.max(0, number(draft.hull, 0));
    const heatBefore = number(draft.heat, 0);
    const resolved = helpers.resolveShieldDamage(config, draft, {
      sector,
      shieldDamage: bypass.damageShield ? shieldDamage : 0,
      hullDamage,
      heatDamage,
      armorPiercing,
      bypass: { hull: bypass.hull, heat: bypass.heat },
    });
    const gm = {
      sector: resolved.sector,
      shield: {
        active: resolved.fieldActive,
        slot: resolved.sector,
        before: resolved.shieldBefore,
        activeBefore: resolved.activeShield,
        damage: resolved.shieldDamageApplied,
        after: resolved.shieldAfter,
        collapsed: resolved.collapsed,
      },
      breakthrough: {
        fraction: resolved.penetratingFraction,
        hullFraction: resolved.hullFraction,
        heatFraction: resolved.heatFraction,
      },
      armor: {
        base: resolved.armor,
        piercing: resolved.armorPiercing,
        effective: resolved.effectiveArmor,
      },
      hull: {
        listed: hullDamage,
        transmitted: resolved.transmittedHull,
        taken: resolved.hullDamageTaken,
        before: hullBefore,
        after: resolved.hullAfter,
      },
      heat: {
        listed: heatDamage,
        transmitted: resolved.transmittedHeat,
        before: heatBefore,
        after: resolved.heatAfter,
      },
      reducedHullToZero: hullBefore > 0 && resolved.hullAfter === 0,
      shieldDetail: resolved,
    };
    return {
      public: input.revealDamage === true
        ? gm
        : { sector: resolved.sector, shieldCollapsed: resolved.collapsed, hullReachedZero: resolved.hullAfter === 0 },
      gm,
    };
  }

  const slot = shieldSlot(config, sector);
  const storedShieldBefore = shieldHp(draft, slot);
  const active = typeof helpers.isShieldActive === "function"
    ? helpers.isShieldActive(config, draft, { sector, slot }) === true
    : defaultShieldActive(config, draft, slot);
  const activeShieldBefore = active ? storedShieldBefore : 0;

  let shieldAfter = storedShieldBefore;
  let penetratingFraction = activeShieldBefore <= 0 ? 1 : 0;
  let collapsed = false;
  if (activeShieldBefore > 0 && bypass.damageShield && shieldDamage > 0) {
    shieldAfter = Math.max(0, activeShieldBefore - shieldDamage);
    setShieldHp(draft, slot, shieldAfter);
    if (shieldAfter === 0) {
      collapsed = true;
      setCollapseCounter(config, draft, slot);
      const rawFraction = Math.max(0, Math.min(1, 1 - activeShieldBefore / shieldDamage));
      penetratingFraction = Math.max(BREAKTHROUGH_FLOOR, rawFraction);
    }
  }

  const hullFraction = bypass.hull ? 1 : penetratingFraction;
  const heatFraction = bypass.heat ? 1 : penetratingFraction;
  const transmittedHull = roundHalfUp(hullDamage * hullFraction);
  const transmittedHeat = roundHalfUp(heatDamage * heatFraction);
  const armor = armorAt(config, sector);
  const effectiveArmor = Math.max(0, armor - armorPiercing);
  const hullTaken = Math.max(0, transmittedHull - effectiveArmor);
  const hullBefore = Math.max(0, number(draft.hull, 0));
  const hullAfter = Math.max(0, hullBefore - hullTaken);
  const heatBefore = number(draft.heat, 0);
  const heatAfter = heatBefore + transmittedHeat;
  draft.hull = hullAfter;
  draft.heat = heatAfter;

  const gm = {
    sector,
    shield: {
      active,
      slot,
      before: storedShieldBefore,
      activeBefore: activeShieldBefore,
      damage: bypass.damageShield ? shieldDamage : 0,
      after: shieldAfter,
      collapsed,
    },
    breakthrough: { fraction: penetratingFraction, hullFraction, heatFraction },
    armor: { base: armor, piercing: armorPiercing, effective: effectiveArmor },
    hull: { listed: hullDamage, transmitted: transmittedHull, taken: hullTaken, before: hullBefore, after: hullAfter },
    heat: { listed: heatDamage, transmitted: transmittedHeat, before: heatBefore, after: heatAfter },
    reducedHullToZero: hullBefore > 0 && hullAfter === 0,
  };

  return {
    public: input.revealDamage === true
      ? gm
      : { sector, shieldCollapsed: collapsed, hullReachedZero: hullAfter === 0 },
    gm,
  };
}

function applyConditionEvent(config, draft, input, helpers, totalHullDamage) {
  if (totalHullDamage < 1) return null;
  const critical = input.naturalRoll === 20;
  const aimed = Boolean(input.aimedComponentId);
  if (!critical && !aimed) return null;

  const vicious = critical && Boolean(traitByKey(input.traits, "vicious"));
  const criticalTiers = critical ? (vicious ? 2 : 1) : 0;
  const tiers = (aimed ? 1 : 0) + criticalTiers;
  const event = {
    type: "condition",
    aimed,
    critical,
    vicious,
    sector: input.sector,
    aimedComponentId: input.aimedComponentId ?? null,
    tiers,
  };
  const conditionId = aimed
    ? input.aimedConditionId ?? input.aimedComponentId
    : helpers.selectCondition(config, draft, {
        sector: input.sector,
        excludeIds: [],
        random: input.random,
      });
  if (!conditionId) {
    return { ...event, kind: "noneEligible", conditionId: null, applications: [], discarded: tiers };
  }

  const result = helpers.applyConditionTiers(config, draft, {
    conditionId,
    tiers,
    sector: input.sector,
    random: input.random,
    selectCondition: helpers.selectCondition,
  });
  const kind = aimed
    ? critical
      ? vicious ? "aimedViciousCritical" : "aimedCritical"
      : "aimed"
    : vicious ? "viciousCritical" : "critical";
  return { ...event, kind, conditionId, ...result };
}

/** @param {object} config @param {object} draft @param {object} input @param {object} [helpers] @returns {{public: object, gm: object}} */
export function resolveAttack(config, draft, input, helpers = {}) {
  if (!Number.isInteger(input.effectiveHits) || input.effectiveHits < 0) {
    throw new RuleViolation("INVALID_EFFECTIVE_HITS", "Effective hits must be a non-negative integer.");
  }
  if (!Number.isInteger(input.naturalRoll) || input.naturalRoll < 1 || input.naturalRoll > 20) {
    throw new RuleViolation("INVALID_D20", "Natural roll must be an integer from 1 through 20.");
  }
  validateConditionHelpers(input, helpers);
  const customTraits = validateCustomTraits(input.traits, helpers);
  const bypass = shieldBypass(input.traits);

  const projectiles = [];
  let totalHullDamage = 0;
  let totalHeatDamage = 0;
  let zeroingProjectile = null;
  for (let index = 0; index < input.effectiveHits; index += 1) {
    const result = resolveProjectile(config, draft, {
      sector: input.sector,
      damage: input.damage,
      armorPiercing: input.armorPiercing,
      traits: input.traits,
      bypass,
      revealDamage: input.revealDamage,
    }, helpers);
    projectiles.push(result.gm);
    totalHullDamage += result.gm.hull.taken;
    totalHeatDamage += result.gm.heat.transmitted;
    if (!zeroingProjectile && result.gm.reducedHullToZero) {
      zeroingProjectile = {
        index,
        nonLethal: Boolean(traitByKey(input.traits, "nonlethal")),
      };
    }
  }

  const conditionEvent = applyConditionEvent(config, draft, input, helpers, totalHullDamage);
  const traitEvents = customTraits.map((trait) => helpers.resolveTrait(config, draft, {
    trait,
    timing: "afterCondition",
    attack: input,
    projectiles,
    random: input.random,
  }));

  let fate = null;
  if (zeroingProjectile) {
    fate = {
      ...pendingFate(config, zeroingProjectile.nonLethal),
      triggeringProjectile: zeroingProjectile.index,
    };
    draft.pendingFate = fate;
  }
  if (input.incrementRevision !== false) {
    draft.revision = Math.max(0, Math.trunc(number(draft.revision, 0))) + 1;
  }

  const gm = {
    effectiveHits: input.effectiveHits,
    sector: input.sector,
    projectiles,
    totals: { hullDamage: totalHullDamage, heatDamage: totalHeatDamage },
    conditionEvent,
    traitEvents,
    fate,
  };
  return {
    public: {
      effectiveHits: input.effectiveHits,
      sector: input.sector,
      ...(input.revealDamage === true ? { projectiles, totals: gm.totals } : {}),
      conditionEvent,
      fate,
    },
    gm,
  };
}

/** @param {object} config @param {object} draft @param {{nonLethal?: boolean}} [input] @returns {{public:object|null,gm:object|null}} */
export function resolveShipFate(config, draft, input = {}) {
  if (number(draft?.hull, 0) > 0) return { public: null, gm: null };
  const fate = pendingFate(config, input.nonLethal === true);
  draft.pendingFate = fate;
  return { public: fate, gm: fate };
}

export { BREAKTHROUGH_FLOOR };
