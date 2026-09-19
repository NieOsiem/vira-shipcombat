import { MODULE_ID, RuleViolation, SHIP_TYPE } from "../constants.js";
import { executeShipOperation } from "../rules/operations.js";
import { sceneGridGeometry } from "../foundry/scene-geometry.js";
import {
  cloneDocumentData,
  isTokenDocument,
  loadShipRecords,
  operationUuids,
  resolveTokenDocument,
  writeShipState,
  writeTokenTransform,
} from "./token-state.js";
import {
  initializeShipSocket,
  isActiveGM,
  requestRemoteShipOperation,
} from "../socket.js";

/**
 * Committed results are retained so a repeated request id replays instead of executing twice. Keys
 * are never re-set, so Map insertion order lets the oldest entry be evicted to bound the retained
 * deep clones; replay semantics for the ids still held are unchanged.
 */
const PROCESSED_LIMIT = 64;
const processed = new Map();
let queueTail = Promise.resolve();
let initialized = false;
let initialization = null;

function now() {
  return new Date().toISOString();
}

function failure(id, error) {
  return {
    ok: false,
    id: typeof id === "string" ? id : "",
    error: {
      code: error.code ?? "SHIP_OPERATION_REJECTED",
      message: error.message,
      ...(error.details === undefined ? {} : { details: cloneDocumentData(error.details) }),
    },
  };
}

function rule(code, message, details) {
  return new RuleViolation(code, message, details);
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw rule("INVALID_REQUEST", "A ship operation request must be an object.");
  }
  if (typeof request.id !== "string" || !request.id) throw rule("INVALID_REQUEST_ID", "A ship operation requires a non-empty process-once ID.");
  if (typeof request.type !== "string" || !request.type) throw rule("INVALID_OPERATION_TYPE", "A ship operation requires a type.");
  if (Object.hasOwn(request, "userId") || Object.hasOwn(request, "submitterId")) {
    throw rule("FORGED_USER_CONTEXT", "Submitter identity belongs only to the socket envelope.");
  }
  if (!Array.isArray(request.targetUuids)) throw rule("INVALID_TARGET_UUIDS", "targetUuids must be an array.");
  if (!request.expectedRevisions || typeof request.expectedRevisions !== "object" || Array.isArray(request.expectedRevisions)) {
    throw rule("INVALID_EXPECTED_REVISIONS", "expectedRevisions must map every involved TokenDocument UUID to a revision.");
  }
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw rule("INVALID_OPERATION_PAYLOAD", "payload must be an object.");
  }
  if (containsIdentity(request.payload)) {
    throw rule("FORGED_USER_CONTEXT", "Operation payloads cannot supply a Foundry user identity.");
  }
  operationUuids(request);
  return request;
}

const SCENE_SNAPSHOT_TYPES = new Set(["maneuver", "setRoster", "refreshResources", "phase.start", "startPhase", "reposition"]);

async function normalizeSceneParticipants(request) {
  if (!SCENE_SNAPSHOT_TYPES.has(request.type)) return;
  const source = await resolveTokenDocument(request.sourceUuid);
  if (!isTokenDocument(source) || !source.parent?.tokens) return;
  const sceneTokens = collectionValues(source.parent?.tokens)
    .filter((token) => token?.actor?.type === SHIP_TYPE && typeof token.uuid === "string")
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  const participants = new Map([[source.uuid, source]]);
  for (const token of sceneTokens) participants.set(token.uuid, token);

  const supplied = request.expectedRevisions;
  const expectedRevisions = {};
  for (const [uuid, token] of participants) {
    if (Object.hasOwn(supplied, uuid)) {
      expectedRevisions[uuid] = supplied[uuid];
      continue;
    }
    const revision = token.actor?.system?.shipCombat?.state?.revision;
    if (Number.isInteger(revision)) expectedRevisions[uuid] = revision;
  }
  request.targetUuids = [...participants.keys()].filter((uuid) => uuid !== source.uuid);
  request.expectedRevisions = expectedRevisions;
}

