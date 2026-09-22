import { RuleViolation } from "../constants.js";
import {
  beginWeaponReload,
  cancelWeaponReload,
  commitAttack,
  contributeWeaponReload,
  getEffectiveAttackAC,
} from "./combat.js";
import {
  applyConditionTiers,
  getFaultEffects,
  selectCondition,
  setConditionSeverity,
} from "./conditions.js";
import { resolveShipFate } from "./damage.js";
import {
  assertActivePhase,
  cycleOutsideCombatRound,
  enterCombat,
  leaveCombat,
  runEndActiveCoast,
  runEndPhase,
  runStartPhase,
} from "./lifecycle.js";
import {
  applyManeuver,
  applyRotation,
  armEvasion,
  disarmEvasion,
  enforceEvasionEligibility,
  getCollisionSeverity,
  getDriveCapabilities,
  getPivotCapability,
} from "./movement.js";
import {
  MODULE_CONTROLS,
  contributeWork,
  refreshResources,
  seedOperatorResources,
  spendOperationResource,
  takeControl,
  validateRoster,
} from "./operators.js";
import { applyPowerShedding, commitPowerRoute, toggleWeapon } from "./power.js";
import {
  activeCooling,
  contributeRecoveryWork,
  emergencyVent,
  repairHull,
  standardRepair,
} from "./repairs.js";
import {
  acquireTarget,
  activePing,
  addPhysicalContact,
  analyzeDefenses,
  breakLock,
  burnThrough,
  calculateFiringSolution,
  deepScan,
  fadeTrack,
  getSensorStats,
  jamTarget,
  refreshObserverTracks,
} from "./sensors.js";
import {
  applyShieldCapacityClamping,
  commitDefenseRoute,
  resolveShieldDamage,
} from "./shields.js";

export const OPERATION_TYPES = Object.freeze({
  ENTER_COMBAT: "enterCombat",
  START_PHASE: "startPhase",
  COAST: "coast",
  END_PHASE: "endPhase",
  LEAVE_COMBAT: "leaveCombat",
  SET_ROSTER: "setRoster",
  REFRESH_RESOURCES: "refreshResources",
  SPEND_RESOURCE: "spendResource",
  TAKE_CONTROL: "takeControl",
  RELEASE_CONTROL: "releaseControl",
  CONTRIBUTE_WORK: "contributeWork",
  MANEUVER: "maneuver",
  ROTATE: "rotate",
  ARM_EVASION: "armEvasion",
  DISARM_EVASION: "disarmEvasion",
  ROUTE_POWER: "routePower",
  TOGGLE_WEAPON: "toggleWeapon",
  ROUTE_DEFENSE: "routeDefense",
  PING: "ping",
  ACQUIRE: "acquire",
  ANALYZE: "analyze",
  DEEP_SCAN: "deepScan",
  FIRING_SOLUTION: "firingSolution",
  FADE: "fade",
  JAM: "jam",
  BREAK_LOCK: "breakLock",
  BURN_THROUGH: "burnThrough",
  ATTACK: "attack",
  BEGIN_RELOAD: "beginReload",
  RELOAD: "reload",
  CANCEL_RELOAD: "cancelReload",
  REPAIR: "repair",
  RECOVERY_WORK: "recoveryWork",
  HULL_REPAIR: "hullRepair",
  COOLING: "cooling",
  VENT: "vent",
  SET_CONDITION: "setCondition",
  REPOSITION: "reposition",
  RESOLVE_FATE: "resolveFate",
  ADVANCE_TURN: "advanceTurn",
});

const TYPE_ALIASES = Object.freeze({
  "combat.enter": OPERATION_TYPES.ENTER_COMBAT,
  "phase.start": OPERATION_TYPES.START_PHASE,
  "phase.coast": OPERATION_TYPES.COAST,
  "phase.end": OPERATION_TYPES.END_PHASE,
  "phase.advance": OPERATION_TYPES.ADVANCE_TURN,
  "turn.advance": OPERATION_TYPES.ADVANCE_TURN,
  "advance-turn": OPERATION_TYPES.ADVANCE_TURN,
  advanceTurn: OPERATION_TYPES.ADVANCE_TURN,
  cycleRound: OPERATION_TYPES.ADVANCE_TURN,
  "cycle-round": OPERATION_TYPES.ADVANCE_TURN,
  "combat.leave": OPERATION_TYPES.LEAVE_COMBAT,
  "admin.reposition": OPERATION_TYPES.REPOSITION,
  "fate.resolve": OPERATION_TYPES.RESOLVE_FATE,
  enter: OPERATION_TYPES.ENTER_COMBAT,
  "enter-combat": OPERATION_TYPES.ENTER_COMBAT,
  start: OPERATION_TYPES.START_PHASE,
  "start-phase": OPERATION_TYPES.START_PHASE,
  "end-active-coast": OPERATION_TYPES.COAST,
  end: OPERATION_TYPES.END_PHASE,
  "end-phase": OPERATION_TYPES.END_PHASE,
  leave: OPERATION_TYPES.LEAVE_COMBAT,
  "leave-combat": OPERATION_TYPES.LEAVE_COMBAT,
  roster: OPERATION_TYPES.SET_ROSTER,
  resource: OPERATION_TYPES.SPEND_RESOURCE,
  control: OPERATION_TYPES.TAKE_CONTROL,
  work: OPERATION_TYPES.CONTRIBUTE_WORK,
  rotation: OPERATION_TYPES.ROTATE,
  evasion: OPERATION_TYPES.ARM_EVASION,
  "disarm-evasion": OPERATION_TYPES.DISARM_EVASION,
  power: OPERATION_TYPES.ROUTE_POWER,
  weapon: OPERATION_TYPES.TOGGLE_WEAPON,
  defense: OPERATION_TYPES.ROUTE_DEFENSE,
  acquireTarget: OPERATION_TYPES.ACQUIRE,
  analyzeDefenses: OPERATION_TYPES.ANALYZE,
  "deep-scan": OPERATION_TYPES.DEEP_SCAN,
  "firing-solution": OPERATION_TYPES.FIRING_SOLUTION,
  fadeTrack: OPERATION_TYPES.FADE,
  jamTarget: OPERATION_TYPES.JAM,
  "break-lock": OPERATION_TYPES.BREAK_LOCK,
  "burn-through": OPERATION_TYPES.BURN_THROUGH,
  "begin-reload": OPERATION_TYPES.BEGIN_RELOAD,
  contributeReload: OPERATION_TYPES.RELOAD,
  "cancel-reload": OPERATION_TYPES.CANCEL_RELOAD,
  standardRepair: OPERATION_TYPES.REPAIR,
  recovery: OPERATION_TYPES.RECOVERY_WORK,
  "recovery-work": OPERATION_TYPES.RECOVERY_WORK,
  "hull-repair": OPERATION_TYPES.HULL_REPAIR,
  activeCooling: OPERATION_TYPES.COOLING,
  emergencyVent: OPERATION_TYPES.VENT,
  setCondition: OPERATION_TYPES.SET_CONDITION,
  "gm-reposition": OPERATION_TYPES.REPOSITION,
  fate: OPERATION_TYPES.RESOLVE_FATE,
  "resolve-fate": OPERATION_TYPES.RESOLVE_FATE,
});

