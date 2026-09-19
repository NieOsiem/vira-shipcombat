#!/usr/bin/env bun
/**
 * Monte-Carlo duel harness for Vira ship combat — drives the real rules engine through
 * executeShipOperation, so every validation, roll, damage, shield and heat result is the engine's.
 * It lives with the module so a sweep can be re-run against whatever the module currently ships.
 *
 * Variants are config-driven only: the drive thrust package (--thrust) and the online weapon
 * loadout. Everything the engine now implements is engine behaviour, so the harness declares none
 * of it: the curved Vector Authority pivot (`integrateBurn` rotates Velocity by pivotRate·dt), the
 * +2 Optimal Range bonus, the kinetic evasion stack, the relative-motion bands, and the per-sector
 * regeneration cap (`regenerationWeightCap`).
 *
 * Usage: bun tools/sim/duel.mjs [--quick] [--debug] [--trace] [--only=<substring[,substring]>]
 *                               [--out=<file>] [--thrust=shipped|retune] [--no-parallel]
 * Writes tools/sim/results.json next to this script; `python3 tools/sim/report.py` renders report.md.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANADENSIS_HULL_CONFIG, CANADENSIS_ENCOUNTER_DEFAULTS, CANADENSIS_IDS } from "../../scripts/data/canadensis.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "../../scripts/data/canadensis-components.js";
import { materializeShipConfig } from "../../scripts/model/equipment.js";
import { createInitialState } from "../../scripts/model/defaults.js";
import { executeShipOperation, OPERATION_TYPES } from "../../scripts/rules/operations.js";
import {
  calculateRangeBand,
  calculateRelativeMotion,
  calculateStruckSector,
  isWithinFiringArc,
} from "../../scripts/rules/combat.js";
import { getDriveCapabilities, getPivotCapability } from "../../scripts/rules/movement.js";
import { bearingDegrees, magnitude, normalizeHeading, shortestAngleDelta, toDegrees } from "../../scripts/rules/math.js";

const HERE = import.meta.dir;
const QUICK = process.argv.includes("--quick");
const DEBUG = process.argv.includes("--debug");
const TRACE = process.argv.includes("--trace");
const NO_PARALLEL = process.argv.includes("--no-parallel");
const ONLY = argumentValue("--only");
const OUT = argumentValue("--out") ?? join(HERE, "results.json");

function argumentValue(flag) {
  const prefix = `${flag}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const PILOT = "canadensis-pilot-commander";
const GUNNER = "canadensis-gunner-sensor";
const SECTORS = ["fore", "port", "starboard", "aft"];
const ROUNDS = 40;
const START_RANGE = 60;

/* ------------------------------------------------------------------ *
 * Configuration knobs that are still real: drive thrust package + loadout
 * ------------------------------------------------------------------ */

const THRUST_PACKAGES = {
  shipped: null,
  retune: { main: 10, retro: 5, lateral: 3 },
};
const THRUST_KEY = argumentValue("--thrust") ?? "shipped";
if (!(THRUST_KEY in THRUST_PACKAGES)) throw new Error(`unknown --thrust=${THRUST_KEY}`);
const THRUST = THRUST_PACKAGES[THRUST_KEY];

const LOADOUTS = {
  antiArmor: { label: "railgun + port macrocannon", online: [CANADENSIS_IDS.railgun, CANADENSIS_IDS.portMacrocannon] },
  laser: { label: "pulse laser + port macrocannon", online: [CANADENSIS_IDS.laser, CANADENSIS_IDS.portMacrocannon] },
};

const VARIANTS = {
  base: { label: `${LOADOUTS.antiArmor.label}${THRUST ? " (retuned drives)" : ""}`, thrust: THRUST, loadout: "antiArmor" },
  laser: { label: `${LOADOUTS.laser.label}${THRUST ? " (retuned drives)" : ""}`, thrust: THRUST, loadout: "laser" },
};

/* ------------------------------------------------------------------ *
 * Movement policies and the shipped-ruleset scenario matrix
 * ------------------------------------------------------------------ */

/**
 * Orbit/station controller. The engine's pivot redirects Velocity by `pivot` degrees across a
 * maneuver and integrates that curve in 64 steps, so the ship flies an arc of radius
 * `v · duration / θ`. The controller asks for the pivot that makes the arc *track the station
 * radius* — the chord-tuned pursuit law it replaces asked for the heading change to the current
 * tangent, which under-rotated the arc and let the orbit drift wide — and then trims the residual
 * radius error with a velocity crab. The mandatory end-of-activation coast is a tangent chord that
 * pushes the orbit out by L²/2r; a feed-forward crab cancels it rather than leaving the trim loop to
 * fight it as a standing offset. The station is flown against the target's *current* position: a
 * lead on its velocity was measured to destabilise mutual orbits without helping station-keeping.
 */
const CONTROL = {
  gain: 1.0,          // crab angle in degrees per unit of relative radius error
  biasMax: 25,        // cap on the steady-state crab (deg)
  insertBiasMax: 55,  // cap on the insertion crab (deg)
  alignTol: 30,       // thrust only when the nose is within this of the flight path (deg)
  standOff: 0.04,     // hold this fraction inside the nominal radius (keeps the macrocannon edge)
  settleTurns: 4,     // sustained samples skipped after the ship first reaches station speed
};

