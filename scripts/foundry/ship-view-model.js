import { BARRAGE_PROFILES, mergeProfile } from "../rules/combat.js";
import { getPowerState } from "../rules/power.js";
import { FAULT_CHANNELS, HAZARD_CHANNELS } from "../rules/conditions.js";
import {
  getCurrentSignature,
  getSensorStats,
  sanitizeTrack,
  TRACK_STATUS,
} from "../rules/sensors.js";
import { previewDefenseRoute } from "../rules/shields.js";
import { getDriveCapabilities } from "../rules/movement.js";
import { sceneGridGeometry } from "./scene-geometry.js";

const POWER_SYSTEMS = Object.freeze([
  ["engines", "Engines"],
  ["shields", "Shields"],
  ["sensors", "Sensors"],
  ["cooling", "Cooling"],
  ["weapons", "Weapons"],
]);
const SYSTEM_ICONS = Object.freeze({
  engines: "fa-solid fa-shuttle-space",
  shields: "fa-solid fa-shield-halved",
  sensors: "fa-solid fa-satellite-dish",
  cooling: "fa-solid fa-snowflake",
  weapons: "fa-solid fa-crosshairs",
});
const SYSTEM_SHORT_LABELS = Object.freeze({
  engines: "ENG",
  shields: "SHD",
  sensors: "SNS",
  cooling: "COL",
  weapons: "WPN",
});
const SECTORS = Object.freeze(["fore", "port", "starboard", "aft"]);
const SECTOR_LABELS = Object.freeze({
  fore: "Fore",
  port: "Port",
  starboard: "Starboard",
  aft: "Aft",
  bubble: "Bubble",
});
const CONDITION_LABELS = new Map(
  [...FAULT_CHANNELS, ...HAZARD_CHANNELS].map((channel) => [
    channel,
    channel.replace(/([a-z])([A-Z])/g, "$1 $2").replace(
      /^./,
      (letter) => letter.toUpperCase(),
    ),
  ]),
);
const PHASE_LABELS = new Map([
  ["outsideCombat", "Outside Combat"],
  ["start", "Start Phase"],
  ["active", "Active Phase"],
  ["end", "End Phase"],
]);

// Priorities are permutations of installed hardware, never of stale state keys.
export function powerPriorities(config, state, staged = {}) {
  const order = (eligible, preferred) => [
    ...new Set([
      ...(preferred ?? []).filter((id) => eligible.includes(id)),
      ...eligible,
    ]),
  ];
  return {
    sheddingPriority: order(
      POWER_SYSTEMS.map(([id]) => id),
      staged.sheddingPriority ?? state?.sheddingPriority ??
        config?.sheddingPriority,
    ),
    weaponPriority: order(
      (config?.components?.weapons ?? []).map((weapon) => weapon.id),
      staged.weaponPriority ?? state?.weaponPriority ?? config?.weaponPriority,
    ),
  };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.trunc(finite(value, fallback)));
}

function signed(value, digits = 2) {
  const number = Number(value ?? 0);
  const rounded = Number(number.toFixed(digits));
  const clean = Math.abs(rounded) < 1e-9 ? 0 : rounded;
  return `${clean >= 0 ? "+" : ""}${clean}`;
}

function percent(value, maximum) {
  const max = finite(maximum);
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((finite(value) / max) * 100)));
}

function meter(value, maximum, tone = "normal") {
  return {
    value: finite(value),
    maximum: finite(maximum),
    percent: percent(value, maximum),
    style: `--meter-value:${percent(value, maximum)}%`,
    tone,
  };
}

export function helmTrackGradientStyle(zeroPosPercent, spentRatio, currentRatio = 0) {
  const Z = Math.min(1, Math.max(0, zeroPosPercent / 100));
  const spent = Math.min(1, Math.max(0, spentRatio));
  const current = Math.min(Math.max(0, 1 - spent), Math.max(0, currentRatio));
  const left = Math.max(0, 1 - spent - current);

  const rLeft = (spent * Z * 100).toFixed(1);
  const yLeft = ((spent + current) * Z * 100).toFixed(1);
  const gRight = ((Z + left * (1 - Z)) * 100).toFixed(1);
  const yRight = ((Z + (left + current) * (1 - Z)) * 100).toFixed(1);

  return `--track-red-end: ${rLeft}%; --track-yellow-end: ${yLeft}%; --track-green-end: ${gRight}%; --track-yellow2-end: ${yRight}%;`;
}

export function helmCoastTrackGradientStyle(spentRatio, currentRatio = 0) {
  const spent = Math.min(1, Math.max(0, spentRatio));
  const current = Math.min(Math.max(0, 1 - spent), Math.max(0, currentRatio));
  const gEnd = (Math.max(0, 1 - spent - current) * 100).toFixed(1);
  const yEnd = (Math.max(0, 1 - spent) * 100).toFixed(1);
  return `--coast-green-end: ${gEnd}%; --coast-yellow-end: ${yEnd}%;`;
}

function availabilityLabel(counter) {
  const turns = whole(counter);
  if (turns === 0) return "Available now";
  if (turns === 1) return "Available next Start";
  if (turns === 2) return "Available on the second future Start";
  return `Available after ${turns} future Starts`;
}

function holderId(holder) {
  return typeof holder === "string" ? holder : holder?.operatorId ?? null;
}

function assignedEntries(state) {
  const entries = [];
  for (const kind of ["command", "crew"]) {
    for (const assignment of state?.roster?.[kind] ?? []) {
      entries.push({
        kind,
        slot: whole(assignment?.slot),
        operatorId: typeof assignment === "string"
          ? assignment
          : assignment?.operatorId ?? assignment?.id,
        assignment,
      });
    }
  }
  return entries;
}

