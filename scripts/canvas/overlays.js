import { SHIP_TYPE } from "../constants.js";
import { materializeActorConfig } from "../foundry/refit.js";
import { registerShipVisibility } from "./visibility.js";

const MODULE_ID = "vira-shipcombat";
const previews = new Map();
const hookIds = new Map();
const shieldGraphics = new Map();
let shieldTicker = null;
let overlayContainer = null;
let overlayGraphics = null;
let trajectoryGraphics = null;
let lastKnownMarkers = [];

const COLORS = Object.freeze({
  powered: 0xb9d8d5,
  coast: 0x8fa6b5,
  pathShadow: 0x071521,
  facing: 0xffffff,
  arc: 0x84d681,
  extendedArc: 0xffbd45,
  collision: 0xff6b55,
  overspeed: 0xffbd45,
  wall: 0xff5c72,
  marker: 0xffd166,
  shield: 0x91c7c4,
  shieldLow: 0xe3b56c,
  shieldCritical: 0xe78383,
  shieldEmpty: 0xa0aab1,
  shieldEdge: 0x10191f,
});

function finitePoint(value) {
  const point = value?.position ?? value?.point ?? value;
  if (
    !point || !Number.isFinite(Number(point.x)) ||
    !Number.isFinite(Number(point.y))
  ) return null;
  return { x: Number(point.x), y: Number(point.y) };
}

function pointsFrom(value) {
  const entries = Array.isArray(value)
    ? value
    : value?.path ?? value?.points ?? [];
  return Array.isArray(entries) ? entries.map(finitePoint).filter(Boolean) : [];
}

function trajectoryPaths(preview) {
  const explicitPowered = preview?.poweredPath ?? preview?.burnPath;
  const explicitCoast = preview?.coastPath ?? preview?.coast;
  if (explicitPowered || explicitCoast) {
    return {
      powered: pointsFrom(explicitPowered),
      coast: pointsFrom(explicitCoast),
    };
  }
  const path = Array.isArray(preview?.path)
    ? preview.path
    : preview?.path?.path;
  if (!Array.isArray(path)) return { powered: [], coast: [] };
  if (path[0]?.phase === "deliberateCoast") {
    return { powered: [], coast: pointsFrom(path) };
  }
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
  return {
    x: origin.x + (Math.sin(radians) * distance),
    y: origin.y - (Math.cos(radians) * distance),
  };
}

function gridSize() {
  return Number(
    globalThis.canvas?.dimensions?.size ?? globalThis.canvas?.grid?.size ?? 100,
  ) || 100;
}

function useModernGraphics(graphics) {
  return typeof graphics?.stroke === "function";
}

function strokePath(
  graphics,
  points,
  {
    color,
    width = 3,
    alpha = 1,
    dashed = false,
    cap = "round",
    join = "round",
  } = {},
) {
  if (points.length < 2) return;
  if (!useModernGraphics(graphics)) graphics.lineStyle(width, color, alpha);
  if (!dashed) {
    graphics.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      graphics.lineTo(points[index].x, points[index].y);
    }
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
        graphics.lineTo(
          start.x + (dx * segmentEnd),
          start.y + (dy * segmentEnd),
        );
      }
    }
  }
  if (useModernGraphics(graphics)) {
    graphics.stroke({ color, width, alpha, cap, join });
  }
}

