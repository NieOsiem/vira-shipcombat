import { SHIP_TYPE } from "../constants.js";
import { registerShipVisibility } from "./visibility.js";

const MODULE_ID = "vira-shipcombat";
const previews = new Map();
const hookIds = new Map();
const shieldGraphics = new Map();
let shieldTicker = null;
let overlayContainer = null;
let overlayGraphics = null;
let lastKnownMarkers = [];

const COLORS = Object.freeze({
  powered: 0x45a3ff,
  coast: 0x78e8ff,
  facing: 0xffffff,
  arc: 0x84d681,
  collision: 0xff6b55,
  overspeed: 0xffbd45,
  wall: 0xff5c72,
  marker: 0xffd166,
  shield: 0x3ee8d0,
  shieldLow: 0xffbd45,
  shieldDown: 0xff5267,
});

function finitePoint(value) {
  const point = value?.position ?? value?.point ?? value;
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
  return { x: Number(point.x), y: Number(point.y) };
}

function pointsFrom(value) {
  const entries = Array.isArray(value) ? value : value?.path ?? value?.points ?? [];
  return Array.isArray(entries) ? entries.map(finitePoint).filter(Boolean) : [];
}

function trajectoryPaths(preview) {
  const explicitPowered = preview?.poweredPath ?? preview?.burnPath;
  const explicitCoast = preview?.coastPath ?? preview?.coast;
  if (explicitPowered || explicitCoast) {
    return { powered: pointsFrom(explicitPowered), coast: pointsFrom(explicitCoast) };
  }
  const path = Array.isArray(preview?.path) ? preview.path : preview?.path?.path;
  if (!Array.isArray(path)) return { powered: [], coast: [] };
  if (path[0]?.phase === "deliberateCoast") return { powered: [], coast: pointsFrom(path) };
  const coastIndex = path.findIndex((entry) => entry?.phase === "coast");
  if (coastIndex < 0) return { powered: pointsFrom(path), coast: [] };
  return {
    powered: pointsFrom(path.slice(0, coastIndex)),
    coast: pointsFrom(path.slice(Math.max(0, coastIndex - 1))),
  };
}

function degreesToRadians(degrees) {
  return Number(degrees) * (Math.PI / 180);
}

function headingPoint(origin, heading, distance) {
  const radians = degreesToRadians(heading);
  return { x: origin.x + (Math.sin(radians) * distance), y: origin.y - (Math.cos(radians) * distance) };
}

function gridSize() {
  return Number(globalThis.canvas?.dimensions?.size ?? globalThis.canvas?.grid?.size ?? 100) || 100;
}

function useModernGraphics(graphics) {
  return typeof graphics?.stroke === "function";
}

function strokePath(graphics, points, { color, width = 3, alpha = 1, dashed = false }) {
  if (points.length < 2) return;
  if (!useModernGraphics(graphics)) graphics.lineStyle(width, color, alpha);
  if (!dashed) {
    graphics.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) graphics.lineTo(points[index].x, points[index].y);
  } else {
    const dash = Math.max(8, gridSize() * 0.12);
    const gap = dash * 0.65;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length <= 0) continue;
      const dx = (end.x - start.x) / length;
      const dy = (end.y - start.y) / length;
      for (let cursor = 0; cursor < length; cursor += dash + gap) {
        const segmentEnd = Math.min(length, cursor + dash);
        graphics.moveTo(start.x + (dx * cursor), start.y + (dy * cursor));
        graphics.lineTo(start.x + (dx * segmentEnd), start.y + (dy * segmentEnd));
      }
    }
  }
  if (useModernGraphics(graphics)) graphics.stroke({ color, width, alpha, cap: "round", join: "round" });
}

function drawCircle(graphics, point, radius, { color, alpha = 1, width = 2, fillAlpha = 0 }) {
  if (useModernGraphics(graphics)) {
    graphics.circle(point.x, point.y, radius);
    if (fillAlpha > 0) graphics.fill({ color, alpha: fillAlpha });
    graphics.stroke({ color, alpha, width });
    return;
  }
  graphics.lineStyle(width, color, alpha);
  if (fillAlpha > 0) graphics.beginFill(color, fillAlpha);
  graphics.drawCircle(point.x, point.y, radius);
  if (fillAlpha > 0) graphics.endFill();
}
function tokenShieldCenter(token) {
  return {
    x: Number(token?.w ?? 0) / 2,
    y: Number(token?.h ?? token?.w ?? 0) / 2,
  };
}