const KNOWN_TYPES = new Set(Object.values(OPERATION_TYPES));
const GM_TYPES = new Set([
  OPERATION_TYPES.ENTER_COMBAT,
  OPERATION_TYPES.START_PHASE,
  OPERATION_TYPES.COAST,
  OPERATION_TYPES.END_PHASE,
  OPERATION_TYPES.LEAVE_COMBAT,
  OPERATION_TYPES.SET_ROSTER,
  OPERATION_TYPES.REFRESH_RESOURCES,
  OPERATION_TYPES.SET_CONDITION,
  OPERATION_TYPES.REPOSITION,
  OPERATION_TYPES.RESOLVE_FATE,
]);
const ACTIVE_TYPES = new Set([
  OPERATION_TYPES.SPEND_RESOURCE,
  OPERATION_TYPES.TAKE_CONTROL,
  OPERATION_TYPES.CONTRIBUTE_WORK,
  OPERATION_TYPES.MANEUVER,
  OPERATION_TYPES.ROTATE,
  OPERATION_TYPES.ARM_EVASION,
  OPERATION_TYPES.DISARM_EVASION,
  OPERATION_TYPES.ROUTE_POWER,
  OPERATION_TYPES.TOGGLE_WEAPON,
  OPERATION_TYPES.ROUTE_DEFENSE,
  OPERATION_TYPES.PING,
  OPERATION_TYPES.ACQUIRE,
  OPERATION_TYPES.ANALYZE,
  OPERATION_TYPES.DEEP_SCAN,
  OPERATION_TYPES.FIRING_SOLUTION,
  OPERATION_TYPES.FADE,
  OPERATION_TYPES.JAM,
  OPERATION_TYPES.BREAK_LOCK,
  OPERATION_TYPES.BURN_THROUGH,
  OPERATION_TYPES.ATTACK,
  OPERATION_TYPES.BEGIN_RELOAD,
  OPERATION_TYPES.RELOAD,
  OPERATION_TYPES.CANCEL_RELOAD,
  OPERATION_TYPES.REPAIR,
  OPERATION_TYPES.RECOVERY_WORK,
  OPERATION_TYPES.HULL_REPAIR,
  OPERATION_TYPES.COOLING,
  OPERATION_TYPES.VENT,
]);
export const OUTSIDE_COMBAT_ALLOWED_TYPES = new Set([
  OPERATION_TYPES.TAKE_CONTROL,
  OPERATION_TYPES.RELEASE_CONTROL,
  OPERATION_TYPES.ROUTE_POWER,
  OPERATION_TYPES.ROUTE_DEFENSE,
  OPERATION_TYPES.TOGGLE_WEAPON,
  OPERATION_TYPES.MANEUVER,
  OPERATION_TYPES.ROTATE,
  // Evasion belongs to the combat round: `cycleOutsideCombatRound` clears any reservation at every
  // round start, so both evasion operations stay Active-phase only.
  OPERATION_TYPES.REPAIR,
  OPERATION_TYPES.HULL_REPAIR,
  OPERATION_TYPES.RECOVERY_WORK,
  OPERATION_TYPES.COOLING,
  OPERATION_TYPES.VENT,
  OPERATION_TYPES.BEGIN_RELOAD,
  OPERATION_TYPES.RELOAD,
  OPERATION_TYPES.CANCEL_RELOAD,
  OPERATION_TYPES.ADVANCE_TURN,
]);
/**
 * Operations that read canvas geometry: position, facing, line of sight, or collision bodies.
 * A hull with no placed token has none of those, so its geometry would be projected onto the
 * scene origin. The Sheet uses this list for its early "place the ship" refusal; the rules report
 * the same policy as TOKEN_REQUIRED where a case needs it.
 */
export const SPATIAL_OPERATION_TYPES = new Set([
  OPERATION_TYPES.COAST,
  OPERATION_TYPES.MANEUVER,
  OPERATION_TYPES.ROTATE,
  OPERATION_TYPES.REPOSITION,
  OPERATION_TYPES.ATTACK,
  OPERATION_TYPES.PING,
  OPERATION_TYPES.ACQUIRE,
  OPERATION_TYPES.ANALYZE,
  OPERATION_TYPES.DEEP_SCAN,
  OPERATION_TYPES.FIRING_SOLUTION,
  OPERATION_TYPES.FADE,
  OPERATION_TYPES.JAM,
  OPERATION_TYPES.BREAK_LOCK,
  OPERATION_TYPES.BURN_THROUGH,
]);

/** @param {string} type canonical or aliased operation type */
export function requiresPlacedToken(type) {
  return SPATIAL_OPERATION_TYPES.has(TYPE_ALIASES[type] ?? type);
}
const SENSOR_TYPES = new Set([
  OPERATION_TYPES.PING,
  OPERATION_TYPES.ACQUIRE,
  OPERATION_TYPES.ANALYZE,
  OPERATION_TYPES.DEEP_SCAN,
  OPERATION_TYPES.FIRING_SOLUTION,
  OPERATION_TYPES.FADE,
  OPERATION_TYPES.JAM,
  OPERATION_TYPES.BREAK_LOCK,
  OPERATION_TYPES.BURN_THROUGH,
]);
const DRIVE_COMPONENT_ROLES = Object.freeze([
  "main",
  "reverse",
  "portLateral",
  "starboardLateral",
]);

/** Declaration keys a client could use to name a target AC; stripped by `withoutDeclaredTargetAc`. */
const DECLARED_AC_KEYS = Object.freeze([
  "ac",
  "targetAc",
  "declaredAc",
  "finalAc",
  "actualTargetAc",
  "effectiveAc",
]);

const GM_EVENT_ONLY_TYPES = new Set([
  ...GM_TYPES,
  ...SENSOR_TYPES,
  OPERATION_TYPES.MANEUVER,
  OPERATION_TYPES.ROTATE,
  OPERATION_TYPES.ROUTE_POWER,
  OPERATION_TYPES.TOGGLE_WEAPON,
  OPERATION_TYPES.ROUTE_DEFENSE,
]);

/** Player-facing upkeep operations whose chat card is public; a GM whisper would duplicate it. */
const PUBLIC_ONLY_EVENT_TYPES = new Set([
  OPERATION_TYPES.CONTRIBUTE_WORK,
  OPERATION_TYPES.REPAIR,
  OPERATION_TYPES.RECOVERY_WORK,
  OPERATION_TYPES.HULL_REPAIR,
  OPERATION_TYPES.COOLING,
  OPERATION_TYPES.VENT,
  OPERATION_TYPES.ARM_EVASION,
  OPERATION_TYPES.DISARM_EVASION,
  OPERATION_TYPES.BEGIN_RELOAD,
  OPERATION_TYPES.RELOAD,
  OPERATION_TYPES.CANCEL_RELOAD,
]);

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function violation(code, message, details) {
  throw new RuleViolation(code, message, details);
}

