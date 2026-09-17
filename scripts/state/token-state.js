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

function isTokenDocument(document) {
  return document?.documentName === "Token" || document?.constructor?.metadata?.name === "Token";
}

export async function resolveTokenDocument(uuid) {
  if (typeof uuid !== "string" || !uuid) {
    throw new RuleViolation("INVALID_TOKEN_UUID", "Ship operations require a TokenDocument UUID.", { uuid });
  }
  const document = await globalThis.fromUuid?.(uuid);
  if (!isTokenDocument(document)) {
    throw new RuleViolation("TOKEN_NOT_FOUND", "The ship TokenDocument could not be resolved.", { uuid });
  }
  if (!document.actor) {
    throw new RuleViolation("TOKEN_ACTOR_MISSING", "The ship token has no actor context.", { uuid });
  }
  return document;
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

export function readShipRecord(tokenDocument) {
  const actor = tokenDocument.actor;
  assertCurrentShipSchema(actor);
  const shipCombat = actor?.system?.shipCombat;
  if (!shipCombat?.config || !shipCombat?.state) {
    throw new RuleViolation("SHIP_STATE_MISSING", "The token actor has no ship combat configuration or state.", {
      uuid: tokenDocument.uuid,
    });
  }
  const config = materializeShipConfig(shipCombat.config, componentItems(actor));
  return {
    uuid: tokenDocument.uuid,
    tokenDocument,
    config,
    state: cloneDocumentData(shipCombat.state),
    token: snapshotTokenTransform(tokenDocument),
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

export async function writeShipState(tokenDocument, state) {
  // Synthetic actors persist into TokenDocument delta data; linked actors persist into
  // their world Actor. Both paths intentionally use the token's actor context.
  const actor = tokenDocument.actor;
  const config = materializeShipConfig(actor.system.shipCombat.config, componentItems(actor));
  const replacement = globalThis.foundry.data.operators.ForcedReplacement.create(cloneDocumentData(state));
  return actor.update({
    "system.shipCombat.state": replacement,
    ...nativeVehicleFieldValues(config, state),
  }, { viraShipCombatInternal: true, diff: false });
}

export async function writeTokenTransform(tokenDocument, transform) {
  const update = {};
  for (const path of TRANSFORM_FIELDS) {
    const value = getProperty(transform, path);
    if (value !== undefined) setProperty(update, path, cloneDocumentData(value));
  }
  if (!Object.keys(update).length) return tokenDocument;
  return tokenDocument.update(update, { viraShipCombatInternal: true });
}

export async function loadShipRecords(uuids) {
  const records = new Map();
  for (const uuid of uuids) {
    if (records.has(uuid)) continue;
    const tokenDocument = await resolveTokenDocument(uuid);
    await initializeShipActor(tokenDocument.actor);
    records.set(uuid, readShipRecord(tokenDocument));
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
