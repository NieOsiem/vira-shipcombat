import {
  COMPONENT_ITEM_TYPE,
  INTERNAL_UPDATE_OPTION as INTERNAL_UPDATE,
  MODULE_ID,
  SHIP_TYPE,
} from "../constants.js";
import { createInitialState, normalizeShipData } from "../model/defaults.js";
import { materializeShipConfig } from "../model/equipment.js";
import {
  validateComponentItem,
  validateEffectiveLoadout,
} from "../model/validation.js";
import {
  nativeVehicleFieldChanges,
  shipFieldsFromNativeVehicleChanges,
} from "../model/native-vehicle.js";
import { assignmentOperatorId, assignedUserIds } from "../rules/operators.js";
import { pruneOrphanedTracks } from "../rules/sensors.js";

import {
  enqueueAuthorityWork,
  submitAutomaticShipOperation,
  submitShipOperation,
} from "../state/action-queue.js";
import { readShipRecord, writeShipState } from "../state/token-state.js";
import { isActiveGM } from "../socket.js";
import { createGmEventMessages, publishOperationEvents } from "./chat.js";
import {
  initializeShipActor,
  isInternalComponentMutation,
} from "./initialization.js";
import { sceneGridGeometry } from "./scene-geometry.js";
import {
  CREW_FEATURE_NAME,
  getActorCrewData,
  refreshOperatorIncapacitation,
} from "./crew.js";
import {
  CrewRatingSheet,
  openCrewRatingEditor,
  syncAssignedShips,
} from "./crew-sheet.js";

const POSITION_FIELDS = Object.freeze(["x", "y", "rotation"]);
let hooksRegistered = false;
let hookWork = Promise.resolve();
const INITIATIVE_PATCH = Symbol.for(`${MODULE_ID}.shipInitiativePatch`);
let activeGmAuthority = false;
let consoleRefreshTimer = null;
let consoleRefreshDeadline = 0;
const deletedCombats = new WeakSet();
const removedCombatants = new WeakSet();
const deletedTokens = new WeakSet();

/**
 * A console rebuild re-renders every tab and rebuilds the radar, and one operation writes a document
 * per changed ship, so the previous same-tick coalescer rebuilt a console once per ship. A trailing
 * debounce folds a whole operation's writes into a single rebuild, and the cap keeps a steady stream
 * of updates from starving the UI.
 */
const CONSOLE_REFRESH_QUIET_MS = 80;
const CONSOLE_REFRESH_MAX_WAIT_MS = 250;

function refreshConsoles() {
  const now = Date.now();
  if (consoleRefreshDeadline === 0) {
    consoleRefreshDeadline = now + CONSOLE_REFRESH_MAX_WAIT_MS;
  }
  const wait = Math.max(
    0,
    Math.min(CONSOLE_REFRESH_QUIET_MS, consoleRefreshDeadline - now),
  );
  clearTimeout(consoleRefreshTimer);
  consoleRefreshTimer = setTimeout(() => {
    consoleRefreshTimer = null;
    consoleRefreshDeadline = 0;
    // No snapshots cross this hook: each console rebuilds its own sanitized view.
    Hooks.callAll?.("viraShipCombatConsoleRefresh");
  }, wait);
}

function activeGm() {
  return isActiveGM();
}

function installShipInitiative() {
  const CombatantClass = globalThis.CONFIG?.Combatant?.documentClass;
  const prototype = CombatantClass?.prototype;
  if (!prototype || prototype[INITIATIVE_PATCH]) return false;
  const original = prototype.getInitiativeRoll;
  if (typeof original !== "function") return false;
  Object.defineProperty(prototype, INITIATIVE_PATCH, {
    value: original,
    configurable: false,
  });
  prototype.getInitiativeRoll = function getShipInitiativeRoll(formula) {
    const config = this.actor?.system?.shipCombat?.config;
    const modifier = Number(config?.initiative);
    if (
      formula || this.actor?.type !== SHIP_TYPE || !Number.isFinite(modifier)
    ) {
      return original.call(this, formula);
    }
    const operator = modifier >= 0 ? "+" : "-";
    return foundry.dice.Roll.create(
      `1d20 ${operator} ${Math.abs(modifier)}`,
      {},
    );
  };
  return true;
}

function isShipToken(token) {
  return token?.actor?.type === SHIP_TYPE;
}

function clone(value) {
  return foundry.utils.deepClone(value);
}

function forcedReplacement(value) {
  return foundry.data.operators.ForcedReplacement.create(value);
}

function sameData(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection);
}

function componentItems(actor) {
  return collectionValues(actor?.items).filter((item) =>
    item?.type === COMPONENT_ITEM_TYPE
  );
}

function embeddedShipComponent(item) {
  const actor = item?.parent;
  return item?.type === COMPONENT_ITEM_TYPE &&
    actor?.documentName === "Actor" &&
    actor.type === SHIP_TYPE;
}

function allowComponentMutation(item, options) {
  if (!embeddedShipComponent(item) || isInternalComponentMutation(options)) {
    return true;
  }
  if (!activeGm()) return false;
  return item.parent.system?.shipCombat?.state?.phase === "outsideCombat";
}