function tokenShieldRadius(token) {
  const document = token?.document ?? token;
  const width = Number(token?.w ?? (Number(document?.width ?? 1) * gridSize()));
  const height = Number(token?.h ?? (Number(document?.height ?? document?.width ?? 1) * gridSize()));
  return (Math.max(width, height) / 2) + Math.max(8, gridSize() * 0.08);
}

function shieldSectorCapacity(shield, sector) {
  const configured = shield?.sectorCap;
  if (typeof configured === "object") return Number(configured?.[sector] ?? 0);
  return Number(configured ?? shield?.totalBudget ?? 0);
}

function shieldColor(charge, capacity, collapsed) {
  if (collapsed) return COLORS.shieldDown;
  const ratio = capacity > 0 ? charge / capacity : 0;
  if (ratio <= 0.25) return COLORS.shieldLow;
  return COLORS.shield;
}

function strokeArc(graphics, center, radius, start, end, { color, width, alpha }) {
  const startPoint = {
    x: center.x + (Math.cos(start) * radius),
    y: center.y + (Math.sin(start) * radius),
  };
  graphics.moveTo(startPoint.x, startPoint.y);
  if (useModernGraphics(graphics)) {
    graphics.arc(center.x, center.y, radius, start, end);
    graphics.stroke({ color, width, alpha, cap: "round" });
    return;
  }
  graphics.lineStyle(width, color, alpha);
  graphics.arc(center.x, center.y, radius, start, end);
}

function hasVisibleShields(token) {
  const actor = token?.actor ?? token?.document?.actor;
  const document = token?.document ?? token;
  if (actor?.type !== SHIP_TYPE || document?.hidden || token?.visible === false) return false;
  if (!globalThis.game?.user?.isGM && !actor?.isOwner) return false;
  return Boolean(actor?.system?.shipCombat?.config?.components?.shield && actor?.system?.shipCombat?.state?.shields);
}

function drawTokenShields(graphics, token) {
  const actor = token.actor ?? token.document?.actor;
  const shield = actor.system.shipCombat.config.components.shield;
  const state = actor.system.shipCombat.state.shields;
  const center = tokenShieldCenter(token);
  const radius = tokenShieldRadius(token);
  const width = Math.max(4, gridSize() * 0.055);
  if (shield.topology === "bubble") {
    const sector = shield.sectors?.[0] ?? "bubble";
    const charge = Number(state.charge?.[sector] ?? 0);
    const capacity = shieldSectorCapacity(shield, sector);
    const collapsed = Number(state.collapse?.[sector] ?? 0) > 0;
    drawCircle(graphics, center, radius, {
      color: shieldColor(charge, capacity, collapsed),
      width,
      alpha: 0.4 + (0.55 * Math.min(1, capacity > 0 ? charge / capacity : 0)),
      fillAlpha: 0,
    });
    return;
  }
  const centers = { fore: 0, starboard: 90, aft: 180, port: 270 };
  for (const sector of ["fore", "starboard", "aft", "port"]) {
    const charge = Number(state.charge?.[sector] ?? 0);
    const capacity = shieldSectorCapacity(shield, sector);
    const collapsed = Number(state.collapse?.[sector] ?? 0) > 0;
    const angle = degreesToRadians(centers[sector] - 90);
    const halfArc = degreesToRadians(37);
    strokeArc(graphics, center, radius, angle - halfArc, angle + halfArc, {
      color: shieldColor(charge, capacity, collapsed),
      width,
      alpha: 0.35 + (0.6 * Math.min(1, capacity > 0 ? charge / capacity : 0)),
    });
  }
}

function removeTokenShield(tokenId) {
  const key = String(tokenId ?? "");
  const graphics = shieldGraphics.get(key);
  if (!graphics) return;
  shieldGraphics.delete(key);
  graphics.parent?.removeChild(graphics);
  if (!graphics.destroyed) graphics.destroy();
}

function renderTokenShield(token) {
  const key = String(token?.id ?? token?.document?.id ?? "");
  if (!key) return;
  if (!hasVisibleShields(token)) {
    removeTokenShield(key);
    return;
  }
  let graphics = shieldGraphics.get(key);
  if (!graphics || graphics.destroyed || graphics.parent !== token) {
    removeTokenShield(key);
    graphics = new PIXI.Graphics();
    graphics.name = `${MODULE_ID}.shield`;
    graphics.eventMode = "none";
    graphics.zIndex = 1_000;
    token.addChild(graphics);
    shieldGraphics.set(key, graphics);
  }
  const center = tokenShieldCenter(token);
  graphics.clear();
  graphics.position.set(center.x, center.y);
  graphics.pivot.set(center.x, center.y);
  drawTokenShields(graphics, token);
}