function activeUser(userId) {
  const user = globalThis.game?.users?.get?.(userId);
  if (!user?.active) throw rule("INACTIVE_SUBMITTER", "The request submitter is not an active Foundry user.", { userId });
  return user;
}

function containsIdentity(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "userId" || key === "submitterId") return true;
    if (containsIdentity(child, seen)) return true;
  }
  return false;
}

function assignmentOperatorId(assignment) {
  return typeof assignment === "string" ? assignment : assignment?.operatorId ?? assignment?.id;
}

export const advanceCooldowns = new Map();

export function assertPermission(user, request, source) {
  if (user.isGM) return;
  if (request.payload.gmOverride === true) {
    throw rule("FORGED_USER_CONTEXT", "Player operation payloads cannot claim GM authority.");
  }
  const isOutside = source.state?.phase === "outsideCombat";
  if (isOutside) {
    const actor = source.tokenDocument?.actor ?? source.actorDocument;
    const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
    if (actor && typeof actor.testUserPermission === "function" && !actor.testUserPermission(user, observer)) {
      throw rule("PERMISSION_DENIED", "Observer permission on the ship is required to operate it outside combat.");
    }
    if (request.type === "advanceTurn" || request.type === "cycleRound") {
      const actorUuid = actor?.uuid;
      const last = Math.max(
        advanceCooldowns.get(source.uuid) ?? 0,
        actorUuid ? (advanceCooldowns.get(actorUuid) ?? 0) : 0,
      );
      const nowMs = Date.now();
      if (nowMs - last < 12000) {
        const remaining = Math.ceil((12000 - (nowMs - last)) / 1000);
        throw rule("ADVANCE_COOLDOWN", `Advance Turn is on cooldown. Please wait ${remaining}s before advancing again.`);
      }
      advanceCooldowns.set(source.uuid, nowMs);
      if (actorUuid) advanceCooldowns.set(actorUuid, nowMs);
    }
    return;
  }
  const operatorId = request.payload.operatorId;
  if (typeof operatorId !== "string" || !operatorId) {
    throw rule("OPERATOR_REQUIRED", "A player ship operation requires an assigned operatorId.");
  }
  const roster = source.state?.roster ?? {};
  const assignment = [...(roster.command ?? []), ...(roster.crew ?? [])]
    .find((entry) => assignmentOperatorId(entry) === operatorId);
  const profile = source.config?.operators?.find((entry) => entry?.id === operatorId);
  if (!assignment || !profile) {
    throw rule("OPERATOR_NOT_ASSIGNED", "The selected operator is not assigned to this ship.", { operatorId, sourceUuid: source.uuid });
  }
  const assignedUserId = (typeof assignment === "object" ? assignment.userId : null) ?? profile.userId ?? null;
  if (assignedUserId !== user.id) {
    throw rule("OPERATOR_USER_MISMATCH", "The active user is not the ship-local assigned operator.", {
      operatorId,
      sourceUuid: source.uuid,
    });
  }
}

function validateExpectedRevisions(request, records) {
  for (const [uuid, record] of records) {
    const expected = request.expectedRevisions[uuid];
    const actual = record.state?.revision;
    if (!Number.isInteger(expected)) {
      throw rule("EXPECTED_REVISION_REQUIRED", "Every involved ship requires an integer expected revision.", { uuid, expected });
    }
    if (expected !== actual) {
      throw rule("STALE_REVISION", "Ship state changed after the operation was prepared.", { uuid, expected, actual });
    }
  }
}

function validateLiveRevisions(request, records) {
  for (const [uuid, record] of records) {
    const expected = request.expectedRevisions[uuid];
    const actor = record.tokenDocument?.actor ?? record.actorDocument;
    const actual = actor?.system?.shipCombat?.state?.revision;
    if (expected !== actual) {
      throw rule("STALE_REVISION", "Ship state changed while the operation was being resolved.", { uuid, expected, actual });
    }
  }
}