const POLICIES = {
  hover: { kind: "hover", solutions: true, evasion: true, label: "hover" },
  brawl: { kind: "station", v: 12, R: 15, solutions: true, evasion: true, label: "brawl station 15 su @ 12" },
  orbit12: { kind: "station", v: 12, R: 30, solutions: true, evasion: true, label: "orbit 30 su @ 12" },
  orbit18: { kind: "station", v: 18, R: 30, solutions: true, evasion: true, label: "orbit 30 su @ 18" },
  orbit24: { kind: "station", v: 24, R: 30, solutions: true, evasion: true, label: "orbit 30 su @ 24" },
  orbit30: { kind: "station", v: 30, R: 30, solutions: true, evasion: true, label: "orbit 30 su @ 30" },
};

const SCENARIOS = [
  ["base", "hover", "hover", "hover mirror"],
  ["base", "brawl", "hover", "brawl vs hover"],
  ["base", "orbit12", "hover", "orbit 12 vs hover"],
  ["base", "orbit18", "hover", "orbit 18 vs hover"],
  ["base", "orbit24", "hover", "orbit 24 vs hover"],
  ["base", "orbit30", "hover", "orbit 30 vs hover"],
  ["base", "orbit18", "orbit18", "orbit 18 mirror"],
  ["base", "brawl", "orbit18", "brawl vs orbit 18"],
  ["base", "brawl", "brawl", "brawl mirror"],
  ["laser", "hover", "hover", "laser hover mirror"],
  ["laser", "brawl", "hover", "laser brawl vs hover"],
  ["laser", "orbit18", "hover", "laser orbit 18 vs hover"],
  ["laser", "orbit18", "orbit18", "laser orbit 18 mirror"],
  ["laser", "brawl", "orbit18", "laser brawl vs orbit 18"],
].map(([variant, policyA, policyB, label], index) => ({
  index,
  id: `${variant}:${policyA}-${policyB}`,
  variant,
  policyA,
  policyB,
  label,
  match: `${policyA} vs ${policyB}`,
}));

function matchesOnly(scenario, only) {
  if (!only) return true;
  return only.split(",").some((token) => scenario.id === token || scenario.id.includes(token) || scenario.label.includes(token));
}