function recordState(record) {
  return record?.state ?? record?.shipCombat?.state ??
    record?.system?.shipCombat?.state;
}

function recordConfig(record) {
  return record?.config ?? record?.shipCombat?.config ??
    record?.system?.shipCombat?.config;
}

function recordToken(record) {
  return record?.token ?? record?.tokenData ?? record?.transform ?? {};
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    violation("INVALID_OPERATION", "A ship operation must be an object.");
  }
  const suppliedType = operation.type;
  if (typeof suppliedType !== "string" || !suppliedType) {
    violation(
      "INVALID_OPERATION_TYPE",
      "A ship operation requires a stable type string.",
    );
  }
  const type = TYPE_ALIASES[suppliedType] ?? suppliedType;
  if (!KNOWN_TYPES.has(type)) {
    violation(
      "UNKNOWN_OPERATION",
      "The requested ship operation is not supported.",
      { type: suppliedType },
    );
  }
  if (typeof operation.sourceUuid !== "string" || !operation.sourceUuid) {
    violation(
      "OPERATION_SOURCE_REQUIRED",
      "A ship operation requires a source token UUID.",
    );
  }
  if (operation.targetUuids != null && !Array.isArray(operation.targetUuids)) {
    violation(
      "INVALID_OPERATION_TARGETS",
      "Operation targetUuids must be an array.",
    );
  }
  if (
    operation.payload != null &&
    (typeof operation.payload !== "object" || Array.isArray(operation.payload))
  ) {
    violation(
      "INVALID_OPERATION_PAYLOAD",
      "An operation payload must be an object.",
    );
  }
  return {
    ...operation,
    type,
    targetUuids: Array.from(operation.targetUuids ?? [], String),
    payload: clone(operation.payload ?? {}),
  };
}

function buildDrafts(context) {
  if (!context?.ships || typeof context.ships !== "object") {
    violation(
      "OPERATION_SHIPS_REQUIRED",
      "Operation context requires ship snapshots keyed by token UUID.",
    );
  }
  const drafts = new Map();
  for (const [uuid, record] of Object.entries(context.ships)) {
    const state = recordState(record);
    const config = recordConfig(record);
    if (
      !state || typeof state !== "object" || !config ||
      typeof config !== "object"
    ) {
      violation(
        "INVALID_SHIP_SNAPSHOT",
        "Every ship snapshot requires config and state objects.",
        { uuid },
      );
    }
    drafts.set(uuid, {
      uuid,
      source: record,
      config,
      state: clone(state),
      token: clone(recordToken(record)),
    });
  }
  return drafts;
}

function requireShip(drafts, uuid, role = "ship") {
  const ship = drafts.get(uuid);
  if (!ship) {
    violation(
      "SHIP_NOT_FOUND",
      `The ${role} token UUID is not present in the operation snapshot.`,
      { uuid, role },
    );
  }
  return ship;
}

function assignmentId(entry) {
  return typeof entry === "string" ? entry : entry?.operatorId ?? entry?.id;
}

function operatorFor(ship, operation, context) {
  const operatorId = operation.payload.operatorId;
  const isOutside = OUTSIDE_COMBAT_ALLOWED_TYPES.has(operation.type) && ship.state?.phase === "outsideCombat";
  const override = context?.isGM === true || isOutside;
  if (typeof operatorId !== "string" || !operatorId) {
    if (override) return null;
    violation(
      "OPERATOR_REQUIRED",
      "This operation requires a ship-local operatorId.",
      { type: operation.type },
    );
  }
  const profile = (ship.config?.operators ?? []).find((candidate) =>
    candidate?.id === operatorId
  );
  const assignment = ["command", "crew"]
    .flatMap((slot) =>
      (ship.state?.roster?.[slot] ?? []).map((entry) => ({ slot, entry }))
    )
    .find(({ entry }) => assignmentId(entry) === operatorId);
  if (!profile || !assignment) {
    if (override) return profile ?? null;
    violation(
      "OPERATOR_NOT_ASSIGNED",
      "The operator is not currently assigned to this ship.",
      { operatorId },
    );
  }
  if (
    profile.active === false || profile.incapacitated === true ||
    profile.disconnected === true ||
    assignment.entry?.active === false ||
    assignment.entry?.incapacitated === true ||
    assignment.entry?.disconnected === true
  ) {
    if (!override) {
      violation(
        "OPERATOR_INACTIVE",
        "The assigned operator is not currently active.",
        { operatorId },
      );
    }
  }
  const assignedUserId =
    (typeof assignment.entry === "object" ? assignment.entry.userId : null) ??
      profile.userId;
  if (assignedUserId !== context?.userId) {
    if (!override) {
      violation(
        "OPERATOR_PERMISSION_DENIED",
        "The submitting user does not own this ship-local operator assignment.",
        {
          operatorId,
          userId: context?.userId ?? null,
        },
      );
    }
  }
  return profile;
}

function requireGM(operation, context) {
  if (context?.isGM !== true) {
    violation(
      "GM_REQUIRED",
      "Only the active GM may perform this ship operation.",
      { type: operation.type },
    );
  }
}

function requireRoll(context) {
  if (typeof context?.rollD20 !== "function") {
    violation(
      "MISSING_ROLL_SOURCE",
      "This operation requires an injected d20 roll source.",
    );
  }
  const roll = context.rollD20();
  if (!Number.isInteger(roll) || roll < 1 || roll > 20) {
    violation(
      "INVALID_D20",
      "Injected d20 roll must return an integer from 1 through 20.",
      { roll },
    );
  }
  return roll;
}

function randomSource(context) {
  if (context?.random !== undefined) return context.random;
  return undefined;
}

function positionOf(ship, context) {
  const adapter = context?.geometry?.positionOf ??
    context?.geometry?.getPosition;
  if (typeof adapter === "function") {
    return clone(adapter(ship.source, ship.state, ship.token));
  }
  return clone(
    ship.state?.position ?? ship.token?.position ??
      { x: ship.token?.x ?? 0, y: ship.token?.y ?? 0 },
  );
}

function facingOf(ship, context) {
  const adapter = context?.geometry?.facingOf ?? context?.geometry?.getFacing;
  if (typeof adapter === "function") {
    return Number(adapter(ship.source, ship.state, ship.token));
  }
  return Number(ship.state?.facing ?? ship.token?.rotation ?? 0);
}