function componentUpdateSource(item, changes) {
  if (typeof item?.clone === "function") {
    const prospective = item.clone(changes, { keepId: true });
    if (typeof prospective?.toObject === "function") {
      return prospective.toObject(false);
    }
  }
  const source = typeof item?.toObject === "function"
    ? item.toObject(false)
    : clone(item);
  const expanded = foundry.utils.expandObject(changes ?? {});
  return foundry.utils.mergeObject(source, expanded, {
    inplace: false,
    insertKeys: true,
    insertValues: true,
    overwrite: true,
  });
}

function validationMessage(label, validation) {
  const details = validation.errors
    .slice(0, 5)
    .map(({ path, message }) => `${path}: ${message}`)
    .join(" ");
  const remaining = validation.errors.length - 5;
  return `${label}: ${details}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

function validateProspectiveComponentUpdate(item, changes) {
  const source = componentUpdateSource(item, changes);
  const componentValidation = validateComponentItem(source);
  if (!componentValidation.valid) {
    return validationMessage("Invalid ship component", componentValidation);
  }
  if (!embeddedShipComponent(item) || !componentIsReferenced(item)) return "";

  try {
    const actor = item.parent;
    const itemId = item.id ?? item._id;
    const items = componentItems(actor).map((candidate) =>
      candidate.id === itemId ? source : candidate
    );
    const effective = materializeShipConfig(
      actor.system.shipCombat.config,
      items,
    );
    const loadoutValidation = validateEffectiveLoadout(effective, {
      tokenWidth: 1,
    });
    return loadoutValidation.valid ? "" : validationMessage(
      "Component would invalidate this ship",
      loadoutValidation,
    );
  } catch (error) {
    return error?.message ?? String(error);
  }
}

function allowComponentUpdate(item, changes, options, userId) {
  if (isInternalComponentMutation(options)) return true;
  if (!allowComponentMutation(item, options)) {
    if (userId === game.user?.id) {
      ui.notifications.error(
        "Only the active GM may refit embedded ship components outside combat.",
      );
    }
    return false;
  }
  if (item?.type !== COMPONENT_ITEM_TYPE) return true;
  // Foundry pre-update hooks are synchronous: a Promise cannot veto the original write.
  // Installed definitions must be saved together with their reconciled Actor state.
  const changesDefinition = Object.keys(changes ?? {}).some((key) =>
    ["system", "type"].includes(key.split(".")[0].replace(/^-=/, ""))
  );
  if (
    embeddedShipComponent(item) && componentIsReferenced(item) &&
    changesDefinition
  ) {
    if (userId === game.user?.id) {
      ui.notifications.error(
        "Edit installed ship component definitions through their Ship Component sheet so ship state is reconciled safely.",
      );
    }
    return false;
  }
  let denial;
  try {
    denial = validateProspectiveComponentUpdate(item, changes);
  } catch (error) {
    denial = error?.message ?? String(error);
  }
  if (!denial) return true;
  if (userId === game.user?.id) ui.notifications.error(denial);
  return false;
}

function componentIsReferenced(item) {
  const id = item?.id ?? item?._id;
  const config = item?.parent?.system?.shipCombat?.config;
  if (typeof id !== "string" || !id || !config) return false;
  return (config.slots ?? []).some((slot) => slot?.itemId === id) ||
    (config.hardpoints ?? []).some((hardpoint) => hardpoint?.weaponId === id);
}

function allowComponentDeletion(item, options) {
  if (!embeddedShipComponent(item) || isInternalComponentMutation(options)) {
    return true;
  }
  if (componentIsReferenced(item)) return false;
  return allowComponentMutation(item, options);
}

async function enforceOperatorOwnership(subject) {
  const contextActor = subject?.documentName === "Actor"
    ? subject
    : subject?.actor;
  const actor = subject?.baseActor ?? contextActor?.token?.baseActor ??
    contextActor;
  const shipData = contextActor?.system?.shipCombat;
  if (!actor || !shipData || !activeGm()) return;
  const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  const ownershipUpdates = {};
  for (const userId of assignedUserIds(shipData.config, shipData.state)) {
    const user = game.users.get(userId);
    if (!user || user.isGM) continue;
    const current = actor.ownership?.[userId] ?? actor.ownership?.default ?? 0;
    if (current < observer) ownershipUpdates[`ownership.${userId}`] = observer;
  }
  if (Object.keys(ownershipUpdates).length) {
    await actor.update(ownershipUpdates, { [INTERNAL_UPDATE]: true });
  }
}

/** Resolve the Actor a config operator links to on this client, if any. */
function resolveOperatorActor(actorId) {
  return game.actors?.get?.(actorId) ?? null;
}

/**
 * Whether a combatant points at this token. The resolved document is preferred; the stored token id
 * is the fallback for a token that is already deleted or whose Scene is not loaded, and it is
 * deliberately not cross-checked against the Combat's Scene: claiming a token is in combat merely
 * keeps its state, while failing to see one would reset a ship that is mid-turn.
 */
function combatantReferencesToken(combatant, token) {
  const document = combatant?.token;
  if (document) return document === token || document.uuid === token?.uuid;
  return Boolean(combatant?.tokenId) && combatant.tokenId === token?.id;
}

function tokenReferencedByCombat(token) {
  for (const combat of collectionValues(game.combats)) {
    for (const combatant of collectionValues(combat?.combatants)) {
      if (combatantReferencesToken(combatant, token)) return true;
    }
  }
  return false;
}

/**
 * Whether an unlinked copy carries a phase it cannot legitimately hold. A synthetic token owns its
 * own ship data, so it is only mid-combat while a Combatant still references it: a duplicated token
 * is born with its source's phase and turnKey, and `combat.enter` is suppressed for a ship that is
 * not outsideCombat, so it could never advance. That persisted phase is stale.
 */
function orphanedSyntheticState(token) {
  if (token?.actorLink !== false) return false;
  const phase = token?.actor?.system?.shipCombat?.state?.phase;
  return phase !== undefined && phase !== "outsideCombat" &&
    !tokenReferencedByCombat(token);
}

/** Whether a scheduled initialization outlived its TokenDocument. */
function tokenDocumentGone(token) {
  return !token?.actor || deletedTokens.has(token);
}

/**
 * Documents that carry authoritative ship state: world Actors, and unlinked tokens whose state lives
 * in their own delta.
 */
function authoritativeShipDocuments() {
  const documents = [];
  for (const actor of game.actors ?? []) {
    if (actor.type === SHIP_TYPE) documents.push(actor);
  }
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actorLink === false && isShipToken(token)) documents.push(token);
    }
  }
  return documents;
}

/** Mark one ship document's operators of a deleted Actor and vacate their stations. */
async function retireOperatorsOf(document, actorId) {
  const actor = document.actor ?? document;
  const shipCombat = actor.system?.shipCombat;
  const operators = shipCombat?.config?.operators;
  if (!Array.isArray(operators) || !shipCombat?.state) return;
  const retired = new Set(
    operators
      .filter((operator) => operator?.actorId === actorId)
      .map((operator) => operator.id),
  );
  if (!retired.size) return;

  const config = clone(shipCombat.config);
  let configChanged = false;
  for (const operator of config.operators) {
    if (!retired.has(operator.id) || operator.incapacitated === true) continue;
    operator.incapacitated = true;
    configChanged = true;
  }

  const state = clone(shipCombat.state);
  let stateChanged = false;
  for (const slot of ["command", "crew"]) {
    const entries = Array.isArray(state.roster?.[slot]) ? state.roster[slot] : [];
    const kept = entries.filter((assignment) =>
      !retired.has(assignmentOperatorId(assignment))
    );
    if (kept.length === entries.length) continue;
    state.roster[slot] = kept;
    stateChanged = true;
  }
  for (const pool of ["actions", "orders"]) {
    const entries = state.resources?.[pool];
    if (!entries || typeof entries !== "object") continue;
    for (const operatorId of retired) {
      if (!Object.hasOwn(entries, operatorId)) continue;
      delete entries[operatorId];
      stateChanged = true;
    }
  }

  if (configChanged) {
    await document.update({
      "system.shipCombat.config": forcedReplacement(config),
    }, { [INTERNAL_UPDATE]: true, diff: false });
  }
  if (stateChanged) await writeShipState(document, state);
}

/**
 * Retire the stations of a deleted crew Actor on every ship that assigns it. The Actor never
 * resolves again, so without this its station keeps granting its Action and Order pools to a
 * character that no longer exists.
 */
async function retireDeletedCrewActor(actor) {
  const actorId = actor?.id;
  if (typeof actorId !== "string" || !actorId) return;
  for (const document of authoritativeShipDocuments()) {
    try {
      await retireOperatorsOf(document, actorId);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Failed to retire the stations of ${
          actor.name ?? actorId
        } on ${document.uuid ?? document}`,
        error,
      );
    }
  }
}