/* ------------------------------------------------------------------ *
 * Duel
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const headingOf = (vector) => (magnitude(vector) < 1e-9 ? null : normalizeHeading(toDegrees(Math.atan2(vector.x, -vector.y))));
const emptySectors = () => Object.fromEntries(SECTORS.map((sector) => [sector, 0]));

function makeShip(uuid, x, y, rotation, variant) {
  const config = materializeShipConfig(CANADENSIS_HULL_CONFIG, CANADENSIS_DEFAULT_COMPONENT_SOURCES);
  if (variant.thrust) {
    config.components.drives.main.base.thrust = variant.thrust.main;
    config.components.drives.reverse.base.thrust = variant.thrust.retro;
    config.components.drives.portLateral.base.thrust = variant.thrust.lateral;
    config.components.drives.starboardLateral.base.thrust = variant.thrust.lateral;
  }
  const state = createInitialState(structuredClone(config));
  state.position = { x, y };
  state.facing = rotation;
  const defaults = CANADENSIS_ENCOUNTER_DEFAULTS;
  for (const [id, weapon] of Object.entries(defaults.weapons)) {
    if (state.weapons[id]) Object.assign(state.weapons[id], structuredClone(weapon));
  }
  const online = new Set(LOADOUTS[variant.loadout].online);
  for (const [id, weapon] of Object.entries(state.weapons)) {
    weapon.status = online.has(id) ? "online" : "off";
    weapon.mode = "nominal";
    weapon.bootCounter = 0;
  }
  Object.assign(state.power, structuredClone(defaults.power));
  state.shields.hp = { ...defaults.shields.hp };
  state.shields.allocation = { ...defaults.shields.allocation };
  state.shields.regenerationAllocation = { ...defaults.shields.regenerationAllocation };
  for (const operator of config.operators) operator.userId = "gm";
  for (const kind of ["command", "crew"]) for (const actor of state.roster[kind]) actor.userId = "gm";
  return { uuid, config, state, token: { uuid, x, y, rotation, width: 2 } };
}

class Duel {
  constructor(seed, variant) {
    this.rng = mulberry32(seed);
    this.variant = variant;
    this.ships = { A: makeShip("A", 0, 0, 0, variant), B: makeShip("B", START_RANGE, 0, 180, variant) };
    this.round = 0;
    this.stats = {
      rounds: 0, ttkA: null, ttkB: null, collapse: {}, shieldDamage: { A: 0, B: 0 }, hullDamage: { A: 0, B: 0 },
      attacks: { A: 0, B: 0 }, rangeSamples: [], motionSamples: [],
      solutionUses: 0, rammed: 0, rejects: {},
      orbit: { A: [], B: [] },
      weaponBands: { A: {}, B: {} },
      strikes: { A: emptySectors(), B: emptySectors() },
      shieldLoss: { A: emptySectors(), B: emptySectors() },
      shieldRegen: { A: emptySectors(), B: emptySectors() },
      pivotSpent: { A: [], B: [] },
      roundSectorLoss: { A: {}, B: {} },
      funnelSector: { A: {}, B: {} },
      funnel: {
        A: { rounds: 0, damage: 0, captured: 0, missedRounds: 0 },
        B: { rounds: 0, damage: 0, captured: 0, missedRounds: 0 },
      },
      rotation: {
        A: { roundsWithDamage: 0, distinctSum: 0, multiSectorRounds: 0 },
        B: { roundsWithDamage: 0, distinctSum: 0, multiSectorRounds: 0 },
      },
    };
  }
  state(uuid) { return this.ships[uuid].state; }
  config(uuid) { return this.ships[uuid].config; }
  d20() { return 1 + Math.floor(this.rng() * 20); }
  call(type, sourceUuid, targetUuids = [], payload = {}) {
    const revisions = {};
    for (const uuid of [sourceUuid, ...targetUuids]) revisions[uuid] = this.ships[uuid].state.revision;
    const result = executeShipOperation(
      { type, sourceUuid, targetUuids, expectedRevisions: revisions, payload },
      { ships: this.ships, userId: "gm", isGM: true, rollD20: () => this.d20(), random: () => this.rng() },
    );
    for (const [uuid, state] of Object.entries(result.shipStates)) this.ships[uuid].state = state;
    for (const [uuid, token] of Object.entries(result.tokenUpdates ?? {})) Object.assign(this.ships[uuid].token, token);
    return result;
  }
  tryCall(type, source, targets, payload) {
    let result = null;
    try {
      result = this.call(type, source, targets, payload);
    } catch (error) {
      const code = error.code ?? String(error);
      this.stats.rejects[`${type}:${code}`] = (this.stats.rejects[`${type}:${code}`] ?? 0) + 1;
      if (DEBUG) console.error(`  REJECT ${type} ${source}: ${code} ${error.message ?? ""}`);
      return null;
    }
    if (type === OPERATION_TYPES.COAST || type === OPERATION_TYPES.MANEUVER) {
      for (const event of result.gmEvents ?? []) {
        const collisions = event.detail?.coast?.collisions ?? event.detail?.collisions ?? [];
        this.stats.rammed += collisions.length;
      }
    }
    return result;
  }
  distance(u, v) {
    const a = this.state(u).position;
    const b = this.state(v).position;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  bearing(u, v) { return bearingDegrees(this.state(u).position, this.state(v).position); }
  speed(u) { return magnitude(this.state(u).velocity); }
  rotationBudget(u) {
    return Math.max(0, getDriveCapabilities(this.config(u), this.state(u)).rotation - (this.state(u).rotationSpent ?? 0));
  }
  pivotBudget(u) {
    return Math.max(0, getPivotCapability(this.config(u), this.state(u)) - (this.state(u).pivotSpent ?? 0));
  }
  faceHeading(u, heading) {
    const delta = shortestAngleDelta(this.state(u).facing, heading);
    const budget = this.rotationBudget(u);
    const applied = Math.max(-budget, Math.min(budget, delta));
    if (Math.abs(applied) > 0.5) this.tryCall(OPERATION_TYPES.ROTATE, u, [], { operatorId: PILOT, rotation: applied });
  }
  faceTarget(u, target) { this.faceHeading(u, this.bearing(u, target)); }
  weaponProfile(u, weaponId) { return this.config(u).components.weapons.find((weapon) => weapon.id === weaponId) ?? null; }
  canBear(u, target, weaponId) {
    const weapon = this.weaponProfile(u, weaponId);
    if (!weapon) return false;
    const hardpoint = this.config(u).hardpoints.find((entry) => entry.id === weapon.hardpointId);
    if (!hardpoint) return false;
    if (!calculateRangeBand(this.distance(u, target), weapon.range.optimal, weapon.range.maximum).valid) return false;
    return isWithinFiringArc({
      shooterPosition: this.state(u).position,
      targetPosition: this.state(target).position,
      shooterFacing: this.state(u).facing,
      hardpointOrientation: hardpoint.orientation ?? 0,
      arcWidth: weapon.arc,
    });
  }
  attack(u, target, weaponId, rounds = 1) {
    const weapon = this.state(u).weapons[weaponId];
    if (!weapon || weapon.status !== "online" || weapon.readiness <= 0) return false;
    if (!this.canBear(u, target, weaponId)) return false;
    const operator = [GUNNER, PILOT].find((id) => {
      if ((this.state(u).resources.actions?.[id] ?? 0) <= 0) return false;
      const profile = this.config(u).operators.find((entry) => entry.id === id);
      return (profile?.ratings?.gunnery ?? 0) > 0;
    });
    if (!operator) return false;
    const before = { hp: { ...this.state(target).shields.hp } };
    const expectedSector = calculateStruckSector({
      attackerPosition: this.state(u).position,
      targetPosition: this.state(target).position,
      targetFacing: this.state(target).facing,
    });
    const result = this.tryCall(OPERATION_TYPES.ATTACK, u, [target], {
      operatorId: operator,
      weaponId,
      barrageRounds: rounds,
    });
    if (!result) return false;
    const detail = (result.gmEvents ?? []).find((event) => event.type === OPERATION_TYPES.ATTACK)?.detail;
    const after = this.state(target);
    let shieldLoss = 0;
    const sectorLoss = emptySectors();
    for (const sector of SECTORS) {
      sectorLoss[sector] = Math.max(0, (before.hp[sector] ?? 0) - (after.shields.hp[sector] ?? 0));
      shieldLoss += sectorLoss[sector];
    }
    const struck = detail?.commitment?.geometry?.sector ?? expectedSector;
    const band = detail?.commitment?.range?.band
      ?? calculateRangeBand(this.distance(u, target), this.weaponProfile(u, weaponId)?.range?.optimal ?? 0, this.weaponProfile(u, weaponId)?.range?.maximum ?? 1).band;
    this.stats.strikes[target][struck] += 1;
    this.stats.roundSectorLoss[target][this.round] ??= emptySectors();
    for (const sector of SECTORS) {
      this.stats.shieldLoss[target][sector] += sectorLoss[sector];
      this.stats.roundSectorLoss[target][this.round][sector] += sectorLoss[sector];
    }
    this.stats.shieldDamage[target] += shieldLoss;
    this.stats.attacks[u] += 1;
    this.stats.rangeSamples.push(this.distance(u, target));
    this.stats.motionSamples.push(calculateRelativeMotion({
      shooterPosition: this.state(u).position,
      targetPosition: this.state(target).position,
      shooterVelocity: this.state(u).velocity,
      targetVelocity: this.state(target).velocity,
      projectileClass: this.weaponProfile(u, weaponId)?.projectileClass ?? "medium",
    }).modifier);
    const entry = (this.stats.weaponBands[u][weaponId] ??= { attacks: 0, optimal: 0, bands: {} });
    entry.attacks += 1;
    entry.bands[band] = (entry.bands[band] ?? 0) + 1;
    if (band === "optimal") entry.optimal += 1;
    return true;
  }
  recordRegeneration(u, result) {
    const events = (result?.gmEvents ?? []).flatMap((event) => event.detail?.events ?? []);
    const regeneration = events.find((event) => event.type === "shieldRegeneration")?.regeneration;
    if (!regeneration?.planned) return;
    for (const sector of SECTORS) this.stats.shieldRegen[u][sector] += regeneration.planned[sector] ?? 0;
  }
  /** Attribute the round's damage to the sector its owner funnelled regeneration into. */
  closeRound(round) {
    for (const uuid of ["A", "B"]) {
      const loss = this.stats.roundSectorLoss[uuid][round] ?? emptySectors();
      const total = SECTORS.reduce((sum, sector) => sum + loss[sector], 0);
      const routed = this.stats.funnelSector[uuid][round];
      const funnel = this.stats.funnel[uuid];
      funnel.rounds += 1;
      funnel.damage += total;
      funnel.captured += routed ? loss[routed] : 0;
      if (total > 0 && (!routed || loss[routed] <= 0)) funnel.missedRounds += 1;
      const touched = SECTORS.filter((sector) => loss[sector] > 0).length;
      const rotation = this.stats.rotation[uuid];
      if (total > 0) {
        rotation.roundsWithDamage += 1;
        rotation.distinctSum += touched;
        if (touched > 1) rotation.multiSectorRounds += 1;
      }
      delete this.stats.roundSectorLoss[uuid][round];
    }
  }
}

