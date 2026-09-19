export const EPSILON = 1e-9;
export const ANGLE_EPSILON = 1e-7;

/** @param {number} value @param {number} minimum @param {number} maximum @returns {number} */
export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** @param {number} start @param {number} end @param {number} fraction @returns {number} */
export function lerp(start, end, fraction) {
  return start + ((end - start) * fraction);
}

/** @param {number} value @returns {number} */
export function roundHalfAwayFromZero(value) {
  if (!Number.isFinite(value)) return value;
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

/** @param {number} value @param {number} places @returns {number} */
export function roundTo(value, places = 9) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** places;
  return roundHalfAwayFromZero(value * scale) / scale;
}

/** @param {number} value @param {number} epsilon @returns {number} */
export function snapNearZero(value, epsilon = EPSILON) {
  return Math.abs(value) <= epsilon ? 0 : value;
}

/** @param {number} degrees @returns {number} */
export function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/** @param {number} radians @returns {number} */
export function toDegrees(radians) {
  return radians * (180 / Math.PI);
}

/** @param {number} degrees @returns {number} */
export function normalizeAngle(degrees) {
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/** @param {number} degrees @returns {number} */
export function normalizeHeading(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/** @param {number} from @param {number} to @returns {number} */
export function shortestAngleDelta(from, to) {
  return normalizeAngle(to - from);
}

/** @param {{x:number,y:number}} value @returns {{x:number,y:number}} */
export function vector(value = { x: 0, y: 0 }) {
  return { x: Number(value.x) || 0, y: Number(value.y) || 0 };
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @returns {{x:number,y:number}} */
export function add(left, right) {
  return { x: left.x + right.x, y: left.y + right.y };
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @returns {{x:number,y:number}} */
export function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y };
}

/** @param {{x:number,y:number}} value @param {number} scalar @returns {{x:number,y:number}} */
export function scale(value, scalar) {
  return { x: value.x * scalar, y: value.y * scalar };
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @returns {number} */
export function dot(left, right) {
  return (left.x * right.x) + (left.y * right.y);
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @returns {number} */
export function cross(left, right) {
  return (left.x * right.y) - (left.y * right.x);
}

/** @param {{x:number,y:number}} value @returns {number} */
export function magnitudeSquared(value) {
  return dot(value, value);
}

/** @param {{x:number,y:number}} value @returns {number} */
export function magnitude(value) {
  return Math.hypot(value.x, value.y);
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @returns {number} */
export function distanceSquared(left, right) {
  return magnitudeSquared(subtract(left, right));
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @returns {number} */
export function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/** @param {{x:number,y:number}} value @param {{x:number,y:number}} fallback @returns {{x:number,y:number}} */
export function normalize(value, fallback = { x: 1, y: 0 }) {
  const length = magnitude(value);
  if (length <= EPSILON) return vector(fallback);
  return scale(value, 1 / length);
}

/** @param {{x:number,y:number}} value @returns {{x:number,y:number}} */
export function perpendicularClockwise(value) {
  return { x: -value.y, y: value.x };
}

/** @param {{x:number,y:number}} value @returns {{x:number,y:number}} */
export function perpendicularCounterclockwise(value) {
  return { x: value.y, y: -value.x };
}

/** @param {{x:number,y:number}} value @param {number} degrees @returns {{x:number,y:number}} */
export function rotateVector(value, degrees) {
  const radians = toRadians(degrees);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: (value.x * cosine) - (value.y * sine),
    y: (value.x * sine) + (value.y * cosine),
  };
}

/** @param {number} facing @returns {{x:number,y:number}} */
export function forwardVector(facing) {
  const radians = toRadians(facing);
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/** @param {number} facing @returns {{x:number,y:number}} */
export function starboardVector(facing) {
  const radians = toRadians(facing);
  return { x: Math.cos(radians), y: Math.sin(radians) };
}

/** @param {{x:number,y:number}} local @param {number} facing @returns {{x:number,y:number}} */
export function localToWorld(local, facing) {
  return add(scale(starboardVector(facing), local.x), scale(forwardVector(facing), local.y));
}

/** @param {{x:number,y:number}} world @param {number} facing @returns {{x:number,y:number}} */
export function worldToLocal(world, facing) {
  return { x: dot(world, starboardVector(facing)), y: dot(world, forwardVector(facing)) };
}

/** @param {{x:number,y:number}} from @param {{x:number,y:number}} to @param {{x:number,y:number}} [coincidentNormal] @returns {number} */
export function bearingDegrees(from, to, coincidentNormal) {
  const delta = subtract(to, from);
  if (magnitudeSquared(delta) <= EPSILON * EPSILON) {
    if (
      coincidentNormal
      && Number.isFinite(coincidentNormal.x)
      && Number.isFinite(coincidentNormal.y)
      && magnitudeSquared(coincidentNormal) > EPSILON * EPSILON
    ) {
      return normalizeAngle(toDegrees(Math.atan2(coincidentNormal.x, -coincidentNormal.y)));
    }
    return 0;
  }
  return normalizeAngle(toDegrees(Math.atan2(delta.x, -delta.y)));
}

/** @param {{x:number,y:number}} left @param {{x:number,y:number}} right @param {number} epsilon @returns {boolean} */
export function nearlyEqualVector(left, right, epsilon = EPSILON) {
  return Math.abs(left.x - right.x) <= epsilon && Math.abs(left.y - right.y) <= epsilon;
}