function operatorViews(config, state) {
  const profiles = new Map(
    (config?.operators ?? []).map((profile) => [profile.id, profile]),
  );
  const controls = state?.controls ?? {};
  return assignedEntries(state).map((entry) => {
    const profile = profiles.get(entry.operatorId) ?? entry.assignment ?? {};
    const resource = entry.kind === "command" ? "Actions" : "Orders";
    const remaining = whole(
      entry.kind === "command"
        ? state?.resources?.actions?.[entry.operatorId]
        : state?.resources?.orders?.[entry.operatorId],
    );
    const heldControls = Object.entries(controls)
      .filter(([, holder]) => holderId(holder) === entry.operatorId)
      .map(([control]) => control);
    return {
      id: entry.operatorId,
      label: profile.label ?? entry.operatorId,
      kind: entry.kind,
      kindLabel: entry.kind === "command" ? "Command" : "Crew",
      slot: entry.slot,
      resource,
      remaining,
      img: profile.img ?? null,
      actorId: profile.actorId ?? null,
      type: profile.type ?? "npc",
      typeLabel: (profile.type ?? "npc").toUpperCase(),
      ratings: {
        piloting: whole(profile?.ratings?.piloting),
        gunnery: whole(profile?.ratings?.gunnery),
        sensors: whole(profile?.ratings?.sensors),
        engineering: whole(profile?.ratings?.engineering),
      },
      heldControls,
      userId: entry.assignment?.userId ?? profile?.userId ?? null,
      controlsLabel: heldControls.length ? heldControls.join(" · ") : "None",
      inactive: profile.active === false || profile.incapacitated === true ||
        profile.disconnected === true ||
        entry.assignment?.active === false ||
        entry.assignment?.incapacitated === true ||
        entry.assignment?.disconnected === true,
    };
  }).sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.slot - right.slot
  );
}

function bestOperator(operators, rating, preferred) {
  if (
    preferred &&
    operators.some((operator) =>
      operator.id === preferred && !operator.inactive
    )
  ) return preferred;
  const activePool = operators.filter((operator) => !operator.inactive);
  const withActions = activePool.filter((operator) => operator.remaining > 0);
  const candidates = withActions.length > 0 ? withActions : activePool;
  return [...candidates]
    .sort((left, right) =>
      right.ratings[rating] - left.ratings[rating] ||
      right.remaining - left.remaining ||
      left.id.localeCompare(right.id)
    )[0]?.id ?? "";
}

function rosterSlots(config, state) {
  const assignments = assignedEntries(state);
  const profiles = config?.operators ?? [];
  const makeSlots = (kind, capacity) =>
    Array.from({ length: whole(capacity) }, (_, slot) => {
      const selected = assignments.find((entry) =>
        entry.kind === kind && entry.slot === slot
      )?.operatorId ?? "";
      return {
        kind,
        slot,
        label: `${kind === "command" ? "Command" : "Crew"} ${slot + 1}`,
        field: `${kind}-${slot}`,
        options: profiles.map((profile) => ({
          id: profile.id,
          label: profile.label ?? profile.id,
          selected: profile.id === selected,
        })),
      };
    });
  return {
    command: makeSlots("command", config?.commandCapacity),
    crew: makeSlots("crew", config?.crewCapacity),
  };
}

function stationSlots(config, state, allOperators) {
  const operatorsBySlot = new Map(
    allOperators.map((op) => [`${op.kind}-${op.slot}`, op]),
  );
  const profiles = config?.operators ?? [];
  const makeSlots = (kind, capacity) =>
    Array.from({ length: whole(capacity) }, (_, slot) => {
      const key = `${kind}-${slot}`;
      const operator = operatorsBySlot.get(key) ?? null;
      const kindLabel = kind === "command" ? "Command" : "Crew";
      const slotNumber = slot + 1;
      return {
        kind,
        kindLabel,
        slot,
        slotNumber,
        label: `${kindLabel} ${slotNumber}`,
        field: key,
        occupied: Boolean(operator),
        empty: !operator,
        operator,
        options: profiles.map((profile) => ({
          id: profile.id,
          label: profile.label ?? profile.id,
          selected: profile.id === operator?.id,
        })),
        dropLabel: `Drop PC or NPC into ${kindLabel} ${slotNumber}`,
      };
    });
  return {
    command: makeSlots("command", config?.commandCapacity),
    crew: makeSlots("crew", config?.crewCapacity),
  };
}

function componentForSystem(config, system) {
  if (system === "engines") return config?.powerSystems?.engines;
  if (system === "shields") return config?.components?.shield;
  if (system === "sensors") return config?.components?.sensor;
  if (system === "cooling") return config?.components?.cooling;
  return null;
}

function powerOptions(config, powerState, system) {
  if (system === "weapons") {
    return Array.from(
      { length: whole(powerState?.ceilings?.maximum) + 1 },
      (_, value) => ({
        value,
        label: String(value),
        selected: value === whole(powerState?.allocation?.weapons),
      }),
    );
  }
  const current = whole(powerState?.allocation?.[system]);
  const component = componentForSystem(config, system);
  if (!component) {
    return [{ value: 0, label: "0 · unavailable", selected: true }];
  }
  const options = (component.tiers ?? []).map((tier) => {
    const detail = tier.multiplier != null
      ? `${finite(tier.multiplier)}×`
      : tier.regeneration != null
      ? `regen ${whole(tier.regeneration)}`
      : tier.cooling != null
      ? `cool ${whole(tier.cooling)}`
      : tier.rangeMultiplier != null
      ? `${finite(tier.rangeMultiplier)}× range`
      : tier.online === false
      ? "offline"
      : "online";
    return {
      value: whole(tier.power),
      label: `${whole(tier.power)} · ${detail}`,
      selected: whole(tier.power) === current,
    };
  });
  return options.length
    ? options
    : [{ value: 0, label: "0 · unavailable", selected: true }];
}