/* ------------------------------------------------------------------ *
 * Turn loop
 * ------------------------------------------------------------------ */

function planOrbit(duel, u, target, policy, room, thrustAllowed) {
  const state = duel.state(u);
  const distance = Math.max(1e-6, duel.distance(u, target));
  const beta = duel.bearing(u, target);
  const speed = duel.speed(u);
  const inserting = speed < policy.v - 0.5;
  const holdRadius = policy.R * (1 - CONTROL.standOff);
  const tangentHeading = normalizeHeading(beta + 90);
  const biasMax = inserting ? CONTROL.insertBiasMax : CONTROL.biasMax;
  const bias = Math.max(-biasMax, Math.min(biasMax, ((distance - holdRadius) / holdRadius) * CONTROL.gain * (180 / Math.PI)));
  const aimHeading = normalizeHeading(tangentHeading - bias);
  const thrust = duel.config(u).components.drives.main.base.thrust;
  const deltaV = inserting && thrustAllowed ? Math.max(0, Math.min(policy.v - speed, thrust * room)) : 0;
  const heading = headingOf(state.velocity);
  const gamma = heading == null ? 0 : shortestAngleDelta(tangentHeading, heading);
  const speedEff = speed + 0.5 * deltaV;
  const chord = Math.max(0, speedEff * (1 - room));
  const biasForward = ((180 / Math.PI) * (chord * chord)) / (2 * holdRadius * Math.max(1e-6, speedEff));
  const arcPivot = -((speedEff * room) / holdRadius) * (180 / Math.PI);
  const pivot = arcPivot + (-(bias + biasForward) - gamma);
  return { distance, holdRadius, speed, inserting, bias, aimHeading, deltaV, pivot, gamma };
}

