import { MODULE_ID } from "./constants.js";

const CHANNEL = `module.${MODULE_ID}`;
const pending = new Map();
let requestHandler = null;
let rollbackHandler = null;
let listening = false;

function activeUsers() {
  const users = globalThis.game?.users;
  if (!users) return [];
  const values = typeof users.values === "function" ? [...users.values()] : Array.from(users);
  return values.filter((user) => user?.active);
}

export function getActiveGM() {
  const designated = globalThis.game?.users?.activeGM;
  if (designated?.active && designated.isGM) return designated;
  return activeUsers()
    .filter((user) => user.isGM)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

export function isActiveGM() {
  const gm = getActiveGM();
  return Boolean(gm && globalThis.game?.user?.id === gm.id);
}

function emit(envelope) {
  const socket = globalThis.game?.socket;
  if (!socket?.emit) throw new Error("Foundry socket transport is unavailable");
  socket.emit(CHANNEL, envelope);
}

function serializeUnexpected(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

function deserializeUnexpected(value) {
  const error = new Error(value?.message ?? "The active GM failed to process the ship operation.");
  error.name = value?.name ?? "Error";
  if (value?.stack) error.remoteStack = value.stack;
  return error;
}

async function receive(envelope) {
  if (!envelope || envelope.moduleId !== MODULE_ID) return;
  if (envelope.kind === "request" || envelope.kind === "rollback-request") {
    const handler = envelope.kind === "request" ? requestHandler : rollbackHandler;
    if (!isActiveGM() || !handler) return;
    try {
      const response = await handler(envelope.request, envelope.submitterId);
      emit({
        moduleId: MODULE_ID,
        kind: "result",
        requestId: envelope.request?.id,
        recipientId: envelope.submitterId,
        authorityId: globalThis.game.user.id,
        response,
      });
    } catch (error) {
      emit({
        moduleId: MODULE_ID,
        kind: "result",
        requestId: envelope.request?.id,
        recipientId: envelope.submitterId,
        authorityId: globalThis.game.user.id,
        unexpectedError: serializeUnexpected(error),
      });
    }
    return;
  }
  if (envelope.kind !== "result" || envelope.recipientId !== globalThis.game?.user?.id) return;
  if (envelope.authorityId !== getActiveGM()?.id) return;
  const waiter = pending.get(envelope.requestId);
  if (!waiter) return;
  pending.delete(envelope.requestId);
  clearTimeout(waiter.timer);
  if (envelope.unexpectedError) waiter.reject(deserializeUnexpected(envelope.unexpectedError));
  else waiter.resolve(envelope.response);
}

export function initializeShipSocket(handler, handleRollback = null) {
  if (handler) requestHandler = handler;
  if (handleRollback) rollbackHandler = handleRollback;
  if (listening) return;
  const socket = globalThis.game?.socket;
  if (!socket?.on) throw new Error("Foundry socket transport is unavailable");
  socket.on(CHANNEL, receive);
  listening = true;
}

function requestRemote(kind, request, submitterId) {
  const gm = getActiveGM();
  if (!gm) return Promise.reject(new Error("No active GM is available to authorize ship operations."));
  if (!submitterId) return Promise.reject(new Error("An active Foundry user is required to submit ship operations."));
  if (pending.has(request?.id)) return pending.get(request.id).promise;

  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => {
    pending.delete(request.id);
    reject(new Error("The active GM did not answer the ship operation request."));
  }, 30_000);
  pending.set(request.id, { promise, resolve, reject, timer });
  try {
    emit({ moduleId: MODULE_ID, kind, request, submitterId });
  } catch (error) {
    pending.delete(request.id);
    clearTimeout(timer);
    reject(error);
  }
  return promise;
}

export function requestRemoteShipOperation(request, submitterId = globalThis.game?.user?.id) {
  return requestRemote("request", request, submitterId);
}

export function requestRemoteShipRollback(request, submitterId = globalThis.game?.user?.id) {
  return requestRemote("rollback-request", request, submitterId);
}

export { CHANNEL };