function powerView(config, state) {
  const powerState = getPowerState(config, state);
  const systems = POWER_SYSTEMS.map(([id, label]) => ({ id, label }));
  const weapons = (config?.components?.weapons ?? []).map((weapon) => ({
    id: weapon.id,
    label: weapon.label ?? weapon.id,
  }));
  const prioritySlots = (entries, selected) =>
    selected.map((selectedId, index) => ({
      index,
      label: `${index + 1}`,
      options: entries.map((entry) => ({
        ...entry,
        selected: entry.id === selectedId,
      })),
    }));
  const { sheddingPriority, weaponPriority } = powerPriorities(config, state);
  const nominal = whole(powerState.ceilings.nominal);
  const maximum = whole(powerState.ceilings.maximum);
  const committed = whole(powerState.committed);
  const nominalFree = Math.max(0, nominal - committed);
  const overdriveTotal = Math.max(0, maximum - nominal);
  const overdriveUsed = Math.max(0, committed - nominal);
  const overdriveAvailable = Math.max(0, maximum - Math.max(nominal, committed));
  const redlining = powerState.redlining;
  const status = redlining
    ? `REDLINE (+${overdriveUsed} OVERDRIVE)`
    : nominalFree > 0
    ? `${nominalFree} SAFE FREE`
    : overdriveAvailable > 0
    ? `0 FREE (${overdriveAvailable} OVERDRIVE)`
    : "0 FREE (AT MAX)";
  const sensor = getSensorStats(config, state);
  const regeneration = config?.components?.shield?.tiers?.find((tier) =>
    tier.power === powerState.allocation.shields
  )?.regeneration ?? 0;
  const drives = getDriveCapabilities(config, state);
  const cooling = config?.components?.cooling?.tiers?.find((tier) =>
    tier.power === powerState.allocation.cooling
  )?.cooling ?? 0;
  const reservingWeapons =
    Object.values(powerState.weaponReservations).filter((reservation) =>
      reservation > 0
    ).length;
  const reservation =
    powerState.weaponReserved
      ? `${powerState.weaponReserved} reserved (${reservingWeapons} wpn)`
      : "No draw";
  const summaries = {
    engines: `${drives.forward} thrust`,
    shields: `${regeneration} regen`,
    sensors: sensor.online ? `${sensor.activeRange} active` : "Offline",
    weapons: reservation,
    cooling: `${cooling} cooling`,
  };

  return {
    ...powerState,
    nominalFree,
    overdriveTotal,
    overdriveUsed,
    overdriveAvailable,
    nominalOutput: nominal,
    redlineOutput: maximum,
    reservingWeapons,
    meter: meter(
      committed,
      nominal > 0 ? nominal : maximum,
      redlining ? "danger" : "power",
    ),
    status,
    reactor: {
      nominal,
      maximum,
      redline: overdriveTotal,
      committed,
      free: Math.max(0, maximum - committed),
      nominalFree,
      overdriveAvailable,
      redlining,
    },
    grid: {
      draw: `${committed} / ${maximum} Power`,
      free: `${powerState.unused} available`,
      emission: redlining ? "REDLINE" : (powerState.emission?.band ?? "normal"),
      heat: "0 Heat on commit",
    },
    systems: POWER_SYSTEMS.map(([id, label]) => {
      const component = componentForSystem(config, id);
      const overclockTiers = (component?.tiers ?? [])
        .filter((tier) => tier.overclock)
        .map((tier) => whole(tier.power));
      return {
        id,
        label,
        shortLabel: SYSTEM_SHORT_LABELS[id] ?? label,
        icon: SYSTEM_ICONS[id] ?? "fa-solid fa-circle",
        value: whole(powerState.allocation[id]),
        options: powerOptions(config, powerState, id),
        overclockTiers,
        reservation: id === "weapons" ? whole(powerState.weaponReserved) : null,
        effect: summaries[id] ?? "",
      };
    }),
    sheddingPriority: prioritySlots(systems, sheddingPriority),
    weaponPriority: prioritySlots(weapons, weaponPriority),
  };
}

// Direction-triangle icons for the defense HUD sector cards.
const SECTOR_ICONS = Object.freeze({
  fore: "fa-solid fa-caret-up",
  port: "fa-solid fa-caret-left",
  starboard: "fa-solid fa-caret-right",
  aft: "fa-solid fa-caret-down",
});
// Mirror of the module-private emitter severity ranking in scripts/rules/shields.js.
const EMITTER_SEVERITY_RANK = Object.freeze({
  healthy: 0,
  minor: 1,
  major: 2,
  critical: 3,
  destroyed: 4,
  catastrophic: 4,
});

function emitterSeverityOf(value) {
  const severity = String(value ?? "healthy").toLowerCase();
  return Object.hasOwn(EMITTER_SEVERITY_RANK, severity) ? severity : "healthy";
}

function emitterConditionChannel(condition) {
  if (condition.conditionId) return condition.conditionId;
  if (condition.channel) return condition.channel;
  if (condition.type !== "fault" && condition.type !== "hazard") {
    return condition.type;
  }
  return condition.name ?? condition.id;
}

