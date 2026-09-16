import { SHIP_TYPE } from "../constants.js";
import { sanitizeTrack, TRACK_STATUS } from "../rules/sensors.js";

const hookIds = new Map();
const tokenRenderState = new Map();
let markerListener = null;
let markerSignature = "";

function isShipActor(actor) {
  return actor?.type === SHIP_TYPE && actor?.system?.shipCombat?.state;
}

function isShipToken(token) {
  return isShipActor(token?.actor ?? token?.document?.actor);
}

function currentTokens() {
  return Array.from(globalThis.canvas?.tokens?.placeables ?? []);
}

function rememberRenderState(token) {
  let state = tokenRenderState.get(token);
  if (!state) {
    state = {
      renderable: token.renderable,
      eventMode: token.eventMode,
      interactiveChildren: token.interactiveChildren,
    };
    tokenRenderState.set(token, state);
  }
  return state;
}

function restoreToken(token) {
  const state = tokenRenderState.get(token);
  if (!state || token?.destroyed) {
    tokenRenderState.delete(token);
    return;
  }
  token.renderable = state.renderable;
  token.eventMode = state.eventMode;
  token.interactiveChildren = state.interactiveChildren;
  tokenRenderState.delete(token);
}

function setLocallyVisible(token, visible) {
  const state = rememberRenderState(token);
  token.renderable = visible ? state.renderable : false;
  token.eventMode = visible ? state.eventMode : "none";
  token.interactiveChildren = visible ? state.interactiveChildren : false;
}

function observerActors() {
  const actors = new Map();
  for (const token of currentTokens()) {
    const actor = token?.actor;
    if (isShipActor(actor) && actor.isOwner) actors.set(actor.uuid ?? token.document?.uuid, actor);
  }
  for (const actor of globalThis.game?.actors ?? []) {
    if (isShipActor(actor) && actor.isOwner) actors.set(actor.uuid, actor);
  }
  return actors.values();
}

function targetKeys(token) {
  // Tracks are keyed by canonical TokenDocument UUID. Actor UUIDs are deliberately
  // not aliases: one linked Actor may have several Tokens at different locations.
  const uuid = token?.document?.uuid;
  return uuid == null ? new Set() : new Set([String(uuid)]);
}

function collectTracks() {
  const tracks = new Map();
  const rank = { [TRACK_STATUS.UNDETECTED]: 0, [TRACK_STATUS.CONTACT]: 1, [TRACK_STATUS.TARGETED]: 2 };
  for (const actor of observerActors()) {
    const observerState = actor.system.shipCombat.state;
    for (const [targetUuid, track] of Object.entries(observerState?.tracks ?? {})) {
      const safe = sanitizeTrack({ observerState, track, targetUuid });
      const previous = tracks.get(safe.targetUuid);
      if (!previous || (rank[safe.state] ?? 0) > (rank[previous.state] ?? 0)) tracks.set(safe.targetUuid, safe);
    }
  }
  return tracks;
}

function trackForToken(token, tracks) {
  let best = null;
  const rank = { [TRACK_STATUS.UNDETECTED]: 0, [TRACK_STATUS.CONTACT]: 1, [TRACK_STATUS.TARGETED]: 2 };
  for (const key of targetKeys(token)) {
    const candidate = tracks.get(key);
    if (candidate && (!best || (rank[candidate.state] ?? 0) > (rank[best.state] ?? 0))) best = candidate;
  }
  return best;
}

function markerFromTrack(track) {
  const lastKnown = track?.lastKnown;
  const position = lastKnown?.position;
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null;
  const sceneId = lastKnown.sceneId == null ? null : String(lastKnown.sceneId);
  if (sceneId && sceneId !== String(globalThis.canvas?.scene?.id ?? "")) return null;
  return {
    targetUuid: track.targetUuid,
    state: track.state,
    position: { x: Number(position.x), y: Number(position.y) },
    facing: Number.isFinite(Number(lastKnown.facing)) ? Number(lastKnown.facing) : null,
    stale: lastKnown.stale !== false,
    label: String(track.remembered?.label ?? track.remembered?.identity?.label ?? "Last known contact"),
  };
}

function publishMarkers(markers) {
  markers.sort((left, right) => left.targetUuid.localeCompare(right.targetUuid));
  const signature = JSON.stringify(markers);
  if (signature === markerSignature) return;
  markerSignature = signature;
  markerListener?.(markers);
}

function refreshShipVisibility() {
  if (!globalThis.canvas?.ready) return;
  const tokens = currentTokens();
  const user = globalThis.game?.user;
  if (!user || user.isGM) {
    for (const token of tokens) restoreToken(token);
    publishMarkers([]);
    return;
  }

  const tracks = collectTracks();
  const suppressedMarkerTargets = new Set();
  for (const token of tokens) {
    if (!isShipToken(token)) {
      restoreToken(token);
      continue;
    }
    const keys = targetKeys(token);
    if (token.document?.hidden) {
      for (const key of keys) suppressedMarkerTargets.add(key);
      setLocallyVisible(token, false);
      continue;
    }
    if (token.actor?.isOwner) {
      for (const key of keys) suppressedMarkerTargets.add(key);
      setLocallyVisible(token, true);
      continue;
    }
    const track = trackForToken(token, tracks);
    setLocallyVisible(token, track?.state === TRACK_STATUS.CONTACT || track?.state === TRACK_STATUS.TARGETED);
  }

  const markers = [];
  for (const track of tracks.values()) {
    if (track.state !== TRACK_STATUS.UNDETECTED) continue;
    if (suppressedMarkerTargets.has(track.targetUuid)) continue;
    const marker = markerFromTrack(track);
    if (marker) markers.push(marker);
  }
  publishMarkers(markers);
}

function resetCanvasVisibility() {
  for (const token of Array.from(tokenRenderState.keys())) restoreToken(token);
  publishMarkers([]);
}
function handleDeletedToken(document) {
  const token = document?.object;
  if (token) restoreToken(token);
  refreshShipVisibility();
}


function registerHook(name, callback) {
  if (!globalThis.Hooks || hookIds.has(name)) return;
  hookIds.set(name, Hooks.on(name, callback));
}

/**
 * Install client-only ship visibility handling. The callback receives only projections
 * returned by sanitizeTrack; it never receives a target Token or Actor document.
 */
export function registerShipVisibility({ onMarkersChanged } = {}) {
  if (typeof onMarkersChanged === "function") markerListener = onMarkersChanged;
  registerHook("canvasReady", refreshShipVisibility);
  registerHook("canvasTearDown", resetCanvasVisibility);
  registerHook("createToken", refreshShipVisibility);
  registerHook("drawToken", refreshShipVisibility);
  registerHook("deleteToken", handleDeletedToken);
  registerHook("updateToken", refreshShipVisibility);
  registerHook("updateActor", (actor) => {
    if (isShipActor(actor)) refreshShipVisibility();
  });
  registerHook("updateUser", (user) => {
    if (user?.id === globalThis.game?.user?.id) refreshShipVisibility();
  });
  // Actor and Token document hooks are the authoritative state-change signal.
  refreshShipVisibility();
}

/** Restore local Token rendering and remove every hook installed by this module. */
export function cleanupShipVisibility() {
  resetCanvasVisibility();
  if (globalThis.Hooks) {
    for (const [name, id] of hookIds) Hooks.off(name, id);
  }
  hookIds.clear();
  markerListener = null;
  markerSignature = "";
}