function historyEvent(request, submitterId, timestamp) {
  return {
    id: request.id,
    type: request.type,
    timestamp,
    submitterId,
  };
}

function incrementChangedStates(result, records, request, submitterId, timestamp) {
  const changed = [...new Set([...(result.changedUuids ?? []), ...Object.keys(result.tokenUpdates ?? {})])];
  for (const uuid of changed) {
    const record = records.get(uuid);
    const next = result.shipStates?.[uuid];
    if (!record || !next) throw rule("INVALID_OPERATION_RESULT", "The rule result changed an unknown ship or omitted its replacement state.", { uuid });
    next.revision = Number(record.state.revision) + 1;
    next.history = Array.isArray(next.history) ? next.history : [];
    next.history.push(historyEvent(request, submitterId, timestamp));
  }
  result.changedUuids = changed;
}

/** Capture the pre-operation ship documents so a failed write can be undone in this session. */
function operationSnapshots(records) {
  const ships = {};
  for (const [uuid, record] of records) {
    ships[uuid] = {
      state: cloneDocumentData(record.state),
      tokenTransform: cloneDocumentData(record.token),
    };
  }
  return { ships };
}

function assertResultScope(result, records) {
  if (!result || typeof result !== "object") throw rule("INVALID_OPERATION_RESULT", "The ship rule dispatcher returned no result.");
  result.shipStates ??= {};
  result.tokenUpdates ??= {};
  result.publicEvents ??= [];
  result.gmEvents ??= [];
  result.changedUuids ??= [];
  for (const uuid of [...Object.keys(result.shipStates), ...Object.keys(result.tokenUpdates), ...result.changedUuids]) {
    if (!records.has(uuid)) throw rule("INVALID_OPERATION_RESULT", "The ship rule dispatcher returned an uninvolved TokenDocument UUID.", { uuid });
  }
}

function rollD20() {
  const random = typeof globalThis.CONFIG?.Dice?.randomUniform === "function"
    ? globalThis.CONFIG.Dice.randomUniform()
    : Math.random();
  return Math.ceil((1 - random) * 20);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection);
}

function sceneForRecord(records, source) {
  return records.get(source?.uuid)?.tokenDocument?.parent ?? null;
}


function tokenCenter(source, token, records) {
  const scene = sceneForRecord(records, source);
  const { gridSize, unitsPerPixel } = sceneGridGeometry(scene);
  const width = Math.max(0, finiteNumber(token?.width, 1));
  const height = Math.max(0, finiteNumber(token?.height, 1));
  const centerX = finiteNumber(token?.x, 0) + ((width * gridSize) / 2);
  const centerY = finiteNumber(token?.y, 0) + ((height * gridSize) / 2);
  return { x: centerX * unitsPerPixel, y: centerY * unitsPerPixel };
}

function wallCoordinates(wall) {
  const coordinates = wall?.c ?? wall?.document?.c ?? wall?._source?.c;
  if (!Array.isArray(coordinates) || coordinates.length < 4) return null;
  const values = coordinates.slice(0, 4).map(Number);
  return values.every(Number.isFinite) ? values : null;
}

function doorIsOpen(wall) {
  const open = globalThis.CONST?.WALL_DOOR_STATES?.OPEN ?? 1;
  return Number(wall?.ds ?? wall?.document?.ds ?? wall?._source?.ds) === open;
}

function movementWall(wall) {
  if (doorIsOpen(wall)) return false;
  const none = globalThis.CONST?.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  return Number(wall?.move ?? wall?.document?.move ?? wall?._source?.move ?? 1) !== none;
}

function sightWall(wall) {
  if (doorIsOpen(wall)) return false;
  const none = globalThis.CONST?.WALL_SENSE_TYPES?.NONE ?? 0;
  return Number(wall?.sight ?? wall?.document?.sight ?? wall?._source?.sight ?? 1) !== none;
}

