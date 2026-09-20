/**
 * Canvas renderer for the sensors radar dial.
 *
 * Pure DOM + Canvas 2D: geometry, zoom limits and hit-target percentages all
 * come from radar-geometry.js, so a painted blip and its DOM hit target are
 * projected by the same call and cannot drift apart. This module owns pixels,
 * time and input only; it never writes ship state.
 */

import {
  RADAR_LIMITS,
  autoScale,
  clampScale,
  dialFromBearing,
  finiteNumber,
  formatRange,
  isAutoScale,
  presetLadder,
  radarPercentStyle,
  ringValues,
} from "./radar-geometry.js";

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const DEGREE = Math.PI / 180;

/** Sweep arm speed, rad/s. */
const SWEEP_SPEED = 0.7;
/** Trail length behind the arm, rad. */
const SWEEP_TRAIL = 1.4;
/** Arm bearing used when the viewer asks for reduced motion. */
const SWEEP_STATIC = -1.1;
/** Arm glow, canvas px. */
const SWEEP_BLUR = 8;

const FRAME_MS = 1000 / 30;
/** A hidden panel keeps failing #size(); retry it at this cadence, not every frame. */
const LAYOUT_RETRY_MS = 250;
/** Longest simulated step after a background tab resumes, seconds. */
const MAX_DELTA = 0.25;

const MIN_RADIUS = 140;
const MAX_RADIUS = 360;
/** A stage smaller than the smallest dial is not laid out yet. */
const MIN_STAGE = MIN_RADIUS * 2;
const EDGE_MARGIN = 8;
const CORNER_CLEARANCE = 12;
const DPR_CAP = 2;

const BLIP_RADIUS = 6;
const BLIP_RADIUS_TARGETED = 7;
const LOCK_RING_OFFSET = 5;
const INTERFERENCE_OFFSET = 4;
const INTERFERENCE_SPAN = 0.5;
const STALE_ALPHA = 0.55;
const DIM_ALPHA = 0.35;

const PULSE_WINDOW = 0.12;
const PULSE_DECAY = 2;
const PULSE_BLUR = 12;
const FLASH_SECONDS = 1.2;
const RIPPLE_SECONDS = 0.9;
const RIPPLE_ALPHA = 0.22;

const HIGHLIGHT_OFFSET = 6;
const HIGHLIGHT_BLUR = 10;
const VECTOR_WIDTH = 1.5;
const VECTOR_MAX = 42;
const VECTOR_HEAD = 6;
const OWN_SHIP_LENGTH = 7;
const OWN_SHIP_HALF = 5;

const HOIST_LENGTH = 11;
const HOIST_HALF = 7;
const HOIST_WIDTH = 3;

const TICK_STEP = 30;
const TICK_COUNT = 12;
const TICK_INNER = 6;
const TICK_INSET = 15;
const RING_LABEL_INSET = 5;
/** Gap a ring label's glyphs keep from the stroke of the ring they sit inside. */
const RING_LABEL_CLEARANCE = 10;
/** A ring or marker this close to the rim puts its label beside the cardinal row. */
const RIM_LABEL_GAP = 14;
/** Clearance the shifted label baseline keeps from the dial edge. */
const RIM_LABEL_MARGIN = 10;
const WEAPON_LABEL_DIAGONAL = Math.SQRT1_2;
const BANNER_INSET = 14;

const CARDINALS = Object.freeze(["N", "E", "S", "W"]);
const TICK_LABELS = Object.freeze(
  Array.from({ length: TICK_COUNT }, (_, index) =>
    index % 3 === 0
      ? CARDINALS[index / 3]
      : String(index * TICK_STEP).padStart(3, "0")),
);

const NO_DASH = Object.freeze([]);
const DASH_WEAPON = Object.freeze([2, 4]);
const DASH_ACTIVE = Object.freeze([1, 3]);
const DASH_PASSIVE = Object.freeze([6, 4]);
const DASH_STALE = Object.freeze([3, 3]);
const DASH_INTERFERENCE = Object.freeze([2, 3]);
const DASH_HIGHLIGHT = Object.freeze([4, 4]);

const EMPTY_CONTACTS = Object.freeze([]);

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgba?\(([^)]*)\)$/i;

/**
 * Custom properties are read back as authored (`#3ee8d0`), so translucent
 * variants are derived here instead of every frame.
 */