/**
 * Whether any live token of this Actor still fights in a combat. A deleted token's Combatant no
 * longer resolves a token, so only surviving documents count.
 */
function actorReferencedByCombat(actor) {
  const uuid = actor?.uuid;
  if (!uuid) return false;
  for (const combat of collectionValues(game.combats)) {
    for (const combatant of collectionValues(combat?.combatants)) {
      if (removedCombatants.has(combatant)) continue;
      const token = combatantToken(combatant);
      if (token?.actor?.uuid === uuid) return true;
    }
  }
  return false;
}

/**
 * Whether a world Actor carries a phase it cannot legitimately hold. A world Actor is only
 * mid-combat while one of its tokens is still a Combatant: a duplicated ship is born with its
 * source's phase and turnKey but joins no combat, and `combat.enter` is suppressed for a ship that
 * is not outsideCombat, so it could never advance. That persisted phase is stale.
 */
function orphanedActorState(actor) {
  if (actor?.isToken) return false;
  const phase = actor?.system?.shipCombat?.state?.phase;
  if (phase === undefined || phase === "outsideCombat") return false;
  return !actorReferencedByCombat(actor);
}

/**
 * Initialize, normalize, and synchronize one world or synthetic ship Actor in its own context.
 * `queued: false` is mandatory for callers that already run inside the authority queue: enqueuing
 * from there would make the running task await work appended behind itself. `refreshOperators`
 * re-derives operator incapacitation from the linked crew Actors, and `resetOrphanedState` rebuilds
 * the state of a synthetic copy that no combat references.
 */
