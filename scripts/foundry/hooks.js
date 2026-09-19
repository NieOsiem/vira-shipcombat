import {
  COMPONENT_ITEM_TYPE,
  INTERNAL_UPDATE_OPTION as INTERNAL_UPDATE,
  MODULE_ID,
  SHIP_TYPE,
} from "../constants.js";
import { normalizeShipData } from "../model/defaults.js";
import { materializeShipConfig } from "../model/equipment.js";
import {
  validateComponentItem,
  validateEffectiveLoadout,
} from "../model/validation.js";
import {
  nativeVehicleFieldChanges,
  shipFieldsFromNativeVehicleChanges,
} from "../model/native-vehicle.js";
import { assignedUserIds } from "../rules/operators.js";

import {
  submitAutomaticShipOperation,
  submitShipOperation,
} from "../state/action-queue.js";
import { isActiveGM } from "../socket.js";
import { createGmEventMessages, publishOperationEvents } from "./chat.js";
import {
  initializeShipActor,
  isInternalComponentMutation,
} from "./initialization.js";
import { sceneGridGeometry } from "./scene-geometry.js";
import { CREW_FEATURE_NAME, getActorCrewData } from "./crew.js";
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

/** Initialize, normalize, and synchronize one world or synthetic ship Actor in its own context. */
async function initializeActorShipData(actor) {
  if (actor?.type !== SHIP_TYPE || !activeGm()) return false;
  const initialized = await initializeShipActor(actor);
  const current = clone(actor.system?.shipCombat ?? {});
  const items = componentItems(actor);
  const normalized = normalizeShipData(current, items);
  const effective = materializeShipConfig(normalized.config, items);
  const shipChanged = !sameData(current, normalized);
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
}

/** Fill only absent ship-data fields, retaining every value already stored by the token actor. */
async function initializeTokenShipData(token) {
  if (!isShipToken(token) || !activeGm()) return false;
  return initializeActorShipData(token.actor);
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
  const token = combatantToken(combatant);
  if (!token) return null;
  const targetTokens = operationTargetTokens(combat, token, type);
  const response = await submitAutomaticShipOperation(async () => {
    if (
      ["combat.enter", "phase.start"].includes(type) &&
      (deletedCombats.has(combat) || removedCombatants.has(combatant))
    ) return null;
    for (const involved of [token, ...targetTokens]) {
      await initializeTokenShipData(involved);
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

function scheduleCombat(combat) {
  // V14's updateCombat hook runs in super._onUpdate, before current/turns are
  // rebuilt. Capture after that synchronous stack, never retain mutable history.
  queueMicrotask(() => {
    const combatants = collectionValues(combat.combatants);
    const current = combatState(combat);
    schedule(
      "Failed to synchronize ship combat",
      () => reconcileCombat(combat, combatants, current),
    );
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

function sceneTokensForActor(actor) {
  const tokens = [];
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token?.actorId === actor?.id) {
        tokens.push(token);
        continue;
      }
      if (!token?.actorId) {
        const tokenActor = token?.actor;
        const baseActor = tokenActor?.baseActor ??
          tokenActor?.token?.baseActor ?? tokenActor;
        if (baseActor?.id === actor?.id) tokens.push(token);
      }
    }
  }
  return tokens;
}

function initializeLoadedTokens() {
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (isShipToken(token)) {
        schedule(
          `Failed to initialize ship ${
            token.name ?? token.actor.name
          } (${token.uuid})`,
          () => initializeTokenShipData(token),
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
        () => initializeActorShipData(actor),
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
        () => initializeActorShipData(actor),
      );
    }
  });

  Hooks.on("createToken", (token) => {
    if (isShipToken(token)) {
      schedule(
        `Failed to initialize ship ${
          token.name ?? token.actor.name
        } (${token.uuid})`,
        () => initializeTokenShipData(token),
      );
    }
  });

  Hooks.on("updateToken", (token, changes, options) => {
    if (!isShipToken(token) || options?.[INTERNAL_UPDATE]) return;
    if (changes.delta || changes.actorId || changes.actorLink) {
      schedule(
        "Failed to reconcile updated ship token",
        () => initializeTokenShipData(token),
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
    schedule("Failed to reconcile ship actor", async () => {
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
      await initializeActorShipData(actor);
      for (const token of tokens) await initializeTokenShipData(token);
    });
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
