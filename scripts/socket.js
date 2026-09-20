import { MODULE_ID } from "./constants.js";

const CHANNEL = `module.${MODULE_ID}`;
/** How long a caller waits for the active GM's answer before the deadline becomes forgiving. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A slow GM still commits the operation it was sent, so the caller waits out a bounded grace period. */
const REQUEST_TIMEOUT_GRACE_MS = 120_000;
/** How often a pending request is re-sent while the same authority is still the active GM. */
const REQUEST_RETRY_MS = 5_000;
const pending = new Map();
let requestHandler = null;
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

async function receive(envelope, senderUserId) {
  if (!envelope || envelope.moduleId !== MODULE_ID) return;
  if (envelope.kind === "request") {
    if (!isActiveGM() || !requestHandler) return;
    // Foundry hands the listener the authenticated sender; the envelope is client-supplied JSON.
    if (String(envelope.submitterId) !== String(senderUserId)) {
      globalThis.console?.warn?.("Vira Ship Combat ignored a ship operation request whose envelope claimed another user.");
      return;
    }
    try {
      const response = await requestHandler(envelope.request, senderUserId);
      emit({
        moduleId: MODULE_ID,
        kind: "result",
        requestId: envelope.request?.id,
        recipientId: senderUserId,
        authorityId: globalThis.game.user.id,
        response,
      });
    } catch (error) {
      emit({
        moduleId: MODULE_ID,
        kind: "result",
        requestId: envelope.request?.id,
        recipientId: senderUserId,
        authorityId: globalThis.game.user.id,
        unexpectedError: serializeUnexpected(error),
      });
    }
    return;
  }
  if (envelope.kind !== "result" || envelope.recipientId !== globalThis.game?.user?.id) return;
  const waiter = pending.get(envelope.requestId);
  if (!waiter) return;
  forget(waiter);
  if (envelope.unexpectedError) waiter.reject(deserializeUnexpected(envelope.unexpectedError));
  else waiter.resolve(envelope.response);
}

export function initializeShipSocket(handler) {
  if (handler) requestHandler = handler;
  if (listening) return;
  const socket = globalThis.game?.socket;
  if (!socket?.on) throw new Error("Foundry socket transport is unavailable");
  socket.on(CHANNEL, receive);
  listening = true;
}

/**
 * Arm the deadline for a pending request. The first expiry only buys the active GM a bounded grace
 * period: a slow GM keeps executing and persisting, so forgetting the request there would desync the
 * caller with the world. The caller is rejected only once the grace period also elapses. An entry
 * never outlives its timer.
 */
function armDeadline(entry, delay) {
  return setTimeout(() => {
    if (pending.get(entry.requestId) !== entry) return;
    if (entry.graced) {
      forget(entry);
      entry.reject(new Error("The active GM did not answer the ship operation request."));
      return;
    }
    entry.graced = true;
    globalThis.console?.warn?.(`Vira Ship Combat is still waiting for the active GM to answer ship operation "${entry.requestId}".`);
    entry.timer = armDeadline(entry, REQUEST_TIMEOUT_GRACE_MS);
  }, delay);
}

/**
 * Re-send a pending request on a short cadence while the same authority is still the active GM. A
 * reloaded GM client answers from its retained result cache by request id, so a replay commits
 * nothing twice; a packet lost while that GM was away is simply delivered again. When the authority
 * changes, replaying would lose the cache that makes the retry idempotent, so the request fails fast
 * instead of hanging out the grace period.
 */
function armRetransmit(entry) {
  return setTimeout(() => {
    if (pending.get(entry.requestId) !== entry) return;
    const authority = getActiveGM();
    if (!authority || authority.id !== entry.authorityId) {
      forget(entry);
      entry.reject(new Error(
        "The active GM changed while this ship operation was pending. Its outcome is unknown; check the ship before retrying.",
      ));
      return;
    }
    try {
      emit(entry.envelope);
    } catch {
      // The socket is down; the next tick tries again.
    }
    entry.retryTimer = armRetransmit(entry);
  }, REQUEST_RETRY_MS);
}

/** Drop every timer a pending entry owns and forget it. */
function forget(entry) {
  pending.delete(entry.requestId);
  clearTimeout(entry.timer);
  clearTimeout(entry.retryTimer);
}

function requestRemote(request, submitterId) {
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
  const envelope = { moduleId: MODULE_ID, kind: "request", request, submitterId };
  const entry = {
    requestId: request.id,
    envelope,
    authorityId: gm.id,
    promise,
    resolve,
    reject,
    timer: null,
    retryTimer: null,
    graced: false,
  };
  pending.set(request.id, entry);
  entry.timer = armDeadline(entry, REQUEST_TIMEOUT_MS);
  entry.retryTimer = armRetransmit(entry);
  try {
    emit(envelope);
  } catch (error) {
    forget(entry);
    reject(error);
  }
  return promise;
}

export function requestRemoteShipOperation(request, submitterId = globalThis.game?.user?.id) {
  return requestRemote(request, submitterId);
}

export { CHANNEL };