function refreshTokenShields() {
  const visibleIds = new Set();
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    const key = String(token?.id ?? token?.document?.id ?? "");
    if (key) visibleIds.add(key);
    renderTokenShield(token);
  }
  for (const key of shieldGraphics.keys()) {
    if (!visibleIds.has(key)) removeTokenShield(key);
  }
  syncTokenShieldTransforms();
}

function syncTokenShieldTransforms() {
  for (const [key, graphics] of shieldGraphics) {
    const token = globalThis.canvas?.tokens?.get?.(key);
    if (!token || graphics.destroyed || graphics.parent !== token) {
      removeTokenShield(key);
      continue;
    }
    graphics.angle = Number(token.mesh?.angle ?? token.document?.rotation ?? 0);
  }
}

function installShieldTicker() {
  const ticker = globalThis.canvas?.app?.ticker;
  if (!ticker || shieldTicker === ticker) return;
  if (shieldTicker) shieldTicker.remove(syncTokenShieldTransforms);
  shieldTicker = ticker;
  shieldTicker.add(syncTokenShieldTransforms);
}

function destroyTokenShields() {
  if (shieldTicker) shieldTicker.remove(syncTokenShieldTransforms);
  shieldTicker = null;
  for (const key of Array.from(shieldGraphics.keys())) removeTokenShield(key);
}


function drawFacing(graphics, origin, facing, length = gridSize() * 0.55, color = COLORS.facing) {
  if (!origin || !Number.isFinite(Number(facing))) return;
  const tip = headingPoint(origin, Number(facing), length);
  const left = headingPoint(tip, Number(facing) + 150, Math.min(18, length * 0.32));
  const right = headingPoint(tip, Number(facing) - 150, Math.min(18, length * 0.32));
  strokePath(graphics, [origin, tip], { color, width: 3, alpha: 0.95 });
  strokePath(graphics, [left, tip, right], { color, width: 3, alpha: 0.95 });
}

function drawArc(graphics, arc, fallbackOrigin, fallbackFacing) {
  const origin = finitePoint(arc?.origin) ?? fallbackOrigin;
  const facing = Number(arc?.facing ?? fallbackFacing);
  const width = Number(arc?.arcWidth ?? arc?.arcWidthDegrees ?? arc?.width ?? 0);
  const center = Number(arc?.arcCenter ?? arc?.arcCenterDegrees ?? arc?.center ?? 0);
  const radius = Number(arc?.range ?? arc?.maxRange ?? arc?.radius ?? gridSize() * 3);
  if (!origin || !Number.isFinite(facing) || !Number.isFinite(width) || width <= 0 || !Number.isFinite(radius) || radius <= 0) return;
  const boundedWidth = Math.min(360, width);
  const startHeading = facing + center - (boundedWidth / 2);
  const endHeading = facing + center + (boundedWidth / 2);
  const start = headingPoint(origin, startHeading, radius);
  const end = headingPoint(origin, endHeading, radius);

  if (!useModernGraphics(graphics)) {
    graphics.lineStyle(2, Number(arc.color ?? COLORS.arc), 0.7);
    graphics.beginFill(Number(arc.color ?? COLORS.arc), 0.07);
    graphics.moveTo(origin.x, origin.y);
    graphics.lineTo(start.x, start.y);
    graphics.arc(origin.x, origin.y, radius, degreesToRadians(startHeading - 90), degreesToRadians(endHeading - 90));
    graphics.lineTo(origin.x, origin.y);
    graphics.endFill();
    return;
  }
  graphics.moveTo(origin.x, origin.y);
  graphics.lineTo(start.x, start.y);
  graphics.arc(origin.x, origin.y, radius, degreesToRadians(startHeading - 90), degreesToRadians(endHeading - 90));
  graphics.lineTo(origin.x, origin.y);
  graphics.fill({ color: Number(arc.color ?? COLORS.arc), alpha: 0.07 });
  graphics.stroke({ color: Number(arc.color ?? COLORS.arc), width: 2, alpha: 0.7 });
}

function drawCollision(graphics, collision) {
  const point = finitePoint(collision);
  if (!point) return;
  const radius = Math.max(6, gridSize() * 0.09);
  drawCircle(graphics, point, radius, { color: COLORS.collision, width: 3, fillAlpha: 0.2 });
  strokePath(graphics, [
    { x: point.x - radius, y: point.y - radius },
    { x: point.x + radius, y: point.y + radius },
  ], { color: COLORS.collision, width: 2 });
  strokePath(graphics, [
    { x: point.x + radius, y: point.y - radius },
    { x: point.x - radius, y: point.y + radius },
  ], { color: COLORS.collision, width: 2 });
}

