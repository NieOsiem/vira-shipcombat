import { RuleViolation, SHIP_TYPE } from "../constants.js";
import { executeShipOperation } from "../rules/operations.js";
import {
  cloneDocumentData,
  loadShipRecords,
  operationUuids,
  resolveTokenDocument,
  writeShipState,
  writeTokenTransform,
} from "./token-state.js";
import {
  appendOperationEntry,
  findOperationEntry,
  initializeOperationLog,
  readOperationEntries,
  removeOperationEntry,
} from "./operation-log.js";
import {
  initializeShipSocket,
  isActiveGM,
  requestRemoteShipOperation,
  requestRemoteShipRollback,
} from "../socket.js";

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

const SCENE_SNAPSHOT_TYPES = new Set(["maneuver", "setRoster", "refreshResources", "phase.start", "startPhase"]);

async function normalizeSceneParticipants(request) {
  if (!SCENE_SNAPSHOT_TYPES.has(request.type)) return;
  const source = await resolveTokenDocument(request.sourceUuid);
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

function assertPermission(user, request, source) {
  if (user.isGM) return;
  if (request.payload.gmOverride === true) {
    throw rule("FORGED_USER_CONTEXT", "Player operation payloads cannot claim GM authority.");
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
    const actual = record.tokenDocument.actor?.system?.shipCombat?.state?.revision;
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

function mergedTransform(before, update) {
  const result = cloneDocumentData(before);
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        merge(target[key] ??= {}, value);
      } else target[key] = cloneDocumentData(value);
    }
  };
  merge(result, update);
  return result;
}