function runTurn(duel, u, policy, target) {
  const started = duel.tryCall(OPERATION_TYPES.START_PHASE, u);
  duel.recordRegeneration(u, started);
  if (duel.state(u).phase !== "active") return;
  duel.tryCall(OPERATION_TYPES.TAKE_CONTROL, u, [], { operatorId: PILOT, control: "helm" });
  if (policy.evasion && !duel.state(u).evasion?.armed) {
    // Standard protocol: the shipped tier the dispatcher can arm. It reserves 20 % of the timeline,
    // which is why the station maneuver only ever gets 80 % of an activation.
    duel.tryCall(OPERATION_TYPES.ARM_EVASION, u, [], { operatorId: PILOT });
  }
  // Regeneration goes where the fire is coming from — at most the hull's own per-sector cap.
  if (duel.state(u).controls.defense == null) {
    duel.tryCall(OPERATION_TYPES.TAKE_CONTROL, u, [], { operatorId: GUNNER, control: "defense" });
  }
  const funnelSector = calculateStruckSector({
    attackerPosition: duel.state(target).position,
    targetPosition: duel.state(u).position,
    targetFacing: duel.state(u).facing,
  });
  const regenerationCap = Math.min(100, Number(duel.config(u).regenerationWeightCap ?? 100));
  duel.stats.funnelSector[u][duel.round] = funnelSector;
  duel.tryCall(OPERATION_TYPES.ROUTE_DEFENSE, u, [], {
    operatorId: GUNNER,
    staged: { regenerationAllocation: Object.fromEntries(SECTORS.map((sector) => [sector, sector === funnelSector ? regenerationCap : 0])) },
  });
  // ---- movement
  const reserve = Number(duel.state(u).evasion?.reserved ?? 0);
  const room = Math.max(0, 1 - reserve - (duel.state(u).timeline ?? 0));
  let inserting = false;
  if (policy.kind === "station") {
    const preview = planOrbit(duel, u, target, policy, room, false);
    let thrustAllowed = true;
    if (preview.inserting) {
      duel.faceHeading(u, preview.aimHeading);
      thrustAllowed = Math.abs(shortestAngleDelta(duel.state(u).facing, preview.aimHeading)) <= CONTROL.alignTol;
    } else {
      duel.faceTarget(u, target);
    }
    const plan = planOrbit(duel, u, target, policy, room, thrustAllowed);
    const budget = duel.pivotBudget(u);
    const pivot = Math.max(-budget, Math.min(budget, plan.pivot));
    const payload = { operatorId: PILOT, deltaV: { forward: plan.deltaV, lateral: 0 }, pivot };
    if (plan.deltaV <= 0.01) payload.duration = room;
    if (Math.abs(pivot) > 0.01 || plan.deltaV > 0.01) duel.tryCall(OPERATION_TYPES.MANEUVER, u, [], payload);
    inserting = plan.inserting && plan.deltaV > 0.01;
    const position = {
      round: duel.round,
      station: policy.label,
      radius: +duel.distance(u, target).toFixed(3),
      target: policy.R,
      speed: +duel.speed(u).toFixed(3),
      pivot: +Math.abs(pivot).toFixed(2),
      pivotBudget: +budget.toFixed(2),
    };
    if (plan.inserting) duel.stats.orbit[u].push({ ...position, phase: "insert" });
    else {
      const sustained = duel.stats.orbit[u].filter((entry) => entry.phase === "orbit").length;
      duel.stats.orbit[u].push({ ...position, phase: "orbit", settled: sustained >= CONTROL.settleTurns });
    }
  } else {
    duel.faceTarget(u, target);
  }
  // ---- sensors
  if (duel.state(u).tracks?.[target]?.state !== "targeted") {
    duel.tryCall(OPERATION_TYPES.PING, u, [target], { operatorId: GUNNER });
    duel.tryCall(OPERATION_TYPES.ACQUIRE, u, [target], { operatorId: GUNNER });
  }
  const track = duel.state(u).tracks?.[target];
  if (policy.solutions && track?.state === "targeted" && !track.firingSolution) {
    if (duel.tryCall(OPERATION_TYPES.FIRING_SOLUTION, u, [target], { operatorId: GUNNER })) duel.stats.solutionUses += 1;
  }
  // ---- fire everything that bears
  if (!inserting && duel.state(u).tracks?.[target]?.state === "targeted") {
    for (const weaponId of LOADOUTS[duel.variant.loadout].online) {
      const weapon = duel.state(u).weapons[weaponId];
      if (!weapon || weapon.status !== "online" || weapon.readiness <= 0) continue;
      duel.attack(u, target, weaponId, weaponId.includes("Macrocan") ? 4 : 1);
    }
  }
  duel.stats.pivotSpent[u].push(duel.state(u).pivotSpent ?? 0);
  if (TRACE) {
    const state = duel.state(u);
    console.log(`r${duel.round} ${u} T=${state.timeline.toFixed(2)} face=${state.facing.toFixed(0)} piv=${(state.pivotSpent ?? 0).toFixed(0)} spd=${duel.speed(u).toFixed(2)} pos=(${state.position.x.toFixed(1)},${state.position.y.toFixed(1)}) range=${duel.distance(u, target).toFixed(1)} track=${state.tracks?.[target]?.state ?? "-"} acts=${state.resources.actions?.[PILOT]}/${state.resources.actions?.[GUNNER]}`);
  }
  duel.tryCall(OPERATION_TYPES.COAST, u, [], { operatorId: PILOT });
  duel.tryCall(OPERATION_TYPES.END_PHASE, u);
}