function wallSegment(wall, scene) {
  const coordinates = wallCoordinates(wall);
  if (!coordinates) return null;
  const { unitsPerPixel } = sceneGridGeometry(scene);
  return {
    id: String(wall?.id ?? wall?._id ?? wall?.document?.id ?? `${coordinates.join(":")}`),
    a: { x: coordinates[0] * unitsPerPixel, y: coordinates[1] * unitsPerPixel },
    b: { x: coordinates[2] * unitsPerPixel, y: coordinates[3] * unitsPerPixel },
  };
}

function cross(first, second, third) {
  return ((second.x - first.x) * (third.y - first.y))
    - ((second.y - first.y) * (third.x - first.x));
}

function pointOnSegment(point, start, end, epsilon = 1e-9) {
  return Math.abs(cross(start, end, point)) <= epsilon
    && point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);
  const epsilon = 1e-9;
  if (((firstSideStart > epsilon && firstSideEnd < -epsilon) || (firstSideStart < -epsilon && firstSideEnd > epsilon))
    && ((secondSideStart > epsilon && secondSideEnd < -epsilon) || (secondSideStart < -epsilon && secondSideEnd > epsilon))) {
    return true;
  }
  return (Math.abs(firstSideStart) <= epsilon && pointOnSegment(secondStart, firstStart, firstEnd, epsilon))
    || (Math.abs(firstSideEnd) <= epsilon && pointOnSegment(secondEnd, firstStart, firstEnd, epsilon))
    || (Math.abs(secondSideStart) <= epsilon && pointOnSegment(firstStart, secondStart, secondEnd, epsilon))
    || (Math.abs(secondSideEnd) <= epsilon && pointOnSegment(firstEnd, secondStart, secondEnd, epsilon));
}

function geometryAdapter(records) {
  const positionOf = (source, state, token) => tokenCenter(source, token, records);
  const lineOfSight = (source, target) => {
    const sourceScene = sceneForRecord(records, source);
    const targetScene = sceneForRecord(records, target);
    const sourceSceneId = sourceScene?.uuid ?? sourceScene?.id;
    const targetSceneId = targetScene?.uuid ?? targetScene?.id;
    if (!sourceScene || !targetScene) return false;
    if (sourceScene !== targetScene && (!sourceSceneId || sourceSceneId !== targetSceneId)) return false;
    const start = tokenCenter(source, source?.token, records);
    const end = tokenCenter(target, target?.token, records);
    return !collectionValues(sourceScene.walls).some((wall) => {
      if (!sightWall(wall)) return false;
      const segment = wallSegment(wall, sourceScene);
      return segment ? segmentsIntersect(start, end, segment.a, segment.b) : false;
    });
  };
  return {
    positionOf,
    facingOf: (source, state, token) => finiteNumber(token?.rotation, finiteNumber(state?.facing, 0)),
    collisionRadius: (source, state, token) => (
      Math.max(0, finiteNumber(token?.width, 1)) / 2
    ),
    distanceBetween: (source, target) => {
      const first = tokenCenter(source, source?.token, records);
      const second = tokenCenter(target, target?.token, records);
      return Math.hypot(second.x - first.x, second.y - first.y);
    },
    tokenUpdate: ({ uuid, token, position, facing }) => {
      const scene = records.get(uuid)?.tokenDocument?.parent ?? null;
      const { gridSize, pixelsPerUnit } = sceneGridGeometry(scene);
      const width = Math.max(0, finiteNumber(token?.width, 1));
      const height = Math.max(0, finiteNumber(token?.height, 1));
      return {
        ...cloneDocumentData(token),
        x: (finiteNumber(position?.x, 0) * pixelsPerUnit) - ((width * gridSize) / 2),
        y: (finiteNumber(position?.y, 0) * pixelsPerUnit) - ((height * gridSize) / 2),
        rotation: finiteNumber(facing, finiteNumber(token?.rotation, 0)),
      };
    },
    walls: (source) => {
      const scene = sceneForRecord(records, source);
      if (!scene) return [];
      return collectionValues(scene.walls)
        .filter(movementWall)
        .map((wall) => wallSegment(wall, scene))
        .filter(Boolean);
    },
    sensorLineOfSight: lineOfSight,
    weaponLineOfSight: lineOfSight,
  };
}