function distanceBetween(source, target, context) {
  const adapter = context?.geometry?.distanceBetween ??
    context?.geometry?.distance;
  if (typeof adapter === "function") {
    return Number(
      adapter(source.source, target.source, source.state, target.state),
    );
  }
  const first = positionOf(source, context);
  const second = positionOf(target, context);
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function lineOfSight(kind, source, target, operation, context) {
  const geometry = context?.geometry ?? {};
  const adapter = kind === "weapon"
    ? geometry.weaponLineOfSight ?? geometry.lineOfSight
    : geometry.sensorLineOfSight ?? geometry.lineOfSight;
  if (typeof adapter === "function") {
    return adapter(source.source, target.source, {
      kind,
      operation,
      sourceState: source.state,
      targetState: target.state,
    }) === true;
  }
  const payloadKey = kind === "weapon" ? "lineOfSight" : "sensorLineOfSight";
  return operation.payload[payloadKey] ?? operation.payload.lineOfSight ?? true;
}

function collisionRadius(ship, context) {
  const adapter = context?.geometry?.collisionRadius;
  if (typeof adapter === "function") {
    return Number(adapter(ship.source, ship.state, ship.token));
  }
  const tokenRadius = Number.isFinite(ship.token?.width)
    ? ship.token.width / 2
    : 0;
  return Number(
    ship.source?.collisionRadius ?? ship.token?.collisionRadius ??
      ship.config?.collisionRadius ?? tokenRadius,
  );
}

function tokenTransform(ship, position, facing, context) {
  ship.state.position = clone(position);
  ship.state.facing = Number(facing);
  const adapter = context?.geometry?.tokenUpdate ??
    context?.geometry?.toTokenUpdate;
  const update = typeof adapter === "function"
    ? adapter({
      uuid: ship.uuid,
      ship: ship.source,
      token: clone(ship.token),
      position: clone(position),
      facing: Number(facing),
    })
    : { x: position.x, y: position.y, rotation: Number(facing) };
  if (!update || typeof update !== "object") {
    violation(
      "INVALID_TOKEN_TRANSFORM",
      "The geometry adapter must return a token update object.",
      { uuid: ship.uuid },
    );
  }
  ship.token = { ...ship.token, ...clone(update) };
}

function driveCapabilities(ship) {
  return {
    ...getDriveCapabilities(ship.config, ship.state),
    pivot: getPivotCapability(ship.config, ship.state),
  };
}
function installedComponents(config) {
  const components = config?.components ?? {};
  const drives = DRIVE_COMPONENT_ROLES
    .map((role) => components.drives?.[role])
    .filter(Boolean);
  return [
    components.reactor,
    ...drives,
    components.shield,
    components.sensor,
    components.cooling,
    ...(components.weapons ?? []),
  ].filter(Boolean);
}

function obstacleSnapshots(source, drafts, context) {
  const obstacles = [];
  for (const ship of drafts.values()) {
    if (ship.uuid === source.uuid) continue;
    // No canvas transform means no collision body: without this the ship would sit invisible at
    // the scene's top-left cell and a placed ship moving through it would take phantom damage.
    if (ship.token?.x == null) continue;
    obstacles.push({
      id: ship.uuid,
      position: positionOf(ship, context),
      velocity: clone(ship.state?.velocity ?? { x: 0, y: 0 }),
      facing: facingOf(ship, context),
      radius: collisionRadius(ship, context),
      size: ship.config?.size ?? "medium",
      maxHull: ship.config?.maxHull,
      armor: 0,
    });
  }
  const wallProvider = context?.geometry?.walls ?? context?.walls;
  const walls = typeof wallProvider === "function"
    ? wallProvider(source.source)
    : wallProvider;
  for (const wall of walls ?? []) {
    obstacles.push({ ...clone(wall), type: "wall" });
  }
  return obstacles;
}

function movementInput(source, drafts, operation, context) {
  return {
    ...operation.payload,
    id: source.uuid,
    position: positionOf(source, context),
    facing: facingOf(source, context),
    capabilities: driveCapabilities(source),
    collisionRadius: collisionRadius(source, context),
    ship: {
      id: source.uuid,
      size: source.config?.size ?? "medium",
      radius: collisionRadius(source, context),
      maxHull: source.config?.maxHull,
      armor: 0,
    },
    obstacles: obstacleSnapshots(source, drafts, context),
  };
}

function targetObservation(source, target, operation, context) {
  const position = positionOf(target, context);
  return {
    targetUuid: target.uuid,
    uuid: target.uuid,
    targetConfig: target.config,
    targetState: target.state,
    distance: distanceBetween(source, target, context),
    sensorLineOfSight: lineOfSight(
      "sensor",
      source,
      target,
      operation,
      context,
    ),
    position,
    velocity: clone(target.state?.velocity ?? { x: 0, y: 0 }),
    facing: facingOf(target, context),
    effectiveAc: getEffectiveAttackAC(target.config, target.state),
    label: target.source?.label ?? target.token?.name ?? target.config?.label,
    size: target.config?.size,
    shipClass: target.config?.shipClass ?? target.config?.label,
  };
}

function occupiedRosterIdentities(source, drafts) {
  const identities = [];
  for (const ship of drafts.values()) {
    if (ship.uuid === source.uuid || ship.state?.phase === "outsideCombat") {
      continue;
    }
    const validated = validateRoster(
      ship.config,
      ship.state?.roster ?? { command: [], crew: [] },
    );
    // Template operator IDs are ship-local; only bound individuals occupy other ships.
    for (const identity of validated.identities) {
      if (identity.actorId != null) {
        identities.push(`actor:${identity.actorId}`);
      }
      if (identity.userId != null) identities.push(`user:${identity.userId}`);
    }
  }
  return identities;
}

function sensorInput(source, target, operation, context, operator) {
  const observation = target
    ? targetObservation(source, target, operation, context)
    : {};
  return {
    ...operation.payload,
    ...observation,
    operatorId: operation.payload.operatorId,
    operatorUuid: operation.payload.operatorId,
    operatorSensors: Number(
      operator?.ratings?.sensors ?? operator?.sensors ?? 0,
    ),
    observerUuid: source.uuid,
    sourceUuid: source.uuid,
    actingUuid: source.uuid,
    config: source.config,
    observerConfig: source.config,
    actingConfig: source.config,
    actingState: source.state,
    state: source.state,
    d20: undefined,
  };
}

function requireSingleTarget(operation, drafts) {
  if (operation.targetUuids.length !== 1) {
    violation(
      "SINGLE_TARGET_REQUIRED",
      "This operation requires exactly one target token UUID.",
      {
        targetUuids: operation.targetUuids,
      },
    );
  }
  if (operation.targetUuids[0] === operation.sourceUuid) {
    violation(
      "SELF_TARGET_FORBIDDEN",
      "This operation cannot target its own source ship.",
    );
  }
  return requireShip(drafts, operation.targetUuids[0], "target");
}

/**
 * The AC a shot rolls against is derived from the target's own configuration, so no field a
 * client can set may stand in for it (§10.10, §8.10, AGENTS.md authority invariants).
 */
function withoutDeclaredTargetAc(source) {
  const clean = { ...source };
  for (const key of DECLARED_AC_KEYS) delete clean[key];
  return clean;
}

function validateExpectedRevisions(operation, drafts, uuids) {
  const expected = operation.expectedRevisions;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    violation(
      "EXPECTED_REVISIONS_REQUIRED",
      "An operation requires expected revisions keyed by token UUID.",
    );
  }
  for (const uuid of uuids) {
    if (
      !Object.hasOwn(expected, uuid) || !Number.isInteger(expected[uuid]) ||
      expected[uuid] < 0
    ) {
      violation(
        "EXPECTED_REVISION_REQUIRED",
        "Every affected ship requires a nonnegative expected revision.",
        { uuid },
      );
    }
    const actual = recordState(requireShip(drafts, uuid))?.revision;
    if (expected[uuid] !== actual) {
      violation(
        "STALE_SHIP_REVISION",
        "A ship changed after this operation was prepared.",
        {
          uuid,
          expected: expected[uuid],
          actual,
        },
      );
    }
  }
}