function emitterSeverityFor(shield, state, sector) {
  const emitterIds = (shield.emitters ?? [])
    .filter((emitter) => emitter.sector === sector)
    .map((emitter) => emitter.id);
  let result = "healthy";
  for (const condition of Object.values(state?.conditions ?? {})) {
    if (!condition || emitterConditionChannel(condition) !== "shieldEmitterDamage") {
      continue;
    }
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
    const severity = emitterSeverityOf(condition.severity);
    if (applies && EMITTER_SEVERITY_RANK[severity] > EMITTER_SEVERITY_RANK[result]) {
      result = severity;
    }
  }
  return result;
}

function shieldStatusLabel(severity, collapse, capacity) {
  if (EMITTER_SEVERITY_RANK[severity] >= EMITTER_SEVERITY_RANK.destroyed) {
    return "Emitter destroyed";
  }
  const turns = whole(collapse);
  if (turns > 0) return `Recovering · ${turns} round${turns === 1 ? "" : "s"}`;
  if (severity !== "healthy") return `Emitter ${severity} · Max ${whole(capacity)}`;
  return "";
}

function shieldView(config, state) {
  const shield = config?.components?.shield;
  if (!shield) {
    return {
      topology: "none",
      directional: false,
      budget: 0,
      regeneration: 0,
      totalHp: 0,
      totalAllocation: 0,
      unassigned: 0,
      regenPipsTotal: 20,
      total: 0,
      meter: meter(0, 0, "shield"),
      sectors: [],
    };
  }
  const route = previewDefenseRoute(config, state, {});
  const regeneration = whole(
    shield.tiers?.find((tier) => tier.power === state?.power?.shields)
      ?.regeneration,
  );
  const budget = whole(shield.totalBudget);
  const totalHp = whole(route.totalHp);
  const totalAllocation = whole(route.totalAllocation);
  const sectors = Object.keys(route.hp).map((id) => {
    const hp = whole(route.hp[id]);
    const allocation = whole(route.allocation[id]);
    const capacity = whole(route.capacities[id]);
    const weight = whole(route.regenerationAllocation[id]);
    const collapse = whole(state?.shields?.collapse?.[id]);
    const severity = emitterSeverityFor(shield, state, id);
    return {
      id,
      label: SECTOR_LABELS[id] ?? id,
      icon: SECTOR_ICONS[id] ?? "fa-solid fa-circle",
      position: id,
      hp,
      allocation,
      capacity,
      hpPercent: percent(hp, capacity),
      allocPercent: percent(allocation, capacity),
      weight,
      pips: Math.max(0, Math.min(20, Math.round(weight / 5))),
      rate: ((regeneration * weight) / 100).toFixed(1),
      canReceive: collapse === 0 && capacity > 0,
      collapse,
      collapseLabel: availabilityLabel(collapse),
      statusLabel: shieldStatusLabel(severity, collapse, capacity),
      emitterSeverity: severity,
    };
  });
  return {
    topology: shield.topology ?? "directional",
    directional: shield.topology !== "bubble",
    budget,
    regeneration,
    totalHp,
    totalAllocation,
    unassigned: budget - totalAllocation,
    regenPipsTotal: 20,
    sectors,
    total: totalHp,
    meter: meter(totalHp, budget, "shield"),
  };
}

function damageSummary(damage = {}) {
  const parts = [];
  if (finite(damage.shield) > 0) parts.push(`${whole(damage.shield)} shield`);
  if (finite(damage.hull) > 0) parts.push(`${whole(damage.hull)} hull`);
  if (finite(damage.heat) > 0) parts.push(`${whole(damage.heat)} heat`);
  return parts.join(" · ") || "No damage";
}

function weaponViews(config, state, powerState) {
  const hardpoints = new Map(
    (config?.hardpoints ?? []).map((hardpoint) => [hardpoint.id, hardpoint]),
  );
  return (config?.components?.weapons ?? []).map((weapon) => {
    const current = state?.weapons?.[weapon.id] ?? {};
    const hardpoint = hardpoints.get(weapon.hardpointId);
    const profile = mergeProfile(weapon, current);
    const barrage = (profile.traits ?? []).some((trait) =>
      String(trait?.id ?? trait).toLowerCase() === "barrage"
    );
    const barrageProfiles = barrage
      ? Object.values(BARRAGE_PROFILES)
      : [BARRAGE_PROFILES[1]];
    const capacity = whole(profile?.readiness?.capacity);
    const readiness = whole(current.readiness);
    const status = current.status ?? "off";
    return {
      id: weapon.id,
      label: weapon.label ?? weapon.id,
      hardpoint: hardpoint?.label ?? weapon.regions?.join(" / ") ?? "Hardpoint",
      status,
      setting: status === "off" ? "off" : current.mode ?? "nominal",
      statusLabel: status === "booting"
        ? `Booting · ${availabilityLabel(current.bootCounter)}`
        : status,
      online: status === "online",
      off: status === "off",
      powered: status !== "off",
      booting: status === "booting",
      nominalMode: (current.mode ?? "nominal") === "nominal",
      overclockMode: current.mode === "overclock",
      mode: current.mode ?? "nominal",
      overclockAvailable: Boolean(weapon?.modes?.overclock),
      readiness,
      capacity,
      readinessMeter: meter(
        readiness,
        capacity,
        readiness > 0 ? "weapon" : "danger",
      ),
      damage: damageSummary(profile.damage),
      armorPiercing: whole(profile.armorPiercing),
      accuracy: finite(profile.accuracy),
      range: `${whole(profile?.range?.optimal)} / ${
        whole(profile?.range?.maximum)
      }`,
      optimalRange: finite(profile?.range?.optimal),
      maximumRange: finite(profile?.range?.maximum),
      arc: finite(profile.arc),
      orientation: finite(hardpoint?.orientation),
      heat: whole(profile?.firingHeat?.amount ?? profile.firingHeat),
      heatPerRound: profile?.firingHeat?.per === "physicalRound",
      reservation: whole(powerState?.weaponReservations?.[weapon.id]),
      barrageProfiles: barrageProfiles.map((profile, index) => ({
        rounds: whole(profile.rounds, 1),
        penalty: finite(profile.penalty),
        hits: whole(profile.maximumEffectiveHits, 1),
        selected: index === 0,
      })),
      manualReload: weapon?.readiness?.recovery === "manualWork",
      reloadWork: current.reloadWork,
      reloadLabel: current.reloadWork
        ? `${whole(current.reloadWork.current)} / ${
          whole(current.reloadWork.required)
        }`
        : "",
    };
  });
}

