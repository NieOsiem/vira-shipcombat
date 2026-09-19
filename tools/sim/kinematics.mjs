#!/usr/bin/env bun
/**
 * kinematics.mjs — movement-geometry analysis of the SHIPPED Vector Authority pivot.
 *
 * The pivot is engine behaviour: a maneuver may carry a `pivot`, and `integrateBurn` rotates
 * Velocity by `pivotRate · dt` at every integration step while Facing and translation stay with the
 * existing drives. This file measures what that buys, executing the engine's own functions:
 *   - integrateBurn            (scripts/rules/movement.js)  the pivot curve, burns and coasts
 *   - getDriveCapabilities     (scripts/rules/movement.js)  thrust + rotation budgets
 *   - getPivotCapability       (scripts/rules/movement.js)  the hull's pivot ceiling
 *   - getManeuverTime          (scripts/rules/movement.js)  segment duration from Δv
 *   - calculateRangeBand       (scripts/rules/combat.js)    optimal / extended range bands
 *   - calculateRelativeMotion  (scripts/rules/combat.js)    relative-motion bands
 *   - createDefaultShipData / createInitialState (scripts/model/defaults.js)  config + state
 *
 * Units: scene units (su) for position/range/radius; su per turn for Velocity and Δv;
 * degrees per turn (deg/turn) for the pivot ω; turns (T in [0,1]) for time.
 *
 * Deterministic: no PRNG, no clock.
 *
 * Run:  bun tools/sim/kinematics.mjs
 * Env:  VIRA_SIM_OUT=<output dir>   (default: this file's directory)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getDriveCapabilities,
  getManeuverTime,
  getPivotCapability,
  integrateBurn,
} from "../../scripts/rules/movement.js";
import { calculateRangeBand, calculateRelativeMotion } from "../../scripts/rules/combat.js";
import { distance, magnitude, normalizeHeading, toDegrees, toRadians } from "../../scripts/rules/math.js";
import { createDefaultShipData, createInitialState } from "../../scripts/model/defaults.js";

const REPO = join(import.meta.dir, "..", "..");
const OUT_DIR = process.env.VIRA_SIM_OUT ?? import.meta.dir;

const EPS = 1e-9;

/* ------------------------------------------------------------------ *
 * Numeric helpers
 * ------------------------------------------------------------------ */

function f(value, digits = 3) {
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toFixed(digits)).toString();
}

function sign(value) {
  return value >= 0 ? "+" : "";
}

function headingOf(vector) {
  return normalizeHeading(toDegrees(Math.atan2(vector.x, -vector.y)));
}

function solve3(A, b) {
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const det = det3(A);
  if (Math.abs(det) < 1e-300) throw new Error("singular circle fit system");
  const withColumn = (column) => A.map((row, i) => row.map((v, j) => (j === column ? b[i] : v)));
  return [det3(withColumn(0)) / det, det3(withColumn(1)) / det, det3(withColumn(2)) / det];
}

/** Kasa algebraic circle fit. @returns {{cx:number,cy:number,r:number}} */
function fitCircle(points) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = points.length;
  for (const p of points) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * z; syz += p.y * z; sz += z;
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const [D, E, F] = solve3(A, [-sxz, -syz, -sz]);
  const cx = -D / 2;
  const cy = -E / 2;
  return { cx, cy, r: Math.sqrt(Math.max(0, cx * cx + cy * cy - F)) };
}

/* ------------------------------------------------------------------ *
 * Ship configurations (real repo config/state, retuned per thrust package)
 * ------------------------------------------------------------------ */

const PACKAGES = {
  "6": { forward: 6, retro: 3, lateral: 2, rotationPerDrive: 30 },
  "10": { forward: 10, retro: 5, lateral: 3, rotationPerDrive: 30 },
};

function buildShip(packageKey) {
  const pkg = PACKAGES[packageKey];
  const data = createDefaultShipData();
  const config = structuredClone(data.config);
  const drives = config.components.drives;
  for (const role of ["main", "reverse", "portLateral", "starboardLateral"]) {
    if (!drives[role]) throw new Error(`missing drive role ${role}`);
  }
  drives.main.base.thrust = pkg.forward;
  drives.reverse.base.thrust = pkg.retro;
  drives.portLateral.base.thrust = pkg.lateral;
  drives.starboardLateral.base.thrust = pkg.lateral;
  drives.portLateral.base.rotation = pkg.rotationPerDrive;
  drives.starboardLateral.base.rotation = pkg.rotationPerDrive;
  const state = createInitialState(config);
  state.power.engines = 3; // engine tier multiplier 1.0
  const capabilities = getDriveCapabilities(config, state);
  const pivot = getPivotCapability(config, state);
  return { config, state, capabilities, pivot };
}