/**
 * §19.1: a ship awaiting its fate pauses further NEW deliberate operations, and a Hull-0
 * wreck (disabled or destroyed) cannot take normal deliberate Ship Actions/Orders at all.
 * Lifecycle transitions, GM operations, resolveFate, and everything outside ACTIVE_TYPES
 * stay available, because those are what move a wrecked ship back out of combat.
 */
function assertShipCanAct(state) {
  const hull = Number(state?.hull);
  if (state?.pendingFate?.status === "pending" || !(hull > 0)) {
    violation(
      "SHIP_DESTROYED",
      "A ship at Hull 0 or awaiting its fate cannot perform further deliberate operations.",
      { hull: Number.isFinite(hull) ? hull : null, pendingFate: state?.pendingFate ?? null },
    );
  }
}

function requireControl(source, control, operatorId, context) {
  if (context?.isGM === true || source.state?.phase === "outsideCombat") return;
  const holder = source.state?.controls?.[control];
  const holderId = typeof holder === "string" ? holder : holder?.operatorId;
  if (holderId !== operatorId) {
    violation(
      "CONTROL_REQUIRED",
      `This operation requires held ${control} control.`,
      { control, operatorId, holderId: holderId ?? null },
    );
  }
}
function releaseControl(source, control, operatorId, context) {
  if (context?.isGM === true) return false;
  if (source.state?.phase === "outsideCombat") return true;
  const holder = source.state?.controls?.[control];
  const holderId = typeof holder === "string" ? holder : holder?.operatorId;
  if (holderId !== operatorId) return false;
  source.state.controls[control] = null;
  return true;
}

function evasionEligibility(ship) {
  const capabilities = driveCapabilities(ship);
  return enforceEvasionEligibility(ship.state, {
    enginesPower: Number(ship.state?.power?.engines ?? 0),
    hardwareOperational:
      Math.max(capabilities.forward, capabilities.retro) > 0 &&
      capabilities.rotation > 0 &&
      Math.max(capabilities.port, capabilities.starboard) > 0,
    pivotCapability: capabilities.pivot,
    evasionAcBonus: ship.config?.evasionAcBonus,
  });
}

function applyImmediateConsequences(ship) {
  const shedding = applyPowerShedding(ship.config, ship.state);
  const shields = applyShieldCapacityClamping(ship.config, ship.state);
  const evasion = evasionEligibility(ship);
  const sensors = getSensorStats(ship.config, ship.state).online
    ? null
    : refreshObserverTracks({
      observerConfig: ship.config,
      observerState: ship.state,
      targets: [],
    });
  return { shedding, shields, evasion, sensors };
}

/**
 * Rules 8.8 / 8.11 / 8.12: passive detection is event-driven, so a ship that moves is
 * re-detected by every observer (and re-detects everyone itself) instead of waiting for its
 * next Start. Only pairs that involve a ship which actually moved can change, and every such
 * pair is handed to `refreshObserverTracks`, which applies the §8.8/§8.11/§8.12 split itself:
 * a passive-only Contact whose detection fails (including by leaving Passive Range) downgrades
 * to Undetected with a visibly stale last-known marker, a Targeted track keeps its next-Start
 * range grace, and a still-live active-contact lifetime stays a Contact. Ranged-out pairs are
 * cheap there — no line-of-sight raycast, and unless a track really changed no observer write
 * and so no console rebuild on any client.
 */
function refreshMovementDetection(drafts, moved, request, context, changed, events) {
  if (!moved.size) return;
  for (const observer of drafts.values()) {
    const stats = getSensorStats(observer.config, observer.state);
    if (!stats.online) continue;
    const before = JSON.stringify(observer.state.tracks ?? {});
    const targets = [];
    for (const other of drafts.values()) {
      if (other.uuid === observer.uuid) continue;
      if (!moved.has(other.uuid) && !moved.has(observer.uuid)) continue;
      targets.push(targetObservation(observer, other, request, context));
    }
    if (!targets.length) continue;
    const result = refreshObserverTracks({
      observerConfig: observer.config,
      observerState: observer.state,
      targets,
    });
    if (JSON.stringify(observer.state.tracks ?? {}) === before) continue;
    changed.add(observer.uuid);
    if (result.acquired.length || result.lost.length) {
      events.gmEvents.push({
        type: "movement.detection",
        sourceUuid: observer.uuid,
        targetUuids: [...result.acquired, ...result.lost],
        detail: { acquired: result.acquired, lost: result.lost, moved: [...moved] },
      });
    }
  }
}

function operationMetadata(operation, context) {
  return {
    id: operation.type,
    bypassProcedure: context?.isGM === true,
  };
}

function spend(source, operation, context) {
  return spendOperationResource(source.config, source.state, {
    operatorId: operation.payload.operatorId,
    operation: operationMetadata(operation, context),
    cost: 1,
    free: false,
  });
}

function addEvent(collections, type, result, options = {}) {
  const base = {
    type,
    sourceUuid: options.sourceUuid,
    targetUuids: options.targetUuids ?? [],
  };
  if (result && (Object.hasOwn(result, "public") || Object.hasOwn(result, "gm"))) {
    if (!options.publicOnly && !options.gmOnly && result.public != null) {
      collections.publicEvents.push({ ...base, detail: clone(result.public) });
    }
    if (!options.publicOnly && result.gm != null) {
      collections.gmEvents.push({ ...base, detail: clone(result.gm) });
    }
    return;
  }
  if (options.publicOnly) {
    collections.publicEvents.push({ ...base, detail: clone(result) });
    return;
  }
  collections.gmEvents.push({ ...base, detail: clone(result) });
  if (!options.gmOnly) {
    collections.publicEvents.push({ ...base, detail: clone(result) });
  }
}

function collisionSector(impact, uuid) {
  return impact?.conditionEvents?.find((event) => String(event.shipId) === uuid)
    ?.sector;
}

function applyCollisionDamage(ship, impact, participant, context) {
  const damage = participant?.damage;
  if (!damage?.applied || damage.calculatedRawDamage <= 0) return null;
  const sector = collisionSector(impact, ship.uuid) ?? "fore";
  const result = resolveShieldDamage(ship.config, ship.state, {
    sector,
    shieldDamage: 0,
    hullDamage: damage.calculatedRawDamage,
    heatDamage: 0,
    bypass: { hull: true },
  });
  const severity = getCollisionSeverity(
    result.hullDamageTaken,
    Number(ship.config?.maxHull),
  );
  let condition = null;
  if (severity) {
    const tiers = { minor: 1, major: 2, critical: 3 }[severity];
    const conditionId = selectCondition(ship.config, ship.state, {
      sector,
      random: randomSource(context),
    });
    if (conditionId) {
      condition = applyConditionTiers(ship.config, ship.state, {
        conditionId,
        tiers,
        sector,
        random: randomSource(context),
      });
    }
  }
  return { sector, damage: result, severity, condition };
}

