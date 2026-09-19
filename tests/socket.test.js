import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

const GM = { id: "gm1", isGM: true, active: true, name: "GM" };
const PLAYER = { id: "p1", isGM: false, active: true, name: "Player" };
const CHANNEL = "module.vira-shipcombat";
const previousGame = globalThis.game;

const users = new Map([[GM.id, GM], [PLAYER.id, PLAYER]]);
users.activeGM = GM;
const listeners = new Map();
const emitted = [];
const shell = {
  user: GM,
  users,
  socket: {
    on(channel, fn) { listeners.set(channel, fn); },
    emit(channel, envelope) { emitted.push({ channel, envelope }); },
  },
};

globalThis.game = shell;
/*
 * The transport is exercised through a private module instance: Bun shares one registry across test
 * files, and another file may already have registered the shared instance's listener elsewhere.
 */
const { initializeShipSocket, requestRemoteShipOperation } = await import(`${import.meta.dir}/../scripts/socket.js?socket-contract`);
const { submitShipOperation } = await import(`${import.meta.dir}/../scripts/state/action-queue.js?socket-contract`);

let currentHandler = null;
initializeShipSocket((request, submitterId) => currentHandler(request, submitterId));
const receive = listeners.get(CHANNEL);
if (!receive) throw new Error("the ship socket listener was not registered");

/** The transport hands the listener the envelope plus the sender Foundry authenticated. */
function deliver(envelope, senderUserId) {
  return receive(envelope, senderUserId);
}

beforeEach(() => {
  emitted.length = 0;
  currentHandler = null;
  // The authority queue may install itself as the handler, so the transport wrapper is restored.
  initializeShipSocket((request, submitterId) => currentHandler(request, submitterId));
});

afterAll(() => {
  if (previousGame === undefined) delete globalThis.game;
  else globalThis.game = previousGame;
});