async function initializeActorShipData(actor, {
  refreshOperators = false,
  resetOrphanedState = false,
  queued = true,
} = {}) {
  if (actor?.type !== SHIP_TYPE || !activeGm()) return false;
  const work = async () => {
    const initialized = await initializeShipActor(actor);
    const current = clone(actor.system?.shipCombat ?? {});
    const items = componentItems(actor);
    const normalized = normalizeShipData(current, items);
    const operatorsChanged = refreshOperators
      ? refreshOperatorIncapacitation(normalized.config, resolveOperatorActor)
      : false;
    const effective = materializeShipConfig(normalized.config, items);
    if (resetOrphanedState && normalized.state.phase !== "outsideCombat") {
      normalized.state = createInitialState(effective);
    }
    const shipChanged = operatorsChanged || !sameData(current, normalized);
    const update = nativeVehicleFieldChanges(actor, effective, normalized.state);
    if (shipChanged) update["system.shipCombat"] = forcedReplacement(normalized);
    if (Object.keys(update).length) {
      const updated = await actor.update(update, { [INTERNAL_UPDATE]: true });
      if (!updated) {
        throw new Error("Ship normalization did not update the Actor.");
      }
    }
    await enforceOperatorOwnership(actor);
    return initialized || shipChanged || Object.keys(update).length > 0;
  };
  return queued ? enqueueAuthorityWork(work) : work();
}

/** Fill only absent ship-data fields, retaining every value already stored by the token actor. */
async function initializeTokenShipData(token, options = {}) {
  const { refreshOperators = false, resetOrphanedState = false, queued = true } =
    options;
  if (tokenDocumentGone(token) || !isShipToken(token) || !activeGm()) return false;
  return initializeActorShipData(token.actor, {
    refreshOperators,
    resetOrphanedState: resetOrphanedState && orphanedSyntheticState(token),
    queued,
  });
}

function scheduleSubmission(label, task) {
  hookWork = hookWork
    .then(task)
    .catch((error) => {
      console.error(`${MODULE_ID} | ${label}`, error);
      ui.notifications.error(
        `${label}: ${
          error.message ?? error
        }. Correct the ship data, then update the combat or reload to retry. Completed turns will not grant resources again.`,
      );
    });
  return hookWork;
}

function schedule(label, task) {
  return scheduleSubmission(label, () => activeGm() ? task() : undefined);
}

/**
 * Background document cleanup: a failure is logged and the hook chain continues, without the
 * user-facing "correct the ship data" notice reserved for failed player-facing reconciliation.
 */
function scheduleCleanup(label, task) {
  hookWork = hookWork.then(task).catch((error) => {
    console.warn(`${MODULE_ID} | ${label}`, error);
  });
  return hookWork;
}

function combatantToken(combatant) {
  const token = combatant?.token;
  return isShipToken(token) ? token : null;
}

function combatState(combat) {
  return {
    round: combat.round ?? 0,
    combatantId: combat.combatant?.id ?? combat.current?.combatantId ?? null,
  };
}

function turnKey(combat, state, combatant) {
  const round = Number.isInteger(state?.round) ? state.round : combat.round;
  return `${combat.id}:${round ?? 0}:${combatant.id}`;
}

function operationId(combat, combatant, key, type) {
  return `${MODULE_ID}:${combat.id}:${combatant.id}:${key}:${type}`;
}

function operationTargetTokens(combat, sourceToken, type) {
  if (type !== "phase.start" && type !== "phase.coast") return [];
  const tokens = [];
  for (const combatant of combat.combatants) {
    const token = combatantToken(combatant);
    if (token && token.uuid !== sourceToken.uuid) tokens.push(token);
  }
  tokens.sort((left, right) => left.uuid.localeCompare(right.uuid));
  return tokens;
}

function lifecyclePayload(type, key) {
  if (type === "combat.enter") return { turnKey: key };
  if (type === "combat.leave") return {};
  if (type === "phase.start") return { turnKey: key };
  if (type === "phase.coast") return { turnKey: key };
  if (type === "phase.end") return { turnKey: key, endKey: key };
  return { turnKey: key };
}

async function executeLifecycle(combat, combatant, type, key) {
  const response = await submitAutomaticShipOperation(async () => {
    // Re-derive the involved tokens at the queue head: a hook snapshot can predate a deletion, and a
    // token that vanished must not stay part of the operation.
    const token = combatantToken(combatant);
    if (!token) return null;
    const targetTokens = operationTargetTokens(combat, token, type);
    if (
      ["combat.enter", "phase.start"].includes(type) &&
      (deletedCombats.has(combat) || removedCombatants.has(combatant))
    ) return null;
    for (const involved of [token, ...targetTokens]) {
      // This builder already runs at the queue head: enqueuing the initialization would make this
      // operation await work appended behind itself. A Start Phase additionally re-derives operator
      // incapacitation, so a crew member lost mid-session stops operating from the next Start.
      await initializeTokenShipData(involved, {
        refreshOperators: type === "phase.start",
        queued: false,
      });
    }
    const state = token.actor.system.shipCombat.state;
    // These guards run inside the operation queue, not against a stale hook snapshot.
    if (type === "combat.enter" && state.phase !== "outsideCombat") return null;
    if (type === "combat.leave" && state.phase === "outsideCombat") return null;
    if (
      type === "phase.start" &&
      (state.phase !== "start" || state.turnKey === key)
    ) return null;
    if (
      type === "phase.coast" &&
      (state.phase !== "active" || state.turnKey !== key)
    ) return null;
    if (
      type === "phase.end" && (state.phase !== "end" || state.turnKey !== key)
    ) return null;
    const expectedRevisions = Object.fromEntries(
      [token, ...targetTokens].map((involved) => [
        involved.uuid,
        Number(involved.actor.system.shipCombat?.state?.revision ?? 0),
      ]),
    );
    // Revision-scoped IDs allow legitimate re-entry after a combat reset, while
    // the queue-head phase/turn guards suppress duplicate hooks and handoffs.
    const idKey = `${key}:${state.revision}`;
    return {
      id: operationId(combat, combatant, idKey, type),
      type,
      sourceUuid: token.uuid,
      targetUuids: targetTokens.map((target) => target.uuid),
      expectedRevisions,
      payload: lifecyclePayload(type, key),
    };
  });
  if (!response?.ok && response?.error) {
    await createGmEventMessages([{
      type: "operation.rejected",
      title: "Ship combat phase failed",
      message: response.error.message,
    }]);
    throw new Error(response.error.message);
  }
  return response;
}