function dispatcherContext(records, user) {
  return {
    ships: Object.fromEntries([...records].map(([uuid, record]) => [uuid, {
      uuid,
      config: cloneDocumentData(record.config),
      state: cloneDocumentData(record.state),
      token: cloneDocumentData(record.token),
    }])),
    userId: user.id,
    isGM: user.isGM,
    rollD20,
    random: Math.random,
    geometry: geometryAdapter(records),
  };
}

async function restoreDocuments(records, before) {
  const errors = [];
  for (const [uuid, record] of [...records].reverse()) {
    try {
      const doc = record.tokenDocument ?? record.actorDocument;
      await writeShipState(doc, before.ships[uuid].state);
    } catch (error) {
      errors.push({ uuid, document: "actor", message: error.message });
    }
  }
  for (const [uuid, record] of [...records].reverse()) {
    if (!record.tokenDocument) continue;
    try {
      await writeTokenTransform(record.tokenDocument, before.ships[uuid].tokenTransform);
    } catch (error) {
      errors.push({ uuid, document: "token", message: error.message });
    }
  }
  return errors;
}

async function persistOperation(records, result, before) {
  // Writes stay sequential per ship on purpose: a measured A/B showed overlapping them is ~45% SLOWER
  // (855 ms vs 590 ms for a five-ship reposition). The cost is client-side document apply plus the
  // console rebuild each update triggers, not the client->server round trip, so concurrency only makes
  // the client contend with itself. A ship's transform also has to follow its own state write, since
  // an unlinked ship persists its state into that same TokenDocument.
  try {
    for (const uuid of result.changedUuids) {
      const record = records.get(uuid);
      const doc = record.tokenDocument ?? record.actorDocument;
      await writeShipState(doc, result.shipStates[uuid]);
    }
    for (const [uuid, transform] of Object.entries(result.tokenUpdates)) {
      const record = records.get(uuid);
      if (record?.tokenDocument) {
        await writeTokenTransform(record.tokenDocument, transform);
      }
    }
  } catch (cause) {
    const restoreErrors = await restoreDocuments(records, before);
    throw rule("PERSISTENCE_FAILED", "The operation could not be persisted; prior ship and token documents were restored.", {
      cause: cause.message,
      restoreErrors,
    });
  }
}

function publicResponse(response, user) {
  if (!response.ok || user.isGM) return cloneDocumentData(response);
  return {
    ok: true,
    id: response.id,
    result: {
      publicEvents: cloneDocumentData(response.result?.publicEvents ?? []),
      changedUuids: cloneDocumentData(response.result?.changedUuids ?? []),
    },
  };
}

function emitCommitted(result, request) {
  try {
    globalThis.Hooks?.callAll?.("viraShipCombatOperationCommitted", result, request);
  } catch (error) {
    globalThis.console?.error?.("Vira Ship Combat commit hook failed", error);
  }
}

/** Retain a result for replay, evicting the oldest entries once the cache exceeds its bound. */
function rememberResult(id, response) {
  processed.set(id, response);
  while (processed.size > PROCESSED_LIMIT) processed.delete(processed.keys().next().value);
}

function recordRejection(request, error) {
  const response = failure(request?.id, error);
  if (response.id) rememberResult(response.id, response);
  return response;
}