function applyMovementResult(
  source,
  result,
  drafts,
  context,
  changed,
  tokenChanged,
) {
  const finalPosition = result.position ?? result.coast?.position;
  const finalFacing = result.facing ?? result.coast?.facing ??
    facingOf(source, context);
  changed.add(source.uuid);
  const collisionResults = [];
  for (
    const collision of result.collisionEvents ??
      result.coast?.collisionEvents ?? []
  ) {
    const impact = collision?.impact;
    if (!impact) continue;
    if (impact.type === "wall") {
      const damage = applyCollisionDamage(source, impact, impact.ship, context);
      collisionResults.push({
        obstacleId: collision.obstacleId,
        sourceUuid: source.uuid,
        damage,
      });
      continue;
    }
    const target = drafts.get(String(collision.obstacleId));
    if (!target) {
      violation(
        "COLLISION_SHIP_NOT_FOUND",
        "A collision participant is missing from the atomic snapshot.",
        { uuid: collision.obstacleId },
      );
    }
    target.state.velocity = clone(impact.shipB.velocity);
    tokenTransform(
      target,
      impact.shipB.position,
      facingOf(target, context),
      context,
    );
    const sourceDamage = applyCollisionDamage(
      source,
      impact,
      impact.shipA,
      context,
    );
    addPhysicalContact(source.state, {
      targetUuid: target.uuid,
      physicalUntilTurnKey: true,
      observation: {
        position: clone(impact.shipB.position),
        velocity: clone(impact.shipB.velocity),
        facing: facingOf(target, context),
      },
    });
    addPhysicalContact(target.state, {
      targetUuid: source.uuid,
      physicalUntilTurnKey: true,
      observation: {
        position: clone(impact.shipA.position),
        velocity: clone(impact.shipA.velocity),
        facing: facingOf(source, context),
      },
    });
    const targetDamage = applyCollisionDamage(
      target,
      impact,
      impact.shipB,
      context,
    );
    changed.add(target.uuid);
    tokenChanged.add(target.uuid);
    collisionResults.push({
      obstacleId: target.uuid,
      sourceUuid: source.uuid,
      sourceDamage,
      targetDamage,
    });
  }
  if (finalPosition) {
    tokenTransform(source, finalPosition, finalFacing, context);
    tokenChanged.add(source.uuid);
  }
  return collisionResults;
}

/**
 * Execute one authoritative operation exclusively against cloned ship and token snapshots.
 * @param {object} operation canonical operation request
 * @param {object} context pure authority context
 * @returns {{shipStates:object,tokenUpdates:object,publicEvents:object[],gmEvents:object[],changedUuids:string[]}}
 */