async function submitLifecycle(combat, combatant, type, key) {
  try {
    return await executeLifecycle(combat, combatant, type, key);
  } catch (error) {
    const token = combatantToken(combatant);
    throw new Error(
      `${token?.name ?? token?.actor?.name ?? "Ship"} (${
        token?.uuid ?? combatant.id
      }), ${type}: ${error.message ?? error}`,
      { cause: error },
    );
  }
}

async function reconcileCombat(combat, combatants, current) {
  if (deletedCombats.has(combat)) return;
  combatants = combatants.filter((entry) => !removedCombatants.has(entry));
  if (!current.round) {
    for (const combatant of combatants) await leaveCombatant(combat, combatant);
    return;
  }
  for (const combatant of combatants) {
    const token = combatantToken(combatant);
    if (!token) continue;
    const state = token.actor.system.shipCombat?.state;
    const key = turnKey(combat, current, combatant);
    if (
      ["active", "end"].includes(state?.phase) &&
      (combatant.id !== current.combatantId || state.turnKey !== key)
    ) {
      await finishTurn(combat, combatant, state);
    }
    await submitLifecycle(combat, combatant, "combat.enter", "combat");
  }
  const currentCombatant = combatants.find((entry) =>
    entry.id === current.combatantId
  );
  if (currentCombatant) await beginTurn(combat, currentCombatant, current);
}

const COMBAT_RECONCILE_RETRY_MS = 750;

function scheduleCombat(combat) {
  // V14's updateCombat hook runs in super._onUpdate, before current/turns are
  // rebuilt. Capture after that synchronous stack, never retain mutable history.
  queueMicrotask(() => {
    schedule("Failed to synchronize ship combat", async () => {
      const combatants = collectionValues(combat.combatants);
      try {
        await reconcileCombat(combat, combatants, combatState(combat));
        return;
      } catch (error) {
        // A rejected lifecycle operation aborts the pass part-way. The phase/turn guards make a
        // second pass safe, so one retry against fresh combat state finishes the handoff that the
        // failed pass left in progress instead of waiting for the next combat update.
        console.warn(
          `${MODULE_ID} | Ship combat synchronization failed; retrying once`,
          error,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, COMBAT_RECONCILE_RETRY_MS)
        );
      }
      await reconcileCombat(
        combat,
        collectionValues(combat.combatants),
        combatState(combat),
      );
    });
  });
}

async function finishTurn(combat, combatant, state) {
  if (!combatantToken(combatant)) return;
  const key = state?.turnKey ?? turnKey(combat, state, combatant);
  await submitLifecycle(combat, combatant, "phase.coast", key);
  await submitLifecycle(combat, combatant, "phase.end", key);
}

async function beginTurn(combat, combatant, state) {
  if (!combatantToken(combatant)) return;
  await submitLifecycle(
    combat,
    combatant,
    "phase.start",
    turnKey(combat, state, combatant),
  );
}

async function leaveCombatant(combat, combatant) {
  const token = combatantToken(combatant);
  if (!token) return;
  const state = token.actor.system.shipCombat?.state;
  if (state?.phase === "outsideCombat") return;
  const key = state?.turnKey ??
    turnKey(combat, { round: combat.round }, combatant);
  await submitLifecycle(combat, combatant, "phase.coast", key);
  await submitLifecycle(combat, combatant, "phase.end", key);
  await submitLifecycle(combat, combatant, "combat.leave", "combat");
}

/**
 * Retire a ship whose token was deleted. The Combatant can no longer resolve a token, so the normal
 * token-based lifecycle cannot run: a linked ship is returned to outsideCombat through its Actor
 * document instead (there is nothing left to coast), and the orphaned Combatant slot is removed
 * because core leaves it in place. An unlinked copy's state lives in the deleted token's delta and
 * dies with it, so only the slot is retired.
 */
async function leaveRemovedShipCombatant(combat, combatant, token) {
  if (combatantToken(combatant)) return leaveCombatant(combat, combatant);
  await deleteOrphanedCombatant(combat, combatant);
  if (token?.actorLink !== true) return;
  const actor = combatant?.actor ?? token.actor ?? null;
  if (!actor || actorReferencedByCombat(actor)) return;
  const state = actor.system?.shipCombat?.state;
  if (!state || state.phase === "outsideCombat") return;
  await submitActorCombatLeave(actor);
}

/**
 * Remove a Combatant whose token no longer exists. Foundry 14.366's own token-deletion cleanup
 * compares the Combat's Scene document with a Scene id and skips every Combat bound to a Scene, so
 * the module retires the slot itself; the guards keep a future core that deletes it from erroring.
 */
async function deleteOrphanedCombatant(combat, combatant) {
  if (!combatant?.id || !combat?.combatants?.has?.(combatant.id)) return;
  try {
    await combat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
  } catch (error) {
    console.warn(
      `${MODULE_ID} | Failed to retire the orphaned combatant ${combatant.id}`,
      error,
    );
  }
}

