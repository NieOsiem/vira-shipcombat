import { COMPONENT_ITEM_TYPE, RuleViolation } from "../constants.js";
import { assertCurrentShipSchema, initializeShipActor } from "../foundry/initialization.js";
import { materializeShipConfig } from "../model/equipment.js";
import { nativeVehicleFieldValues } from "../model/native-vehicle.js";


const TRANSFORM_FIELDS = Object.freeze([
  "x",
  "y",
  "elevation",
  "rotation",
  "width",
  "height",
  "texture.scaleX",
  "texture.scaleY",
]);

export function cloneDocumentData(value) {
  if (value === undefined) return undefined;
  if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(value);
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function getProperty(object, path) {
  if (globalThis.foundry?.utils?.getProperty) return globalThis.foundry.utils.getProperty(object, path);
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
  if (globalThis.foundry?.utils?.setProperty) {
    globalThis.foundry.utils.setProperty(object, path, value);
    return;
  }
  const keys = path.split(".");
  let cursor = object;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[keys.at(-1)] = value;
}

export function isTokenDocument(document) {
  return document?.documentName === "Token" || document?.constructor?.metadata?.name === "Token";
}

export function isActorDocument(document) {
  return document?.documentName === "Actor" || document?.constructor?.metadata?.name === "Actor";
}

export async function resolveShipDocument(uuid) {
  if (typeof uuid !== "string" || !uuid) {
    throw new RuleViolation("INVALID_TOKEN_UUID", "Ship operations require a TokenDocument or Actor UUID.", { uuid });
  }
  const document = await globalThis.fromUuid?.(uuid);
  if (isTokenDocument(document)) {
    if (!document.actor) {
      throw new RuleViolation("TOKEN_ACTOR_MISSING", "The ship token has no actor context.", { uuid });
    }
    return document;
  }
  if (isActorDocument(document)) {
    return document;
  }
  throw new RuleViolation("TOKEN_NOT_FOUND", "The ship Document could not be resolved.", { uuid });
}

export async function resolveTokenDocument(uuid) {
  return resolveShipDocument(uuid);
}

function componentItems(actor) {
  const collection = actor?.items;
  if (!collection) return [];
  const items = Array.isArray(collection.contents)
    ? collection.contents
    : typeof collection.values === "function"
      ? [...collection.values()]
      : Array.from(collection);
  return items.filter((item) => item?.type === COMPONENT_ITEM_TYPE);
}

export function readShipRecord(document) {
  const isToken = Boolean(document?.actor);
  const actor = isToken ? document.actor : document;
  assertCurrentShipSchema(actor);
  const shipCombat = actor?.system?.shipCombat;
  if (!shipCombat?.config || !shipCombat?.state) {
    throw new RuleViolation("SHIP_STATE_MISSING", "The ship actor has no ship combat configuration or state.", {
      uuid: document.uuid,
    });
  }
  const config = materializeShipConfig(shipCombat.config, componentItems(actor));
  return {
    uuid: document.uuid,
    tokenDocument: isToken ? document : null,
    actorDocument: isToken ? document.actor : document,
    config,
    state: cloneDocumentData(shipCombat.state),
    token: isToken ? snapshotTokenTransform(document) : {},
  };
}

export function snapshotTokenTransform(tokenDocument) {
  const source = typeof tokenDocument.toObject === "function" ? tokenDocument.toObject() : tokenDocument;
  const transform = {};
  for (const path of TRANSFORM_FIELDS) {
    const value = getProperty(source, path);
    if (value !== undefined) setProperty(transform, path, cloneDocumentData(value));
  }
  return transform;
}

export async function writeShipState(document, state) {
  // Synthetic actors persist into TokenDocument delta data; linked actors and sidebar
  // actors persist into their world Actor.
  const isToken = Boolean(document?.actor);
  const actor = isToken ? document.actor : document;
  const config = materializeShipConfig(actor.system.shipCombat.config, componentItems(actor));
  const replacement = globalThis.foundry.data.operators.ForcedReplacement.create(cloneDocumentData(state));
  await actor.update({
    "system.shipCombat.state": replacement,
    ...nativeVehicleFieldValues(config, state),
  }, { viraShipCombatInternal: true, diff: false });
  // The replacement operator replaces the whole state, which for a delta-backed token also replaces
  // the state its stored delta carries: a finished Recovery Work entry, an expired jam or a dropped
  // track cannot survive there. Foundry applies the operator and refreshes the document source before
  // the awaited update resolves, so nothing is left to delete afterwards, and a delta-side deletion
  // could not suppress a key the base Actor contributes because ActorDelta re-merges it on load.
  return document;
}

export async function writeTokenTransform(document, transform) {
  if (!isTokenDocument(document)) return document;
  const update = {};
  for (const path of TRANSFORM_FIELDS) {
    const value = getProperty(transform, path);
    if (value !== undefined) setProperty(update, path, cloneDocumentData(value));
  }
  if (!Object.keys(update).length) return document;
  return document.update(update, { viraShipCombatInternal: true });
}

/**
 * Load ship records for an operation. A target that vanished between preparation and execution stops
 * being involved instead of failing the whole operation; required uuids must always resolve.
 */
export async function loadShipRecords(uuids, { requiredUuids = [] } = {}) {
  const required = new Set(requiredUuids);
  const records = new Map();
  for (const uuid of uuids) {
    if (records.has(uuid)) continue;
    let document;
    try {
      document = await resolveShipDocument(uuid);
    } catch (error) {
      if (
        required.has(uuid) || !(error instanceof RuleViolation) ||
        error.code !== "TOKEN_NOT_FOUND"
      ) throw error;
      continue;
    }
    const actor = isTokenDocument(document) ? document.actor : document;
    await initializeShipActor(actor);
    records.set(uuid, readShipRecord(document));
  }
  return records;
}

export function operationUuids(request) {
  const sourceUuid = request?.sourceUuid;
  const targets = Array.isArray(request?.targetUuids) ? request.targetUuids : [];
  const uuids = [sourceUuid, ...targets];
  if (uuids.some((uuid) => typeof uuid !== "string" || !uuid)) {
    throw new RuleViolation("INVALID_OPERATION_UUIDS", "A ship operation requires a source UUID and an array of target UUIDs.", {
      sourceUuid,
      targetUuids: request?.targetUuids,
    });
  }
  return [...new Set(uuids)];
}

export { TRANSFORM_FIELDS };
