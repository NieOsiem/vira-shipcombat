/**
 * Pure radar geometry for the sensors dial.
 *
 * One implementation is shared by the sheet view model (first Handlebars
 * placement), the canvas renderer (every animation frame) and the unit tests,
 * so a contact can never be drawn in one place and clicked in another.
 *
 * Dial coordinates: u/v in [-1, 1] with (0, 0) at own ship; |(u, v)| = 1 is
 * the rim, which represents `scale` Distance Units (1 DU = one grid interval,
 * per scene-geometry.js). +x is starboard, +y is astern, FORE is up.
 *
 * Bearings are FORE-relative degrees, clockwise positive, normalized to
 * [-180, 180) to match the struck-sector convention in the rules draft.
 */

export const GREEK_DESIGNATORS = Object.freeze([
  "ALPHA",
  "BETA",
  "GAMMA",
  "DELTA",
  "EPSILON",
  "ZETA",
  "ETA",
  "THETA",
  "IOTA",
  "KAPPA",
  "LAMBDA",
  "MU",
  "NU",
  "XI",
  "OMICRON",
  "PI",
  "RHO",
  "SIGMA",
  "TAU",
  "UPSILON",
  "PHI",
  "CHI",
  "PSI",
  "OMEGA",
]);

export const RADAR_LIMITS = Object.freeze({
  minimum: 5,
  maximum: 150,
  fitPadding: 1.15,
  divisions: 5,
});

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Rotate a world delta into dial space: FORE up, +x starboard, +y astern. */
export function screenOffset(dx, dy, facingDeg = 0) {
  const radians = -finiteNumber(facingDeg) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: (dx * cos) - (dy * sin),
    y: (dx * sin) + (dy * cos),
  };
}

/** FORE-relative bearing in degrees, clockwise positive, [-180, 180). */
export function bearingRelDegrees(x, y) {
  const degrees = Math.atan2(finiteNumber(x), -finiteNumber(y)) * 180 / Math.PI;
  return degrees === 180 ? -180 : degrees;
}

/**
 * World delta plus own-ship facing into a dial-space offset and bearing.
 * Returns null without a usable pair of positions.
 */
export function relativeVector({ position, origin, facingDeg = 0 } = {}) {
  const px = finiteNumber(position?.x, Number.NaN);
  const py = finiteNumber(position?.y, Number.NaN);
  const ox = finiteNumber(origin?.x, Number.NaN);
  const oy = finiteNumber(origin?.y, Number.NaN);
  if (!Number.isFinite(px) || !Number.isFinite(py) ||
    !Number.isFinite(ox) || !Number.isFinite(oy)) return null;
  const dx = px - ox;
  const dy = py - oy;
  const offset = screenOffset(dx, dy, facingDeg);
  return {
    dx,
    dy,
    x: offset.x,
    y: offset.y,
    distance: Math.hypot(dx, dy),
    bearingRel: bearingRelDegrees(offset.x, offset.y),
  };
}

/**
 * Dial point for an offset. Contacts beyond the displayed range are hoisted
 * onto the rim along their true bearing instead of being silently clamped.
 */
export function dialPoint(relative, scale) {
  const span = Math.max(1e-6, finiteNumber(scale, RADAR_LIMITS.minimum));
  const x = finiteNumber(relative?.x);
  const y = finiteNumber(relative?.y);
  const length = Math.hypot(x, y);
  if (length <= 1e-9) return { u: 0, v: 0, hoisted: false };
  const hoisted = finiteNumber(relative?.distance) > span;
  const factor = hoisted ? 1 / length : 1 / span;
  return { u: x * factor, v: y * factor, hoisted };
}

export function projectContact({ position, origin, facingDeg = 0, scale } = {}) {
  const relative = relativeVector({ position, origin, facingDeg });
  if (!relative) {
    return {
      u: 0,
      v: 0,
      distance: 0,
      bearingRel: 0,
      hoisted: false,
      unknown: true,
    };
  }
  const point = dialPoint(relative, scale);
  return {
    u: point.u,
    v: point.v,
    hoisted: point.hoisted,
    distance: relative.distance,
    bearingRel: relative.bearingRel,
    unknown: false,
  };
}