function conditionViews(config, state) {
  const components = config?.components ?? {};
  const namedComponents = new Map(
    [
      components.reactor,
      components.shield,
      components.sensor,
      components.cooling,
      ...Object.values(components.drives ?? {}),
      ...(components.weapons ?? []),
    ].filter((component) => component?.id && component?.label).map((
      component,
    ) => [component.id, component.label]),
  );
  const shieldLabel = components.shield?.label ?? "Shields";
  for (const emitter of components.shield?.emitters ?? []) {
    const sectorLabel = Object.hasOwn(SECTOR_LABELS, emitter.sector)
      ? SECTOR_LABELS[emitter.sector]
      : "Shield";
    namedComponents.set(
      emitter.id,
      emitter.label || `${shieldLabel} · ${sectorLabel} emitter`,
    );
  }
  return Object.entries(state?.conditions ?? {}).map(([key, condition]) => {
    const channel = condition?.channelId ?? condition?.conditionId;
    const kind = condition?.kind ??
      (HAZARD_CHANNELS.includes(channel) || condition?.clock != null
        ? "hazard"
        : "fault");
    const label = condition?.label || condition?.name ||
      CONDITION_LABELS.get(channel) || "Unknown condition";
    const componentId = condition?.componentId ?? condition?.targetId ?? "";
    let componentLabel = namedComponents.get(componentId) ??
      "Unknown component";
    if (kind === "hazard") {
      const region = condition?.region ?? condition?.sector ??
        condition?.targetId;
      componentLabel = region === "ship" ||
          (!region &&
            ["electricalCascade", "reactorInstability"].includes(channel))
        ? "Ship"
        : SECTORS.includes(region)
        ? SECTOR_LABELS[region]
        : "Unknown region";
    } else if (
      channel === "shieldEmitterDamage" &&
      componentId === components.shield?.id &&
      Object.hasOwn(SECTOR_LABELS, condition?.sector)
    ) {
      componentLabel = `${shieldLabel} · ${
        SECTOR_LABELS[condition.sector]
      } emitter`;
    }
    const destroyed = condition?.severity === "destroyed";
    const work = state?.work?.[`recovery:${key}`];
    return {
      id: key,
      label,
      severity: condition?.severity ?? "unknown",
      kind,
      sector: condition?.sector ?? condition?.region ?? "",
      componentId,
      componentLabel,
      clock: condition?.clock,
      destroyed,
      work,
      workLabel: work ? `${whole(work.current)} / ${whole(work.required)}` : "",
    };
  }).sort((left, right) =>
    left.severity.localeCompare(right.severity) ||
    left.label.localeCompare(right.label)
  );
}

function turnLabel(turnKey) {
  if (typeof turnKey !== "string") return "";
  const parts = /^([^:\s]+):(\d+):(\d+)$/.exec(turnKey);
  if (!parts) return "";
  const round = Number(parts[2]);
  const turn = Number(parts[3]) + 1;
  return Number.isSafeInteger(round) && Number.isSafeInteger(turn)
    ? `Round ${round} / Turn ${turn}`
    : "";
}

function tokenPosition(token) {
  if (!token) return null;
  const { gridSize, unitsPerPixel } = sceneGridGeometry(token.parent);
  return {
    x: (finite(token.x) + (finite(token.width, 1) * gridSize / 2)) *
      unitsPerPixel,
    y: (finite(token.y) +
      (finite(token.height, token.width ?? 1) * gridSize / 2)) * unitsPerPixel,
  };
}

function radarPosition(lastKnown, origin, facing, range) {
  if (!lastKnown?.position || !origin || range <= 0) {
    return { x: 50, y: 50, style: "--contact-x:50%;--contact-y:50%" };
  }
  const dx = finite(lastKnown.position.x) - origin.x;
  const dy = finite(lastKnown.position.y) - origin.y;
  const radians = -finite(facing) * Math.PI / 180;
  const relativeX = (dx * Math.cos(radians)) - (dy * Math.sin(radians));
  const relativeY = (dx * Math.sin(radians)) + (dy * Math.cos(radians));
  const scale = 43 / range;
  const x = Math.max(5, Math.min(95, 50 + (relativeX * scale)));
  const y = Math.max(5, Math.min(95, 50 + (relativeY * scale)));
  return {
    x,
    y,
    style: `--contact-x:${x.toFixed(2)}%;--contact-y:${y.toFixed(2)}%`,
  };
}