function alphaColor(color, alpha) {
  const value = typeof color === "string" ? color.trim() : "";
  const hex = HEX_COLOR.exec(value);
  if (hex) {
    const digits = hex[1];
    const expanded = digits.length === 3
      ? `${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
      : digits;
    return `rgba(${parseInt(expanded.slice(0, 2), 16)}, ` +
      `${parseInt(expanded.slice(2, 4), 16)}, ` +
      `${parseInt(expanded.slice(4, 6), 16)}, ${alpha})`;
  }
  const rgb = RGB_COLOR.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  }
  return value || "transparent";
}

/** Writes the shared dial percentages onto a hit target. */
function applyPercentStyle(element, u, v) {
  for (const declaration of radarPercentStyle(u, v).split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    element.style.setProperty(
      declaration.slice(0, separator).trim(),
      declaration.slice(separator + 1).trim(),
    );
  }
}

/**
 * Labels shifted beside the axis sit close to the rim, so their baseline is
 * clamped clear of the dial edge the label would otherwise overhang.
 */
function rimLabelY(y, cy, radius) {
  return Math.min(Math.max(y, cy - radius + RIM_LABEL_MARGIN), cy + radius - RIM_LABEL_MARGIN);
}

export class SensorRadar {
  #stage = null;
  #canvas = null;
  #ctx = null;
  #hits = null;
  #zoom = null;
  #corners = [];
  #observer = null;
  #motion = null;
  #frameId = null;
  #resizeFrame = null;
  #lastTime = 0;
  #clock = 0;
  #sweepAngle = SWEEP_STATIC;
  #reduceMotion = false;

  /**
   * Current sweep arm bearing, rad. Reading it before a rebuild and writing it back afterwards keeps
   * the arm where it was: the console recreates the radar on every render, and a fresh instance would
   * otherwise snap the arm back to its start (visible whenever the ship's state updates, e.g. a drag).
   */
  get sweepAngle() {
    return this.#sweepAngle;
  }

  set sweepAngle(value) {
    if (Number.isFinite(value)) this.#sweepAngle = value;
  }

  #radius = 0;
  #laidOut = false;
  #lastLayoutAttempt = 0;
  #dpr = 1;

  #radar = null;
  #contacts = EMPTY_CONTACTS;
  #plots = [];
  #plotByUuid = new Map();
  #presets = presetLadder(RADAR_LIMITS.maximum, { minimum: RADAR_LIMITS.minimum });
  #requestedScale = null;
  #scale = RADAR_LIMITS.minimum;
  #rings = [];
  #distances = [];

  #activeRange = 0;
  #passiveRange = 0;
  #activeLabel = "";
  #passiveLabel = "";
  #banner = "";

  #theme = {};
  #flash = new Map();
  #rippleAt = -1;
  #liveCount = 0;
  #hasView = false;

  #hoveredUuid = "";
  #focusedUuid = "";

  onScaleChange = null;

  constructor(stage) {
    this.#stage = stage ?? null;
  }

  /** Number in DU the operator asked for, or null for auto-fit. */
  get requestedScale() {
    return this.#requestedScale;
  }

  /**
   * Queries the stage the sheet just rendered, sizes the dial and starts the
   * loop. Safe to call again after a re-render: every element reference and
   * listener is rebuilt, never reused.
   */
  attach(stage = this.#stage) {
    this.#detachElements();
    this.#adoptStage(stage);
  }

  /**
   * Re-points the radar at the stage the sheet just rendered, keeping this
   * instance — and with it the sweep phase, clock and view — alive across a
   * rebuild instead of a destroy() plus a fresh constructor. Every binding that
   * points into the node being left is dropped (resize observer, motion,
   * pointer and zoom listeners) and every element reference is re-resolved
   * inside the replacement, so no cached node survives the move; the ticker and
   * the dial state are not touched. A no-op when handed the node already in
   * use, so a caller can pass whatever the render produced.
   */
  setStage(stage) {
    const next = stage ?? null;
    if (next === this.#stage) {
      // A frame that ended itself after its canvas detached is restarted here when the
      // same stage is handed back still connected. #startLoop is a no-op while running.
      if (next && this.#canvas?.isConnected) this.#startLoop();
      return;
    }
    this.#detachStage();
    this.#adoptStage(next);
  }

  #adoptStage(stage) {
    const next = stage ?? null;
    this.#stage = next;
    if (!next) {
      // With no stage there is nothing to paint, so the frame is dropped; the
      // dial state stays put for a later setStage()/attach().
      this.#stopLoop();
      this.#clearStageElements();
      return;
    }

    const canvas = next.querySelector("[data-radar-canvas]");
    this.#canvas = canvas && typeof canvas.getContext === "function" ? canvas : null;
    this.#ctx = this.#canvas ? this.#canvas.getContext("2d") : null;
    this.#hits = next.querySelector("[data-radar-hits]");
    this.#zoom = next.querySelector("[data-radar-zoom]");
    this.#corners = Array.from(next.querySelectorAll(".ship-radar-corner"));
    this.#hoveredUuid = "";
    this.#focusedUuid = "";

    // The hit layer covers the canvas, so zoom is captured stage-wide.
    next.addEventListener("wheel", this.#onWheel, { passive: false });
    if (this.#hits) {
      this.#hits.addEventListener("pointerover", this.#onPointerOver);
      this.#hits.addEventListener("pointerout", this.#onPointerOut);
      this.#hits.addEventListener("focusin", this.#onFocusIn);
      this.#hits.addEventListener("focusout", this.#onFocusOut);
    }
    if (this.#zoom) this.#zoom.addEventListener("click", this.#onZoomClick);

    this.#motion = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    this.#reduceMotion = this.#motion?.matches === true;
    this.#motion?.addEventListener("change", this.#onMotionChange);

    if (typeof ResizeObserver === "function") {
      this.#observer = new ResizeObserver(this.#onResize);
      this.#observer.observe(next);
    }

    this.#readTheme();
    this.#size();
    this.#refresh();
    this.#paint();
    this.#startLoop();
  }

  /** Drops the element references cached from a stage, so none can outlive it. */
  #clearStageElements() {
    this.#canvas = null;
    this.#ctx = null;
    this.#hits = null;
    this.#zoom = null;
    this.#corners = [];
  }

  setView(view) {
    const previousPlots = this.#plotByUuid;
    const previousLive = this.#liveCount;

    this.#radar = view?.radar ?? null;
    this.#contacts = Array.isArray(view?.contacts) ? view.contacts : EMPTY_CONTACTS;
    this.#presets = presetValues(this.#radar);
    if (this.#radar) {
      this.#requestedScale = this.#radar.auto === true
        ? null
        : clampScale(this.#radar.scale, this.#limits());
    }

    this.#readTheme();
    this.#refresh();

    if (this.#hasView) {
      const now = this.#clock;
      for (const contact of this.#contacts) {
        const uuid = String(contact?.targetUuid ?? "");
        if (!uuid || contact.unknown === true) continue;
        if (!previousPlots.has(uuid)) this.#flash.set(uuid, now);
      }
      if (finiteNumber(this.#radar?.liveCount) > previousLive) this.#rippleAt = now;
    }
    for (const uuid of this.#flash.keys()) {
      if (!this.#plotByUuid.has(uuid)) this.#flash.delete(uuid);
    }

    this.#hasView = true;
    this.#liveCount = finiteNumber(this.#radar?.liveCount);
    if (!this.#laidOut) this.#size();
    this.#paint();
  }

  /** Number in DU, or null to fit the dial to the furthest contact. */
  setScale(value) {
    this.#requestedScale = isAutoScale(value) ? null : clampScale(value, this.#limits());
    this.#refresh();
    this.#paint();
    if (typeof this.onScaleChange === "function") this.onScaleChange(this.#requestedScale);
  }

  destroy() {
    this.#detachElements();
  }

  #detachElements() {
    this.#stopLoop();
    if (this.#resizeFrame !== null) {
      cancelAnimationFrame(this.#resizeFrame);
      this.#resizeFrame = null;
    }
    this.#detachStage();
  }

  /**
   * Drops the bindings that point into the stage node the radar is leaving,
   * leaving the ticker and the dial state alone: setStage() re-points with
   * these, while destroy() stacks them on top of the full teardown.
   */
  #detachStage() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#motion?.removeEventListener("change", this.#onMotionChange);
    this.#motion = null;
    this.#stage?.removeEventListener("wheel", this.#onWheel);
    this.#hits?.removeEventListener("pointerover", this.#onPointerOver);
    this.#hits?.removeEventListener("pointerout", this.#onPointerOut);
    this.#hits?.removeEventListener("focusin", this.#onFocusIn);
    this.#hits?.removeEventListener("focusout", this.#onFocusOut);
    this.#zoom?.removeEventListener("click", this.#onZoomClick);
  }

  /*
   * Scale, geometry and DOM sync.
   */

  #limits() {
    const minimum = finiteNumber(this.#radar?.minimum, RADAR_LIMITS.minimum);
    return {
      minimum,
      maximum: Math.max(minimum, finiteNumber(this.#radar?.maximum, RADAR_LIMITS.maximum)),
    };
  }

  #refresh() {
    this.#computeScale();
    this.#computeRings();
    this.#computeMarkers();
    this.#computeGeometry();
    this.#syncHits();
    this.#syncZoomUi();
  }

  #computeScale() {
    const limits = this.#limits();
    if (!isAutoScale(this.#requestedScale)) {
      this.#scale = clampScale(this.#requestedScale, limits);
      return;
    }
    const radarScale = Number(this.#radar?.scale);
    if (this.#radar?.auto === true && Number.isFinite(radarScale) && radarScale > 0) {
      // The view model fitted the dial to the furthest track; reuse its fit.
      this.#scale = clampScale(radarScale, limits);
      return;
    }
    const distances = this.#distances;
    distances.length = 0;
    for (const contact of this.#contacts) {
      if (Number.isFinite(Number(contact?.distance))) distances.push(contact.distance);
    }
    this.#scale = autoScale(distances, limits);
  }

  #computeRings() {
    const rings = this.#rings;
    rings.length = 0;
    for (const value of ringValues(this.#scale)) {
      rings.push({ factor: value / this.#scale, label: formatRange(value) });
    }
  }

  #computeMarkers() {
    const radar = this.#radar;
    this.#activeRange = radar ? finiteNumber(radar.activeRange) : 0;
    this.#passiveRange = radar ? finiteNumber(radar.passiveRange) : 0;
    this.#activeLabel = `ACTIVE ${formatRange(this.#activeRange)}`;
    this.#passiveLabel = `PASSIVE ${formatRange(this.#passiveRange)}`;
    this.#banner = !radar
      ? ""
      : radar.online === false
      ? "SENSORS OFFLINE"
      : radar.originKnown === false
      ? "NO POSITION FIX"
      : "";
  }

  #computeGeometry() {
    const plots = this.#plots;
    const byUuid = new Map();
    plots.length = 0;
    for (const contact of this.#contacts) {
      const distance = Number(contact?.distance);
      const bearing = Number(contact?.bearingRel);
      if (contact?.unknown === true || !Number.isFinite(distance) || !Number.isFinite(bearing)) {
        plots.push(null);
        continue;
      }
      const plot = dialFromBearing(distance, bearing, this.#scale);
      plots.push(plot);
      byUuid.set(String(contact.targetUuid ?? ""), plot);
    }
    this.#plotByUuid = byUuid;
  }

  #syncHits() {
    const hits = this.#hits;
    if (!hits) return;
    for (const button of hits.querySelectorAll("[data-sensor-focus]")) {
      const plot = this.#plotByUuid.get(button.dataset.sensorFocus ?? "");
      // A contact without a usable fix renders no hit target at all.
      if (!plot) continue;
      applyPercentStyle(button, plot.u, plot.v);
      button.classList.toggle("is-hoisted", plot.hoisted === true);
    }
  }

  #syncZoomUi() {
    const zoom = this.#zoom;
    if (!zoom) return;
    const auto = isAutoScale(this.#requestedScale);
    const autoChip = zoom.querySelector("[data-radar-zoom-auto]");
    if (autoChip) autoChip.setAttribute("aria-pressed", auto ? "true" : "false");
    for (const chip of zoom.querySelectorAll("[data-radar-zoom-preset]")) {
      const active = !auto && Number(chip.dataset.radarZoomPreset) === this.#scale;
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const readout = zoom.querySelector("[data-radar-zoom-readout]");
    if (readout) readout.textContent = `${formatRange(this.#scale)} DU`;
  }

  /*
   * Sizing.
   */

  #size() {
    const stage = this.#stage;
    const canvas = this.#canvas;
    if (!stage || !canvas) return false;
    const rect = stage.getBoundingClientRect();
    // A hidden or unsized panel would otherwise paint a degenerate dial; keep
    // the previous box and retry from the loop and the observer.
    if (!(rect.width >= MIN_STAGE) || !(rect.height >= MIN_STAGE)) {
      this.#laidOut = false;
      return false;
    }

    const halfWidth = rect.width / 2;
    const halfHeight = rect.height / 2;
    let radius = Math.min(rect.width, rect.height) / 2 - EDGE_MARGIN;
    for (const corner of this.#corners) {
      const box = corner.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) continue;
      // Nearest point of the panel to the dial centre. The spec's
      // hypot(halfWidth - right, halfHeight - bottom) is this same distance for
      // the top-left panel; clamping both axes keeps the clearance honest for
      // the other three, whose inner corners the raw expression misses.
      const nearestX = Math.max(box.left - rect.left, Math.min(halfWidth, box.right - rect.left));
      const nearestY = Math.max(box.top - rect.top, Math.min(halfHeight, box.bottom - rect.top));
      const clearance = Math.hypot(nearestX - halfWidth, nearestY - halfHeight) - CORNER_CLEARANCE;
      if (clearance < radius) radius = clearance;
    }
    radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, radius));

    // Floor, so the corner clearance stays at least CORNER_CLEARANCE wide.
    const boxSize = Math.floor(radius * 2);
    // Keep the painted circle inscribed in the box: percentages of the box and
    // dial coordinates stay one linear map for the canvas and the hit layer.
    this.#radius = boxSize / 2;
    this.#laidOut = true;
    this.#dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);

    // Unrounded centring keeps the clearance symmetric on both sides.
    const left = (rect.width - boxSize) / 2;
    const top = (rect.height - boxSize) / 2;
    const deviceSize = Math.round(boxSize * this.#dpr);
    for (const element of [canvas, this.#hits]) {
      if (!element) continue;
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.width = `${boxSize}px`;
      element.style.height = `${boxSize}px`;
    }
    if (canvas.width !== deviceSize || canvas.height !== deviceSize) {
      canvas.width = deviceSize;
      canvas.height = deviceSize;
    }
  }

  /*
   * Painting.
   */

  #readTheme() {
    const stage = this.#stage;
    const computed = stage ? getComputedStyle(stage) : null;
    const read = (name, fallback) => {
      const value = computed?.getPropertyValue(name);
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed || fallback;
    };
    const family = read("--font-monospace", "monospace");
    const theme = this.#theme;
    theme.cyan = read("--ship-cyan", "aqua");
    theme.red = read("--ship-red", "crimson");
    theme.amber = read("--ship-amber", "orange");
    theme.muted = read("--ship-muted", "gray");
    theme.text = read("--ship-text", "white");
    theme.border = read("--ship-border", "gray");
    theme.borderBright = read("--ship-border-bright", "silver");
    theme.panel = read("--ship-panel", "black");
    theme.weapon = alphaColor(theme.borderBright, 0.55);
    theme.active = alphaColor(theme.cyan, 0.7);
    theme.passive = alphaColor(theme.amber, 0.6);
    theme.sweepClear = alphaColor(theme.cyan, 0);
    theme.sweepBright = alphaColor(theme.cyan, 0.3);
    theme.fontRing = `500 8px ${family}`;
    theme.fontTick = `600 8px ${family}`;
    theme.fontCardinal = `700 9px ${family}`;
    theme.fontBanner = `700 14px ${family}`;
  }

  #paint() {
    const ctx = this.#ctx;
    if (!ctx || !this.#canvas || !this.#laidOut) return;
    const radius = this.#radius;
    if (!(radius > 0)) return;

    const theme = this.#theme;
    const cx = radius;
    const cy = radius;
    const scale = this.#scale;
    const dimmed = this.#banner !== "";
    const baseAlpha = dimmed ? DIM_ALPHA : 1;

    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, radius * 2, radius * 2);
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    ctx.setLineDash(NO_DASH);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Disc and rim.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.borderBright;
    ctx.stroke();

    ctx.globalAlpha = baseAlpha;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1, 0, TAU);
    ctx.clip();

    this.#paintRings(ctx, cx, cy, radius, theme);
    this.#paintWeapons(ctx, cx, cy, radius, scale, theme);
    this.#paintMarker(ctx, cx, cy, radius, scale, this.#activeRange, this.#activeLabel, DASH_ACTIVE, theme.active);
    this.#paintMarker(ctx, cx, cy, radius, scale, this.#passiveRange, this.#passiveLabel, DASH_PASSIVE, theme.passive);
    this.#paintTicks(ctx, cx, cy, radius, theme);
    if (!dimmed) this.#paintSweep(ctx, cx, cy, radius, theme);

    ctx.restore();
    ctx.globalAlpha = baseAlpha;

    this.#paintBlips(ctx, cx, cy, radius, scale, baseAlpha, theme);
    this.#paintRipple(ctx, cx, cy, radius, theme);

    if (dimmed) {
      ctx.globalAlpha = 1;
      ctx.font = theme.fontBanner;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.muted;
      ctx.fillText(this.#banner, cx, cy - BANNER_INSET);
      return;
    }

    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = theme.cyan;
    ctx.beginPath();
    ctx.moveTo(cx, cy - OWN_SHIP_LENGTH);
    ctx.lineTo(cx + OWN_SHIP_HALF, cy + OWN_SHIP_LENGTH);
    ctx.lineTo(cx, cy + 3);
    ctx.lineTo(cx - OWN_SHIP_HALF, cy + OWN_SHIP_LENGTH);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  #paintRings(ctx, cx, cy, radius, theme) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.border;
    ctx.font = theme.fontRing;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.muted;
    ctx.setLineDash(NO_DASH);
    for (const ring of this.#rings) {
      const ringRadius = radius * ring.factor;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, TAU);
      ctx.stroke();
      // The rim-adjacent ring's value is already in the zoom readout, and its
      // label would sit on the cardinal row.
      if (ringRadius > radius - RIM_LABEL_GAP) continue;
      ctx.textAlign = "center";
      ctx.fillText(
        ring.label,
        cx,
        rimLabelY(cy - ringRadius + RING_LABEL_INSET + RING_LABEL_CLEARANCE, cy, radius),
      );
      ctx.textAlign = "left";
    }
  }

  #paintWeapons(ctx, cx, cy, radius, scale, theme) {
    const ranges = this.#radar?.weaponRanges;
    if (!Array.isArray(ranges) || !ranges.length) return;
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.weapon;
    ctx.setLineDash(DASH_WEAPON);
    ctx.font = theme.fontRing;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.weapon;
    for (const weapon of ranges) {
      const value = finiteNumber(weapon?.value);
      if (!(value > 0) || value > scale) continue;
      const ringRadius = radius * value / scale;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, TAU);
      ctx.stroke();
      ctx.fillText(
        String(weapon.label ?? formatRange(value)),
        cx + ringRadius * WEAPON_LABEL_DIAGONAL + 4,
        cy - ringRadius * WEAPON_LABEL_DIAGONAL,
      );
    }
    ctx.setLineDash(NO_DASH);
  }

  #paintMarker(ctx, cx, cy, radius, scale, value, label, dash, color) {
    if (!(value > 0) || value > scale) return;
    const ringRadius = radius * value / scale;
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.font = this.#theme.fontRing;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    if (ringRadius <= radius - RIM_LABEL_GAP) {
      ctx.textAlign = "center";
      ctx.fillText(
        label,
        cx,
        rimLabelY(cy + ringRadius - RING_LABEL_INSET - RING_LABEL_CLEARANCE, cy, radius),
      );
      ctx.textAlign = "left";
      return;
    }
    ctx.textAlign = "right";
    ctx.fillText(label, cx - 4, rimLabelY(cy - ringRadius + RING_LABEL_INSET + 22, cy, radius));
    ctx.textAlign = "left";
  }

  #paintTicks(ctx, cx, cy, radius, theme) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.borderBright;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (let index = 0; index < TICK_COUNT; index++) {
      const angle = index * TICK_STEP * DEGREE - HALF_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(cx + cos * (radius - TICK_INNER), cy + sin * (radius - TICK_INNER));
      ctx.lineTo(cx + cos * radius, cy + sin * radius);
      ctx.stroke();
      const cardinal = index % 3 === 0;
      ctx.font = cardinal ? theme.fontCardinal : theme.fontTick;
      ctx.fillStyle = cardinal ? theme.cyan : theme.muted;
      ctx.fillText(
        TICK_LABELS[index],
        cx + cos * (radius - TICK_INSET),
        cy + sin * (radius - TICK_INSET),
      );
    }
  }

  #paintSweep(ctx, cx, cy, radius, theme) {
    const angle = this.#reduceMotion ? SWEEP_STATIC : this.#sweepAngle;
    const gradient = ctx.createConicGradient(angle - SWEEP_TRAIL, cx, cy);
    const bright = SWEEP_TRAIL / TAU;
    gradient.addColorStop(0, theme.sweepClear);
    gradient.addColorStop(bright, theme.sweepBright);
    gradient.addColorStop(Math.min(1, bright + 0.002), theme.sweepClear);
    gradient.addColorStop(1, theme.sweepClear);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = theme.cyan;
    ctx.lineWidth = 2;
    ctx.shadowColor = theme.cyan;
    ctx.shadowBlur = SWEEP_BLUR;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.stroke();
    ctx.restore();
  }

  #paintBlips(ctx, cx, cy, radius, scale, baseAlpha, theme) {
    const contacts = this.#contacts;
    const plots = this.#plots;
    const animating = this.#animating();
    const highlighted = this.#focusedUuid || this.#hoveredUuid;
    const viewScale = Number(this.#radar?.scale) > 0 ? Number(this.#radar.scale) : scale;

    for (let index = 0; index < contacts.length; index++) {
      const plot = plots[index];
      if (!plot) continue;
      const contact = contacts[index];
      const x = cx + plot.u * radius;
      const y = cy + plot.v * radius;
      const targeted = contact.targeted === true;
      const stale = contact.stale === true && !targeted;
      const hoisted = plot.hoisted === true;
      const color = targeted ? theme.red : contact.live === true ? theme.amber : theme.muted;
      const blipRadius = targeted ? BLIP_RADIUS_TARGETED : BLIP_RADIUS;
      const punch = targeted ? 1 : stale ? STALE_ALPHA : 1;

      let blur = 0;
      let glow = 0;
      if (animating) {
        const passDelta = ((this.#sweepAngle - Math.atan2(plot.v, plot.u)) % TAU + TAU) % TAU;
        glow = Math.max(0, 1 - (passDelta / SWEEP_SPEED) / PULSE_DECAY);
        if (passDelta <= PULSE_WINDOW) blur = PULSE_BLUR * glow;
        const flash = this.#flashStrength(contact.targetUuid);
        if (flash > glow) glow = flash;
      }

      ctx.globalAlpha = baseAlpha * punch;
      ctx.setLineDash(NO_DASH);
      // A hoisted contact sits on the rim, where the disc, stale outline, lock
      // ring and jam arc would all stack under the arrow: draw the arrow alone.
      if (stale && !hoisted) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.setLineDash(DASH_STALE);
        ctx.beginPath();
        ctx.arc(x, y, blipRadius, 0, TAU);
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
      } else if (!hoisted) {
        ctx.fillStyle = color;
        if (blur > 0) {
          ctx.shadowColor = color;
          ctx.shadowBlur = blur;
        }
        ctx.beginPath();
        ctx.arc(x, y, blipRadius, 0, TAU);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (glow > 0) {
          // Overdrawing the text colour approximates a lerp toward white
          // without building a colour string per blip per frame.
          ctx.globalAlpha = baseAlpha * punch * glow;
          ctx.fillStyle = theme.text;
          ctx.beginPath();
          ctx.arc(x, y, blipRadius, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = baseAlpha * punch;
        }
        if (targeted) {
          ctx.strokeStyle = theme.red;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, blipRadius + LOCK_RING_OFFSET, 0, TAU);
          ctx.stroke();
        }
        if (contact.jammed === true) {
          ctx.strokeStyle = theme.muted;
          ctx.lineWidth = 1.5;
          ctx.setLineDash(DASH_INTERFERENCE);
          ctx.beginPath();
          ctx.arc(x, y, blipRadius + INTERFERENCE_OFFSET, -HALF_PI - INTERFERENCE_SPAN, -HALF_PI + INTERFERENCE_SPAN);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
      }

      if (hoisted) {
        const length = Math.hypot(plot.u, plot.v) || 1;
        const nx = plot.u / length;
        const ny = plot.v / length;
        const baseX = x - nx * HOIST_LENGTH;
        const baseY = y - ny * HOIST_LENGTH;
        const perpX = -ny * HOIST_HALF;
        const perpY = nx * HOIST_HALF;
        ctx.strokeStyle = color;
        ctx.lineWidth = HOIST_WIDTH;
        if (blur > 0) {
          ctx.shadowColor = color;
          ctx.shadowBlur = blur;
        }
        ctx.beginPath();
        ctx.moveTo(baseX + perpX, baseY + perpY);
        ctx.lineTo(x, y);
        ctx.lineTo(baseX - perpX, baseY - perpY);
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (glow > 0) {
          // Same white overdraw as the disc, so the arrow pulses with the sweep.
          ctx.globalAlpha = baseAlpha * punch * glow;
          ctx.strokeStyle = theme.text;
          ctx.beginPath();
          ctx.moveTo(baseX + perpX, baseY + perpY);
          ctx.lineTo(x, y);
          ctx.lineTo(baseX - perpX, baseY - perpY);
          ctx.stroke();
          ctx.globalAlpha = baseAlpha * punch;
        }
      }

      if (highlighted && String(contact.targetUuid ?? "") === highlighted) {
        ctx.globalAlpha = baseAlpha;
        ctx.strokeStyle = theme.cyan;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(DASH_HIGHLIGHT);
        ctx.shadowColor = theme.cyan;
        ctx.shadowBlur = HIGHLIGHT_BLUR;
        ctx.beginPath();
        ctx.arc(x, y, blipRadius + HIGHLIGHT_OFFSET, 0, TAU);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash(NO_DASH);
      }
      ctx.globalAlpha = baseAlpha;

      const velocity = contact.velocity;
      if (!velocity || stale || contact.unknown === true) continue;
      const vx = finiteNumber(velocity.u);
      const vy = finiteNumber(velocity.v);
      const length = Math.hypot(vx, vy);
      if (length <= 1e-6) continue;
      const dirX = vx / length;
      const dirY = vy / length;
      const pixels = Math.min(VECTOR_MAX, length * viewScale / scale * radius);
      const tipX = x + dirX * pixels;
      const tipY = y + dirY * pixels;
      const head = Math.atan2(dirY, dirX);
      ctx.strokeStyle = theme.cyan;
      ctx.lineWidth = VECTOR_WIDTH;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tipX, tipY);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(head - 0.4) * VECTOR_HEAD, tipY - Math.sin(head - 0.4) * VECTOR_HEAD);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(head + 0.4) * VECTOR_HEAD, tipY - Math.sin(head + 0.4) * VECTOR_HEAD);
      ctx.stroke();
    }
    ctx.globalAlpha = baseAlpha;
  }

  #paintRipple(ctx, cx, cy, radius, theme) {
    if (!this.#animating() || this.#rippleAt < 0) return;
    const progress = (this.#clock - this.#rippleAt) / RIPPLE_SECONDS;
    if (progress >= 1) {
      this.#rippleAt = -1;
      return;
    }
    if (progress < 0) return;
    ctx.globalAlpha = RIPPLE_ALPHA * (1 - progress);
    ctx.strokeStyle = theme.cyan;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(NO_DASH);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * progress, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  #flashStrength(uuid) {
    const started = this.#flash.get(uuid);
    if (started === undefined) return 0;
    const progress = (this.#clock - started) / FLASH_SECONDS;
    if (progress >= 1) {
      this.#flash.delete(uuid);
      return 0;
    }
    if (progress < 0) return 0;
    return (1 - progress) * Math.abs(Math.sin(TAU * progress));
  }

  /*
   * Loop.
   */

  #animating() {
    return this.#frameId !== null && !this.#reduceMotion;
  }

  #startLoop() {
    // The media query can flip between renders; setStage() carries the previous
    // stage's frame over, so the reduced-motion answer decides here rather than
    // letting a sweep keep animating after the setting changed.
    if (this.#reduceMotion) {
      this.#stopLoop();
      return;
    }
    if (this.#frameId !== null || !this.#canvas) return;
    this.#lastTime = 0;
    this.#frameId = requestAnimationFrame(this.#frame);
  }

  #stopLoop() {
    if (this.#frameId !== null) {
      cancelAnimationFrame(this.#frameId);
      this.#frameId = null;
    }
    this.#lastTime = 0;
  }

  #frame = (time) => {
    if (!this.#canvas?.isConnected || !this.#ctx) {
      // The sheet moved on without calling destroy(); drop the frame instead of
      // rescheduling a loop that can never paint. setStage() restarts it.
      this.#stopLoop();
      return;
    }
    this.#frameId = requestAnimationFrame(this.#frame);
    if (document.hidden) return;
    if (!this.#laidOut) {
      // A hidden panel measures 0x0. Retrying layout every frame would query it at
      // frame rate, so retry at a fixed cadence until the panel is back.
      if (this.#lastLayoutAttempt !== 0 &&
        time - this.#lastLayoutAttempt < LAYOUT_RETRY_MS) return;
      this.#lastLayoutAttempt = time;
      if (!this.#size()) return;
    }
    const last = this.#lastTime;
    if (last !== 0 && time - last < FRAME_MS) return;
    let delta = last === 0 ? 0 : (time - last) / 1000;
    this.#lastTime = time;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    this.#clock += delta;
    if (delta > 0) this.#sweepAngle = (this.#sweepAngle + SWEEP_SPEED * delta) % TAU;
    this.#paint();
  };

  /*
   * Input.
   */

  #stepPreset(zoomIn) {
    const presets = this.#presets;
    if (!presets.length) return;
    const scale = this.#scale;
    let next = null;
    if (zoomIn) {
      for (let index = presets.length - 1; index >= 0; index--) {
        if (presets[index] < scale) {
          next = presets[index];
          break;
        }
      }
    } else {
      for (let index = 0; index < presets.length; index++) {
        if (presets[index] > scale) {
          next = presets[index];
          break;
        }
      }
    }
    if (next === null) next = zoomIn ? presets[0] : presets[presets.length - 1];
    this.setScale(next);
  }

  #onWheel = (event) => {
    if (!this.#radar) return;
    event.preventDefault();
    const delta = finiteNumber(event.deltaY);
    if (delta === 0) return;
    this.#stepPreset(delta < 0);
  };

  #onZoomClick = (event) => {
    const chip = event.target?.closest?.("[data-radar-zoom-preset],[data-radar-zoom-auto]");
    if (!chip || !this.#zoom?.contains(chip)) return;
    event.preventDefault();
    const preset = chip.dataset.radarZoomPreset;
    this.setScale(preset == null ? null : Number(preset));
  };

  #hitButton(node) {
    const button = node?.closest?.("[data-sensor-focus]");
    return button && this.#hits?.contains(button) ? button : null;
  }

  #onPointerOver = (event) => {
    const button = this.#hitButton(event.target);
    if (button) this.#setHover(button.dataset.sensorFocus ?? "");
  };

  #onPointerOut = (event) => {
    const button = this.#hitButton(event.target);
    if (!button) return;
    const related = event.relatedTarget;
    if (related && button.contains(related)) return;
    if (this.#hoveredUuid === (button.dataset.sensorFocus ?? "")) this.#setHover("");
  };

  #onFocusIn = (event) => {
    const button = this.#hitButton(event.target);
    if (button) this.#setFocus(button.dataset.sensorFocus ?? "");
  };

  #onFocusOut = (event) => {
    const button = this.#hitButton(event.target);
    if (button && this.#focusedUuid === (button.dataset.sensorFocus ?? "")) this.#setFocus("");
  };

  #setHover(uuid) {
    if (this.#hoveredUuid === uuid) return;
    this.#hoveredUuid = uuid;
    // Without the loop (reduced motion) a hover must repaint on its own.
    if (!this.#animating()) this.#paint();
  }

  #setFocus(uuid) {
    if (this.#focusedUuid === uuid) return;
    this.#focusedUuid = uuid;
    if (!this.#animating()) this.#paint();
  }

  #onResize = () => {
    if (this.#resizeFrame !== null) return;
    this.#resizeFrame = requestAnimationFrame(this.#onResizeFrame);
  };

  #onResizeFrame = () => {
    this.#resizeFrame = null;
    this.#readTheme();
    this.#size();
    this.#paint();
  };

  #onMotionChange = (event) => {
    this.#reduceMotion = event.matches === true;
    if (this.#reduceMotion) {
      this.#stopLoop();
      this.#paint();
      return;
    }
    this.#startLoop();
  };
}

function presetValues(radar) {
  const presets = radar?.presets;
  const derived = presetLadder(
    finiteNumber(radar?.maximum, RADAR_LIMITS.maximum),
    { minimum: finiteNumber(radar?.minimum, RADAR_LIMITS.minimum) },
  );
  if (!Array.isArray(presets) || !presets.length) return derived;
  const values = [];
  for (const preset of presets) {
    const value = Number(preset?.value);
    if (Number.isFinite(value) && value > 0 && !values.includes(value)) values.push(value);
  }
  if (!values.length) return derived;
  return values.sort((left, right) => left - right);
}