function runDuel(seed, variantName, policyA, policyB, { maxRounds = ROUNDS } = {}) {
  const duel = new Duel(seed, VARIANTS[variantName]);
  duel.tryCall(OPERATION_TYPES.ENTER_COMBAT, "A", [], { turnKey: "r1" });
  duel.tryCall(OPERATION_TYPES.ENTER_COMBAT, "B", [], { turnKey: "r1" });
  const policies = { A: POLICIES[policyA], B: POLICIES[policyB] };
  for (let round = 1; round <= maxRounds; round++) {
    duel.round = round;
    for (const [u, target] of [["A", "B"], ["B", "A"]]) {
      if (duel.state(u).hull <= 0) continue;
      runTurn(duel, u, policies[u], target);
      const foe = target;
      if (duel.stats.collapse[foe] == null && SECTORS.some((sector) => (duel.state(foe).shields.hp[sector] ?? 0) <= 0)) {
        duel.stats.collapse[foe] = round;
      }
      if (duel.stats.ttkA == null && duel.state("A").hull <= 0) duel.stats.ttkA = round;
      if (duel.stats.ttkB == null && duel.state("B").hull <= 0) duel.stats.ttkB = round;
    }
    duel.closeRound(round);
    if (duel.state("A").hull <= 0 || duel.state("B").hull <= 0) break;
  }
  duel.stats.rounds = duel.round;
  duel.stats.firstCollapse = duel.stats.collapse.A ?? duel.stats.collapse.B ?? null;
  duel.stats.hullRemaining = { A: duel.state("A").hull, B: duel.state("B").hull };
  duel.stats.speed = { A: duel.speed("A"), B: duel.speed("B") };
  duel.stats.minRange = Math.min(...duel.stats.rangeSamples, Infinity);
  duel.stats.policy = { A: policyA, B: policyB };
  return duel;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : +((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2);
}
const mean = (values, digits = 3) => +(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(digits);
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
};
const sumSectors = (runs, pick) => runs.reduce((acc, duel) => {
  for (const sector of SECTORS) acc[sector] += pick(duel)[sector];
  return acc;
}, emptySectors());

function orbitSummary(entries, targetRadius) {
  const orbit = entries.filter((entry) => entry.phase === "orbit");
  if (!orbit.length) return null;
  const settled = orbit.filter((entry) => entry.settled);
  const sample = settled.length ? settled : orbit;
  const errors = sample.map((entry) => Math.abs(entry.radius - targetRadius) / targetRadius);
  const radii = sample.map((entry) => entry.radius);
  const pivots = sample.map((entry) => entry.pivot);
  return {
    targetRadius,
    holdRadius: +(targetRadius * (1 - CONTROL.standOff)).toFixed(2),
    settledTurns: sample.length,
    insertTurns: entries.filter((entry) => entry.phase === "insert").length,
    meanRadius: mean(radii, 2),
    minRadius: +Math.min(...radii).toFixed(2),
    maxRadius: +Math.max(...radii).toFixed(2),
    radiusErrorPct: +(100 * (errors.reduce((a, b) => a + b, 0) / errors.length)).toFixed(2),
    radiusP95ErrorPct: +(100 * (quantile(errors, 0.95) ?? 0)).toFixed(2),
    radiusMaxErrorPct: +(100 * Math.max(...errors)).toFixed(2),
    pivotMedian: median(pivots),
    pivotSpendPctMedian: median(sample.map((entry) => +(100 * entry.pivot / Math.max(1e-9, entry.pivotBudget)).toFixed(1))),
    pivotCapabilityMin: +Math.min(...sample.map((entry) => entry.pivotBudget)).toFixed(1),
    insideNominalPct: +(100 * sample.filter((entry) => entry.radius <= targetRadius + 1e-9).length / sample.length).toFixed(1),
    clippedTurns: sample.filter((entry) => entry.pivot >= entry.pivotBudget - 0.01).length,
  };
}

function weaponSummary(bands, variant) {
  const summary = {};
  for (const weaponId of LOADOUTS[variant.loadout].online) {
    const entry = bands[weaponId];
    if (!entry) continue;
    summary[weaponId] = {
      attacks: entry.attacks,
      optimal: entry.optimal,
      optimalPct: +(100 * (entry.optimal / Math.max(1, entry.attacks))).toFixed(1),
      bands: entry.bands,
    };
  }
  return summary;
}

function sectorSummary(strikes, loss, regen, funnel, rotation) {
  const damageTotal = SECTORS.reduce((sum, sector) => sum + loss[sector], 0);
  const top = Math.max(...SECTORS.map((sector) => loss[sector]));
  return {
    struck: strikes,
    damage: loss,
    regen,
    damageTotal,
    regenTotal: SECTORS.reduce((sum, sector) => sum + regen[sector], 0),
    funnelCapture: damageTotal > 0 ? +(funnel.captured / damageTotal).toFixed(3) : null,
    funnelMissedRounds: funnel.missedRounds,
    funnelRounds: funnel.rounds,
    distinctSectorsDamaged: SECTORS.filter((sector) => loss[sector] > 0).length,
    topSectorShare: damageTotal > 0 ? +(top / damageTotal).toFixed(3) : null,
    sectorsPerDamagedRound: rotation.roundsWithDamage > 0 ? +(rotation.distinctSum / rotation.roundsWithDamage).toFixed(2) : null,
    multiSectorRoundShare: rotation.roundsWithDamage > 0 ? +(rotation.multiSectorRounds / rotation.roundsWithDamage).toFixed(3) : null,
  };
}

function runScenario(scenario, runsPer) {
  const runs = [];
  for (let index = 0; index < runsPer; index += 1) {
    runs.push(runDuel(7000 + index * 7919, scenario.variant, scenario.policyA, scenario.policyB));
  }
  const ttks = runs
    .map((duel) => (duel.stats.ttkA != null || duel.stats.ttkB != null ? Math.min(duel.stats.ttkA ?? 99, duel.stats.ttkB ?? 99) : null))
    .filter((value) => value != null);
  const side = (uuid) => {
    const policyKey = uuid === "A" ? scenario.policyA : scenario.policyB;
    const policy = POLICIES[policyKey];
    const bands = {};
    for (const duel of runs) {
      for (const [weaponId, entry] of Object.entries(duel.stats.weaponBands[uuid])) {
        bands[weaponId] ??= { attacks: 0, optimal: 0, bands: {} };
        bands[weaponId].attacks += entry.attacks;
        bands[weaponId].optimal += entry.optimal;
        for (const [band, count] of Object.entries(entry.bands)) bands[weaponId].bands[band] = (bands[weaponId].bands[band] ?? 0) + count;
      }
    }
    return {
      policy: policyKey,
      policyLabel: policy.label,
      orbit: policy.kind === "station" ? orbitSummary(runs.flatMap((duel) => duel.stats.orbit[uuid]), policy.R) : null,
      weapons: weaponSummary(bands, runs[0].variant),
      sectors: sectorSummary(
        sumSectors(runs, (duel) => duel.stats.strikes[uuid]),
        sumSectors(runs, (duel) => duel.stats.shieldLoss[uuid]),
        sumSectors(runs, (duel) => duel.stats.shieldRegen[uuid]),
        runs.reduce((acc, duel) => {
          for (const key of ["rounds", "damage", "captured", "missedRounds"]) acc[key] += duel.stats.funnel[uuid][key];
          return acc;
        }, { rounds: 0, damage: 0, captured: 0, missedRounds: 0 }),
        runs.reduce((acc, duel) => {
          for (const key of ["roundsWithDamage", "distinctSum", "multiSectorRounds"]) acc[key] += duel.stats.rotation[uuid][key];
          return acc;
        }, { roundsWithDamage: 0, distinctSum: 0, multiSectorRounds: 0 }),
      ),
      speed: mean(runs.map((duel) => duel.stats.speed[uuid]), 2),
      pivotSpentMedian: median(runs.flatMap((duel) => duel.stats.pivotSpent[uuid])),
      pivotSpentP95: quantile(runs.flatMap((duel) => duel.stats.pivotSpent[uuid]), 0.95),
    };
  };
  return {
    id: scenario.id,
    variant: scenario.variant,
    match: scenario.match,
    label: scenario.label,
    policyA: scenario.policyA,
    policyB: scenario.policyB,
    runs: runsPer,
    killRate: +(ttks.length / runsPer).toFixed(2),
    medianTtk: median(ttks),
    medianFirstCollapse: median(runs.map((duel) => duel.stats.firstCollapse).filter((value) => value != null)),
    shieldDmgPerTurn: {
      A_deals: mean(runs.map((duel) => duel.stats.shieldDamage.B / duel.stats.rounds)),
      B_deals: mean(runs.map((duel) => duel.stats.shieldDamage.A / duel.stats.rounds)),
    },
    hullDmgPerTurn: {
      A_deals: mean(runs.map((duel) => duel.stats.hullDamage.B / duel.stats.rounds)),
      B_deals: mean(runs.map((duel) => duel.stats.hullDamage.A / duel.stats.rounds)),
    },
    medianHullRemaining: { A: median(runs.map((duel) => duel.stats.hullRemaining.A)), B: median(runs.map((duel) => duel.stats.hullRemaining.B)) },
    attacksPerTurn: mean(runs.map((duel) => (duel.stats.attacks.A + duel.stats.attacks.B) / (2 * duel.stats.rounds))),
    meanRounds: mean(runs.map((duel) => duel.stats.rounds), 2),
    solutionsPerTurn: mean(runs.map((duel) => duel.stats.solutionUses / (2 * duel.stats.rounds))),
    motionModifier: mean(runs.flatMap((duel) => duel.stats.motionSamples)),
    range: mean(runs.flatMap((duel) => duel.stats.rangeSamples), 1),
    medianMinRange: median(runs.map((duel) => (Number.isFinite(duel.stats.minRange) ? +duel.stats.minRange.toFixed(1) : null)).filter((value) => value != null)),
    ramEvents: runs.reduce((acc, duel) => acc + duel.stats.rammed, 0),
    rejects: runs.reduce((acc, duel) => {
      for (const [key, value] of Object.entries(duel.stats.rejects)) acc[key] = (acc[key] ?? 0) + value;
      return acc;
    }, {}),
    sides: { A: side("A"), B: side("B") },
  };
}

function sweep(scenarios, runsPer) {
  const results = [];
  for (const scenario of scenarios) {
    const started = Date.now();
    results.push(runScenario(scenario, runsPer));
    console.error(`  ${scenario.label.padEnd(28)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return { runsPer, quick: QUICK, generatedAt: new Date().toISOString(), thrust: THRUST_KEY, results };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main() {
  const runsPer = QUICK ? 20 : 120;
  const scenarios = SCENARIOS.filter((scenario) => matchesOnly(scenario, ONLY));
  if (!scenarios.length) throw new Error(`--only=${ONLY} matched no scenario`);
  if (TRACE || DEBUG) {
    const scenario = scenarios[0];
    const duel = runDuel(11, scenario.variant, scenario.policyA, scenario.policyB, { maxRounds: DEBUG ? 20 : 14 });
    console.log("rejects:", JSON.stringify(duel.stats.rejects, null, DEBUG ? 1 : 0));
    console.log("rounds:", duel.stats.rounds, "hull:", duel.stats.hullRemaining, "speed:", duel.stats.speed, "minRange:", duel.stats.minRange);
    console.log("shieldDamage:", JSON.stringify(duel.stats.shieldDamage), "hullDamage:", JSON.stringify(duel.stats.hullDamage));
    console.log("strikes:", JSON.stringify(duel.stats.strikes));
    console.log("round losses:", JSON.stringify(duel.stats.roundSectorLoss));
    console.log("funnel:", JSON.stringify(duel.stats.funnel));
    console.log("rotation:", JSON.stringify(duel.stats.rotation));
    console.log("regen:", JSON.stringify(duel.stats.shieldRegen));
    for (const uuid of ["A", "B"]) {
      const policy = POLICIES[uuid === "A" ? scenario.policyA : scenario.policyB];
      console.log(uuid, policy.label, "orbit:", JSON.stringify(orbitSummary(duel.stats.orbit[uuid], policy.R ?? 0)));
    }
    return;
  }
  if (ONLY || NO_PARALLEL) {
    const payload = sweep(scenarios, runsPer);
    writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);
    console.log(JSON.stringify(payload, null, 1));
    return;
  }
  // One process per scenario, bounded by the CPU count: each duel clones and validates full ship
  // states, so sharding is the difference between a two-minute and a twelve-minute sweep.
  const jobs = Math.max(1, Math.min(scenarios.length, Number(process.env.VIRA_SIM_JOBS) || cpus().length));
  const dir = mkdtempSync(join(tmpdir(), "vira-sim-"));
  const script = fileURLToPath(import.meta.url);
  const chunks = Array.from({ length: jobs }, (_, index) => scenarios.filter((_, position) => position % jobs === index)).filter((chunk) => chunk.length);
  const children = chunks.map((chunk, index) => {
    const file = join(dir, `shard-${index}.json`);
    const child = Bun.spawn([
      process.execPath,
      script,
      `--only=${chunk.map((scenario) => scenario.id).join(",")}`,
      `--out=${file}`,
      ...(QUICK ? ["--quick"] : []),
      ...(THRUST_KEY !== "shipped" ? [`--thrust=${THRUST_KEY}`] : []),
    ], { stdout: "pipe", stderr: "inherit" });
    return { child, file };
  });
  const payloads = [];
  for (const { child, file } of children) {
    const exit = await child.exited;
    if (exit !== 0) {
      const stdout = await new Response(child.stdout).text();
      throw new Error(`sweep shard failed (${exit}): ${stdout.slice(-2000)}`);
    }
    payloads.push(JSON.parse(readFileSync(file, "utf8")));
  }
  rmSync(dir, { recursive: true, force: true });
  const merged = {
    runsPer,
    quick: QUICK,
    generatedAt: new Date().toISOString(),
    thrust: THRUST_KEY,
    jobs: chunks.length,
    results: SCENARIOS.flatMap((scenario) => payloads.flatMap((payload) => payload.results.filter((row) => row.id === scenario.id))),
  };
  writeFileSync(OUT, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(JSON.stringify(merged, null, 1));
}

await main();