function operationSnapshots(records, result = null) {
  const ships = {};
  for (const [uuid, record] of records) {
    ships[uuid] = {
      state: cloneDocumentData(result?.shipStates?.[uuid] ?? record.state),
      tokenTransform: result?.tokenUpdates?.[uuid]
        ? mergedTransform(record.token, result.tokenUpdates[uuid])
        : cloneDocumentData(record.token),
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

function sceneMetrics(scene) {
  const configuredSize = finiteNumber(scene?.grid?.size, NaN);
  const dimensionSize = finiteNumber(scene?.dimensions?.size, NaN);
  const gridSize = configuredSize > 0 ? configuredSize : (dimensionSize > 0 ? dimensionSize : 100);
  const configuredDistance = finiteNumber(scene?.grid?.distance, 1);
  const gridDistance = configuredDistance > 0 ? configuredDistance : 1;
  return { gridSize, gridDistance, unitsPerPixel: gridDistance / gridSize };
}

function tokenCenter(source, token, records) {
  const scene = sceneForRecord(records, source);
  const { gridSize, unitsPerPixel } = sceneMetrics(scene);
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
  const { unitsPerPixel } = sceneMetrics(scene);
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
    collisionRadius: (source, state, token) => {
      const { gridDistance } = sceneMetrics(sceneForRecord(records, source));
      return Math.max(0, finiteNumber(token?.width, 1)) * gridDistance / 2;
    },
    distanceBetween: (source, target) => {
      const first = tokenCenter(source, source?.token, records);
      const second = tokenCenter(target, target?.token, records);
      return Math.hypot(second.x - first.x, second.y - first.y);
    },
    tokenUpdate: ({ uuid, token, position, facing }) => {
      const scene = records.get(uuid)?.tokenDocument?.parent ?? null;
      const { gridSize, gridDistance } = sceneMetrics(scene);
      const pixelsPerUnit = gridSize / gridDistance;
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
      await writeShipState(record.tokenDocument, before.ships[uuid].state);
    } catch (error) {
      errors.push({ uuid, document: "actor", message: error.message });
    }
  }
  for (const [uuid, record] of [...records].reverse()) {
    try {
      await writeTokenTransform(record.tokenDocument, before.ships[uuid].tokenTransform);
    } catch (error) {
      errors.push({ uuid, document: "token", message: error.message });
    }
  }
  return errors;
}

async function persistOperation(records, result, entry) {
  const before = entry.before;
  try {
    for (const uuid of result.changedUuids) {
      await writeShipState(records.get(uuid).tokenDocument, result.shipStates[uuid]);
    }
    for (const [uuid, transform] of Object.entries(result.tokenUpdates)) {
      await writeTokenTransform(records.get(uuid).tokenDocument, transform);
    }
    await appendOperationEntry(entry);
  } catch (cause) {
    const restoreErrors = await restoreDocuments(records, before);
    try {
      await removeOperationEntry(entry.id);
    } catch (error) {
      restoreErrors.push({ document: "journal", message: error.message });
    }
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

async function recordRejection(request, submitterId, error, records = null) {
  const response = failure(request?.id, error);
  if (response.id) processed.set(response.id, response);
  if (!isActiveGM() || !request?.id) return response;
  const timestamp = now();
  await appendOperationEntry({
    id: request.id,
    kind: "rejected",
    timestamp,
    submitterId,
    request: cloneDocumentData(request),
    before: records ? operationSnapshots(records) : null,
    after: records ? operationSnapshots(records) : null,
    publicEvents: [],
    gmEvents: [{ type: "operation.rejected", code: error.code, message: error.message, details: cloneDocumentData(error.details) }],
    response,
  });
  return response;
}

async function processRequest(request, submitterId) {
  if (!isActiveGM()) throw new Error("Only the active GM may execute the authoritative ship operation queue.");
  let records = null;
  try {
    validateRequest(request);
    const user = activeUser(submitterId);
    const cached = processed.get(request.id);
    if (cached) return cloneDocumentData(cached);
    const persisted = await findOperationEntry(request.id);
    if (persisted?.response) {
      processed.set(request.id, persisted.response);
      return cloneDocumentData(persisted.response);
    }
    await normalizeSceneParticipants(request);
    const uuids = operationUuids(request);
    records = await loadShipRecords(uuids);
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
    const entry = {
      id: request.id,
      kind: "operation",
      timestamp,
      submitterId,
      request: cloneDocumentData(request),
      before,
      after: operationSnapshots(records, result),
      publicEvents: cloneDocumentData(result.publicEvents),
      gmEvents: cloneDocumentData(result.gmEvents),
      response: cloneDocumentData(response),
    };
    await persistOperation(records, result, entry);
    processed.set(request.id, response);
    emitCommitted(result, cloneDocumentData(request));
    return response;
  } catch (error) {
    if (!(error instanceof RuleViolation)) throw error;
    return recordRejection(request, submitterId, error, records);
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

async function receiveRemoteRollback(request, submitterId) {
  const user = globalThis.game?.users?.get?.(submitterId);
  const rollbackId = typeof request?.id === "string" ? request.id : "";
  if (!user?.active) return failure(rollbackId, rule("INACTIVE_SUBMITTER", "The request submitter is not an active Foundry user.", { userId: submitterId }));
  if (!user.isGM) return failure(rollbackId, rule("GM_ONLY", "Only a GM may roll back ship operations."));
  return enqueue(() => resolveRollback(request?.operationId, rollbackId, submitterId));
}

export async function initializeShipAuthority() {
  initializeShipSocket(receiveRemote, receiveRemoteRollback);
  if (!isActiveGM()) {
    initialized = true;
    return;
  }
  if (initialization) return initialization;
  initialization = (async () => {
    await initializeOperationLog();
    for (const entry of await readOperationEntries()) {
      if (entry?.id && entry.response) processed.set(entry.id, entry.response);
    }
    initialized = true;
  })();
  try {
    await initialization;
  } finally {
    initialization = null;
  }
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
  if (isActiveGM()) return enqueue(() => processRequest(canonical, globalThis.game.user.id));
  return requestRemoteShipOperation(canonical, globalThis.game?.user?.id);
}

function rollbackRequestId(operationId, suppliedId) {
  return suppliedId || `rollback:${operationId}`;
}

async function processRollback(operationId, rollbackId, userId) {
  if (!isActiveGM()) throw new Error("Only the active GM may roll back ship operations.");
  if (typeof rollbackId !== "string" || !rollbackId) {
    return failure("", rule("INVALID_REQUEST_ID", "A rollback requires a non-empty process-once ID."));
  }
  if (typeof operationId !== "string" || !operationId) {
    return failure(rollbackId, rule("ROLLBACK_OPERATION_REQUIRED", "A rollback requires an operation ID."));
  }
  const user = activeUser(userId);
  if (!user.isGM) return failure(rollbackId, rule("GM_ONLY", "Only a GM may roll back ship operations."));
  const cached = processed.get(rollbackId);
  if (cached) return cloneDocumentData(cached);
  const original = await findOperationEntry(operationId);
  if (!original?.before?.ships || original.kind !== "operation") {
    return failure(rollbackId, rule("ROLLBACK_NOT_FOUND", "The completed operation snapshot was not found.", { operationId }));
  }

  const records = await loadShipRecords(Object.keys(original.before.ships));
  validateLiveRevisions({
    expectedRevisions: Object.fromEntries([...records].map(([uuid, record]) => [uuid, record.state.revision])),
  }, records);
  const timestamp = now();
  const before = operationSnapshots(records);
  const shipStates = {};
  const tokenUpdates = {};
  for (const [uuid, record] of records) {
    const snapshot = original.before.ships[uuid];
    if (!snapshot?.state || !snapshot?.tokenTransform) {
      return failure(rollbackId, rule("ROLLBACK_INCOMPLETE", "The operation does not contain a complete ship snapshot.", { operationId, uuid }));
    }
    const restored = cloneDocumentData(snapshot.state);
    restored.revision = Number(record.state.revision) + 1;
    restored.history = Array.isArray(restored.history) ? restored.history : [];
    restored.history.push({ id: rollbackId, type: "operation.rollback", timestamp, submitterId: userId, operationId });
    shipStates[uuid] = restored;
    tokenUpdates[uuid] = cloneDocumentData(snapshot.tokenTransform);
  }
  const result = {
    shipStates,
    tokenUpdates,
    publicEvents: [{ type: "operation.rollback", operationId }],
    gmEvents: [{ type: "operation.rollback", operationId, rollbackId }],
    changedUuids: [...records.keys()],
  };
  const response = { ok: true, id: rollbackId, result: cloneDocumentData(result) };
  const entry = {
    id: rollbackId,
    kind: "rollback",
    timestamp,
    submitterId: userId,
    rolledBackOperationId: operationId,
    request: {
      id: rollbackId,
      type: "operation.rollback",
      sourceUuid: records.keys().next().value,
      targetUuids: [...records.keys()].slice(1),
      expectedRevisions: Object.fromEntries([...records].map(([uuid, record]) => [uuid, record.state.revision])),
      payload: { operationId },
    },
    before,
    after: operationSnapshots(records, result),
    publicEvents: cloneDocumentData(result.publicEvents),
    gmEvents: cloneDocumentData(result.gmEvents),
    response: cloneDocumentData(response),
  };
  try {
    await persistOperation(records, result, entry);
  } catch (error) {
    if (error instanceof RuleViolation) return failure(rollbackId, error);
    throw error;
  }
  processed.set(rollbackId, response);
  emitCommitted(result, cloneDocumentData(entry.request));
  return response;
}

async function resolveRollback(operationId, rollbackId, userId) {
  try {
    const response = await processRollback(operationId, rollbackId, userId);
    if (response?.id) processed.set(response.id, cloneDocumentData(response));
    return response;
  } catch (error) {
    if (error instanceof RuleViolation) {
      const response = failure(rollbackId, error);
      if (response.id) processed.set(response.id, cloneDocumentData(response));
      return response;
    }
    throw error;
  }
}

export async function rollbackShipOperation(operationIdOrOptions, options = {}) {
  const operationId = typeof operationIdOrOptions === "string" ? operationIdOrOptions : operationIdOrOptions?.operationId;
  const suppliedId = typeof operationIdOrOptions === "object" ? operationIdOrOptions?.id : options.id;
  const rollbackId = rollbackRequestId(operationId, suppliedId);
  if (typeof operationId !== "string" || !operationId) {
    return failure(rollbackId, rule("ROLLBACK_OPERATION_REQUIRED", "rollbackShipOperation requires an operation ID."));
  }
  if (!initialized) await initializeShipAuthority();
  if (!globalThis.game?.user?.isGM) return failure(rollbackId, rule("GM_ONLY", "Only a GM may roll back ship operations."));
  if (!isActiveGM()) {
    return requestRemoteShipRollback({ id: rollbackId, operationId }, globalThis.game.user.id);
  }
  return enqueue(() => resolveRollback(operationId, rollbackId, globalThis.game.user.id));
}

export async function getOperationLog() {
  if (!globalThis.game?.user?.isGM) return [];
  if (!initialized) await initializeShipAuthority();
  return readOperationEntries();
}