function makeText(text, color) {
  const style = {
    fill: color,
    fontFamily: "sans-serif",
    fontSize: 14,
    fontWeight: "bold",
    stroke: { color: 0x000000, width: 4 },
    dropShadow: { color: 0x000000, alpha: 0.75, blur: 2, distance: 1 },
  };
  try {
    return new PIXI.Text({ text, style });
  } catch (_error) {
    return new PIXI.Text(text, style);
  }
}

function addLabel(text, point, color, offset = { x: 10, y: -10 }) {
  if (!overlayContainer || !point || !text) return;
  const label = makeText(String(text), color);
  label.position.set(point.x + offset.x, point.y + offset.y);
  label.eventMode = "none";
  overlayContainer.addChild(label);
}

function warningEntries(preview, anchor, collisions) {
  const warnings = [];
  const append = (entry, defaultKind = "warning") => {
    if (!entry) return;
    if (typeof entry === "string") {
      warnings.push({ kind: defaultKind, message: entry, position: anchor });
      return;
    }
    const code = String(entry.code ?? entry.kind ?? entry.type ?? defaultKind);
    let message = entry.message ?? entry.label ?? code.replace(/^MOVEMENT_/, "").replaceAll("_", " ");
    if (code.includes("OVERSPEED") && Number.isFinite(Number(entry.overspeed))) {
      message = `OVERSPEED +${Number(entry.overspeed)}`;
      if (Number.isFinite(Number(entry.hullDamage))) message += ` (${Number(entry.hullDamage)} hull)`;
    }
    warnings.push({ kind: code, message, position: finitePoint(entry) ?? anchor });
  };
  const supplied = Array.isArray(preview?.warnings) ? preview.warnings : preview?.warnings ? [preview.warnings] : [];
  for (const warning of supplied) append(warning);
  append(preview?.overspeedWarning ?? (preview?.overspeed ? "OVERSPEED" : null), "overspeed");
  append(preview?.wallWarning, "wall");
  for (const collision of collisions) {
    if (collision?.type !== "wall") continue;
    append({ kind: "wall", message: "WALL COLLISION", point: finitePoint(collision) }, "wall");
  }
  return warnings;
}

function drawPreview(graphics, preview) {
  for (const projection of preview?.targetedCoasts ?? []) {
    const points = pointsFrom(projection.path ?? []);
    strokePath(graphics, points, { color: COLORS.marker, width: 2, alpha: 0.45, dashed: true });
    if (points.length) addLabel(`${projection.label ?? "Target"} COAST`, points.at(-1), COLORS.marker, { x: 8, y: 8 });
  }
  const { powered, coast } = trajectoryPaths(preview);
  strokePath(graphics, powered, { color: COLORS.powered, width: 4, alpha: 0.95 });
  strokePath(graphics, coast, { color: COLORS.coast, width: 3, alpha: 0.9, dashed: true });

  const finalPoint = finitePoint(preview?.position)
    ?? finitePoint(preview?.coastEnd)
    ?? coast.at(-1)
    ?? finitePoint(preview?.poweredEnd)
    ?? powered.at(-1)
    ?? finitePoint(preview?.origin);
  const facing = preview?.facing ?? preview?.finalFacing ?? preview?.coastEnd?.facing ?? preview?.poweredEnd?.facing ?? preview?.heading;
  drawFacing(graphics, finalPoint, facing, Number(preview?.facingLength) || undefined);

  const arcs = Array.isArray(preview?.firingArcs) ? preview.firingArcs : preview?.firingArc ? [preview.firingArc] : [];
  for (const arc of arcs) drawArc(graphics, arc, finalPoint, facing);

  const suppliedCollisions = preview?.collisions ?? preview?.collisionPoints ?? preview?.sweptCollisions ?? [];
  const collisions = Array.isArray(suppliedCollisions) ? suppliedCollisions : [suppliedCollisions];
  for (const collision of collisions) drawCollision(graphics, collision);

  warningEntries(preview, finalPoint, collisions).forEach((warning, index) => {
    const kind = String(warning.kind).toLowerCase();
    const color = kind.includes("wall") ? COLORS.wall : COLORS.overspeed;
    addLabel(warning.message, warning.position, color, { x: 10, y: -10 + (index * 18) });
  });
}