async function processRequest(request, submitterId) {
  if (!isActiveGM()) throw new Error("Only the active GM may execute the authoritative ship operation queue.");
  try {
    validateRequest(request);
    const user = activeUser(submitterId);
    const cached = processed.get(request.id);
    if (cached) return cloneDocumentData(cached);
    await normalizeSceneParticipants(request);
    const uuids = operationUuids(request);
    const records = await loadShipRecords(uuids);
    validateExpectedRevisions(request, records);
    assertPermission(user, request, records.get(request.sourceUuid));

    const timestamp = now();
    const before = operationSnapshots(records);
    const result = await executeShipOperation(cloneDocumentData(request), dispatcherContext(records, user));
    assertResultScope(result, records);
    activeUser(submitterId);
    validateLiveRevisions(request, records);
    incrementChangedStates(result, records, request, submitterId, timestamp);
    const response = { ok: true, id: request.id, result: cloneDocumentData(result) };
    await persistOperation(records, result, before);
    rememberResult(request.id, response);
    emitCommitted(result, cloneDocumentData(request));
    return response;
  } catch (error) {
    if (!(error instanceof RuleViolation)) throw error;
    return recordRejection(request, error);
  }
}

function enqueue(work) {
  const pending = queueTail.then(work);
  queueTail = pending.catch(() => undefined);
  return pending;
}

async function receiveRemote(request, submitterId) {
  const user = globalThis.game?.users?.get?.(submitterId);
  const response = await enqueue(() => processRequest(request, submitterId));
  return publicResponse(response, user ?? { isGM: false });
}

const LEGACY_OPERATION_LOG_MARKER = "isOperationLog";

function isLegacyOperationLog(journalEntry) {
  return (journalEntry?.getFlag?.(MODULE_ID, LEGACY_OPERATION_LOG_MARKER)
    ?? journalEntry?.flags?.[MODULE_ID]?.[LEGACY_OPERATION_LOG_MARKER]) === true;
}

/**
 * Delete the journal entry that used to hold the operation history. Nothing reads it any more, so
 * leaving a multi-megabyte blob in the world would only cost load time and storage.
 */
async function purgeLegacyOperationLog() {
  if (!isActiveGM()) return;
  try {
    const legacy = collectionValues(globalThis.game?.journal).filter(isLegacyOperationLog);
    for (const journalEntry of legacy) await journalEntry.delete();
    if (legacy.length) {
      globalThis.ui?.notifications?.info?.("Vira Ship Combat removed its unused operation log journal entry.");
    }
  } catch (error) {
    globalThis.console?.warn?.("Vira Ship Combat could not remove the unused operation log journal entry", error);
  }
}

export async function initializeShipAuthority() {
  initializeShipSocket(receiveRemote);
  if (!isActiveGM()) {
    initialized = true;
    return;
  }
  if (initialization) return initialization;
  initialization = (async () => {
    initialized = true;
    await purgeLegacyOperationLog();
  })();
  try {
    await initialization;
  } finally {
    initialization = null;
  }
}

/**
 * Run GM-side work serialized with the authoritative operation queue. Never call from inside the
 * queue: the work would then block behind the operation that is waiting for it.
 */
export function enqueueAuthorityWork(work) {
  return enqueue(work);
}

export async function submitShipOperation(request) {
  const id = typeof request?.id === "string" ? request.id : "";
  try {
    validateRequest(request);
  } catch (error) {
    if (error instanceof RuleViolation) return failure(id, error);
    throw error;
  }
  const canonical = cloneDocumentData(request);
  if (!initialized) await initializeShipAuthority();
  const response = isActiveGM()
    ? await enqueue(() => processRequest(canonical, globalThis.game.user.id))
    : await requestRemoteShipOperation(canonical, globalThis.game?.user?.id);
  if (response?.ok && (canonical.type === "advanceTurn" || canonical.type === "cycleRound") && !globalThis.game?.user?.isGM) {
    const nowMs = Date.now();
    advanceCooldowns.set(canonical.sourceUuid, nowMs);
  }
  return response;
}

/** Build a GM automation request at the queue head, against the latest document revisions. */
export async function submitAutomaticShipOperation(buildRequest) {
  if (!isActiveGM()) return null;
  if (!initialized) await initializeShipAuthority();
  return enqueue(async () => {
    if (!isActiveGM()) return null;
    const request = await buildRequest();
    if (!request) return null;
    return processRequest(cloneDocumentData(request), globalThis.game.user.id);
  });
}