/** Inverse of relativeVector's bearing: a dial point from range and bearing. */
export function dialFromBearing(distance, bearingRel, scale) {
  const range = Math.max(0, finiteNumber(distance));
  const radians = finiteNumber(bearingRel) * Math.PI / 180;
  return dialPoint({
    x: Math.sin(radians) * range,
    y: -Math.cos(radians) * range,
    distance: range,
  }, scale);
}

/** Dial point as percentages of the dial box, for the DOM hit layer. */
export function dialPercent(u, v) {
  return {
    x: 50 + (finiteNumber(u) * 50),
    y: 50 + (finiteNumber(v) * 50),
  };
}

export function radarPercentStyle(u, v) {
  const point = dialPercent(u, v);
  return `--contact-x:${point.x.toFixed(2)}%;--contact-y:${point.y.toFixed(2)}%`;
}

export function clampScale(value, limits = {}) {
  const minimum = finiteNumber(limits.minimum, RADAR_LIMITS.minimum);
  const maximum = Math.max(minimum, finiteNumber(limits.maximum, RADAR_LIMITS.maximum));
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, minimum)));
}

export function isAutoScale(value) {
  return value == null || !Number.isFinite(Number(value)) || Number(value) <= 0;
}

/** Auto-fit: the furthest shown contact lands inside the rim, never on it. */
export function autoScale(distances, limits = {}) {
  const minimum = finiteNumber(limits.minimum, RADAR_LIMITS.minimum);
  const maximum = Math.max(minimum, finiteNumber(limits.maximum, RADAR_LIMITS.maximum));
  const padding = Math.max(1, finiteNumber(limits.fitPadding, RADAR_LIMITS.fitPadding));
  let furthest = 0;
  for (const value of Array.isArray(distances) ? distances : []) {
    const distance = Number(value);
    if (Number.isFinite(distance) && distance > furthest) furthest = distance;
  }
  if (furthest <= 0) return minimum;
  return clampScale(furthest * padding, { minimum, maximum });
}

/**
 * Zoom ladder for one ship's sensor envelope. The envelope is power-tier and
 * fault scaled, so a fixed ladder would misrepresent how far the operator can
 * actually see: derive 1/2/5 x 10^n stops below the exact maximum instead.
 */
export function presetLadder(maximum, options = {}) {
  const minimum = Math.max(1, finiteNumber(options.minimum, RADAR_LIMITS.minimum));
  const span = Math.max(minimum, finiteNumber(maximum, minimum));
  const chips = Math.max(2, Math.trunc(finiteNumber(options.chips, 6)));
  const nice = [];
  for (let decade = 1; decade <= span; decade *= 10) {
    for (const step of [1, 2, 5]) {
      const value = step * decade;
      if (value <= span) nice.push(value);
    }
  }
  const below = nice
    .filter((value) => value >= minimum && value < span)
    .slice(-(chips - 1));
  return [...new Set([...below, span])].sort((left, right) => left - right);
}

export function ringValues(scale, divisions = RADAR_LIMITS.divisions) {
  const span = Math.max(0, finiteNumber(scale));
  const count = Math.max(1, Math.trunc(finiteNumber(divisions, RADAR_LIMITS.divisions)));
  const rings = [];
  for (let index = 1; index <= count; index++) rings.push(span * index / count);
  return rings;
}

export function formatRange(value) {
  const number = finiteNumber(value);
  return number >= 10 ? String(Math.round(number)) : String(Math.round(number * 10) / 10);
}

/**
 * Designators are a pure function of the target uuid, so a contact keeps its
 * name for the whole fight no matter how the track map or render order
 * changes. Collisions probe the next free Greek letter in a deterministic
 * order, so callers must assign over a stable (uuid-sorted) sequence.
 */
export function designatorFor(targetUuid, used = []) {
  const key = String(targetUuid ?? "");
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  const taken = new Set(Array.isArray(used) ? used : []);
  for (let step = 0; step < GREEK_DESIGNATORS.length; step++) {
    const candidate = GREEK_DESIGNATORS[(hash + step) % GREEK_DESIGNATORS.length];
    if (!taken.has(candidate)) return candidate;
  }
  return "";
}

export function designatorLabel(designator) {
  const name = String(designator ?? "").trim();
  return name ? `CONTACT-${name}` : "CONTACT";
}