function contactViews(state, token, sensorStats, labels = {}) {
  const origin = state?.position ?? tokenPosition(token);
  const facing = finite(state?.facing ?? token?.rotation);
  const range = Math.max(
    1,
    finite(sensorStats.activeRange),
    finite(sensorStats.passiveRange),
  );
  return Object.entries(state?.tracks ?? {}).map(([key, track], index) => {
    const safe = sanitizeTrack({
      observerState: state,
      track,
      targetUuid: track?.targetUuid ?? key,
    });
    const position = radarPosition(safe.lastKnown, origin, facing, range);
    const live = safe.state === TRACK_STATUS.CONTACT ||
      safe.state === TRACK_STATUS.TARGETED;
    const targeted = safe.state === TRACK_STATUS.TARGETED;
    const rememberedLabel = safe.remembered?.label ??
      safe.remembered?.identity?.label;
    return {
      ...safe,
      key,
      label: rememberedLabel ?? labels[safe.targetUuid] ??
        `Contact ${index + 1}`,
      live,
      targeted,
      stale: safe.lastKnown?.stale === true ||
        safe.state === TRACK_STATUS.UNDETECTED,
      style: position.style,
      stateLabel: safe.state === TRACK_STATUS.TARGETED
        ? "Targeted"
        : safe.state === TRACK_STATUS.CONTACT
        ? "Contact"
        : "Last known",
      bearing: safe.lastKnown?.facing == null
        ? "—"
        : `${Math.round(finite(safe.lastKnown.facing))}°`,
      jammed: Array.isArray(safe.jams) && safe.jams.length > 0,
    };
  }).sort((left, right) =>
    Number(right.targeted) - Number(left.targeted) ||
    Number(right.live) - Number(left.live) ||
    left.label.localeCompare(right.label)
  );
}