function drawCircle(
  graphics,
  point,
  radius,
  { color, alpha = 1, width = 2, fillAlpha = 0 },
) {
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
function fillCircle(graphics, point, radius, color, alpha = 1) {
  if (useModernGraphics(graphics)) {
    graphics.circle(point.x, point.y, radius);
    graphics.fill({ color, alpha });
    return;
  }
  graphics.beginFill(color, alpha);
  graphics.drawCircle(point.x, point.y, radius);
  graphics.endFill();
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
  const height = Number(
    token?.h ?? (Number(document?.height ?? document?.width ?? 1) * gridSize()),
  );
  return Math.hypot(width, height) / 2 + Math.max(6, gridSize() * 0.06);
}

function shieldSectorCapacity(shield, sector) {
  const configured = shield?.sectorCap;
  if (typeof configured === "object") return Number(configured?.[sector] ?? 0);
  return Number(configured ?? shield?.totalBudget ?? 0);
}

function shieldAppearance(hp, capacity, collapsed) {
  const ratio = capacity > 0 ? Math.min(1, Math.max(0, hp / capacity)) : 0;
  if (collapsed) return { color: COLORS.shieldCritical, ratio: 0 };
  if (hp <= 0) return { color: COLORS.shieldEmpty, ratio: 0 };
  if (ratio <= 0.25) return { color: COLORS.shieldCritical, ratio };
  if (ratio <= 0.5) return { color: COLORS.shieldLow, ratio };
  return { color: COLORS.shield, ratio };
}

function strokeArc(
  graphics,
  center,
  radius,
  start,
  end,
  { color, width, alpha },
) {
  const startPoint = {
    x: center.x + (Math.cos(start) * radius),
    y: center.y + (Math.sin(start) * radius),
  };
  if (useModernGraphics(graphics)) {
    graphics.moveTo(startPoint.x, startPoint.y);
    graphics.arc(center.x, center.y, radius, start, end);
    graphics.stroke({ color, width, alpha, cap: "butt" });
    return;
  }
  graphics.lineStyle(width, color, alpha);
  graphics.moveTo(startPoint.x, startPoint.y);
  graphics.arc(center.x, center.y, radius, start, end);
}

function drawShieldArc(graphics, center, radius, start, end, appearance) {
  strokeArc(graphics, center, radius, start, end, {
    color: COLORS.shieldEdge,
    width: 4,
    alpha: 0.25,
  });
  strokeArc(graphics, center, radius, start, end, {
    color: COLORS.shieldEmpty,
    width: 3,
    alpha: 0.3,
  });
  if (appearance.ratio <= 0) return;
  const middle = (start + end) / 2;
  const half = (end - start) * appearance.ratio / 2;
  strokeArc(graphics, center, radius, middle - half, middle + half, {
    color: appearance.color,
    width: 3,
    alpha: 0.95,
  });
}

function tokenShieldData(token) {
  const actor = token?.actor ?? token?.document?.actor;
  if (actor?.type !== SHIP_TYPE) return null;
  const state = actor.system?.shipCombat?.state?.shields;
  if (!state) return null;
  let shield = actor.system?.shipCombat?.config?.components?.shield;
  if (!shield) {
    try {
      shield = materializeActorConfig(actor)?.components?.shield;
    } catch (_error) {
      shield = null;
    }
  }
  if (!shield) return null;
  return { actor, shield, state };
}

function hasVisibleShields(token) {
  const actor = token?.actor ?? token?.document?.actor;
  const document = token?.document ?? token;
  if (
    actor?.type !== SHIP_TYPE || document?.hidden || token?.visible === false
  ) return false;
  if (!globalThis.game?.user?.isGM && !actor?.isOwner) return false;
  return Boolean(tokenShieldData(token));
}

function shieldLabel(text, color, heading, radius) {
  const style = {
    fontFamily: "Arial, sans-serif",
    fontSize: 12,
    fontWeight: "600",
    fill: color,
  };
  const label = Number.parseInt(globalThis.PIXI?.VERSION, 10) >= 8
    ? new PIXI.Text({
      text,
      style: {
        ...style,
        stroke: { color: COLORS.shieldEdge, width: 0.75, join: "round" },
      },
    })
    : new PIXI.Text(text, {
      ...style,
      stroke: COLORS.shieldEdge,
      strokeThickness: 0.75,
      lineJoin: "round",
    });
  label.anchor.set(0.5);
  label.resolution = Math.max(2, globalThis.devicePixelRatio ?? 1);
  label.eventMode = "none";
  label._viraHeading = heading;
  label._viraRadius = radius;
  return label;
}

function drawTokenShields(entry, token) {
  const shieldData = tokenShieldData(token);
  if (!shieldData) {
    entry.graphics.clear();
    entry.labels.removeChildren().forEach((child) =>
      child.destroy?.({ children: true })
    );
    return;
  }
  const { shield, state } = shieldData;
  const center = tokenShieldCenter(token);
  const radius = tokenShieldRadius(token);
  const bubble = shield.topology === "bubble";
  const sectors = bubble
    ? [shield.sectors?.[0] ?? "bubble"]
    : ["fore", "starboard", "aft", "port"];
  const headings = { fore: 0, starboard: 90, aft: 180, port: 270 };
  const halfArc = degreesToRadians(bubble ? 170 : 32);

  entry.graphics.clear();
  drawDestinationFacing(entry.graphics, center, 0, Number(token.h ?? token.w));
  entry.labels.removeChildren().forEach((child) =>
    child.destroy?.({ children: true })
  );
  for (const sector of sectors) {
    const hp = Number(state.hp?.[sector] ?? 0);
    const collapsed = Number(state.collapse?.[sector] ?? 0) > 0;
    const appearance = shieldAppearance(
      hp,
      shieldSectorCapacity(shield, sector),
      collapsed,
    );
    const heading = bubble ? 0 : headings[sector];
    const middle = degreesToRadians(bubble ? 90 : heading - 90);
    drawShieldArc(
      entry.graphics,
      center,
      radius,
      middle - halfArc,
      middle + halfArc,
      appearance,
    );
    entry.labels.addChild(
      shieldLabel(
        collapsed ? "×" : String(hp),
        appearance.color,
        heading,
        radius + 12,
      ),
    );
  }
}

function positionShieldLabels(entry, token) {
  const center = tokenShieldCenter(token);
  const rotation = Number(token.mesh?.angle ?? token.document?.rotation ?? 0);
  entry.graphics.position.set(center.x, center.y);
  entry.graphics.pivot.set(center.x, center.y);
  entry.graphics.angle = rotation;
  for (const label of entry.labels.children) {
    const position = headingPoint(
      center,
      Number(label._viraHeading) + rotation,
      Number(label._viraRadius),
    );
    label.position.set(position.x, position.y);
  }
}

function removeTokenShield(tokenId) {
  const key = String(tokenId ?? "");
  const entry = shieldGraphics.get(key);
  if (!entry) return;
  shieldGraphics.delete(key);
  entry.root.parent?.removeChild(entry.root);
  if (!entry.root.destroyed) entry.root.destroy({ children: true });
}

function renderTokenShield(token) {
  const key = String(token?.id ?? token?.document?.id ?? "");
  if (!key) return;
  if (!hasVisibleShields(token)) {
    removeTokenShield(key);
    return;
  }
  let entry = shieldGraphics.get(key);
  if (!entry || entry.root.destroyed || entry.root.parent !== token) {
    removeTokenShield(key);
    const root = new PIXI.Container();
    const graphics = new PIXI.Graphics();
    const labels = new PIXI.Container();
    root.name = `${MODULE_ID}.shield`;
    root.eventMode = "none";
    root.interactiveChildren = false;
    root.sortableChildren = true;
    root.zIndex = 1_000;
    graphics.zIndex = 0;
    labels.zIndex = 1;
    root.addChild(graphics, labels);
    token.addChild(root);
    entry = { root, graphics, labels };
    shieldGraphics.set(key, entry);
  }
  drawTokenShields(entry, token);
  positionShieldLabels(entry, token);
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
  for (const [key, entry] of shieldGraphics) {
    const token = globalThis.canvas?.tokens?.get?.(key);
    if (!token || entry.root.destroyed || entry.root.parent !== token) {
      removeTokenShield(key);
      continue;
    }
    positionShieldLabels(entry, token);
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

function drawFacing(
  graphics,
  origin,
  facing,
  length = gridSize() * 0.55,
  color = COLORS.facing,
) {
  if (!origin || !Number.isFinite(Number(facing))) return;
  const tip = headingPoint(origin, Number(facing), length);
  const left = headingPoint(
    tip,
    Number(facing) + 154,
    Math.min(16, length * 0.28),
  );
  const right = headingPoint(
    tip,
    Number(facing) - 154,
    Math.min(16, length * 0.28),
  );
  strokePath(graphics, [origin, tip], {
    color: COLORS.pathShadow,
    width: 7,
    alpha: 0.8,
  });
  strokePath(graphics, [left, tip, right], {
    color: COLORS.pathShadow,
    width: 7,
    alpha: 0.8,
  });
  strokePath(graphics, [origin, tip], { color, width: 3, alpha: 1 });
  strokePath(graphics, [left, tip, right], { color, width: 3, alpha: 1 });
}

function drawTrajectory(graphics, points, { color, dashed = false }) {
  if (points.length < 2) return;
  strokePath(graphics, points, {
    color: COLORS.pathShadow,
    width: 3.5,
    alpha: 0.2,
    dashed,
  });
  strokePath(graphics, points, {
    color,
    width: 1.5,
    alpha: dashed ? 0.4 : 0.55,
    dashed,
  });
}

function sourceToken(preview) {
  const sourceUuid = String(preview?.sourceUuid ?? preview?.tokenUuid ?? "");
  if (!sourceUuid) return null;
  return (globalThis.canvas?.tokens?.placeables ?? []).find((token) => (
    String(token?.document?.uuid ?? token?.uuid ?? "") === sourceUuid ||
    String(token?.id ?? token?.document?.id ?? "") === sourceUuid
  )) ?? null;
}

function destinationSize(preview) {
  const token = sourceToken(preview);
  const meshWidth = Math.abs(Number(token?.mesh?.width));
  const meshHeight = Math.abs(Number(token?.mesh?.height));
  if (meshWidth > 0 && meshHeight > 0) {
    return { width: meshWidth, height: meshHeight };
  }

  const width = Math.abs(Number(token?.w ?? gridSize()));
  const height = Math.abs(Number(token?.h ?? gridSize()));
  const textureWidth = Number(token?.mesh?.texture?.orig?.width);
  const textureHeight = Number(token?.mesh?.texture?.orig?.height);
  if (!(textureWidth > 0) || !(textureHeight > 0)) return { width, height };
  const scale = Math.min(width / textureWidth, height / textureHeight);
  return { width: textureWidth * scale, height: textureHeight * scale };
}

function addDestinationGhost(preview, point, facing, size) {
  const token = sourceToken(preview);
  const texture = token?.mesh?.texture;
  if (
    !overlayContainer || !point || !texture || texture === PIXI.Texture?.EMPTY
  ) return;
  const ghost = new PIXI.Sprite(texture);
  ghost.name = `${MODULE_ID}.destination`;
  ghost.anchor?.set?.(0.5);
  ghost.position.set(point.x, point.y);
  ghost.width = size.width;
  ghost.height = size.height;
  ghost.angle = Number(facing) || 0;
  ghost.alpha = 0.36;
  ghost.eventMode = "none";
  ghost.zIndex = 5;
  overlayContainer.addChild(ghost);
}

function drawDestinationFacing(graphics, point, facing, shipHeight) {
  if (!Number.isFinite(Number(facing))) return;
  const size = Math.max(5, gridSize() * 0.05);
  const baseDistance = (shipHeight / 2) + Math.max(6, gridSize() * 0.06);
  const tip = headingPoint(point, facing, baseDistance + size);
  const base = headingPoint(point, facing, baseDistance);
  const left = headingPoint(base, Number(facing) - 90, size);
  const right = headingPoint(base, Number(facing) + 90, size);
  strokePath(graphics, [left, tip, right], {
    color: COLORS.pathShadow,
    width: 3.5,
    alpha: 0.5,
  });
  strokePath(graphics, [left, tip, right], {
    color: COLORS.powered,
    width: 1.5,
    alpha: 0.9,
  });
}

function drawArc(graphics, arc, fallbackOrigin, fallbackFacing) {
  const origin = finitePoint(arc?.origin) ?? fallbackOrigin;
  const facing = Number(arc?.rotation ?? arc?.facing ?? fallbackFacing);
  const width = Number(
    arc?.arcDegrees ?? arc?.arcWidth ?? arc?.arcWidthDegrees ?? arc?.width ?? 0,
  );
  const center = Number(
    arc?.arcCenter ?? arc?.arcCenterDegrees ?? arc?.center ?? 0,
  );
  const radius = Number(
    arc?.maximumRange ?? arc?.range ?? arc?.maxRange ?? arc?.radius ??
      gridSize() * 3,
  );
  if (
    !origin || !Number.isFinite(facing) || !Number.isFinite(width) ||
    width <= 0 || !Number.isFinite(radius) || radius <= 0
  ) return;
  const optimal = Math.max(
    0,
    Math.min(radius, Number(arc?.optimalRange ?? radius)),
  );
  if (!Number.isFinite(optimal)) return;
  const boundedWidth = Math.min(360, width);
  const startHeading = facing + center - (boundedWidth / 2);
  const endHeading = facing + center + (boundedWidth / 2);
  const startAngle = degreesToRadians(startHeading - 90);
  const endAngle = degreesToRadians(endHeading - 90);
  const band = (inner, outer, color) => {
    if (outer <= inner) return;
    const start = headingPoint(origin, startHeading, outer);
    const innerEnd = headingPoint(origin, endHeading, inner);
    const modern = useModernGraphics(graphics);
    if (!modern) {
      graphics.lineStyle(2, color, 0.7);
      graphics.beginFill(color, 0.09);
    }
    graphics.moveTo(start.x, start.y);
    graphics.arc(origin.x, origin.y, outer, startAngle, endAngle);
    graphics.lineTo(innerEnd.x, innerEnd.y);
    if (inner > 0) {
      graphics.arc(origin.x, origin.y, inner, endAngle, startAngle, true);
    }
    graphics.lineTo(start.x, start.y);
    if (modern) {
      graphics.fill({ color, alpha: 0.09 });
      graphics.stroke({ color, width: 2, alpha: 0.7 });
    } else graphics.endFill();
  };
  band(optimal, radius, COLORS.extendedArc);
  band(0, optimal, Number(arc.color ?? COLORS.arc));
  if (arc?.optimalRange != null) {
    addLabel(
      "OPTIMAL",
      headingPoint(origin, facing + center, optimal),
      COLORS.arc,
      { x: 10, y: -22 },
    );
    addLabel(
      "MAXIMUM · extended range",
      headingPoint(origin, facing + center, radius),
      COLORS.extendedArc,
      { x: 10, y: 0 },
    );
  }
}

function drawCollision(graphics, collision) {
  const point = finitePoint(collision);
  if (!point) return;
  const radius = Math.max(6, gridSize() * 0.09);
  drawCircle(graphics, point, radius, {
    color: COLORS.collision,
    width: 3,
    fillAlpha: 0.2,
  });
  strokePath(graphics, [
    { x: point.x - radius, y: point.y - radius },
    { x: point.x + radius, y: point.y + radius },
  ], { color: COLORS.collision, width: 2 });
  strokePath(graphics, [
    { x: point.x + radius, y: point.y - radius },
    { x: point.x - radius, y: point.y + radius },
  ], { color: COLORS.collision, width: 2 });
}

function makeText(text, color, { fontSize = 14, strokeWidth = 4 } = {}) {
  const common = {
    fill: color,
    fontFamily: "Roboto Condensed, Arial Narrow, sans-serif",
    fontSize,
    fontWeight: "700",
  };
  if (Number.parseInt(globalThis.PIXI?.VERSION, 10) >= 8) {
    return new PIXI.Text({
      text,
      style: {
        ...common,
        stroke: { color: 0x000000, width: strokeWidth },
        dropShadow: { color: 0x000000, alpha: 0.8, blur: 2, distance: 1 },
      },
    });
  }
  return new PIXI.Text(String(text), {
    ...common,
    stroke: 0x000000,
    strokeThickness: strokeWidth,
    dropShadow: true,
    dropShadowColor: 0x000000,
    dropShadowAlpha: 0.8,
    dropShadowBlur: 2,
    dropShadowDistance: 1,
  });
}

function addLabel(text, point, color, offset = { x: 10, y: -10 }) {
  if (!overlayContainer || !point || !text) return;
  const label = makeText(String(text), color);
  label.position.set(point.x + offset.x, point.y + offset.y);
  label.eventMode = "none";
  label.zIndex = 30;
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
    let message = entry.message ?? entry.label ??
      code.replace(/^MOVEMENT_/, "").replaceAll("_", " ");
    if (
      code.includes("OVERSPEED") && Number.isFinite(Number(entry.overspeed))
    ) {
      message = `OVERSPEED +${Number(entry.overspeed)}`;
      if (Number.isFinite(Number(entry.hullDamage))) {
        message += ` (${Number(entry.hullDamage)} hull)`;
      }
    }
    warnings.push({
      kind: code,
      message,
      position: finitePoint(entry) ?? anchor,
    });
  };
  const supplied = Array.isArray(preview?.warnings)
    ? preview.warnings
    : preview?.warnings
    ? [preview.warnings]
    : [];
  for (const warning of supplied) append(warning);
  append(
    preview?.overspeedWarning ?? (preview?.overspeed ? "OVERSPEED" : null),
    "overspeed",
  );
  append(preview?.wallWarning, "wall");
  for (const collision of collisions) {
    if (collision?.type !== "wall") continue;
    append({
      kind: "wall",
      message: "WALL COLLISION",
      point: finitePoint(collision),
    }, "wall");
  }
  return warnings;
}

function drawPreview(graphics, preview) {
  for (const projection of preview?.targetedCoasts ?? []) {
    const points = pointsFrom(projection.path ?? []);
    strokePath(trajectoryGraphics, points, {
      color: COLORS.pathShadow,
      width: 7,
      alpha: 0.3,
      dashed: true,
    });
    strokePath(trajectoryGraphics, points, {
      color: COLORS.marker,
      width: 3,
      alpha: 0.45,
      dashed: true,
    });
    if (points.length) {
      addLabel(
        `${projection.label ?? "Target"} · COAST`,
        points.at(-1),
        COLORS.marker,
        { x: 10, y: 10 },
      );
    }
  }

  const { powered, coast } = trajectoryPaths(preview);
  drawTrajectory(trajectoryGraphics, powered, { color: COLORS.powered });
  drawTrajectory(trajectoryGraphics, coast, {
    color: COLORS.coast,
    dashed: true,
  });

  const finalPoint = finitePoint(preview?.coastEnd) ??
    coast.at(-1) ??
    finitePoint(preview?.position) ??
    finitePoint(preview?.poweredEnd) ??
    powered.at(-1) ??
    finitePoint(preview?.origin);
  const facing = preview?.finalFacing ?? preview?.facing ??
    preview?.coastEnd?.facing ?? preview?.poweredEnd?.facing ??
    preview?.heading;
  const startPoint = powered[0] ?? coast[0];
  if (startPoint) {
    fillCircle(trajectoryGraphics, startPoint, 3, COLORS.pathShadow, 0.4);
    fillCircle(trajectoryGraphics, startPoint, 1.5, COLORS.powered);
  }
  const phasePoint = powered.at(-1);
  if (phasePoint && coast.length > 1) {
    fillCircle(trajectoryGraphics, phasePoint, 3, COLORS.pathShadow, 0.4);
    fillCircle(trajectoryGraphics, phasePoint, 1.5, COLORS.powered);
  }
  if (finalPoint) {
    drawCircle(trajectoryGraphics, finalPoint, 4, {
      color: COLORS.pathShadow,
      width: 3.5,
      alpha: 0.3,
    });
    drawCircle(trajectoryGraphics, finalPoint, 4, {
      color: COLORS.powered,
      width: 1.5,
      alpha: 0.55,
    });

    const size = destinationSize(preview);
    addDestinationGhost(preview, finalPoint, facing, size);
    drawDestinationFacing(graphics, finalPoint, facing, size.height);
  }

  const arcs = Array.isArray(preview?.firingArcs)
    ? preview.firingArcs
    : preview?.firingArc
    ? [preview.firingArc]
    : [];
  for (const arc of arcs) drawArc(graphics, arc, finalPoint, facing);

  const suppliedCollisions = preview?.collisions ?? preview?.collisionPoints ??
    preview?.sweptCollisions ?? [];
  const collisions = Array.isArray(suppliedCollisions)
    ? suppliedCollisions
    : [suppliedCollisions];
  for (const collision of collisions) drawCollision(graphics, collision);

  warningEntries(preview, finalPoint, collisions).forEach((warning, index) => {
    const kind = String(warning.kind).toLowerCase();
    const color = kind.includes("wall") ? COLORS.wall : COLORS.overspeed;
    addLabel(warning.message, warning.position, color, {
      x: 12,
      y: -14 + (index * 19),
    });
  });
}

function drawLastKnown(graphics, marker) {
  const point = finitePoint(marker?.position);
  if (!point) return;
  const radius = Math.max(9, gridSize() * 0.14);
  drawCircle(graphics, point, radius, {
    color: COLORS.marker,
    alpha: 0.8,
    width: 2,
    fillAlpha: 0.08,
  });
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
  if (
    !overlayContainer || !overlayGraphics || !trajectoryGraphics ||
    !globalThis.canvas?.ready
  ) return;
  overlayGraphics.clear();
  trajectoryGraphics.clear();
  trajectoryGraphics.elevation = Number(canvas.level?.elevation?.base ?? 0);
  canvas.primary.sortDirty = true;
  clearLabels();
  refreshTokenShields();
  for (const preview of previews.values()) {
    drawPreview(overlayGraphics, preview);
  }
  for (const marker of lastKnownMarkers) drawLastKnown(overlayGraphics, marker);
}

function createContainer() {
  destroyContainer();
  if (
    !globalThis.canvas?.stage || !globalThis.canvas?.primary || !globalThis.PIXI
  ) return;
  overlayContainer = new PIXI.Container();
  overlayContainer.name = `${MODULE_ID}.overlays`;
  overlayContainer.eventMode = "none";
  overlayContainer.interactiveChildren = false;
  overlayContainer.sortableChildren = true;
  overlayContainer.zIndex = 10_000;
  overlayGraphics = new PIXI.Graphics();
  overlayGraphics.eventMode = "none";
  overlayGraphics.zIndex = 20;
  overlayContainer.addChild(overlayGraphics);
  canvas.stage.addChild(overlayContainer);
  trajectoryGraphics = new PIXI.Graphics();
  trajectoryGraphics.name = `${MODULE_ID}.trajectories`;
  trajectoryGraphics.eventMode = "none";
  // Primary rendering puts paths above level scenery but below token meshes.
  trajectoryGraphics.sortLayer =
    foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS.TOKENS - 1;
  canvas.primary.addChild(trajectoryGraphics);
  installShieldTicker();
  refreshTokenShields();
  redraw();
}

function destroyContainer() {
  if (trajectoryGraphics && !trajectoryGraphics.destroyed) {
    trajectoryGraphics.parent?.removeChild(trajectoryGraphics);
    trajectoryGraphics.destroy();
  }
  trajectoryGraphics = null;
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
  return String(
    sourceOrPreview?.sourceUuid ?? sourceOrPreview?.tokenUuid ??
      sourceOrPreview?.id ?? "default",
  );
}

/** Set or replace a ship movement preview and redraw the dedicated overlay container. */
export function setMovementPreview(sourceOrPreview, suppliedPreview) {
  const key = previewKey(sourceOrPreview, suppliedPreview);
  const preview = suppliedPreview === undefined
    ? sourceOrPreview
    : suppliedPreview;
  if (!preview) previews.delete(key);
  else {previews.set(
      key,
      typeof preview === "object"
        ? {
          ...preview,
          sourceUuid: preview.sourceUuid ?? preview.tokenUuid ?? key,
        }
        : preview,
    );}
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
  const onItemChanged = (item) => {
    const actor = item?.parent;
    if (actor?.type === SHIP_TYPE && actor?.system?.shipCombat) {
      refreshTokenShields();
      redraw();
    }
  };
  registerHook("createItem", onItemChanged);
  registerHook("updateItem", onItemChanged);
  registerHook("deleteItem", onItemChanged);
  registerHook("updateActorDelta", (delta) => {
    const actor = delta?.parent?.actor ?? delta?.actor;
    if (actor?.type === SHIP_TYPE && actor?.system?.shipCombat) {
      refreshTokenShields();
      redraw();
    }
  });
  registerHook("viraShipCombatOperationCommitted", () => {
    refreshTokenShields();
    redraw();
  });
  if (globalThis.canvas?.ready) createContainer();
}
