import { COMPONENT_ITEM_TYPE, INTERNAL_UPDATE_OPTION as INTERNAL_UPDATE, MODULE_ID, SHIP_TYPE } from "../constants.js";
import { normalizeShipData } from "../model/defaults.js";
import { materializeShipConfig } from "../model/equipment.js";
import { validateComponentItem, validateEffectiveLoadout } from "../model/validation.js";
import { nativeVehicleFieldChanges } from "../model/native-vehicle.js";

import { submitShipOperation } from "../state/action-queue.js";
import { isActiveGM } from "../socket.js";
import { createGmEventMessages, publishOperationEvents } from "./chat.js";
import { isInternalComponentMutation, initializeShipActor } from "./initialization.js";
import { sceneGridGeometry } from "./scene-geometry.js";

const POSITION_FIELDS = Object.freeze(["x", "y", "rotation"]);
let hooksRegistered = false;
let hookWork = Promise.resolve();
const INITIATIVE_PATCH = Symbol.for(`${MODULE_ID}.shipInitiativePatch`);
let activeGmAuthority = false;

function activeGm() {
  return isActiveGM();
}

function installShipInitiative() {
  const CombatantClass = globalThis.CONFIG?.Combatant?.documentClass;
  const prototype = CombatantClass?.prototype;
  if (!prototype || prototype[INITIATIVE_PATCH]) return false;
  const original = prototype.getInitiativeRoll;
  if (typeof original !== "function") return false;
  Object.defineProperty(prototype, INITIATIVE_PATCH, { value: original, configurable: false });
  prototype.getInitiativeRoll = function getShipInitiativeRoll(formula) {
    const config = this.actor?.system?.shipCombat?.config;
    const modifier = Number(config?.initiative);
    if (formula || this.actor?.type !== SHIP_TYPE || !Number.isFinite(modifier)) {
      return original.call(this, formula);
    }
    const operator = modifier >= 0 ? "+" : "-";
    return foundry.dice.Roll.create(`1d20 ${operator} ${Math.abs(modifier)}`, {});
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
  return collectionValues(actor?.items).filter((item) => item?.type === COMPONENT_ITEM_TYPE);
}

function embeddedShipComponent(item) {
  const actor = item?.parent;
  return item?.type === COMPONENT_ITEM_TYPE
    && actor?.documentName === "Actor"
    && actor.type === SHIP_TYPE;
}

function allowComponentMutation(item, options) {
  if (!embeddedShipComponent(item) || isInternalComponentMutation(options)) return true;
  if (!activeGm()) return false;
  return item.parent.system?.shipCombat?.state?.phase === "outsideCombat";
}

function componentUpdateSource(item, changes) {
  if (typeof item?.clone === "function") {
    const prospective = item.clone(changes, { keepId: true });
    if (typeof prospective?.toObject === "function") return prospective.toObject(false);
  }
  const source = typeof item?.toObject === "function" ? item.toObject(false) : clone(item);
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
  if (!componentValidation.valid) return validationMessage("Invalid ship component", componentValidation);
  if (!embeddedShipComponent(item) || !componentIsReferenced(item)) return "";

  try {
    const actor = item.parent;
    const itemId = item.id ?? item._id;
    const items = componentItems(actor).map((candidate) => candidate.id === itemId ? source : candidate);
    const effective = materializeShipConfig(actor.system.shipCombat.config, items);
    const loadoutValidation = validateEffectiveLoadout(effective, { tokenWidth: 1 });
    return loadoutValidation.valid ? "" : validationMessage("Component would invalidate this ship", loadoutValidation);
  } catch (error) {
    return error?.message ?? String(error);
  }
}

function allowComponentUpdate(item, changes, options, userId) {
  if (isInternalComponentMutation(options)) return true;
  if (!allowComponentMutation(item, options)) {
    if (userId === game.user?.id) ui.notifications.error("Only the active GM may refit embedded ship components outside combat.");
    return false;
  }
  if (item?.type !== COMPONENT_ITEM_TYPE) return true;
  // Foundry pre-update hooks are synchronous: a Promise cannot veto the original write.
  // Installed definitions must be saved together with their reconciled Actor state.
  const changesDefinition = Object.keys(changes ?? {}).some((key) =>
    ["system", "type"].includes(key.split(".")[0].replace(/^-=/, "")));
  if (embeddedShipComponent(item) && componentIsReferenced(item) && changesDefinition) {
    if (userId === game.user?.id) {
      ui.notifications.error("Edit installed ship component definitions through their Ship Component sheet so ship state is reconciled safely.");
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
  return (config.slots ?? []).some((slot) => slot?.itemId === id)
    || (config.hardpoints ?? []).some((hardpoint) => hardpoint?.weaponId === id);
}

function allowComponentDeletion(item, options) {
  if (!embeddedShipComponent(item) || isInternalComponentMutation(options)) return true;
  if (componentIsReferenced(item)) return false;
  return allowComponentMutation(item, options);
}

function assignmentOperatorId(assignment) {
  if (typeof assignment === "string") return assignment;
  return assignment?.operatorId ?? assignment?.id ?? null;
}

function assignedUserIds(shipData) {
  const profiles = new Map((shipData?.config?.operators ?? []).map((profile) => [profile?.id, profile]));
  const ids = new Set();
  for (const kind of ["command", "crew"]) {
    for (const assignment of shipData?.state?.roster?.[kind] ?? []) {
      const profile = profiles.get(assignmentOperatorId(assignment));
      const userId = assignment?.userId ?? profile?.userId;
      if (typeof userId === "string" && userId) ids.add(userId);
    }
  }
  return ids;
}

async function enforceOperatorOwnership(subject) {
  const contextActor = subject?.documentName === "Actor" ? subject : subject?.actor;
  const actor = subject?.baseActor ?? contextActor?.token?.baseActor ?? contextActor;
  const shipData = contextActor?.system?.shipCombat;
  if (!actor || !shipData || !activeGm()) return;
  const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  const ownershipUpdates = {};
  for (const userId of assignedUserIds(shipData)) {
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
    if (!updated) throw new Error("Ship normalization did not update the Actor.");
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
    .catch((error) => console.error(`${MODULE_ID} | ${label}`, error));
  return hookWork;
}

function schedule(label, task) {
  return scheduleSubmission(label, () => activeGm() ? task() : undefined);
}

function combatantToken(combatant) {
  const token = combatant?.token;
  return isShipToken(token) ? token : null;
}

function combatantByState(combat, state) {
  if (!state?.combatantId) return null;
  return combat.combatants.get(state.combatantId) ?? null;
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

async function submitLifecycle(combat, combatant, type, key) {
  const token = combatantToken(combatant);
  if (!token) return null;
  const targetTokens = operationTargetTokens(combat, token, type);
  for (const involved of [token, ...targetTokens]) await initializeTokenShipData(involved);
  const expectedRevisions = Object.fromEntries([token, ...targetTokens].map((involved) => [
    involved.uuid,
    Number(involved.actor.system.shipCombat?.state?.revision ?? 0),
  ]));
  const response = await submitShipOperation({
    id: operationId(combat, combatant, key, type),
    type,
    sourceUuid: token.uuid,
    targetUuids: targetTokens.map((target) => target.uuid),
    expectedRevisions,
    payload: lifecyclePayload(type, key),
  });
  if (!response?.ok && response?.error) {
    await createGmEventMessages([{
      title: `${type} failed`,
      message: response.error.message,
      details: { code: response.error.code, details: response.error.details, requestId: response.id },
    }]);
  }
  return response;
}

async function enterCombatants(combat) {
  for (const combatant of combat.combatants) {
    if (!combatantToken(combatant)) continue;
    await submitLifecycle(combat, combatant, "combat.enter", "combat");
  }
}

async function finishTurn(combat, combatant, state) {
  if (!combatantToken(combatant)) return;
  const key = turnKey(combat, state, combatant);
  await submitLifecycle(combat, combatant, "phase.coast", key);
  await submitLifecycle(combat, combatant, "phase.end", key);
}

async function beginTurn(combat, combatant, state) {
  if (!combatantToken(combatant)) return;
  await submitLifecycle(combat, combatant, "phase.start", turnKey(combat, state, combatant));
}

async function leaveCombatant(combat, combatant) {
  const token = combatantToken(combatant);
  if (!token) return;
  const state = token.actor.system.shipCombat?.state;
  const key = typeof state?.turnKey === "string" && state.turnKey
    ? state.turnKey
    : turnKey(combat, { round: combat.round }, combatant);
  if (state?.phase === "active") {
    await submitLifecycle(combat, combatant, "phase.coast", key);
    await submitLifecycle(combat, combatant, "phase.end", key);
  } else if (state?.phase === "end") {
    await submitLifecycle(combat, combatant, "phase.end", key);
  }
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
  return `${MODULE_ID}:reposition:${token.uuid}:${revision}:${position.x}:${position.y}:${payload.facing ?? ""}:${payload.resetVelocity}`;
}

async function submitAdministrativeReposition(token, proposed, options) {
  await initializeTokenShipData(token);
  const revision = Number(token.actor.system.shipCombat?.state?.revision ?? 0);
  const payload = {
    position: proposedCenterPosition(token, proposed),
    resetVelocity: options?.viraShipCombatResetVelocity === true || options?.resetVelocity === true,
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
      title: "Administrative reposition failed",
      message: response.error.message,
      details: { code: response.error.code, details: response.error.details, requestId: response.id },
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
        const baseActor = tokenActor?.baseActor ?? tokenActor?.token?.baseActor ?? tokenActor;
        if (baseActor?.id === actor?.id) tokens.push(token);
      }
    }
  }
  return tokens;
}

function initializeLoadedTokens() {
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (isShipToken(token)) schedule("Failed to initialize ship token", () => initializeTokenShipData(token));
    }
  }
}
function initializeLoadedActors() {
  for (const actor of game.actors) {
    if (actor.type === SHIP_TYPE) schedule("Failed to initialize ship actor", () => initializeActorShipData(actor));
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
}


/** Register V14 hooks for ship initialization, authority, combat phases, and administrative token movement. */
export function registerShipHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  installShipInitiative();

  Hooks.on("viraShipCombatOperationCommitted", (fullResult, request) => {
    void publishOperationEvents(fullResult, request)
      .catch((error) => console.error(`${MODULE_ID} | Failed to publish ship operation events`, error));
  });

  Hooks.on("createActor", (actor) => {
    if (actor.type === SHIP_TYPE) schedule("Failed to initialize created ship actor", () => initializeActorShipData(actor));
  });

  Hooks.on("createToken", (token) => {
    if (isShipToken(token)) schedule("Failed to initialize created ship token", () => initializeTokenShipData(token));
  });

  Hooks.on("updateToken", (token, changes, options) => {
    if (!isShipToken(token) || options?.[INTERNAL_UPDATE]) return;
    if (changes.delta || changes.actorId || changes.actorLink) {
      schedule("Failed to reconcile updated ship token", () => initializeTokenShipData(token));
    }
  });

  Hooks.on("updateActor", (actor, changes, options) => {
    if (actor.type !== SHIP_TYPE || options?.[INTERNAL_UPDATE]) return;
    const tokens = sceneTokensForActor(actor).filter(isShipToken);
    schedule("Failed to reconcile ship actor", async () => {
      await initializeActorShipData(actor);
      for (const token of tokens) await initializeTokenShipData(token);
    });
  });

  Hooks.on("preCreateItem", (item, _data, options) => allowComponentMutation(item, options));
  Hooks.on("preUpdateItem", (item, changes, options, userId) => allowComponentUpdate(item, changes, options, userId));
  Hooks.on("preDeleteItem", (item, options) => allowComponentDeletion(item, options));

  Hooks.on("preUpdateToken", (token, changes, options, userId) => {
    if (!isShipToken(token) || options?.[INTERNAL_UPDATE] || !hasPositionChange(changes)) return true;
    const user = game.users.get(userId);
    if (!user?.isGM) {
      if (userId === game.user.id) ui.notifications.warn("Ship tokens cannot be maneuvered by dragging. Use the Helm controls.");
      return false;
    }
    const proposed = Object.fromEntries(POSITION_FIELDS
      .filter((field) => Object.hasOwn(changes, field))
      .map((field) => [field, changes[field]]));
    scheduleSubmission("Failed to submit administrative reposition", () => submitAdministrativeReposition(token, proposed, options));
    return false;
  });

  Hooks.on("combatStart", (combat) => {
    schedule("Failed to enter ship combat", () => enterCombatants(combat));
  });

  Hooks.on("combatTurnChange", (combat, previous, current) => {
    schedule("Failed to advance ship combat phase", async () => {
      const previousCombatant = combatantByState(combat, previous);
      const currentCombatant = combatantByState(combat, current);
      if (previousCombatant) await finishTurn(combat, previousCombatant, previous);
      if (currentCombatant) await beginTurn(combat, currentCombatant, current);
    });
  });

  Hooks.on("createCombatant", (combatant) => {
    const combat = combatant.parent;
    if (!combat?.started || !combatantToken(combatant)) return;
    schedule("Failed to enter added ship combatant", async () => {
      await submitLifecycle(combat, combatant, "combat.enter", "combat");
      if (combat.combatant?.id === combatant.id) await beginTurn(combat, combatant, combat.current);
    });
  });

  Hooks.on("deleteCombatant", (combatant) => {
    const combat = combatant.parent;
    if (!combat || !combatantToken(combatant)) return;
    schedule("Failed to leave removed ship combatant", () => leaveCombatant(combat, combatant));
  });

  Hooks.on("deleteCombat", (combat) => {
    schedule("Failed to leave ended ship combat", async () => {
      for (const combatant of combat.combatants) {
        if (combatantToken(combatant)) await leaveCombatant(combat, combatant);
      }
    });
  });

  Hooks.on("updateUser", () => sweepWhenActiveGm());
  Hooks.on("userConnected", () => sweepWhenActiveGm());

  sweepWhenActiveGm();
}