export function executeShipOperation(operation, context) {
  const request = normalizeOperation(operation);
  const drafts = buildDrafts(context);
  const source = requireShip(drafts, request.sourceUuid, "source");
  const changed = new Set();
  const tokenChanged = new Set();
  const events = { publicEvents: [], gmEvents: [] };

  if (GM_TYPES.has(request.type)) requireGM(request, context);
  let operator = null;
  if (!GM_TYPES.has(request.type)) {
    operator = operatorFor(source, request, context);
  }
  if (ACTIVE_TYPES.has(request.type)) {
    const allowedOutside = OUTSIDE_COMBAT_ALLOWED_TYPES.has(request.type) && source.state.phase === "outsideCombat";
    if (!allowedOutside && context?.isGM !== true) {
      assertActivePhase(source.state);
    }
    assertShipCanAct(source.state);
  }
  if (request.type === OPERATION_TYPES.ADVANCE_TURN) {
    if (source.state.phase !== "outsideCombat") {
      violation(
        "SHIP_NOT_OUTSIDE_COMBAT",
        "Advance Turn can only be performed outside combat.",
        { phase: source.state.phase },
      );
    }
    assertShipCanAct(source.state);
  }
  validateExpectedRevisions(request, drafts, [
    request.sourceUuid,
    ...request.targetUuids,
  ]);

  let result;
  switch (request.type) {
    case OPERATION_TYPES.ENTER_COMBAT:
      result = enterCombat(source.config, source.state, {
        turnKey: request.payload.turnKey,
      });
      break;
    case OPERATION_TYPES.START_PHASE: {
      const targets = Array.from(drafts.values())
        .filter((ship) => ship.uuid !== source.uuid)
        .map((ship) => targetObservation(source, ship, request, context));
      result = runStartPhase(source.config, source.state, {
        ...request.payload,
        occupiedIdentities: occupiedRosterIdentities(source, drafts),
        conflictPolicy: "advisory",
        targets,
        random: randomSource(context),
      });
      break;
    }
    case OPERATION_TYPES.COAST: {
      result = runEndActiveCoast(
        source.config,
        source.state,
        movementInput(source, drafts, request, context),
      );
      const collisions = applyMovementResult(
        source,
        result,
        drafts,
        context,
        changed,
        tokenChanged,
      );
      result = { ...result, collisions };
      break;
    }
    case OPERATION_TYPES.END_PHASE:
      result = runEndPhase(source.config, source.state, {
        ...request.payload,
        random: randomSource(context),
      });
      break;
    case OPERATION_TYPES.LEAVE_COMBAT:
      result = leaveCombat(source.config, source.state);
      break;
    case OPERATION_TYPES.SET_ROSTER: {
      const roster = request.payload.roster ?? request.payload;
      const validated = validateRoster(source.config, roster, {
        occupiedIdentities: occupiedRosterIdentities(source, drafts),
        conflictPolicy: "explicit",
      });
      source.state.roster = {
        ...(source.state.roster ?? {}),
        command: validated.command,
        crew: validated.crew,
      };
      // A mid-combat recruit seated after the Start Phase still needs its pool entry, and
      // seeding only absent entries leaves every partly spent pool untouched.
      seedOperatorResources(source.state, source.state.roster);
      result = validated;
      break;
    }
    case OPERATION_TYPES.REFRESH_RESOURCES:
      result = refreshResources(source.config, source.state, {
        ...request.payload,
        occupiedIdentities: occupiedRosterIdentities(source, drafts),
        conflictPolicy: "advisory",
      });
      break;
    case OPERATION_TYPES.SPEND_RESOURCE:
      result = spend(source, request, context);
      break;
    case OPERATION_TYPES.TAKE_CONTROL:
      result = takeControl(source.config, source.state, {
        operatorId: request.payload.operatorId,
        control: request.payload.control,
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.RELEASE_CONTROL: {
      const control = request.payload.control;
      if (!MODULE_CONTROLS.includes(control)) {
        violation(
          "INVALID_CONTROL",
          `Unknown subsystem control "${control}". Allowed controls: ${
            MODULE_CONTROLS.join(", ")
          }.`,
          { control, allowed: MODULE_CONTROLS },
        );
      }
      const holder = source.state?.controls?.[control];
      const holderId = typeof holder === "string" ? holder : holder?.operatorId;
      if (
        holderId &&
        holderId !== request.payload.operatorId &&
        context?.isGM !== true
      ) {
        violation(
          "CONTROL_HELD_BY_OTHER",
          "You cannot release a control held by another operator.",
          { control, holderId },
        );
      }
      source.state.controls ??= {};
      source.state.controls[control] = null;
      result = { control, released: true };
      break;
    }
    case OPERATION_TYPES.CONTRIBUTE_WORK:
      result = contributeWork(source.config, source.state, {
        ...request.payload,
        operatorId: request.payload.operatorId,
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.MANEUVER: {
      if (source.token?.x == null) {
        violation("TOKEN_REQUIRED", "Maneuver requires a placed token on the canvas.");
      }
      requireControl(source, "helm", request.payload.operatorId, context);
      result = applyManeuver(
        source.state,
        movementInput(source, drafts, request, context),
      );
      const collisions = applyMovementResult(
        source,
        result,
        drafts,
        context,
        changed,
        tokenChanged,
      );
      result = { ...result, collisions };
      break;
    }
    case OPERATION_TYPES.ROTATE: {
      if (source.token?.x == null) {
        violation("TOKEN_REQUIRED", "Rotation requires a placed token on the canvas.");
      }
      requireControl(source, "helm", request.payload.operatorId, context);
      result = applyRotation(
        source.state,
        movementInput(source, drafts, request, context),
      );
      applyMovementResult(
        source,
        result,
        drafts,
        context,
        changed,
        tokenChanged,
      );
      break;
    }
    case OPERATION_TYPES.ARM_EVASION: {
      requireControl(source, "helm", request.payload.operatorId, context);
      const capabilities = driveCapabilities(source);
      const reserve = Number(source.config?.evasionReserve ?? 0);
      result = armEvasion(source.state, {
        phase: context?.isGM === true ? "active" : source.state.phase,
        hasHelm: true,
        enginesPower: Number(source.state?.power?.engines ?? 0),
        hardwareOperational:
          Math.max(capabilities.forward, capabilities.retro) > 0 &&
          capabilities.rotation > 0 &&
          Math.max(capabilities.port, capabilities.starboard) > 0,
        pivotCapability: capabilities.pivot,
        tier: request.payload.tier === "hard" ? "hard" : "standard",
        evasionReserve: request.payload.reserve != null && Number(request.payload.reserve) <= 1
          ? Number(request.payload.reserve)
          : reserve > 1 ? reserve / 100 : reserve,
        evasionAcBonus: source.config?.evasionAcBonus,
      });
      break;
    }
    case OPERATION_TYPES.DISARM_EVASION:
      requireControl(source, "helm", request.payload.operatorId, context);
      result = disarmEvasion(source.state);
      break;
    case OPERATION_TYPES.ROUTE_POWER: {
      requireControl(source, "power", request.payload.operatorId, context);
      const route = commitPowerRoute(
        source.config,
        source.state,
        request.payload.staged ?? request.payload,
      );
      result = {
        ...route,
        evasion: evasionEligibility(source),
        controlReleased: releaseControl(
          source,
          "power",
          request.payload.operatorId,
          context,
        ),
      };
      break;
    }
    case OPERATION_TYPES.TOGGLE_WEAPON: {
      const eligibility = spendOperationResource(source.config, source.state, {
        operatorId: request.payload.operatorId,
        operation: operationMetadata(request, context),
        free: true,
      });
      result = {
        ...toggleWeapon(source.config, source.state, request.payload),
        eligibility,
      };
      break;
    }
    case OPERATION_TYPES.ROUTE_DEFENSE:
      requireControl(source, "defense", request.payload.operatorId, context);
      result = {
        ...commitDefenseRoute(
          source.config,
          source.state,
          request.payload.staged ?? request.payload,
        ),
        controlReleased: releaseControl(
          source,
          "defense",
          request.payload.operatorId,
          context,
        ),
      };
      break;
    case OPERATION_TYPES.PING: {
      const targets = request.targetUuids.length
        ? request.targetUuids.map((uuid) =>
          targetObservation(
            source,
            requireShip(drafts, uuid, "target"),
            request,
            context,
          )
        )
        : Array.from(drafts.values()).filter((ship) =>
          ship.uuid !== source.uuid
        ).map((ship) => targetObservation(source, ship, request, context));
      spend(source, request, context);
      result = activePing(source.state, {
        ...sensorInput(source, null, request, context, operator),
        d20: requireRoll(context),
        targets,
      });
      break;
    }
    case OPERATION_TYPES.ACQUIRE:
    case OPERATION_TYPES.ANALYZE:
    case OPERATION_TYPES.DEEP_SCAN:
    case OPERATION_TYPES.FIRING_SOLUTION: {
      const target = requireSingleTarget(request, drafts);
      spend(source, request, context);
      const input = sensorInput(source, target, request, context, operator);
      if (request.type === OPERATION_TYPES.ACQUIRE) {
        if (request.payload.dc != null) input.d20 = requireRoll(context);
        // §8.10: the AC and velocity a Targeted track reveals come from the target itself,
        // never from a declaration field the client supplied.
        input.telemetry = targetObservation(source, target, request, context);
        result = acquireTarget(source.state, input);
      } else if (request.type === OPERATION_TYPES.ANALYZE) {
        result = analyzeDefenses(source.state, {
          ...input,
          telemetry: targetObservation(source, target, request, context),
        });
      } else if (request.type === OPERATION_TYPES.DEEP_SCAN) {
        result = deepScan(source.state, {
          ...input,
          identifiedSubsystems: installedComponents(target.config)
            .map(({ id, label, class: componentClass, regions }) => ({
              id,
              label,
              class: componentClass,
              regions,
            })),
          telemetry: targetObservation(source, target, request, context),
        });
      } else result = calculateFiringSolution(source.state, input);
      break;
    }
    case OPERATION_TYPES.FADE: {
      spend(source, request, context);
      const observers = Array.from(drafts.values()).filter((ship) =>
        ship.uuid !== source.uuid
      ).map((observer) => ({
        observerUuid: observer.uuid,
        observerConfig: observer.config,
        observerState: observer.state,
        distance: distanceBetween(observer, source, context),
        sensorLineOfSight: lineOfSight(
          "sensor",
          observer,
          source,
          request,
          context,
        ),
      }));
      result = fadeTrack({
        ...sensorInput(source, null, request, context, operator),
        observers,
      });
      for (const observerUuid of result.lostBy) changed.add(observerUuid);
      break;
    }
    case OPERATION_TYPES.JAM:
    case OPERATION_TYPES.BREAK_LOCK:
    case OPERATION_TYPES.BURN_THROUGH: {
      const target = requireSingleTarget(request, drafts);
      spend(source, request, context);
      const input = {
        ...sensorInput(source, target, request, context, operator),
        targetUuid: target.uuid,
        targetConfig: target.config,
        targetState: target.state,
        jammerUuid: target.uuid,
        jammerConfig: target.config,
        jammerState: target.state,
        recipientDistance: distanceBetween(target, source, context),
        recipientSensorLineOfSight: lineOfSight(
          "sensor",
          target,
          source,
          request,
          context,
        ),
        d20: requireRoll(context),
      };
      if (request.type === OPERATION_TYPES.JAM) {
        result = jamTarget(input);
        if (result.success) changed.add(target.uuid);
      } else if (request.type === OPERATION_TYPES.BREAK_LOCK) {
        result = breakLock(input);
        if (result.broken) changed.add(target.uuid);
      } else result = burnThrough(input);
      break;
    }
    case OPERATION_TYPES.ATTACK: {
      // §9 and decision 46: one Action fires one weapon or Barrage at exactly one target, so a
      // second target is rejected here instead of spending an extra Action per target.
      const target = requireSingleTarget(request, drafts);
      const targetPayload = request.payload.targets?.[target.uuid] ?? {};
      const declaration = {
        ...withoutDeclaredTargetAc(request.payload),
        ...withoutDeclaredTargetAc(targetPayload),
        attackerUuid: source.uuid,
        targetUuid: target.uuid,
        attackerPosition: positionOf(source, context),
        targetPosition: positionOf(target, context),
        attackerVelocity: clone(source.state.velocity),
        targetVelocity: clone(target.state.velocity),
        attackerFacing: facingOf(source, context),
        targetFacing: facingOf(target, context),
        lineOfSight: lineOfSight("weapon", source, target, request, context),
        gunneryModifier: Number(
          operator?.ratings?.gunnery ?? operator?.gunnery ?? 0,
        ),
      };
      result = commitAttack({
        attackerConfig: source.config,
        attackerDraft: source.state,
        targetConfig: target.config,
        targetDraft: target.state,
        declaration,
        bypassProcedure: context?.isGM === true,
        rollD20: () => requireRoll(context),
        random: randomSource(context),
        helpers: {
          spendOperationResource,
          applyConditionTiers,
          selectCondition,
          getFaultEffects,
          resolveShieldDamage,
        },
      });
      changed.add(target.uuid);
      break;
    }
    case OPERATION_TYPES.BEGIN_RELOAD:
      result = beginWeaponReload(source.config, source.state, {
        weaponId: request.payload.weaponId,
      }, { getFaultEffects });
      break;
    case OPERATION_TYPES.RELOAD: {
      const weaponId = request.payload.weaponId;
      const reload = source.state?.weapons?.[weaponId]?.reloadWork;
      if (!reload) {
        violation(
          "WEAPON_NOT_RELOADING",
          "No manual reload Work is in progress.",
          { weaponId },
        );
      }
      const work = contributeWork(source.config, source.state, {
        operatorId: request.payload.operatorId,
        jobId: `reload:${weaponId}`,
        required: reload.required,
        operation: {
          ...operationMetadata(request, context),
          allowWork: true,
          requiresPhysicalTask: true,
        },
      });
      const contribution = contributeWeaponReload(source.config, source.state, {
        weaponId,
        amount: 1,
      }, { getFaultEffects });
      result = { work, contribution };
      break;
    }
    case OPERATION_TYPES.CANCEL_RELOAD:
      result = cancelWeaponReload(source.config, source.state, {
        weaponId: request.payload.weaponId,
      });
      break;
    case OPERATION_TYPES.REPAIR:
      result = standardRepair(source.config, source.state, {
        ...request.payload,
        total: undefined,
        roll: requireRoll(context),
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.RECOVERY_WORK:
      result = contributeRecoveryWork(source.config, source.state, {
        ...request.payload,
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.HULL_REPAIR:
      result = repairHull(source.config, source.state, {
        ...request.payload,
        total: undefined,
        roll: requireRoll(context),
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.COOLING:
      result = activeCooling(source.config, source.state, {
        ...request.payload,
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.VENT:
      result = emergencyVent(source.config, source.state, {
        ...request.payload,
        operation: operationMetadata(request, context),
      });
      break;
    case OPERATION_TYPES.SET_CONDITION:
      result = setConditionSeverity(source.config, source.state, {
        conditionId: request.payload.conditionId,
        severity: request.payload.severity,
      });
      break;
    case OPERATION_TYPES.REPOSITION: {
      const position = request.payload.position;
      if (
        !position || !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      ) {
        violation(
          "INVALID_REPOSITION",
          "GM reposition requires finite position coordinates.",
          { position },
        );
      }
      const facing = request.payload.facing == null
        ? facingOf(source, context)
        : Number(request.payload.facing);
      if (!Number.isFinite(facing)) {
        violation(
          "INVALID_REPOSITION",
          "GM reposition facing must be finite.",
          { facing },
        );
      }
      tokenTransform(source, position, facing, context);
      if (request.payload.resetVelocity === true) {
        source.state.velocity = { x: 0, y: 0 };
      }
      tokenChanged.add(source.uuid);
      result = {
        position: clone(position),
        facing,
        velocityReset: request.payload.resetVelocity === true,
      };
      break;
    }
    case OPERATION_TYPES.RESOLVE_FATE:
      result = resolveShipFate(source.config, source.state, {
        nonLethal: request.payload.nonLethal === true,
        outcome: request.payload.outcome,
      });
      break;
    case OPERATION_TYPES.ADVANCE_TURN: {
      // A hull with no canvas transform has no position to coast from: the round resolves without
      // the movement step instead of simulating the ship from the scene origin.
      const placed = source.token?.x != null;
      result = cycleOutsideCombatRound(
        source.config,
        source.state,
        {
          input: placed ? movementInput(source, drafts, request, context) : {},
          random: randomSource(context),
        },
      );
      if (result.coast && source.token?.x != null) {
        const collisions = applyMovementResult(
          source,
          result.coast,
          drafts,
          context,
          changed,
          tokenChanged,
        );
        result = { ...result, collisions };
      }
      break;
    }
    default:
      violation(
        "UNKNOWN_OPERATION",
        "The requested ship operation is not supported.",
        { type: request.type },
      );
  }

  changed.add(source.uuid);
  refreshMovementDetection(drafts, tokenChanged, request, context, changed, events);
  for (const uuid of changed) applyImmediateConsequences(drafts.get(uuid));
  for (const ship of drafts.values()) {
    ship.state.revision = recordState(ship.source).revision;
  }
  addEvent(events, request.type, result, {
    sourceUuid: source.uuid,
    targetUuids: request.targetUuids,
    gmOnly: GM_EVENT_ONLY_TYPES.has(request.type),
    publicOnly: PUBLIC_ONLY_EVENT_TYPES.has(request.type),
  });

  return {
    shipStates: Object.fromEntries(
      Array.from(drafts, ([uuid, ship]) => [uuid, ship.state]),
    ),
    tokenUpdates: Object.fromEntries(
      Array.from(tokenChanged, (uuid) => [uuid, drafts.get(uuid).token]),
    ),
    publicEvents: events.publicEvents,
    gmEvents: events.gmEvents,
    changedUuids: Array.from(changed).sort(),
  };
}