describe("ship operation transport identity", () => {
  test("a request whose envelope claims another user is ignored", async () => {
    const handler = spyOn({ handle: async () => ({ ok: true }) }, "handle").mockImplementation(async () => ({ ok: true }));
    currentHandler = handler;
    await deliver({ moduleId: "vira-shipcombat", kind: "request", request: { id: "req-1" }, submitterId: GM.id }, PLAYER.id);
    expect(handler).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  test("a request with no authenticated sender is ignored", async () => {
    const handler = spyOn({ handle: async () => ({ ok: true }) }, "handle").mockImplementation(async () => ({ ok: true }));
    currentHandler = handler;
    await deliver({ moduleId: "vira-shipcombat", kind: "request", request: { id: "req-2" }, submitterId: GM.id }, undefined);
    expect(handler).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  test("the authenticated sender is the identity handed to the authority and back to the caller", async () => {
    const submitters = [];
    currentHandler = async (request, submitterId) => {
      submitters.push(submitterId);
      return { ok: true, id: request.id };
    };
    await deliver({ moduleId: "vira-shipcombat", kind: "request", request: { id: "req-3" }, submitterId: PLAYER.id }, PLAYER.id);
    expect(submitters).toEqual([PLAYER.id]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].envelope.recipientId).toBe(PLAYER.id);
    expect(emitted[0].envelope.response).toEqual({ ok: true, id: "req-3" });
  });
});

describe("ship operation result delivery", () => {
  beforeEach(() => {
    currentHandler = async () => ({ ok: true });
  });

  test("a result from a different authority than the current GM still resolves the request", async () => {
    const promise = requestRemoteShipOperation({ id: "req-4" }, PLAYER.id);
    await deliver({
      moduleId: "vira-shipcombat",
      kind: "result",
      requestId: "req-4",
      recipientId: GM.id,
      authorityId: "gm-previous",
      response: { ok: true, id: "req-4", result: { changedUuids: [] } },
    }, GM.id);
    await expect(promise).resolves.toEqual({ ok: true, id: "req-4", result: { changedUuids: [] } });
  });

  test("a result addressed to another user is ignored", async () => {
    const promise = requestRemoteShipOperation({ id: "req-5" }, PLAYER.id);
    let settled = "pending";
    promise.then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
    await deliver({
      moduleId: "vira-shipcombat",
      kind: "result",
      requestId: "req-5",
      recipientId: PLAYER.id,
      authorityId: GM.id,
      response: { ok: true, id: "req-5" },
    }, PLAYER.id);
    expect(settled).toBe("pending");
    await deliver({
      moduleId: "vira-shipcombat",
      kind: "result",
      requestId: "req-5",
      recipientId: GM.id,
      authorityId: GM.id,
      response: { ok: true, id: "req-5" },
    }, GM.id);
    await expect(promise).resolves.toEqual({ ok: true, id: "req-5" });
  });
});

describe("ship operation deadline", () => {
  beforeEach(() => {
    currentHandler = async () => ({ ok: true });
  });

  /** Deadlines are captured instead of scheduled so both expiry stages can be driven deterministically. */
  function fakeTimers() {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers = [];
    const cleared = [];
    globalThis.setTimeout = (fn, delay) => {
      const handle = { fn, delay };
      timers.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => cleared.push(handle);
    return {
      timers,
      cleared,
      restore() {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
      },
    };
  }

  test("the first expiry only re-arms, so a late result still resolves the request", async () => {
    const clock = fakeTimers();
    try {
      const promise = requestRemoteShipOperation({ id: "req-6" }, PLAYER.id);
      let settled = "pending";
      promise.then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
      expect(clock.timers.map((timer) => timer.delay)).toEqual([30_000]);

      clock.timers[0].fn();
      await Promise.resolve();
      expect(settled).toBe("pending");
      expect(clock.timers.map((timer) => timer.delay)).toEqual([30_000, 120_000]);

      await deliver({
        moduleId: "vira-shipcombat",
        kind: "result",
        requestId: "req-6",
        recipientId: GM.id,
        authorityId: GM.id,
        response: { ok: true, id: "req-6" },
      }, GM.id);
      await expect(promise).resolves.toEqual({ ok: true, id: "req-6" });
      expect(clock.cleared).toContain(clock.timers[1]);
    } finally {
      clock.restore();
    }
  });

  test("the second expiry rejects the request and forgets it", async () => {
    const clock = fakeTimers();
    try {
      const promise = requestRemoteShipOperation({ id: "req-7" }, PLAYER.id);
      clock.timers[0].fn();
      clock.timers[1].fn();
      await expect(promise).rejects.toThrow("did not answer");
      expect(clock.timers.map((timer) => timer.delay)).toEqual([30_000, 120_000]);

      // The forgotten request can be retried under the same id instead of replaying a dead entry.
      const retry = requestRemoteShipOperation({ id: "req-7" }, PLAYER.id);
      expect(clock.timers).toHaveLength(3);
      await deliver({
        moduleId: "vira-shipcombat",
        kind: "result",
        requestId: "req-7",
        recipientId: GM.id,
        authorityId: GM.id,
        response: { ok: true, id: "req-7", retried: true },
      }, GM.id);
      await expect(retry).resolves.toEqual({ ok: true, id: "req-7", retried: true });
    } finally {
      clock.restore();
    }
  });
});

describe("authority queue process-once cache", () => {
  /*
   * No TokenDocument resolves in this harness, so every operation is rejected after the authority has
   * consulted its cache. The rejected response echoes the requested UUID, which makes a replay
   * distinguishable from a fresh execution.
   */
  function submit(id, uuid) {
    return submitShipOperation({ id, type: "probe", sourceUuid: uuid, targetUuids: [], expectedRevisions: {}, payload: {} });
  }

  test("retained ids replay while the oldest entries are evicted", async () => {
    const first = await submit("cache-probe", "Actor.missing-a");
    expect(first.error.code).toBe("TOKEN_NOT_FOUND");
    expect(first.error.details.uuid).toBe("Actor.missing-a");

    const replay = await submit("cache-probe", "Actor.missing-b");
    expect(replay.error.details.uuid).toBe("Actor.missing-a");

    for (let index = 0; index < 64; index++) {
      const response = await submit(`cache-fill-${index}`, `Actor.fill-${index}`);
      expect(response.error.details.uuid).toBe(`Actor.fill-${index}`);
    }

    const evicted = await submit("cache-probe", "Actor.missing-c");
    expect(evicted.error.details.uuid).toBe("Actor.missing-c");

    const retained = await submit("cache-fill-63", "Actor.replayed");
    expect(retained.error.details.uuid).toBe("Actor.fill-63");
  });
});
