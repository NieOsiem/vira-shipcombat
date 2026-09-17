import { BARRAGE_PROFILES, mergeProfile } from "../rules/combat.js";
import { getPowerState } from "../rules/power.js";
import { FAULT_CHANNELS, HAZARD_CHANNELS } from "../rules/conditions.js";
import {
  getCurrentSignature,
  getSensorStats,
  sanitizeTrack,
  TRACK_STATUS,
} from "../rules/sensors.js";
import { allocateRegeneration, previewDefenseRoute } from "../rules/shields.js";
import { getDriveCapabilities } from "../rules/movement.js";
import { sceneGridGeometry } from "./scene-geometry.js";

const POWER_SYSTEMS = Object.freeze([
  ["engines", "Engines"],
  ["shields", "Shields"],
  ["sensors", "Sensors"],
  ["cooling", "Cooling"],
  ["weapons", "Weapons"],
]);
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
  return [...operators]
    .filter((operator) => !operator.inactive)
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
  return {
    ...powerState,
    reservingWeapons:
      Object.values(powerState.weaponReservations).filter((reservation) =>
        reservation > 0
      ).length,
    meter: meter(
      powerState.committed,
      powerState.ceilings.maximum,
      powerState.redlining ? "danger" : "power",
    ),
    status: powerState.redlining ? "REDLINE" : `${powerState.unused} AVAILABLE`,
    systems: POWER_SYSTEMS.map(([id, label]) => ({
      id,
      label,
      value: whole(powerState.allocation[id]),
      options: powerOptions(config, powerState, id),
      reservation: id === "weapons" ? whole(powerState.weaponReserved) : null,
    })),
    presets: (config?.powerPresets ?? []).map((preset) => ({
      id: preset.id,
      label: preset.label ?? preset.id,
      allocation: JSON.stringify(preset.allocations ?? {}),
      selected: preset.id === state?.powerPresetId,
    })),
    sheddingPriority: prioritySlots(systems, sheddingPriority),
    weaponPriority: prioritySlots(weapons, weaponPriority),
  };
}

function shieldView(config, state) {
  const shield = config?.components?.shield;
  if (!shield) {
    return {
      topology: "none",
      directional: false,
      sectors: [],
      total: 0,
      budget: 0,
      regeneration: 0,
      meter: meter(0, 0, "shield"),
    };
  }
  const route = previewDefenseRoute(config, state, {});
  const regeneration = whole(
    shield.tiers?.find((tier) => tier.power === state?.power?.shields)
      ?.regeneration,
  );
  const assigned = allocateRegeneration(
    regeneration,
    route.regenerationAllocation,
  );
  const sectors = Object.keys(route.charge).map((id) => ({
    id,
    label: SECTOR_LABELS[id] ?? id,
    charge: whole(route.charge[id]),
    capacity: whole(route.capacities[id]),
    allocation: route.regenerationAllocation[id],
    regeneration: assigned[id],
    canReceive: whole(state?.shields?.collapse?.[id]) === 0 &&
      route.capacities[id] > 0,
    collapse: whole(state?.shields?.collapse?.[id]),
    collapseLabel: availabilityLabel(state?.shields?.collapse?.[id]),
    meter: meter(
      route.charge[id],
      route.capacities[id],
      state?.shields?.collapse?.[id] > 0 ? "danger" : "shield",
    ),
  }));
  return {
    topology: shield.topology ?? "directional",
    directional: shield.topology !== "bubble",
    regeneration,
    sectors,
    total: whole(route.totalCharge),
    budget: whole(shield.totalBudget),
    meter: meter(route.totalCharge, shield.totalBudget, "shield"),
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
  const operators = operatorViews(config, state)
    .filter((operator) =>
      operatorUserId == null || operator.userId === operatorUserId
    );
  const controls = state?.controls ?? {};
  const defaults = {
    helm: bestOperator(operators, "piloting", holderId(controls.helm)),
    power: bestOperator(operators, "engineering", holderId(controls.power)),
    defense: bestOperator(operators, "engineering", holderId(controls.defense)),
    sensors: bestOperator(operators, "sensors"),
    gunnery: bestOperator(operators, "gunnery"),
    engineering: bestOperator(operators, "engineering"),
  };
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
  const rotationCapacity = getDriveCapabilities(config, state).rotation;
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
        state?.weapons?.[weapon.id]?.status !== "online"
      ).map((weapon) => ({
        label: weapon.label ?? weapon.id,
        componentLabel: "Weapon",
        statusLabel: state?.weapons?.[weapon.id]?.status ?? "off",
      })),
      ...[["shields", config?.components?.shield], [
        "sensors",
        config?.components?.sensor,
      ], ["cooling", config?.components?.cooling]].filter((
        [system, component],
      ) => !component || finite(state?.power?.[system]) === 0).map((
        [system, component],
      ) => ({
        label: component?.label ?? system,
        componentLabel: "System",
        statusLabel: component ? "Offline" : "Not installed",
      })),
      ...Object.entries(config?.components?.drives ?? {}).filter(() =>
        finite(state?.power?.engines) === 0
      ).map(([role, component]) => ({
        label: component.label ?? role,
        componentLabel: "Drive",
        statusLabel: "Offline",
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
    defaults,
    roster: rosterSlots(config, state),
    power,
    shields,
    sensor,
    contacts,
    liveContacts: contacts.filter((contact) => contact.live),
    targetedContacts: contacts.filter((contact) => contact.targeted),
    weapons: weaponViews(config, state, power),
    conditions,
    hasConditions: conditions.length > 0,
    work: Object.values(state?.work ?? {}),
    movement: {
      velocityX: Number(finite(state?.velocity?.x).toFixed(2)),
      velocityY: Number(finite(state?.velocity?.y).toFixed(2)),
      speed: Number(speed.toFixed(2)),
      timeline: finite(state?.timeline),
      timelineOccupied: Math.min(
        1,
        finite(state?.timeline) + finite(state?.evasion?.reserved),
      ),
      timelineRemaining: Math.max(
        0,
        1 - finite(state?.timeline) - finite(state?.evasion?.reserved),
      ),
      timelinePercent: percent(
        finite(state?.timeline) + finite(state?.evasion?.reserved),
        1,
      ),
      timelineStyle: `--meter-value:${
        percent(finite(state?.timeline) + finite(state?.evasion?.reserved), 1)
      }%`,
      rotationSpent: finite(state?.rotationSpent),
      rotationCapacity,
      rotationRemaining: Math.max(
        0,
        rotationCapacity - finite(state?.rotationSpent),
      ),
      evasionArmed: state?.evasion?.armed === true,
      evasionReserved: finite(state?.evasion?.reserved),
      safeVelocity: finite(config?.safeVelocity),
    },
    cooling: {
      heat,
      ventCooldown: whole(state?.ventCooldown),
      ventCooldownLabel: availabilityLabel(state?.ventCooldown),
      ventReady: whole(state?.ventCooldown) === 0,
    },
  };
}