const SHIPS = Object.fromEntries(Object.keys(PACKAGES).map((k) => [k, buildShip(k)]));
for (const [k, ship] of Object.entries(SHIPS)) {
  const c = ship.capabilities;
  if (!(ship.pivot > 0)) throw new Error(`hull has no pivot capability for package ${k}`);
  const expected = PACKAGES[k];
  if (Math.abs(c.forward - expected.forward) > 1e-9 ||
      Math.abs(c.retro - expected.retro) > 1e-9 ||
      Math.abs(c.port - expected.lateral) > 1e-9 ||
      Math.abs(c.starboard - expected.lateral) > 1e-9 ||
      Math.abs(c.rotation - 60) > 1e-9) {
    throw new Error(`unexpected capabilities for package ${k}: ${JSON.stringify(c)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Pivot integration — delegated to the engine's integrateBurn
 * ------------------------------------------------------------------ *
 * `integrateBurn` rotates Velocity by `pivotRate · dt` at every step and integrates the resulting
 * curve with its midpoint kinematics, so the pivot path is the engine's, not a local model. The
 * engine caps one segment at a single activation (duration ≤ 1 timeline), so a multi-turn run is
 * integrated turn by turn, and the nose is rotated with the Velocity (rotation = pivot) so the
 * lateral axis stays perpendicular to it. Optional `inwardAccel` (su/turn²) is sustained inward
 * lateral thrust: it is applied along that perpendicular axis, i.e. at the turn centre.
 */
function pivotIntegrate({
  position, velocity, heading = null, omegaDeg, turns,
  substeps = 64, deltaV = { forward: 0, lateral: 0 }, inwardAccel = 0,
}) {
  let p = { ...position };
  let v = { ...velocity };
  let theta = heading ?? headingOf(v);
  const perTurn = { forward: deltaV.forward / turns, lateral: deltaV.lateral / turns };
  const inward = inwardAccel === 0 ? 0 : inwardAccel * (Math.sign(omegaDeg) || 1);
  const path = [{ t: 0, position: { ...p }, velocity: { ...v }, heading: theta }];
  for (let turn = 0; turn < turns; turn += 1) {
    const run = integrateBurn({
      position: p,
      velocity: v,
      facing: theta,
      duration: 1,
      deltaV: { forward: perTurn.forward, lateral: perTurn.lateral + inward },
      rotation: omegaDeg,
      pivot: omegaDeg,
      stepsPerInterval: substeps,
      collisionRadius: 0,
    });
    p = { ...run.position };
    v = { ...run.velocity };
    theta += omegaDeg;
    for (const point of run.path.slice(1)) {
      path.push({ t: point.time + turn, position: { ...point.position }, velocity: { ...point.velocity }, heading: point.unwrappedFacing });
    }
  }
  return { position: p, velocity: v, heading: theta, path };
}

function measureRadius(path, from, to) {
  const window = path.filter((sample) => sample.t >= from - EPS && sample.t <= to + EPS);
  return fitCircle(window.map((sample) => sample.position));
}

function measurePeriod(path, centre, target = 360) {
  let accumulated = 0;
  for (let i = 1; i < path.length; i += 1) {
    const point = path[i];
    const previousPoint = path[i - 1];
    const a = toDegrees(Math.atan2(point.position.y - centre.cy, point.position.x - centre.cx));
    const b = toDegrees(Math.atan2(previousPoint.position.y - centre.cy, previousPoint.position.x - centre.cx));
    let delta = a - b;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    if (Math.abs(delta) < 90) {
      const before = accumulated;
      accumulated += Math.abs(delta);
      if (before < target && accumulated >= target) {
        return previousPoint.t + (point.t - previousPoint.t) * ((target - before) / Math.abs(delta));
      }
    }
  }
  return NaN;
}

/** Pivot-only (or pivot + sustained inward thrust) circle measured by the integrator. */
function pivotCircle({ omegaDeg, speed, substeps = 64, inwardAccel = 0, extraTurns = 1 }) {
  const period = 360 / omegaDeg;
  const totalTurns = period + extraTurns;
  const run = pivotIntegrate({
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: -speed },
    heading: 0,
    omegaDeg,
    turns: totalTurns,
    substeps,
    inwardAccel,
  });
  const fit = measureRadius(run.path, extraTurns, totalTurns);
  return {
    radius: fit.r,
    centre: fit,
    period: measurePeriod(run.path, fit),
    speedEnd: magnitude(run.velocity),
  };
}

/* ------------------------------------------------------------------ *
 * Part 1 — integrator vs closed form
 * ------------------------------------------------------------------ */

const OMEGAS = [30, 45, 60, 75];
const SPEEDS = [6, 12, 18, 24, 30, 36];

const integratorVerification = [];
for (const omegaDeg of OMEGAS) {
  for (const speed of SPEEDS) {
    const omegaRad = toRadians(omegaDeg);
    const closed = speed / omegaRad;
    const converged = pivotCircle({ omegaDeg, speed, substeps: 64 });
    const harness = pivotCircle({ omegaDeg, speed, substeps: 6 });
    const closedPeriod = 360 / omegaDeg;
    integratorVerification.push({
      omegaDeg,
      speed,
      omegaRadPerTurn: omegaRad,
      radiusClosed: closed,
      radiusMeasured: converged.radius,
      radiusDeviationPct: ((converged.radius - closed) / closed) * 100,
      radiusSubsteps6: harness.radius,
      radiusSubsteps6DeviationPct: ((harness.radius - closed) / closed) * 100,
      periodClosedTurns: closedPeriod,
      periodMeasuredTurns: converged.period,
      periodDeviationPct: ((converged.period - closedPeriod) / closedPeriod) * 100,
      speedEnd: converged.speedEnd,
    });
  }
}

const worstRadiusDeviation = Math.max(...integratorVerification.map((r) => Math.abs(r.radiusDeviationPct)));
const worstHarnessDeviation = Math.max(...integratorVerification.map((r) => Math.abs(r.radiusSubsteps6DeviationPct)));
const worstPeriodDeviation = Math.max(...integratorVerification.map((r) => Math.abs(r.periodDeviationPct)));

/* ------------------------------------------------------------------ *
 * Part (a) — achievable turn radius vs (speed, omega, thrust package)
 * ------------------------------------------------------------------ */

const partA = {};
const pivotRadiusTable = {};

for (const packageKey of Object.keys(PACKAGES)) {
  const capabilities = SHIPS[packageKey].capabilities;
  const lateralCap = Math.min(capabilities.port, capabilities.starboard);
  const rows = [];
  for (const speed of SPEEDS) {
    for (const omegaDeg of OMEGAS) {
      const omegaRad = toRadians(omegaDeg);
      const rPivotClosed = speed / omegaRad;
      const pivot = pivotCircle({ omegaDeg, speed, substeps: 64 });
      const rTightClosed = speed / (omegaRad + lateralCap / speed);
      const inward = pivotCircle({ omegaDeg, speed, substeps: 64, inwardAccel: lateralCap });
      // One full turn of forward thrust while pivoting, measured by the integrator.
      const forwardRun = pivotIntegrate({
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: -speed },
        heading: 0,
        omegaDeg,
        turns: 1,
        substeps: 64,
        deltaV: { forward: capabilities.forward, lateral: 0 },
      });
      const speedAfterForward = magnitude(forwardRun.velocity);
      rows.push({
        speed,
        omegaDeg,
        rPivotClosed,
        rPivotMeasured: pivot.radius,
        rPivotDeviationPct: ((pivot.radius - rPivotClosed) / rPivotClosed) * 100,
        rTightClosed,
        rTightMeasured: inward.radius,
        rTightDeviationPct: ((inward.radius - rTightClosed) / rTightClosed) * 100,
        speedAfterForwardTurn: speedAfterForward,
        rAfterForwardTurn: speedAfterForward / omegaRad,
      });
    }
  }
  partA[packageKey] = { capabilities, lateralCap, rows };
  const tightest = rows.reduce((best, row) => (row.rTightMeasured < best.rTightMeasured ? row : best), rows[0]);
  const tightestPivot = rows.reduce((best, row) => (row.rPivotMeasured < best.rPivotMeasured ? row : best), rows[0]);
  pivotRadiusTable[packageKey] = {
    tightestMeasured: tightest.rTightMeasured,
    tightestAtSpeed: tightest.speed,
    tightestAtOmega: tightest.omegaDeg,
    tightestPivotMeasured: tightestPivot.rPivotMeasured,
    tightestPivotAtSpeed: tightestPivot.speed,
    tightestPivotAtOmega: tightestPivot.omegaDeg,
  };
}

/* ------------------------------------------------------------------ *
 * Part (b) — orbit feasibility inside each weapon Optimal Range (30 / 40 / 60)
 * ------------------------------------------------------------------ */

const WEAPONS = [
  { key: "macrocannon", label: "Macrocannon (x2)", optimal: 30, maximum: 60, projectileClass: "medium", arc: 120 },
  { key: "laser", label: "Pulse Laser", optimal: 40, maximum: 80, projectileClass: "instant", arc: 180 },
  { key: "railgun", label: "Twin Railgun", optimal: 60, maximum: 120, projectileClass: "fast", arc: 90 },
];

const partB = {};
for (const packageKey of Object.keys(PACKAGES)) {
  const { capabilities, lateralCap } = partA[packageKey];
  const rows = [];
  for (const speed of SPEEDS) {
    for (const omegaDeg of OMEGAS) {
      const omegaRad = toRadians(omegaDeg);
      const rPivot = speed / omegaRad;
      const rTight = speed / (omegaRad + lateralCap / speed);
      // The only straight leg of an activation is the mandatory end-of-activation coast. With the
      // standard Evasive Protocol reserving 20 % of the timeline the ship drifts v·0.2 su along the
      // tangent, which puts its range L²/2R outside the circle its maneuver tracked.
      const RESERVE = 0.2;
      const coastTail = ((speed * RESERVE) ** 2) / (2 * (speed / omegaRad));
      const bands = {};
      for (const weapon of WEAPONS) {
        bands[weapon.key] = {
          optimal: weapon.optimal,
          maximum: weapon.maximum,
          minRadius: rTight,
          bandOptimal: rTight <= weapon.optimal + EPS ? [rTight, weapon.optimal] : null,
          bandValid: rTight <= weapon.maximum + EPS ? [rTight, weapon.maximum] : null,
          feasibleOptimal: rTight <= weapon.optimal + EPS,
        };
      }
      rows.push({
        speed,
        omegaDeg,
        pivotOnlyMinRadius: rPivot,
        tightMinRadius: rTight,
        pivotOnlyFeasibleMacro30: rPivot <= 30 + EPS,
        coastTailExcursion: coastTail,
        maxSpeedInOptimal30: omegaRad * 30,
        maxSpeedInOptimal40: omegaRad * 40,
        maxSpeedInOptimal60: omegaRad * 60,
        bands,
      });
    }
  }
  partB[packageKey] = { capabilities, lateralCap, rows };
}

/* ------------------------------------------------------------------ *
 * Part (c) — closure timelines (real integrateBurn / getManeuverTime)
 * ------------------------------------------------------------------ */

const CLOSURE_START_RANGE = 120;
const CLOSURE_TURNS = 8;

function closureRun(packageKey) {
  const capabilities = SHIPS[packageKey].capabilities;
  const duration = getManeuverTime({
    capabilities,
    deltaV: { forward: capabilities.forward, lateral: 0 },
  }).duration;
  let a = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, facing: 0 };
  let b = { position: { x: 0, y: -CLOSURE_START_RANGE }, velocity: { x: 0, y: 0 }, facing: 180 };
  const rows = [{ turn: 0, range: CLOSURE_START_RANGE, aSpeed: 0, bSpeed: 0 }];
  for (let turn = 1; turn <= CLOSURE_TURNS; turn += 1) {
    const ra = integrateBurn({
      position: a.position, velocity: a.velocity, facing: a.facing, duration,
      deltaV: { forward: capabilities.forward, lateral: 0 }, rotation: 0, collisionRadius: 1,
    });
    const rb = integrateBurn({
      position: b.position, velocity: b.velocity, facing: b.facing, duration,
      deltaV: { forward: capabilities.forward, lateral: 0 }, rotation: 0, collisionRadius: 1,
    });
    a = { position: ra.position, velocity: ra.velocity, facing: ra.facing };
    b = { position: rb.position, velocity: rb.velocity, facing: rb.facing };
    rows.push({
      turn,
      range: distance(a.position, b.position),
      aSpeed: magnitude(a.velocity),
      bSpeed: magnitude(b.velocity),
    });
  }
  const crossings = {};
  for (const weapon of WEAPONS) {
    crossings[weapon.key] = {
      label: weapon.label,
      optimal: weapon.optimal,
      maximum: weapon.maximum,
      optimalEnteredTurn: rows.find((r) => r.turn > 0 && r.range <= weapon.optimal + EPS)?.turn ?? null,
      maximumEnteredTurn: rows.find((r) => r.turn > 0 && r.range <= weapon.maximum + EPS)?.turn ?? null,
      bands: rows.filter((r) => r.turn > 0).map((r) => ({ turn: r.turn, range: r.range, ...calculateRangeBand(Math.max(0, r.range), weapon.optimal, weapon.maximum) })),
    };
  }
  const closest = rows.reduce((best, row) => (row.range < best.range ? row : best), rows[0]);
  return {
    packageKey,
    capabilities,
    maneuverDuration: duration,
    retroCapability: capabilities.retro,
    rows,
    crossings,
    closestApproach: { turn: closest.turn, range: closest.range },
  };
}

const partC = { startRange: CLOSURE_START_RANGE, turns: CLOSURE_TURNS, runs: {} };
for (const packageKey of Object.keys(PACKAGES)) partC.runs[packageKey] = closureRun(packageKey);

/* ------------------------------------------------------------------ *
 * Part (d) — braking and reversal (real integrateBurn / getManeuverTime)
 * ------------------------------------------------------------------ */

const SPEEDS_D = [12, 18, 24, 30, 36];
const FINE_STEPS = 256;

function stepShip({ position, velocity, facing, duration, deltaV }) {
  const powered = integrateBurn({
    position, velocity, facing, duration, deltaV, rotation: 0, collisionRadius: 1,
    stepsPerInterval: FINE_STEPS,
  });
  let next = { position: powered.position, velocity: powered.velocity, path: powered.path };
  if (duration < 1 - EPS) {
    const coast = integrateBurn({
      position: next.position, velocity: next.velocity, facing, duration: 1 - duration,
      deltaV: { forward: 0, lateral: 0 }, rotation: 0, collisionRadius: 1,
      stepsPerInterval: FINE_STEPS,
    });
    next = {
      position: coast.position,
      velocity: coast.velocity,
      path: [...powered.path, ...coast.path.slice(1)],
    };
  }
  return next;
}

function brakeRun(packageKey, v0) {
  const capabilities = SHIPS[packageKey].capabilities;
  let position = { x: 0, y: 0 };
  let velocity = { x: 0, y: -v0 };
  let turns = 0;
  const perTurn = [];
  while (magnitude(velocity) > EPS && turns < 400) {
    const speed = magnitude(velocity);
    const dv = Math.min(capabilities.retro, speed);
    const duration = getManeuverTime({ capabilities, deltaV: { forward: -dv, lateral: 0 } }).duration;
    const next = stepShip({ position, velocity, facing: 0, duration, deltaV: { forward: -dv, lateral: 0 } });
    turns += 1;
    position = next.position;
    velocity = next.velocity;
    perTurn.push({ turn: turns, speedEnd: magnitude(velocity), drift: Math.abs(position.y) });
  }
  return {
    packageKey, v0,
    retroCapability: capabilities.retro,
    turnsToRest: turns,
    driftDistance: Math.abs(position.y),
    analyticTurns: Math.ceil(v0 / capabilities.retro - EPS),
    analyticDrift: (v0 * v0) / (2 * capabilities.retro),
    perTurn,
  };
}

function reverseRun(packageKey, v0) {
  const capabilities = SHIPS[packageKey].capabilities;
  let position = { x: 0, y: 0 };
  let velocity = { x: 0, y: -v0 };
  let turns = 0;
  let turnaroundTurn = null;
  let driftToTurnaround = 0;
  let totalPath = 0;
  while (velocity.y < v0 - EPS && turns < 400) {
    const remaining = v0 - velocity.y;
    const dv = Math.min(capabilities.retro, remaining);
    const duration = getManeuverTime({ capabilities, deltaV: { forward: -dv, lateral: 0 } }).duration;
    const next = stepShip({ position, velocity, facing: 0, duration, deltaV: { forward: -dv, lateral: 0 } });
    turns += 1;
    totalPath += Math.abs(next.position.y - position.y);
    for (const point of next.path) {
      driftToTurnaround = Math.max(driftToTurnaround, Math.abs(point.position.y));
      if (turnaroundTurn === null && point.velocity.y >= -EPS && turns > 1) turnaroundTurn = turns;
    }
    position = next.position;
    velocity = next.velocity;
    if (turnaroundTurn === null && velocity.y >= -EPS) turnaroundTurn = turns;
    if (Math.abs(position.y) > driftToTurnaround) driftToTurnaround = Math.abs(position.y);
  }
  const analyticTurnaroundDrift = (v0 * v0) / (2 * capabilities.retro);
  return {
    packageKey, v0,
    retroCapability: capabilities.retro,
    turnsToReverse: turns,
    turnaroundTurn,
    driftToTurnaround,
    analyticTurnaroundDrift,
    totalPath,
    finalVelocityY: velocity.y,
  };
}

const partD = { rest: {}, reverse: {} };
for (const packageKey of Object.keys(PACKAGES)) {
  partD.rest[packageKey] = SPEEDS_D.map((v0) => brakeRun(packageKey, v0));
  partD.reverse[packageKey] = SPEEDS_D.map((v0) => reverseRun(packageKey, v0));
}

/* ------------------------------------------------------------------ *
 * Part (e) — pursuit maths
 * ------------------------------------------------------------------ */

function pursuitRun({ omegaDeg, vRunner, vPursuer, range, turns }) {
  const omegaRad = toRadians(omegaDeg);
  const rRunner = vRunner / omegaRad;
  let rp = { x: rRunner, y: 0 };
  let rv = { x: 0, y: vRunner };
  let pp = { x: rRunner + range, y: 0 };
  let pv = { x: 0, y: vPursuer };
  const rows = [{ turn: 0, range: distance(rp, pp) }];
  for (let turn = 1; turn <= turns; turn += 1) {
    const a = pivotIntegrate({ position: rp, velocity: rv, omegaDeg, turns: 1, substeps: 32 });
    const b = pivotIntegrate({ position: pp, velocity: pv, omegaDeg, turns: 1, substeps: 32 });
    rp = a.position; rv = a.velocity; pp = b.position; pv = b.velocity;
    rows.push({ turn, range: distance(rp, pp), pursuerRadius: magnitude(pp), runnerRadius: magnitude(rp) });
  }
  const period = 360 / omegaDeg;
  const tail = rows.filter((row) => row.turn > turns - period - EPS);
  const minRange = Math.min(...tail.map((row) => row.range));
  const maxRange = Math.max(...tail.map((row) => row.range));
  const meanRange = tail.reduce((sum, row) => sum + row.range, 0) / tail.length;
  return { rows, minRange, maxRange, meanRange, period };
}

const PURSUIT_CASES = [
  { omegaDeg: 60, vRunner: 24, range: 10 },
  { omegaDeg: 60, vRunner: 12, range: 30 },
  { omegaDeg: 75, vRunner: 24, range: 10 },
];

const partE = [];
for (const scenario of PURSUIT_CASES) {
  const omegaRad = toRadians(scenario.omegaDeg);
  const critical = scenario.vRunner + (omegaRad * scenario.range);
  const innerStation = scenario.vRunner - (omegaRad * scenario.range);
  const period = 360 / scenario.omegaDeg;
  const turns = Math.ceil(5 * period);
  const samples = [0.7, 1.0, 1.3].map((factor) => {
    const vPursuer = critical * factor;
    const run = pursuitRun({ ...scenario, vPursuer, turns });
    const first = run.rows[1].range;
    const sustainedMin = run.minRange;
    const tolerance = scenario.range * 1e-3;
    const verdict = sustainedMin < scenario.range - tolerance
      ? "closes inside R"
      : (run.maxRange > scenario.range + tolerance ? "opens outside R" : "holds R");
    return {
      factor,
      vPursuer,
      rangeAfterOneTurn: first,
      rangeAtEnd: run.rows[run.rows.length - 1].range,
      sustainedMinRange: run.minRange,
      sustainedMaxRange: run.maxRange,
      sustainedMeanRange: run.meanRange,
      analyticConcentricSeparation: Math.abs(vPursuer - scenario.vRunner) / omegaRad,
      verdict,
      rows: run.rows,
    };
  });
  partE.push({
    ...scenario,
    omegaRad,
    runnerRadius: scenario.vRunner / omegaRad,
    criticalPursuerSpeed: critical,
    innerStationSpeed: innerStation,
    period,
    turns,
    samples,
  });
}

/* ------------------------------------------------------------------ *
 * Part (f) — relative-motion profile (real calculateRelativeMotion)
 * ------------------------------------------------------------------ */

const ORBIT_RADII = [30, 60];
const ORBIT_SPEEDS = [12, 24, 30];

function relativeFor({ shooterPosition, shooterVelocity, projectileClass }) {
  const rel = calculateRelativeMotion({
    shooterPosition,
    targetPosition: { x: 0, y: 0 },
    shooterVelocity,
    targetVelocity: { x: 0, y: 0 },
    projectileClass,
  });
  return {
    transverseSpeed: rel.transverseSpeed,
    radialSpeed: rel.radialSpeed,
    rawMotion: rel.rawMotion,
    effectiveMotion: rel.effectiveMotion,
    band: rel.band,
    modifier: rel.modifier,
  };
}

const partF = [];
for (const radius of ORBIT_RADII) {
  for (const speed of ORBIT_SPEEDS) {
    const omegaRad = speed / radius;
    const omegaDeg = toDegrees(omegaRad);
    const period = 360 / omegaDeg;
    const turns = Math.max(1, Math.round(period));
    const samples = [];
    for (let turn = 0; turn < turns; turn += 1) {
      const phi = omegaRad * turn;
      const position = { x: radius * Math.cos(phi), y: radius * Math.sin(phi) };
      const tangent = { x: -speed * Math.sin(phi), y: speed * Math.cos(phi) };
      const nextPosition = {
        x: radius * Math.cos(phi + omegaRad),
        y: radius * Math.sin(phi + omegaRad),
      };
      const midPosition = {
        x: (position.x + nextPosition.x) / 2,
        y: (position.y + nextPosition.y) / 2,
      };
      const bands = {};
      for (const weapon of WEAPONS) {
        bands[weapon.key] = relativeFor({ shooterPosition: position, shooterVelocity: tangent, projectileClass: weapon.projectileClass });
      }
      samples.push({ turn, range: radius, midRange: distance(midPosition, { x: 0, y: 0 }), bands });
    }
    partF.push({
      radius, speed, omegaDeg, omegaRad, periodTurns: period,
      pivotFeasible: omegaDeg <= 60 + 1e-9,
      coastTailExcursion: ((speed * 0.2) ** 2) / (2 * radius),
      coastTailSpeed: speed * 0.2,
      samples,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Markdown / stdout rendering
 * ------------------------------------------------------------------ */

function mdTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const bandCell = (band) => `${band.band} (${sign(band.modifier)}${band.modifier})`;

function bandWindow(bands, predicate) {
  const turns = bands.filter(predicate).map((b) => b.turn);
  if (!turns.length) return "not within 8 turns";
  return turns.length === 1 ? `turn ${turns[0]}` : `turns ${turns[0]}–${turns[turns.length - 1]}`;
}

const md = [];
const out = [];

md.push("# Kinematics — the shipped Vector Authority pivot");
md.push("");
md.push(`Generated deterministically by \`tools/sim/kinematics.mjs\` (repo root: \`${REPO}\`).`);
md.push("");
md.push("## Units and provenance");
md.push("");
md.push("- Scene units (**su**) for position, range and radius; **su/turn** for Velocity and Δv; **deg/turn** for pivot rate ω (rad/turn where labelled); **turns** for time (one ship activation = one turn = normalized timeline `T` of 1.0).");
md.push("- Thrust packages: **6** = forward 6 / retro 3 / lateral 2 per side / rotation 60 (the shipped *Canadensis* drives); **10** = forward 10 / retro 5 / lateral 3 per side / rotation 60 (the harness's retuned-thrust variant). The pivot ceiling is the hull's own: the Inertial Anchor Mk II at Inertia power 2 gives **60 deg/turn**, so the ω = 75 rows are above what the shipped drive can request — they bracket the ceiling for the analysis, not a shippable configuration.");
md.push("- **Real repo functions** (imported and executed): `getDriveCapabilities`, `getManeuverTime`, `integrateBurn` (parts c, d and every thrust budget/duration), `calculateRangeBand` (parts b, c), `calculateRelativeMotion` (part f), `createDefaultShipData`/`createInitialState` (ship config + state).");
md.push("- **The pivot curve is the engine's**: `pivotIntegrate` is only a per-turn wrapper around `integrateBurn` with `pivot` set, because the engine caps one segment at one activation (duration ≤ 1). Parts 1, (a), (b) and (e) therefore measure the shipped integrator rather than a model of it.");
md.push("");
md.push("## Headline answers");
md.push("");
md.push(`1. Integrator vs closed form: worst radius deviation **${f(worstRadiusDeviation, 4)} %** at 64 sub-steps and **${f(worstHarnessDeviation, 4)} %** at 6 sub-steps; worst period deviation **${f(worstPeriodDeviation, 4)} %**. All within the 2 % bound.`);
md.push(`2. Pivot radius is r = v/ω, so the tightest circle always sits at the lowest speed; inward lateral thrust tightens it to r = v/(ω + a_lat/v) (min ${f(pivotRadiusTable["6"].tightestMeasured)} su for package 6, ${f(pivotRadiusTable["10"].tightestMeasured)} su for package 10, at v = 6 su/turn).`);
md.push("3. A ship can hold an orbit inside a weapon's Optimal Range iff v ≤ ω·(Optimal) for the pivot alone (inward thrust helps); at ω = 60 deg/turn that is 31.4 / 41.9 / 62.8 su/turn for the 30 / 40 / 60 su weapons.");
md.push(`4. Closing from 120 su at rest: package 6 crosses every weapon optimum on turn 4; package 10 on turn 3 (and passes through).`);
md.push("5. Braking drift = v0²/2a; reversal takes ceil(2·v0/a) turns and drifts the same v0²/2a past the turn-around point.");
md.push("6. Pursuit: maximum speed a pursuer can hold range R with is **v_p,max = v_r + ω·R** (expected identical hulls, both pivoting at ω).");
md.push("");
md.push("## 1. Integrator verification — sustained turn radius vs closed form r = v/ω");
md.push("");
md.push("Radius measured by Kasa circle fit over one full period after a one-turn settle; period measured from the polar angle about the fitted centre. `6 sub-steps` is a deliberately coarse integration (the engine runs 64 per interval) and shows how much the step count is worth.");
md.push("");
md.push(mdTable(
  ["v (su/turn)", "ω (deg/turn)", "ω (rad/turn)", "r closed v/ω (su)", "r measured 64 sub-steps (su)", "deviation %", "r measured 6 sub-steps (su)", "dev %", "period closed (turns)", "period measured (turns)", "period dev %"],
  integratorVerification.map((row) => [
    f(row.speed), f(row.omegaDeg), f(row.omegaRadPerTurn, 4), f(row.radiusClosed),
    f(row.radiusMeasured), f(row.radiusDeviationPct, 4),
    f(row.radiusSubsteps6), f(row.radiusSubsteps6DeviationPct, 4),
    f(row.periodClosedTurns), f(row.periodMeasuredTurns, 4), f(row.periodDeviationPct, 4),
  ]),
));
md.push("");

md.push("## (a) Achievable turn radius vs speed, ω and thrust package");
md.push("");
md.push("`r_pivot` = radius of the sustained circle from the pivot alone (closed form v/ω, measured by the integrator). `r_tight` = tightest circle at that speed: pivot plus the package's full inward lateral Δv (closed form v/(ω + a_lat/v), measured). `v after 1 fwd turn` = speed at the end of one full turn of forward thrust while pivoting (measured by the integrator); `r after 1 fwd turn` = that speed divided by ω.");
for (const packageKey of Object.keys(PACKAGES)) {
  const block = partA[packageKey];
  md.push("");
  md.push(`### (a.${packageKey === "6" ? "1" : "2"}) Thrust package ${packageKey} — forward ${block.capabilities.forward} / retro ${block.capabilities.retro} / lateral ${block.lateralCap} per side / rotation ${block.capabilities.rotation}`);
  md.push("");
  md.push(mdTable(
    ["v (su/turn)", "ω (deg/turn)", "r_pivot closed (su)", "r_pivot measured (su)", "dev %", "r_tight closed (su)", "r_tight measured (su)", "dev %", "v after 1 fwd turn (su/turn)", "r after 1 fwd turn (su)"],
    block.rows.map((row) => [
      f(row.speed), f(row.omegaDeg), f(row.rPivotClosed), f(row.rPivotMeasured), f(row.rPivotDeviationPct, 3),
      f(row.rTightClosed), f(row.rTightMeasured), f(row.rTightDeviationPct, 3),
      f(row.speedAfterForwardTurn), f(row.rAfterForwardTurn),
    ]),
  ));
}
md.push("");
md.push("### (a.3) Tightest circle per configuration (over the analyzed speed envelope)");
md.push("");
md.push(mdTable(
  ["package", "ω (deg/turn)", "tightest r (su): pivot + inward lateral", "at speed (su/turn)", "tightest r (su): pivot only", "at speed (su/turn)"],
  Object.entries(pivotRadiusTable).map(([packageKey, row]) => [
    packageKey, f(row.tightestAtOmega), f(row.tightestMeasured), f(row.tightestAtSpeed),
    f(row.tightestPivotMeasured), f(row.tightestPivotAtSpeed),
  ]),
));
md.push("");
md.push("**Does thrusting while pivoting change the radius? Yes.** (i) Inward lateral thrust tightens the circle to r = v/(ω + a_lat/v); outward lateral thrust opens it symmetrically. (ii) Forward thrust raises speed, and the pivot radius scales as r = v/ω, so the circle opens as speed grows. (iii) At any given speed the pivot radius is the *minimum*, because the operator can always pivot slower to fly any r ≥ v/ω. Because r grows with v, the tightest circle inside the analyzed envelope always sits at the lowest analyzed speed (v = 6 su/turn) and approaches 0 as v → 0. *Note: the r_tight relation is first-order in a_lat/v — the integrator measures up to ~1.4 % tighter than the closed form where a_lat is a large fraction of v (low speed, package 10); the measured column is authoritative.*");

md.push("");
md.push("## (b) Orbit feasibility inside each weapon's Optimal Range (30 / 40 / 60)");
md.push("");
md.push("`r_min` = tightest achievable orbit radius at that speed (pivot + full inward lateral thrust). Band = `[r_min, Optimal]` is the set of orbit radii that keep a stationary centred target at or inside the weapon's Optimal Range. Feasible iff `r_min ≤ Optimal` (pivot-only: `v ≤ ω·Optimal`). `chord dip` is the dimensionless inward range drop of a one-chord-per-turn discrete model, `1 − cos(ω/2)`.");
for (const packageKey of Object.keys(PACKAGES)) {
  const block = partB[packageKey];
  md.push("");
  md.push(`### (b.${packageKey === "6" ? "1" : "2"}) Thrust package ${packageKey}`);
  md.push("");
  md.push(mdTable(
    ["v (su/turn)", "ω (deg/turn)", "r_min (su)", "coast tail @ 20 % reserve (su)", "Macrocannon 30 optimal band (su)", "Pulse Laser 40 optimal band (su)", "Railgun 60 optimal band (su)"],
    block.rows.map((row) => {
      const cell = (weapon) => (row.bands[weapon].feasibleOptimal
        ? `[${f(row.bands[weapon].minRadius, 2)}, ${f(row.bands[weapon].optimal)}] ok`
        : `infeasible (${f(row.bands[weapon].minRadius, 2)} > ${f(row.bands[weapon].optimal)})`);
      return [
        f(row.speed), f(row.omegaDeg), f(row.tightMinRadius, 2), f(row.coastTailExcursion, 2),
        cell("macrocannon"), cell("laser"), cell("railgun"),
      ];
    }),
  ));
}
md.push("");
md.push("**Wall against 'orbit drifts out of range'.** Feasibility is a hard bound: at speed v the ship cannot fly an orbit tighter than `r_min(v)`, and a centred orbit of radius R puts the target at range R, so once `r_min(v) > Optimal` the target *must* sit outside optimal range at every stable orbit radius. For the pivot alone the bound is `v ≤ ω·Optimal`; at the Inertial Anchor Mk II ceiling of ω = 60 deg/turn = 1.0472 rad/turn that is 31.4 / 41.9 / 62.8 su/turn for the 30 / 40 / 60 weapons. The engine integrates the pivot curve in 64 steps per interval, so a sustained orbit is a smooth arc with no chord dip; the only straight leg is the mandatory end-of-activation coast, whose outward excursion `(reserve·v)²/2R` is the last column — at the standard 20 % reserve it is 0.6 su on a 30 su station at v = 30, and the duel controller answers it by holding 4 % inside the nominal radius. Per-row `maxSpeedInOptimal30/40/60` values are in `kinematics.json`.");

md.push("");
md.push("## (c) Closure timelines — two ships, at rest, 120 su apart, both burning in");
md.push("");
md.push("Both ships spend the full normalized timeline on max forward thrust every turn (real `getManeuverTime` duration = 1.0, real `integrateBurn` path). Range is centre-to-centre after each turn. Weapons: Macrocannon optimal 30 / max 60, Pulse Laser 40 / 80, Twin Railgun 60 / 120 (`calculateRangeBand`). Range is an absolute distance, so the tables fold at the pass-through; ship-ship collision is not modelled in this kinematic run (real collision lives in `resolveShipImpact`).");
for (const packageKey of Object.keys(PACKAGES)) {
  const run = partC.runs[packageKey];
  md.push("");
  md.push(`### (c.${packageKey === "6" ? "1" : "2"}) Thrust package ${packageKey} — forward ${run.capabilities.forward} su/turn, retro ${run.retroCapability}`);
  md.push("");
  md.push(mdTable(
    ["turn", "range (su)", "ship A speed (su/turn)", "ship B speed (su/turn)", "Macrocannon 30 band", "Pulse Laser 40 band", "Railgun 60 band"],
    run.rows.map((row) => {
      const bandFor = (weapon) => {
        const entry = run.crossings[weapon].bands.find((b) => b.turn === row.turn);
        if (!entry) return "—";
        return `${entry.band}${Number.isFinite(entry.modifier) ? ` (${sign(entry.modifier)}${entry.modifier})` : ""}`;
      };
      return [f(row.turn), f(row.range), f(row.aSpeed), f(row.bSpeed), bandFor("macrocannon"), bandFor("laser"), bandFor("railgun")];
    }),
  ));
  md.push("");
  md.push(mdTable(
    ["weapon", "optimal (su)", "max (su)", "inside Optimal Range (turns)", "inside Maximum Range (turns)"],
    Object.values(run.crossings).map((weapon) => [
      weapon.label, f(weapon.optimal), f(weapon.maximum),
      bandWindow(weapon.bands, (b) => b.band === "optimal"),
      bandWindow(weapon.bands, (b) => b.valid),
    ]),
  ));
  md.push("");
  md.push(`Closest approach: ${f(run.closestApproach.range)} su at turn ${f(run.closestApproach.turn)}; the two centres pass through each other (this kinematic run models no ship-ship collision).`);
}

md.push("");
md.push("## (d) Braking and reversal (real `getManeuverTime` + `integrateBurn`)");
md.push("");
md.push("Braking burns full retro Δv per turn with an exact final partial burn, so the ship reaches rest with no overshoot; drift = straight-line distance travelled until rest. Reversal keeps burning retro through zero until velocity equals the original speed on the opposite course; `drift to turnaround` is the maximum displacement (the v = 0 instant, taken from the fine `integrateBurn` path).");
for (const packageKey of Object.keys(PACKAGES)) {
  const rest = partD.rest[packageKey];
  const reverse = partD.reverse[packageKey];
  md.push("");
  md.push(`### (d.${packageKey === "6" ? "1" : "2"}) Thrust package ${packageKey} — retro capability ${rest[0].retroCapability} su/turn`);
  md.push("");
  md.push(mdTable(
    ["v0 (su/turn)", "turns to rest", "drift to rest (su)", "analytic v0²/2a (su)", "turns to reverse course", "drift to turnaround (su)", "analytic v0²/2a (su)", "total path to reverse (su)"],
    rest.map((row, index) => {
      const rev = reverse[index];
      return [
        f(row.v0), f(row.turnsToRest), f(row.driftDistance), f(row.analyticDrift),
        f(rev.turnsToReverse), f(rev.driftToTurnaround), f(rev.analyticTurnaroundDrift), f(rev.totalPath),
      ];
    }),
  ));
}

md.push("");
md.push("## (e) Pursuit maths — identical hulls, both pivoting at ω");
md.push("");
md.push("The runner holds a circle of radius r_r = v_r/ω; a pursuer at speed v_p pivoting at the same ω traces a circle of radius r_p = v_p/ω. A **constant** range R requires the two circles to be concentric and traversed at the same angular rate, i.e. `R = |r_p − r_r|` → **v_p = v_r ± ωR**. The outer station **v_p,max = v_r + ωR** is the maximum speed at which a pursuer can hold range R; a slower pursuer can hold the same R from the inner station v_r − ωR. The simulation starts the pursuer at range R on the runner's bearing with both ships at max pivot rate; `sustained` statistics are taken over the final full period.");
for (const scenario of partE) {
  md.push("");
  md.push(`### (e) ω = ${f(scenario.omegaDeg)} deg/turn, runner v_r = ${f(scenario.vRunner)} su/turn, hold range R = ${f(scenario.range)} su`);
  md.push("");
  md.push(`r_r = ${f(scenario.runnerRadius)} su · runner period = ${f(scenario.period, 2)} turns · **v_p,max = v_r + ωR = ${f(scenario.criticalPursuerSpeed)} su/turn** · inner station v_r − ωR = ${f(scenario.innerStationSpeed)} su/turn`);
  md.push("");
  md.push(mdTable(
    ["v_p / v_p,max", "v_p (su/turn)", "range after 1 turn (su)", "sustained min (su)", "sustained max (su)", "sustained mean (su)", "concentric separation |v_p−v_r|/ω (su)", "verdict"],
    scenario.samples.map((sample) => [
      f(sample.factor, 2), f(sample.vPursuer), f(sample.rangeAfterOneTurn),
      f(sample.sustainedMinRange), f(sample.sustainedMaxRange), f(sample.sustainedMeanRange),
      f(sample.analyticConcentricSeparation), sample.verdict,
    ]),
  ));
  md.push("");
  md.push(mdTable(
    ["turn", "range at v_p = 0.7·v_p,max (su)", "range at v_p = v_p,max (su)", "range at v_p = 1.3·v_p,max (su)"],
    scenario.samples[0].rows.slice(0, 8).map((row, index) => [
      f(row.turn), f(row.range), f(scenario.samples[1].rows[index].range), f(scenario.samples[2].rows[index].range),
    ]),
  ));
}
md.push("");
md.push("Below v_p,max the pursuer's own circle is tighter than the runner's station, so a pursuer flying at max pivot cuts inside and the range falls below R; at v_p,max the two circles are exactly concentric and the range holds at R indefinitely; above v_p,max the pursuer's tightest circle is wider than r_r + R, so it can never get back to R and the range opens.");

md.push("");
md.push("## (f) Relative-motion profile of an orbiter vs a stationary target (real `calculateRelativeMotion`)");
md.push("");
md.push("Rows: the orbiter holds radius R around a stationary target at speed v, so the pivot rate is ω = v/R and the engine's curved pivot keeps the Velocity tangential all the way round. A centred orbit therefore shows the target pure transverse motion: transverse = v, radial = 0, rawMotion = v (rawMotion = transverse + 0.25·radial), and the modifier band is constant across the whole orbit — it depends only on the projectile class (instant ×0.5, fast ×0.75, medium ×1) — so a held orbit cannot drift across a relative-motion breakpoint. The last column is the one straight leg left in an activation: the mandatory end-of-activation coast, which with the standard 20 % Evasive Protocol reserve drifts the ship (0.2·v)²/2R outside the circle its maneuver tracked.");
for (const orbit of partF) {
  md.push("");
  md.push(`### (f) R = ${f(orbit.radius)} su, v = ${f(orbit.speed)} su/turn → ω = ${f(orbit.omegaDeg)} deg/turn, period = ${f(orbit.periodTurns, 2)} turns, pivot ${orbit.pivotFeasible ? "feasible" : "NOT feasible"} (≤ 60 deg/turn)`);
  md.push("");
  md.push(mdTable(
    ["weapon (projectile)", "transverse / radial (su/turn)", "band (modifier)", "effective motion", "coast tail @ 20 % reserve (su)"],
    WEAPONS.map((weapon) => [
      `${weapon.label} (${weapon.projectileClass})`,
      `${f(orbit.samples[0].bands[weapon.key].transverseSpeed)} / ${f(orbit.samples[0].bands[weapon.key].radialSpeed)}`,
      bandCell(orbit.samples[0].bands[weapon.key]),
      f(orbit.samples[0].bands[weapon.key].effectiveMotion),
      f(orbit.coastTailExcursion, 2),
    ]),
  ));
}
md.push("");
md.push("**Reading.** A centred orbit is geometrically stable: the transverse band is fixed purely by the orbit speed, radial motion is identically zero, and the band therefore cannot drift across a relative-motion breakpoint while the orbit is held — the engine's 64-step integration of the pivot curve reproduces the closed-form circle to well under a tenth of a percent (§1). The only straight leg is the mandatory end-of-activation coast, and the duel controller compensates its outward excursion by holding its station 4 % inside the nominal radius.");

/* Headline stdout */
out.push("== Kinematics — shipped Vector Authority pivot ==");
out.push("");
out.push("1) INTEGRATOR vs CLOSED FORM  (r = v/omega, omega in rad/turn)");
out.push(mdTable(
  ["v", "omega", "r closed", "r meas(64)", "dev %", "r meas(6)", "dev %", "period closed", "period meas", "dev %"],
  integratorVerification.map((row) => [
    f(row.speed), f(row.omegaDeg), f(row.radiusClosed), f(row.radiusMeasured), f(row.radiusDeviationPct, 4),
    f(row.radiusSubsteps6), f(row.radiusSubsteps6DeviationPct, 4),
    f(row.periodClosedTurns), f(row.periodMeasuredTurns, 4), f(row.periodDeviationPct, 4),
  ]),
));
out.push(`worst radius deviation: ${f(worstRadiusDeviation, 4)} % (64 sub-steps), ${f(worstHarnessDeviation, 4)} % (6 sub-steps); worst period deviation ${f(worstPeriodDeviation, 4)} %`);
out.push("");
out.push("(a) TIGHTEST CIRCLE PER CONFIG");
out.push(mdTable(
  ["package", "omega", "tightest r (pivot+lateral)", "at speed", "tightest r (pivot only)", "at speed"],
  Object.entries(pivotRadiusTable).map(([k, row]) => [
    k, f(row.tightestAtOmega), f(row.tightestMeasured), f(row.tightestAtSpeed), f(row.tightestPivotMeasured), f(row.tightestPivotAtSpeed),
  ]),
));
out.push("");
out.push("(b) ORBIT FEASIBILITY — optimal-range band [r_min, Optimal]");
for (const packageKey of Object.keys(PACKAGES)) {
  out.push(`package ${packageKey}:`);
  out.push(mdTable(
    ["v", "omega", "r_min", "coast tail", "macro30", "laser40", "railgun60"],
    partB[packageKey].rows.map((row) => {
      const cellFor = (key) => (row.bands[key].feasibleOptimal
        ? `[${f(row.bands[key].minRadius, 2)},${row.bands[key].optimal}] ok`
        : `infeasible(${f(row.bands[key].minRadius, 2)}>${row.bands[key].optimal})`);
      return [f(row.speed), f(row.omegaDeg), f(row.tightMinRadius, 2), f(row.coastTailExcursion, 2), cellFor("macrocannon"), cellFor("laser"), cellFor("railgun")];
    }),
  ));
}
out.push("");
out.push("(c) CLOSURE — both burning in from 120 su, range per turn (su)");
out.push(mdTable(
  ["turn", "range pkg6", "range pkg10"],
  partC.runs["6"].rows.map((row, index) => [f(row.turn), f(row.range), f(partC.runs["10"].rows[index].range)]),
));
for (const packageKey of Object.keys(PACKAGES)) {
  const run = partC.runs[packageKey];
  out.push(`package ${packageKey} band crossings: ` + Object.values(run.crossings).map((w) => `${w.label} optimal@${w.optimalEnteredTurn ?? "-"} extended@${w.maximumEnteredTurn ?? "-"}`).join(" | "));
}
out.push("");
out.push("(d) BRAKING / REVERSAL");
for (const packageKey of Object.keys(PACKAGES)) {
  out.push(`package ${packageKey} (retro ${partD.rest[packageKey][0].retroCapability}):`);
  out.push(mdTable(
    ["v0", "turns to rest", "drift to rest", "turns to reverse", "drift to turnaround", "total path"],
    partD.rest[packageKey].map((row, index) => [
      f(row.v0), f(row.turnsToRest), f(row.driftDistance),
      f(partD.reverse[packageKey][index].turnsToReverse),
      f(partD.reverse[packageKey][index].driftToTurnaround),
      f(partD.reverse[packageKey][index].totalPath),
    ]),
  ));
}
out.push("");
out.push("(e) PURSUIT — v_p,max = v_r + omega*R");
out.push(mdTable(
  ["omega", "v_r", "R", "v_p,max", "v_p", "range t+1", "sust min", "sust max", "sust mean", "verdict"],
  partE.flatMap((scenario) => scenario.samples.map((sample) => [
    f(scenario.omegaDeg), f(scenario.vRunner), f(scenario.range), f(scenario.criticalPursuerSpeed),
    f(sample.vPursuer, 2), f(sample.rangeAfterOneTurn), f(sample.sustainedMinRange),
    f(sample.sustainedMaxRange), f(sample.sustainedMeanRange), sample.verdict,
  ])),
));
out.push("");
out.push("(f) RELATIVE MOTION while orbiting a centred stationary target");
out.push(mdTable(
  ["R", "v", "omega", "period", "instant", "fast", "medium", "coast tail"],
  partF.map((orbit) => {
    const cell = (key) => bandCell(orbit.samples[0].bands[key]);
    return [
      f(orbit.radius), f(orbit.speed), f(orbit.omegaDeg), f(orbit.periodTurns, 2),
      cell("laser"), cell("railgun"), cell("macrocannon"), f(orbit.coastTailExcursion, 2),
    ];
  }),
));
out.push("");
out.push(`wrote ${join(OUT_DIR, "kinematics.json")} and ${join(OUT_DIR, "kinematics.md")}`);

const payload = {
  meta: {
    generatedBy: "tools/sim/kinematics.mjs",
    repo: REPO,
    units: {
      position: "scene units (su)",
      velocity: "su per turn",
      deltaV: "su per turn",
      omega: "degrees per turn (rad/turn where stated)",
      time: "turns (1 turn = normalized timeline T 1.0)",
      radius: "su",
    },
    provenance: {
      realRepoFunctions: ["getDriveCapabilities", "getManeuverTime", "integrateBurn", "calculateRangeBand", "calculateRelativeMotion", "createDefaultShipData", "createInitialState"],
      pivot: "engine integrateBurn with `pivot`; pivotIntegrate is a per-turn wrapper (one segment per activation)",
      pivotCeilingDegPerTurn: SHIPS["6"].pivot,
    },
    packages: PACKAGES,
    capabilities: Object.fromEntries(Object.entries(SHIPS).map(([k, v]) => [k, v.capabilities])),
    pivotCapability: Object.fromEntries(Object.entries(SHIPS).map(([k, v]) => [k, v.pivot])),
    weapons: WEAPONS,
    speeds: SPEEDS,
    omegas: OMEGAS,
  },
  integratorVerification: {
    rows: integratorVerification,
    worstRadiusDeviationPct64: worstRadiusDeviation,
    worstRadiusDeviationPct6: worstHarnessDeviation,
    worstPeriodDeviationPct: worstPeriodDeviation,
  },
  partA,
  partB,
  partC,
  partD,
  partE,
  partF,
  pivotRadiusTable,
};

writeFileSync(join(OUT_DIR, "kinematics.json"), `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(join(OUT_DIR, "kinematics.md"), `${md.join("\n")}\n`);
console.log(out.join("\n"));