export function buildShipConsoleView(
  config,
  state,
  { token = null, targetLabels = {}, operatorUserId = null } = {},
) {
  const power = powerView(config, state);
  const shields = shieldView(config, state);
  const sensor = getSensorStats(config, state);
  const signature = getCurrentSignature(config, state);
  const allOperators = operatorViews(config, state);
  const operators = allOperators
    .filter((operator) =>
      operatorUserId == null || operator.userId === operatorUserId
    );
  const commandOperators = operators.filter((op) => op.kind === "command");
  const crewOperators = operators.filter((op) => op.kind === "crew");
  const commandPool = commandOperators.length > 0 ? commandOperators : operators;
  const stationSlotsView = stationSlots(config, state, allOperators);
  const controls = state?.controls ?? {};
  const defaults = {
    helm: bestOperator(commandPool, "piloting", holderId(controls.helm)),
    power: bestOperator(commandPool, "engineering", holderId(controls.power)),
    defense: bestOperator(commandPool, "engineering", holderId(controls.defense)),
    sensors: bestOperator(commandPool, "sensors"),
    gunnery: bestOperator(commandPool, "gunnery"),
    engineering: bestOperator(operators, "engineering"),
  };
  const helmHolder = holderId(controls.helm);
  const helmHolderProfile = allOperators.find((op) => op.id === helmHolder);
  const helmHeld = Boolean(helmHolder);

  const contacts = contactViews(state, token, sensor, targetLabels);
  const conditions = conditionViews(config, state);
  const combat = globalThis.game?.combat;
  const combatants = Array.isArray(combat?.combatants)
    ? combat.combatants
    : combat?.combatants?.contents ??
      Array.from(combat?.combatants?.values?.() ?? []);
  const inCombat = Boolean(
    token &&
      combatants.some((entry) =>
        entry.tokenId === token.id || entry.token?.uuid === token.uuid
      ),
  );
  const active = inCombat &&
    (combat?.combatant?.tokenId === token.id ||
      combat?.combatant?.token?.uuid === token.uuid);
  const speed = Math.hypot(
    finite(state?.velocity?.x),
    finite(state?.velocity?.y),
  );
  const heat = meter(
    state?.heat,
    config?.heatCapacity,
    finite(state?.heat) > finite(config?.heatCapacity) ? "danger" : "heat",
  );
  const hull = meter(
    state?.hull,
    config?.maxHull,
    finite(state?.hull) <= finite(config?.maxHull) * 0.25 ? "danger" : "hull",
  );
  const driveCapabilities = getDriveCapabilities(config, state);
  const rotationCapacity = driveCapabilities.rotation;
  const facing = finite(state?.facing ?? token?.rotation);
  const normalizedFacing = ((Math.round(facing) % 360) + 360) % 360;
  const headingLabel = `${String(normalizedFacing).padStart(3, "0")}°`;
  const weaponsList = weaponViews(config, state, power);

  const availableCrewOrders = crewOperators.reduce(
    (sum, op) => sum + (op.remaining ?? 0),
    0,
  );
  const bestCrewOperator = bestOperator(crewOperators, "engineering") || bestOperator(operators, "engineering");
  const crewOrders = {
    availableOrders: availableCrewOrders,
    totalCrew: crewOperators.length,
    defaultOperatorId: bestCrewOperator,
    jobs: [
      ...(hull.value < hull.maximum ? [{
        id: "hullRepair",
        type: "hullRepair",
        label: "Field-Patch Hull",
        detail: `${hull.value} / ${hull.maximum} Hull · Engineering repair roll`,
        actionLabel: "Patch Hull",
        costLabel: "1 Order",
      }] : []),
      ...conditions.map((condition) => ({
        id: `condition-${condition.id}`,
        type: condition.destroyed ? "recoveryWork" : "repair",
        conditionId: condition.id,
        label: condition.destroyed ? `Rebuild ${condition.label}` : `Repair ${condition.label}`,
        detail: `${condition.severity} ${condition.kind}${condition.sector ? ` · ${condition.sector}` : ""}`,
        actionLabel: condition.destroyed ? "Contribute Work" : "Attempt Repair",
        costLabel: "1 Order",
      })),
      ...weaponsList.filter((w) => w.manualReload).map((w) => ({
        id: `reload-${w.id}`,
        type: w.reloadWork ? "reload" : "beginReload",
        weaponId: w.id,
        label: `Reload ${w.label}`,
        detail: `${w.readiness}/${w.capacity} ready${w.reloadLabel ? ` · ${w.reloadLabel}` : ""}`,
        actionLabel: w.reloadWork ? "Contribute Reload Work" : "Begin Reload",
        costLabel: "1 Order",
      })),
      ...(finite(state?.heat) > 0 ? [{
        id: "cooling",
        type: "cooling",
        label: "Assist Coolant Flush",
        detail: `${state.heat} / ${config?.heatCapacity ?? 20} Heat`,
        actionLabel: "Flush Coolant",
        costLabel: "1 Order",
      }] : []),
    ],
  };

  return {
    combat: {
      inCombat,
      active,
      round: inCombat ? whole(combat.round) : 0,
      label: inCombat
        ? `COMBAT · ROUND ${whole(combat.round)} · ${
          active ? "ACTIVE" : "WAITING"
        }`
        : "OUTSIDE COMBAT",
    },
    importantDamage: [
      ...(config?.components?.weapons ?? []).filter((weapon) =>
        ["destroyed", "damaged", "fault"].includes(state?.weapons?.[weapon.id]?.status)
      ).map((weapon) => ({
        label: weapon.label ?? weapon.id,
        componentLabel: "Weapon",
        statusLabel: state?.weapons?.[weapon.id]?.status ?? "damaged",
      })),
      ...conditions.filter((c) => ["critical", "major", "minor"].includes(c.severity)).map((c) => ({
        label: c.label,
        componentLabel: c.kind,
        statusLabel: c.severity,
      })),
    ],
    status: {
      hull,
      heat,
      shields: shields.meter,
      power: power.meter,
      speed: Number(speed.toFixed(2)),
      safeVelocity: finite(config?.safeVelocity),
      overspeed: speed > finite(config?.safeVelocity),
      signature,
      phase: state?.phase ?? "outsideCombat",
      phaseLabel: PHASE_LABELS.get(state?.phase ?? "outsideCombat") ??
        "Unknown phase",
      turnKey: state?.turnKey ?? "—",
      turnLabel: turnLabel(state?.turnKey),
      revision: whole(state?.revision),
    },
    operators,
    commandOperators,
    crewOperators,
    crewOrders,
    stationSlots: stationSlotsView,
    defaults,
    helmHeld,
    helmHolder,
    helmHolderLabel: helmHolderProfile?.label ?? helmHolder ?? "None",
    roster: rosterSlots(config, state),
    power,
    shields,
    sensor,
    contacts,
    liveContacts: contacts.filter((contact) => contact.live),
    targetedContacts: contacts.filter((contact) => contact.targeted),
    weapons: weaponsList,
    conditions,
    hasConditions: conditions.length > 0,
    work: Object.values(state?.work ?? {}),
    movement: {
      velocityX: Number(finite(state?.velocity?.x).toFixed(2)),
      velocityY: Number(finite(state?.velocity?.y).toFixed(2)),
      speed: Number(speed.toFixed(2)),
      heading: normalizedFacing,
      headingLabel,
      angularVelocity: signed(
        Number(finite(state?.rotationSpent).toFixed(1)),
        1,
      ) + "°",
      timeline: Number(finite(state?.timeline).toFixed(2)),
      timelineOccupied: Number(Math.min(
        1,
        finite(state?.timeline) + finite(state?.evasion?.reserved),
      ).toFixed(2)),
      timelineRemaining: Number(Math.max(
        0,
        1 - finite(state?.timeline) - finite(state?.evasion?.reserved),
      ).toFixed(2)),
      timelinePercent: percent(
        finite(state?.timeline) + finite(state?.evasion?.reserved),
        1,
      ),
      timelineStyle: `--meter-value:${
        percent(finite(state?.timeline) + finite(state?.evasion?.reserved), 1)
      }%`,
      rotationSpent: Number(finite(state?.rotationSpent).toFixed(2)),
      rotationCapacity,
      rotationRemaining: Number(Math.max(
        0,
        rotationCapacity - finite(state?.rotationSpent),
      ).toFixed(2)),
      evasionArmed: state?.evasion?.armed === true,
      evasionReserved: Number(finite(state?.evasion?.reserved).toFixed(2)),
      safeVelocity: finite(config?.safeVelocity),
      forwardMax: driveCapabilities.forward,
      retroMax: driveCapabilities.retro,
      portMax: driveCapabilities.port,
      starboardMax: driveCapabilities.starboard,
      rotationMax: rotationCapacity,
      translationBudgetSpentPct: percent(
        finite(state?.timeline) + finite(state?.evasion?.reserved),
        1,
      ),
      translationBudgetLeftPct: percent(
        Math.max(
          0,
          1 - finite(state?.timeline) - finite(state?.evasion?.reserved),
        ),
        1,
      ),
      rotationBudgetSpentPct: rotationCapacity > 0
        ? percent(finite(state?.rotationSpent), rotationCapacity)
        : 0,
      rotationBudgetLeftPct: rotationCapacity > 0
        ? percent(
          Math.max(0, rotationCapacity - finite(state?.rotationSpent)),
          rotationCapacity,
        )
        : 0,
      forwardZeroPosition: driveCapabilities.forward + driveCapabilities.retro >
          0
        ? Math.round(
          driveCapabilities.retro /
            (driveCapabilities.retro + driveCapabilities.forward) * 100,
        )
        : 50,
      lateralZeroPosition: driveCapabilities.port +
            driveCapabilities.starboard > 0
        ? Math.round(
          driveCapabilities.port /
            (driveCapabilities.port + driveCapabilities.starboard) * 100,
        )
        : 50,
      forwardTrackStyle: helmTrackGradientStyle(
        driveCapabilities.forward + driveCapabilities.retro > 0
          ? Math.round(
            driveCapabilities.retro /
              (driveCapabilities.retro + driveCapabilities.forward) * 100,
          )
          : 50,
        finite(state?.timeline) + finite(state?.evasion?.reserved),
        0,
      ),
      lateralTrackStyle: helmTrackGradientStyle(
        driveCapabilities.port + driveCapabilities.starboard > 0
          ? Math.round(
            driveCapabilities.port /
              (driveCapabilities.port + driveCapabilities.starboard) * 100,
          )
          : 50,
        finite(state?.timeline) + finite(state?.evasion?.reserved),
        0,
      ),
      rotationTrackStyle: helmTrackGradientStyle(
        50,
        rotationCapacity > 0
          ? finite(state?.rotationSpent) / rotationCapacity
          : 0,
        0,
      ),
      timelineRemainingHalf: Number((Math.max(
        0,
        1 - finite(state?.timeline) - finite(state?.evasion?.reserved),
      ) / 2).toFixed(2)),
      coastTrackStyle: helmCoastTrackGradientStyle(
        finite(state?.timeline) + finite(state?.evasion?.reserved),
        0,
      ),
    },
    cooling: {
      heat,
      ventCooldown: whole(state?.ventCooldown),
      ventCooldownLabel: availabilityLabel(state?.ventCooldown),
    },
    specGroups: [
      {
        label: "Identity and limits",
        entries: [
          { label: "Class", value: config?.hullClass ?? "Custom" },
          { label: "Size", value: config?.size ?? "medium" },
          { label: "Initiative", value: signed(config?.initiative) },
          { label: "AC", value: whole(config?.ac) },
          { label: "Signature", value: whole(signature.value) },
          { label: "Hull", value: `${hull.value} / ${hull.maximum}` },
          { label: "Heat", value: `${heat.value} / ${heat.maximum}` },
          {
            label: "Command / Crew",
            value: `${whole(config?.commandCapacity)} / ${
              whole(config?.crewCapacity)
            }`,
          },
          { label: "Fate policy", value: config?.fatePolicy ?? "important" },
        ],
      },
      {
        label: "Movement and defense",
        entries: [
          {
            label: "Main / Reverse thrust",
            value: `${whole(getDriveCapabilities(config, state).forward)} / ${
              whole(getDriveCapabilities(config, state).retro)
            }`,
          },
          {
            label: "Port / Starboard thrust",
            value: `${whole(getDriveCapabilities(config, state).port)} / ${
              whole(getDriveCapabilities(config, state).starboard)
            }`,
          },
          {
            label: "Rotation",
            value: `${whole(rotationCapacity)}°`,
          },
          {
            label: "Safe Velocity",
            value: whole(config?.safeVelocity),
          },
          {
            label: "Evasion",
            value:
              `${percent(config?.evasion?.timelineReserve, 1)}% reserve · +${
                whole(config?.evasion?.acBonus)
              } AC`,
          },
          {
            label: "Armor",
            value: Object.entries(config?.armor ?? {}).map(([sector, value]) =>
              `${SECTOR_LABELS[sector] ?? sector} ${whole(value)}`
            ).join(" · ") || "None",
          },
        ],
      },
      {
        label: "Power, shields, and sensors",
        entries: [
          {
            label: "Reactor",
            value:
              `${whole(config?.components?.reactor?.nominalOutput)} nominal · ${
                whole(config?.components?.reactor?.redlineOutput)
              } redline · ${
                whole(config?.components?.reactor?.overclockHeat)
              } Heat`,
          },
          {
            label: "Available power",
            value: `${power.nominalFree} free · ${power.nominalOutput} nominal (${power.overdriveAvailable} overdrive)`,
          },
          {
            label: "Shields",
            value:
              `${config?.components?.shield?.topology ?? "none"} · ${shields.budget} budget · ${
                whole(config?.components?.shield?.sectorCap)
              } cap · ${whole(config?.components?.shield?.rechargeDelay)} delay`,
          },
          {
            label: "Shield regeneration (Power:value)",
            value: (config?.components?.shield?.tiers ?? []).map((tier) =>
              `${tier.power}:${tier.regeneration ?? 0}`
            ).join(" · ") || "None",
          },
          {
            label: "Passive sensors",
            value:
              `${whole(sensor.passiveRange)} range · ${whole(sensor.passiveStrength)} strength`,
          },
          {
            label: "Active sensors",
            value:
              `${whole(sensor.activeRange)} range · ${signed(sensor.activeModifier)} modifier · ${
                signed(sensor.activeEw)
              } EW`,
          },
          {
            label: "Cooling (Power:value)",
            value: (config?.components?.cooling?.tiers ?? []).map((tier) =>
              `${tier.power}:${tier.cooling ?? 0}`
            ).join(" · ") || "None",
          },
          {
            label: "Emergency vent",
            value:
              `${whole(config?.components?.cooling?.emergencyVentHeat)} Heat · ${
                whole(config?.components?.cooling?.emergencyVentCooldown)
              } Start cooldown`,
          },
        ],
      },
    ],
  };
}