/**
 * Return a token-less ship to outsideCombat. The request is built at the queue head so the
 * expected revision is current, and a no-op when the ship already left combat.
 */
async function submitActorCombatLeave(actor) {
  const response = await submitAutomaticShipOperation(async () => {
    const state = actor.system?.shipCombat?.state;
    if (!state || state.phase === "outsideCombat") return null;
    const revision = Number(state.revision ?? 0);
    return {
      id: `${MODULE_ID}:leave:${actor.uuid}:${revision}`,
      type: "combat.leave",
      sourceUuid: actor.uuid,
      targetUuids: [],
      expectedRevisions: { [actor.uuid]: revision },
      payload: {},
    };
  });
  if (!response?.ok && response?.error) {
    console.warn(
      `${MODULE_ID} | Failed to return ${actor.name} to outside combat after its token was removed: ${response.error.message}`,
    );
  }
  return response;
}

function hasPositionChange(changes) {
  return POSITION_FIELDS.some((field) => Object.hasOwn(changes, field));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function proposedCenterPosition(token, proposed) {
  const { gridSize, unitsPerPixel } = sceneGridGeometry(token.parent);
  const width = Math.max(0, finiteNumber(token.width, 1));
  const height = Math.max(0, finiteNumber(token.height, 1));
  const topLeftX = finiteNumber(proposed.x, finiteNumber(token.x, 0));
  const topLeftY = finiteNumber(proposed.y, finiteNumber(token.y, 0));
  return {
    x: (topLeftX + ((width * gridSize) / 2)) * unitsPerPixel,
    y: (topLeftY + ((height * gridSize) / 2)) * unitsPerPixel,
  };
}

function stableRepositionId(token, revision, payload) {
  const position = payload.position;
  return `${MODULE_ID}:reposition:${token.uuid}:${revision}:${position.x}:${position.y}:${
    payload.facing ?? ""
  }:${payload.resetVelocity}`;
}

async function submitAdministrativeReposition(token, proposed, options) {
  await initializeTokenShipData(token);
  const revision = Number(token.actor.system.shipCombat?.state?.revision ?? 0);
  const payload = {
    position: proposedCenterPosition(token, proposed),
    resetVelocity: options?.viraShipCombatResetVelocity === true ||
      options?.resetVelocity === true,
    gmOverride: true,
  };
  const facing = Number(proposed.rotation);
  if (Number.isFinite(facing)) payload.facing = facing;
  const response = await submitShipOperation({
    id: stableRepositionId(token, revision, payload),
    type: "reposition",
    sourceUuid: token.uuid,
    targetUuids: [],
    expectedRevisions: { [token.uuid]: revision },
    payload,
  });
  if (!response?.ok && response?.error) {
    await createGmEventMessages([{
      type: "operation.rejected",
      title: "Administrative reposition failed",
      message: response.error.message,
    }]);
  }
}

/**
 * The tokens that carry `actor`'s authoritative ship data. A world Actor is mounted by its linked
 * tokens, wherever those Scenes are; a synthetic Actor is carried by exactly its own token. An
 * unlinked copy holds independent state under its own delta, so reconciling the base Actor must never
 * touch it.
 */
function sceneTokensForActor(actor) {
  if (actor?.isToken) return actor.token ? [actor.token] : [];
  const tokens = [];
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token?.actorId === actor?.id && token.actorLink !== false) {
        tokens.push(token);
      }
    }
  }
  return tokens;
}

/** Every TokenDocument UUID this client can still resolve, used to find dead sensor tracks. */
function liveTokenUuids() {
  const uuids = new Set();
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token?.uuid) uuids.add(token.uuid);
    }
  }
  return uuids;
}

/** Whether a deleted document was a ship token; a synthetic copy keeps its type only in its delta. */
function deletedTokenIsShip(token) {
  if (isShipToken(token)) return true;
  const delta = token?.delta ?? token?._source?.delta ?? null;
  return delta?.type === SHIP_TYPE;
}

/** The Scene that owns a token document, even when a deleted copy has detached from it. */
function tokenScene(token) {
  if (token?.parent?.tokens) return token.parent;
  const [documentName, sceneId] = String(token?.uuid ?? "").split(".");
  if (documentName !== "Scene" || !sceneId) return null;
  return game.scenes?.get?.(sceneId) ?? null;
}

/**
 * Drop the sensor tracks that referenced a deleted token from every surviving ship on its Scene. Run
 * inside the authority queue: the records are read and written there, so the cleanup can never
 * interleave with a queued operation's own state write.
 */