function drawLastKnown(graphics, marker) {
  const point = finitePoint(marker?.position);
  if (!point) return;
  const radius = Math.max(9, gridSize() * 0.14);
  drawCircle(graphics, point, radius, { color: COLORS.marker, alpha: 0.8, width: 2, fillAlpha: 0.08 });
  strokePath(graphics, [
    { x: point.x - radius, y: point.y },
    { x: point.x + radius, y: point.y },
  ], { color: COLORS.marker, width: 1, alpha: 0.75, dashed: true });
  strokePath(graphics, [
    { x: point.x, y: point.y - radius },
    { x: point.x, y: point.y + radius },
  ], { color: COLORS.marker, width: 1, alpha: 0.75, dashed: true });
  drawFacing(graphics, point, marker.facing, radius * 1.8, COLORS.marker);
  addLabel(marker.label, point, COLORS.marker, { x: radius + 5, y: -radius });
}

function clearLabels() {
  if (!overlayContainer) return;
  for (const child of Array.from(overlayContainer.children)) {
    if (child === overlayGraphics) continue;
    overlayContainer.removeChild(child);
    child.destroy?.({ children: true });
  }
}

function redraw() {
  if (!overlayContainer || !overlayGraphics || !globalThis.canvas?.ready) return;
  overlayGraphics.clear();
  clearLabels();
  refreshTokenShields();
  for (const preview of previews.values()) drawPreview(overlayGraphics, preview);
  for (const marker of lastKnownMarkers) drawLastKnown(overlayGraphics, marker);
}

function createContainer() {
  destroyContainer();
  if (!globalThis.canvas?.stage || !globalThis.PIXI) return;
  overlayContainer = new PIXI.Container();
  overlayContainer.name = `${MODULE_ID}.overlays`;
  overlayContainer.eventMode = "none";
  overlayContainer.interactiveChildren = false;
  overlayContainer.sortableChildren = true;
  overlayContainer.zIndex = 10_000;
  overlayGraphics = new PIXI.Graphics();
  overlayGraphics.eventMode = "none";
  overlayContainer.addChild(overlayGraphics);
  canvas.stage.addChild(overlayContainer);
  installShieldTicker();
  refreshTokenShields();
  redraw();
}

function destroyContainer() {
  if (overlayContainer) {
    overlayContainer.parent?.removeChild(overlayContainer);
    overlayContainer.destroy({ children: true });
  }
  overlayContainer = null;
  destroyTokenShields();
  overlayGraphics = null;
}

function registerHook(name, callback) {
  if (!globalThis.Hooks || hookIds.has(name)) return;
  hookIds.set(name, Hooks.on(name, callback));
}

function previewKey(sourceOrPreview, preview) {
  if (preview !== undefined) return String(sourceOrPreview ?? "default");
  return String(sourceOrPreview?.sourceUuid ?? sourceOrPreview?.tokenUuid ?? sourceOrPreview?.id ?? "default");
}

/** Set or replace a ship movement preview and redraw the dedicated overlay container. */
export function setMovementPreview(sourceOrPreview, suppliedPreview) {
  const key = previewKey(sourceOrPreview, suppliedPreview);
  const preview = suppliedPreview === undefined ? sourceOrPreview : suppliedPreview;
  if (!preview) previews.delete(key);
  else previews.set(key, preview);
  redraw();
}

/** Clear one ship preview, or every movement preview when no source UUID is supplied. */
export function clearMovementPreview(sourceUuid) {
  if (sourceUuid == null) previews.clear();
  else previews.delete(String(sourceUuid));
  redraw();
}

/** Install event-driven canvas overlays and permission-safe ship visibility. */
export function registerCanvasIntegration() {
  registerShipVisibility({
    onMarkersChanged(markers) {
      lastKnownMarkers = markers;
      redraw();
    },
  });
  registerHook("canvasReady", createContainer);
  registerHook("canvasTearDown", () => {
    destroyContainer();
    previews.clear();
    lastKnownMarkers = [];
  });
  registerHook("drawToken", renderTokenShield);
  registerHook("refreshToken", renderTokenShield);
  registerHook("updateToken", (document) => {
    if (document?.object) renderTokenShield(document.object);
    redraw();
  });
  registerHook("createToken", (document) => {
    if (document?.object) renderTokenShield(document.object);
    else refreshTokenShields();
    redraw();
  });
  registerHook("deleteToken", (document) => {
    removeTokenShield(document?.id);
    redraw();
  });
  registerHook("updateActor", (actor) => {
    if (actor?.type !== SHIP_TYPE || !actor?.system?.shipCombat) return;
    refreshTokenShields();
    redraw();
  });
  if (globalThis.canvas?.ready) createContainer();
}