async function pruneOrphanedSceneTracks(token) {
  const live = liveTokenUuids();
  const surviving = collectionValues(tokenScene(token)?.tokens).filter(
    (candidate) => candidate !== token && isShipToken(candidate),
  );
  for (const ship of surviving) {
    // Only a ship that has ever held a track can hold an orphaned one, and an uninitialized
    // ship has no ship data to read at all.
    const held = ship?.actor?.system?.shipCombat?.state?.tracks;
    if (!held || !Object.keys(held).length) continue;
    try {
      const record = readShipRecord(ship);
      if (!pruneOrphanedTracks(record.state, live).length) continue;
      await writeShipState(ship, record.state);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Could not prune the sensor tracks of ${
          ship?.uuid ?? ship
        }`,
        error,
      );
    }
  }
}

function initializeLoadedTokens() {
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (isShipToken(token)) {
        schedule(
          `Failed to initialize ship ${
            token.name ?? token.actor.name
          } (${token.uuid})`,
          () => initializeTokenShipData(token, { resetOrphanedState: true }),
        );
      }
    }
  }
}
function initializeLoadedActors() {
  for (const actor of game.actors) {
    if (actor.type === SHIP_TYPE) {
      schedule(
        `Failed to initialize ship ${actor.name} (${actor.uuid ?? actor.id})`,
        () => initializeActorShipData(actor, {
          resetOrphanedState: orphanedActorState(actor),
        }),
      );
    }
  }
}

function sweepWhenActiveGm() {
  const authority = activeGm();
  if (!authority) {
    activeGmAuthority = false;
    return;
  }
  if (activeGmAuthority) return;
  activeGmAuthority = true;
  initializeLoadedActors();
  initializeLoadedTokens();
  for (const combat of game.combats ?? []) scheduleCombat(combat);
}

/** Register V14 hooks for ship initialization, authority, combat phases, and administrative token movement. */
export function registerShipHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  installShipInitiative();

  foundry.applications.apps.DocumentSheetConfig.registerSheet(
    Item,
    MODULE_ID,
    CrewRatingSheet,
    { types: ["feat"], label: "Ship Station Qualifications" },
  );

  Hooks.on("getHeaderControlsApplicationV2", (sheet, controls) => {
    const actor = sheet?.actor;
    if (!actor || actor.type === SHIP_TYPE) return;
    controls.unshift({
      icon: "fa-solid fa-compass",
      label: "Ship Ratings",
      action: "openShipRatings",
      onClick: () => void openCrewRatingEditor(actor),
    });
  });

  Hooks.on("updateItem", (item) => {
    if (item.flags?.[MODULE_ID]?.isCrewRole || item.name === CREW_FEATURE_NAME) {
      const actor = item.parent;
      if (actor) {
        const crewData = getActorCrewData(actor);
        void syncAssignedShips(actor.id, {
          ratings: crewData.ratings,
          type: crewData.type,
          capabilities: crewData.capabilities,
          label: actor.name,
          img: actor.img,
        });
      }
    }
  });

  // Ordinary synchronization is read-only. refreshResources is a turn reset,
  // not a refresh API: calling it here would replenish spent actions and orders.
  for (
    const event of [
      "createActor",
      "updateActor",
      "deleteActor",
      "createItem",
      "updateItem",
      "deleteItem",
      "createToken",
      "updateToken",
      "deleteToken",
      "updateActorDelta",
      "createWall",
      "updateWall",
      "deleteWall",
      "createActiveEffect",
      "updateActiveEffect",
      "deleteActiveEffect",
      "createCombat",
      "updateCombat",
      "deleteCombat",
      "combatTurnChange",
      "createCombatant",
      "updateCombatant",
      "deleteCombatant",
      "updateUser",
      "userConnected",
      "canvasReady",
    ]
  ) Hooks.on(event, refreshConsoles);

  Hooks.on("viraShipCombatOperationCommitted", (fullResult, request) => {
    void publishOperationEvents(fullResult, request)
      .catch((error) =>
        console.error(
          `${MODULE_ID} | Failed to publish ship operation events`,
          error,
        )
      );
    if (request.type === "setRoster") {
      schedule(
        "Failed to synchronize assigned operator ownership",
        async () => {
          const token = await globalThis.fromUuid?.(request.sourceUuid);
          if (token) await enforceOperatorOwnership(token);
        },
      );
    }
  });

  Hooks.on("createActor", (actor) => {
    if (actor.type === SHIP_TYPE) {
      schedule(
        `Failed to initialize ship ${actor.name} (${actor.uuid ?? actor.id})`,
        () => initializeActorShipData(actor, {
          resetOrphanedState: orphanedActorState(actor),
        }),
      );
    }
  });

  Hooks.on("deleteActor", (actor) => {
    if (!actor || actor.type === SHIP_TYPE) return;
    schedule(
      `Failed to retire the crew stations of ${actor.name}`,
      () => enqueueAuthorityWork(() => retireDeletedCrewActor(actor)),
    );
  });

  Hooks.on("createToken", (token) => {
    if (isShipToken(token)) {
      schedule(
        `Failed to initialize ship ${
          token.name ?? token.actor.name
        } (${token.uuid})`,
        () => initializeTokenShipData(token, { resetOrphanedState: true }),
      );
    }
  });

  Hooks.on("updateToken", (token, changes, options) => {
    if (!isShipToken(token) || options?.[INTERNAL_UPDATE]) return;
    if (changes.delta || changes.actorId || changes.actorLink) {
      schedule(
        "Failed to reconcile updated ship token",
        () => initializeTokenShipData(token, { resetOrphanedState: true }),
      );
    }
  });

  Hooks.on("deleteToken", (token) => {
    try {
      deletedTokens.add(token);
      if (!deletedTokenIsShip(token)) return;
      // A deleted token cannot leave combat through its own hook, so every combatant that pointed at
      // it is retired here. A linked ship is returned to outsideCombat through its Actor document and
      // the orphaned Combatant slot is removed; the track prune tolerates an already-gone token.
      for (const combat of collectionValues(game.combats)) {
        for (const combatant of collectionValues(combat?.combatants)) {
          if (!combatantReferencesToken(combatant, token)) continue;
          removedCombatants.add(combatant);
          scheduleCleanup(
            "Failed to retire removed ship combatant",
            () => activeGm()
              ? leaveRemovedShipCombatant(combat, combatant, token)
              : undefined,
          );
        }
      }
      scheduleCleanup(
        "Failed to prune orphaned sensor tracks",
        () => activeGm()
          ? enqueueAuthorityWork(() => pruneOrphanedSceneTracks(token))
          : undefined,
      );
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Failed to clean up the deleted ship token ${
          token?.uuid ?? token
        }`,
        error,
      );
    }
  });

  Hooks.on("updateActor", (actor, changes, options, userId) => {
    if (actor.type !== SHIP_TYPE) {
      if (changes.name || changes.img || changes.prototypeToken) {
        void syncAssignedShips(actor.id, { label: actor.name, img: actor.img });
      }
      return;
    }
    if (options?.[INTERNAL_UPDATE]) return;
    const ship = actor.system?.shipCombat;
    const nativeUpdate = ship?.config && ship?.state
      ? shipFieldsFromNativeVehicleChanges(changes, ship.config, ship.state)
      : {};
    const hasNativeEdit = Object.keys(nativeUpdate).length > 0;
    const hasConfigEdit = Object.keys(nativeUpdate).some((path) =>
      path.startsWith("system.shipCombat.config.")
    );
    const configBlocked = hasConfigEdit && ship.state.phase !== "outsideCombat";
    if (configBlocked && userId === game.user.id) {
      ui.notifications.error(
        `Native ship configuration cannot be edited during phase '${ship.state.phase}'. Refit is only allowed outside combat.`,
      );
    }
    const tokens = sceneTokensForActor(actor).filter(isShipToken);
    schedule("Failed to reconcile ship actor", () =>
      enqueueAuthorityWork(async () => {
        if (hasNativeEdit) {
          const { config, state } = actor.system.shipCombat;
          const allowConfig = !configBlocked && state.phase === "outsideCombat";
          if (hasConfigEdit && !configBlocked && !allowConfig) {
            ui.notifications.error(
              `Native ship configuration cannot be edited during phase '${state.phase}'. Refit is only allowed outside combat.`,
            );
          }
          const update = shipFieldsFromNativeVehicleChanges(
            changes,
            config,
            state,
            { allowConfig },
          );
          if (Object.keys(update).length) {
            update["system.shipCombat.state.revision"] =
              Number.isInteger(state.revision) ? state.revision + 1 : 1;
            const updated = await actor.update(update, {
              [INTERNAL_UPDATE]: true,
            });
            if (!updated) {
              throw new Error(
                "Native vehicle edits did not update the ship data.",
              );
            }
          }
        }
        await initializeActorShipData(actor, { queued: false });
        for (const token of tokens) {
          await initializeTokenShipData(token, { queued: false });
        }
      }));
  });

  Hooks.on(
    "preCreateItem",
    (item, _data, options) => allowComponentMutation(item, options),
  );
  Hooks.on(
    "preUpdateItem",
    (item, changes, options, userId) =>
      allowComponentUpdate(item, changes, options, userId),
  );
  Hooks.on(
    "preDeleteItem",
    (item, options) => allowComponentDeletion(item, options),
  );

  Hooks.on("preUpdateToken", (token, changes, options, userId) => {
    if (
      !isShipToken(token) || options?.[INTERNAL_UPDATE] ||
      !hasPositionChange(changes)
    ) return true;
    const user = game.users.get(userId);
    if (!user?.isGM) {
      if (userId === game.user.id) {
        ui.notifications.warn(
          "Ship tokens cannot be maneuvered by dragging. Use the Helm controls.",
        );
      }
      return false;
    }
    const proposed = Object.fromEntries(
      POSITION_FIELDS
        .filter((field) => Object.hasOwn(changes, field))
        .map((field) => [field, changes[field]]),
    );
    scheduleSubmission(
      "Failed to submit administrative reposition",
      () => submitAdministrativeReposition(token, proposed, options),
    );
    return false;
  });

  // combatStart fires before the update, only on the initiating client. V14's
  // persisted update is the reliable entry point, including the initial turn.
  Hooks.on("updateCombat", (combat) => scheduleCombat(combat));
  Hooks.on("combatTurnChange", (combat) => scheduleCombat(combat));
  Hooks.on("createCombatant", (combatant) => {
    if (combatant.parent) scheduleCombat(combatant.parent);
  });
  Hooks.on("updateCombatant", (combatant) => {
    if (combatant.parent) scheduleCombat(combatant.parent);
  });

  Hooks.on("deleteCombatant", (combatant) => {
    const combat = combatant.parent;
    if (!combat) return;
    removedCombatants.add(combatant);
    schedule(
      "Failed to leave removed ship combatant",
      () => leaveCombatant(combat, combatant),
    );
    scheduleCombat(combat);
  });

  Hooks.on("deleteCombat", (combat) => {
    deletedCombats.add(combat);
    const combatants = collectionValues(combat.combatants);
    schedule("Failed to leave ended ship combat", async () => {
      for (const combatant of combatants) {
        if (combatantToken(combatant)) await leaveCombatant(combat, combatant);
      }
    });
  });

  Hooks.on("updateUser", () => sweepWhenActiveGm());
  Hooks.on("userConnected", () => sweepWhenActiveGm());

  sweepWhenActiveGm();
}
