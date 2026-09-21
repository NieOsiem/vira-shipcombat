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
 * The harness is hull-agnostic. `--hull=<reference-build-id>` sweeps a bundled build;
 * `--hull-file=<hull.json> --components-file=<items.json>` sweeps an arbitrary schema-v2 hull with
 * its own component Items. With no hull flag it sweeps the shipped default build exactly as before.
 * Everything hull-derived — shield pool keys, the pilot/gunner roles, the online weapon loadouts
 * (and the swap variant that stands in for the primary gun), the station radii and speeds, and the
 * scenario matrix — is read from the loaded configuration, so no bundled id, sector or operator
 * name appears in the policies below.
 *
 * Turn doctrines are selected by the hull's own command roster: `corvette` (two or more command
 * operators) is the shipped flow — gunner owns Ping/Acquire/Solution and the shots — while `fighter`
 * (a single command operator, one console for helm/sensing/guns) serializes the turn and fires every
 * bearing gun before it spends a spare Action on a Firing Solution. `hangfire` in every result row
 * counts the bearing, ready guns that could not fire because the hull's Actions ran out: the price a
 * one-console hull pays for its third job.
 *
 * Usage: bun tools/sim/duel.mjs [--quick] [--debug] [--trace] [--only=<substring[,substring]>]
 *                               [--out=<file>] [--thrust=shipped|retune] [--no-parallel]
 *                               [--hull=<build-id>] [--hull-file=<file>] [--components-file=<file>]
 * Writes tools/sim/results.json next to this script — results-<hullId>.json when another hull is
 * selected, so a second hull can never clobber the default sweep; `python3 tools/sim/report.py`
 * renders report.md from it.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SECTORS as GEOMETRY_SECTORS, TRAIT_IDS } from "../../scripts/constants.js";
import { DEFAULT_REFERENCE_BUILD_ID, REFERENCE_BUILDS, referenceBuild } from "../../scripts/data/reference-builds.js";
import { materializeShipConfig } from "../../scripts/model/equipment.js";
import { createInitialState } from "../../scripts/model/defaults.js";
import { executeShipOperation, OPERATION_TYPES } from "../../scripts/rules/operations.js";
import {
  BARRAGE_PROFILES,
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
const HULL_ARG = argumentValue("--hull");
const HULL_FILE = argumentValue("--hull-file");
const COMPONENTS_FILE = argumentValue("--components-file");

function argumentValue(flag) {
  const prefix = `${flag}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const ROUNDS = 40;
const START_RANGE = 60;

/* ------------------------------------------------------------------ *
 * Configuration knobs that are still real: the drive thrust package
 * ------------------------------------------------------------------ */

export const THRUST_PACKAGES = {
  shipped: null,
  retune: { main: 10, retro: 5, lateral: 3 },
};
const THRUST_KEY = argumentValue("--thrust") ?? "shipped";
if (!(THRUST_KEY in THRUST_PACKAGES)) throw new Error(`unknown --thrust=${THRUST_KEY}`);

/* ------------------------------------------------------------------ *
 * Hull loading — every later decision reads from this, never from a bundled id
 * ------------------------------------------------------------------ */

function readJson(file) {
  const path = resolve(file);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * A data file is JSON, or a JS module exporting the same payload. Catalogue hulls live in
 * `world-data/**` as modules (they import `componentSource()` and share the module's own shapes), so
 * the `.js`/`.mjs` form is the primary one and JSON stays for ad-hoc files.
 */
async function readDataFile(file) {
  const path = resolve(file);
  if (/\.(mjs|js|cjs)$/.test(path)) {
    try {
      return await import(pathToFileURL(path).href);
    } catch (error) {
      throw new Error(`cannot import ${path}: ${error.message}`);
    }
  }
  return readJson(file);
}

/** @returns {Promise<object>} a hull config, from a bare object or a module exporting one. */
async function readHullConfig(file) {
  const payload = await readDataFile(file);
  const isHull = (value) => Boolean(value) && typeof value === "object" && typeof value.id === "string" && Array.isArray(value.slots);
  const candidates = [payload, payload?.default, ...Object.values(payload ?? {})];
  for (const candidate of candidates) {
    if (isHull(candidate)) return candidate;
  }
  for (const key of ["hull", "config", "hullConfig"]) {
    if (isHull(payload?.[key])) return payload[key];
  }
  throw new Error(`${file} must be a hull config, or a module exporting one (e.g. *_HULL_CONFIG)`);
}

/** A hull id is data: never let it steer a path when it becomes part of an output filename. */
export const outputSlug = (value) => {
  const slug = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 80);
  return slug || "hull";
};

/** A component catalogue file is a bare Item array, an object wrapping one, or a module exporting one. */
async function readComponentSources(file) {
  const payload = await readDataFile(file);
  const isSources = (value) => Array.isArray(value) && value.every((entry) => Boolean(entry) && typeof entry === "object" && typeof entry._id === "string");
  const candidates = [payload, payload?.default, ...Object.values(payload ?? {})];
  for (const candidate of candidates) {
    if (isSources(candidate)) return candidate;
  }
  for (const key of ["items", "components", "componentSources", "sources"]) {
    if (isSources(payload?.[key])) return payload[key];
  }
  throw new Error(`${file} must be an array of component Items, an object carrying one, or a module exporting one`);
}

/**
 * Resolve the hull to sweep: a bundled reference build, or a hull file plus the component Items it
 * installs. A hull file inherits the bundled kit when its ID is a reference build, exactly as
 * `reference-builds.js` defines the relationship; any other hull must name its components, because a
 * custom hull installs nothing by itself. `--components-file` also overrides a bundled build's kit,
 * which is how a refit of a reference hull gets swept. The pair is materialized once here, so a
 * malformed hull or a dangling installation fails before the sweep starts with the engine's own
 * error code.
 * @returns {{id:string,label:string,hull:object,componentSources:object[],config:object,source:string}}
 */
export async function loadBuild({ hull, hullFile, componentsFile } = {}) {
  const bundled = referenceBuild(hull ?? DEFAULT_REFERENCE_BUILD_ID);
  if (!hullFile && !bundled) {
    throw new Error(`unknown --hull=${hull}; bundled builds: ${REFERENCE_BUILDS.map((entry) => entry.id).join(", ")}`);
  }
  const hullConfig = hullFile ? await readHullConfig(hullFile) : bundled.hull;
  const inheritedKit = hullFile ? referenceBuild(hullConfig?.id)?.componentSources ?? null : bundled.componentSources;
  if (!componentsFile && !inheritedKit) {
    throw new Error("--hull-file requires --components-file unless the hull's ID is a bundled reference build");
  }
  const componentSources = componentsFile ? await readComponentSources(componentsFile) : inheritedKit;
  const id = hullConfig?.id ?? "custom-hull";
  return {
    id,
    label: hullConfig?.label ?? id,
    hull: hullConfig,
    componentSources,
    config: materializeShipConfig(hullConfig, componentSources),
    source: `${hullFile ?? `${id} (reference build)`}${componentsFile ? ` + ${componentsFile}` : ""}`,
  };
}

/**
 * The shield pool keys this hull actually has. A directional deflector has one key per configured
 * sector; a Bubble Shield has the single pool rules §7.6 describes, so a hull-level
 * Regeneration Allocation is meaningless there. This restates `sectorsFor` in scripts/rules/shields.js,
 * which is module-private, and is the harness's only copy of that rule.
 */
function shieldSectors(config) {
  const shield = config?.components?.shield;
  if (!shield) return [];
  if (shield.topology === "bubble") return [shield.sectors?.[0] ?? "bubble"];
  const configured = Array.isArray(shield.sectors) && shield.sectors.length ? shield.sectors : GEOMETRY_SECTORS;
  return GEOMETRY_SECTORS.filter((sector) => configured.includes(sector));
}

/**
 * Who flies and who shoots, straight from the hull's own operator profiles: the pilot is the best
 * Piloting rating, the gunner the best Gunnery rating that is not the pilot whenever the hull can
 * afford a second seat. A single-seat craft resolves both roles to its one operator — which is the
 * case the control handoff in `runTurn` has to survive, because one operator cannot hold Helm and
 * Defense at once and every Control Action spends from the same three-Action pool.
 *
 * Roles are resolved inside the hull's Command seats on purpose: Actions come from
 * `resources.actions`, which `refreshResources` seeds for command assignments only — a crew profile
 * carries Orders, so seating one as gunner would silently rob the hull of every shot (and of the
 * hangfire that would have shown it).
 */
function operatorsFor(config) {
  const profiles = config?.operators ?? [];
  const command = profiles.filter((profile) => profile?.defaultAssignment?.kind === "command");
  const pool = command.length ? command : profiles;
  const best = (rating) => pool.reduce(
    (winner, profile) => ((profile?.ratings?.[rating] ?? 0) > (winner?.ratings?.[rating] ?? -1) ? profile : winner),
    null,
  );
  const pilot = best("piloting") ?? pool[0] ?? null;
  const gunnerBest = best("gunnery");
  const gunner = gunnerBest && gunnerBest.id === pilot?.id
    ? pool.find((profile) => profile.id !== pilot.id && (profile.ratings?.gunnery ?? 0) > 0) ?? gunnerBest
    : gunnerBest;
  return { pilot, gunner };
}

/** The weapon's short name — its label's last word — so a swap variant can be named after it. */
const shortName = (weapon) => String(weapon?.label ?? weapon?.id ?? "weapon").trim().split(/\s+/).at(-1).toLowerCase();

/**
 * The engine's own weapon-online rule (defaults.js `initialWeapons`): walk the hull's Weapon
 * Priority and reserve Weapons Power while it fits. Replayed here — the module does not export it —
 * so the harness can also ask for the same set with the hull's first-priority weapon excluded:
 * rules §18.10's Railgun→Pulse Laser swap, generalized to "what this hull looks like when its
 * primary gun is the wrong tool, or gone".
 */
function onlineWeapons(config, weaponsPower, excluded = null) {
  const weapons = config?.components?.weapons ?? [];
  const byId = new Map(weapons.map((weapon) => [weapon.id, weapon]));
  const priority = [...(config?.weaponPriority ?? [])];
  for (const weapon of [...weapons].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!priority.includes(weapon.id)) priority.push(weapon.id);
  }
  const online = [];
  let reserved = 0;
  for (const id of priority) {
    if (id === excluded) continue;
    const weapon = byId.get(id);
    if (!weapon) continue;
    const rating = Number(weapon.powerRating ?? 0);
    if (reserved + rating > weaponsPower) continue;
    online.push(id);
    reserved += rating;
  }
  return online;
}

/**
 * Barrage rounds the policy declares. The engine owns the profile table (combat.js `BARRAGE_PROFILES`,
 * keyed 1/4/6/8/10) and ignores any profile list a component trait carries, so the smallest standard
 * profile above a single round is what the harness fires — the cheapest way to put more than one
 * round in the air (rules §9.5: the attacker declares the round count).
 */
const DECLARED_BARRAGE_ROUNDS = Math.min(...Object.keys(BARRAGE_PROFILES).map(Number).filter((rounds) => rounds > 1));

function barrageRounds(weapon) {
  const barrage = (weapon?.traits ?? []).some((candidate) => candidate.id === TRAIT_IDS.barrage);
  return barrage ? DECLARED_BARRAGE_ROUNDS : 1;
}

/**
 * Movement policies, derived from the hull: the station radius is the tightest Optimal Range its
 * guns have (the band every installed weapon can still use), the brawl radius half of that, and the
 * orbital speeds the 40/60/80/100 % rungs of the hull's own Safe Velocity. `role` and `orbitRole`
 * let a caller (or the balance report) pick a rung without knowing its speed.
 */
const ORBIT_FRACTIONS = [0.4, 0.6, 0.8, 1];

function buildPolicies(config) {
  const optima = (config?.components?.weapons ?? [])
    .map((weapon) => Number(weapon?.range?.optimal))
    .filter((value) => Number.isFinite(value));
  const radius = optima.length ? Math.min(...optima) : 30;
  const safe = Number(config?.safeVelocity ?? 0);
  const policies = {
    hover: { key: "hover", role: "hover", kind: "hover", solutions: true, evasion: true, label: "hover" },
  };
  const brawlSpeed = +(safe * ORBIT_FRACTIONS[0]).toFixed(3);
  const brawlRadius = radius / 2;
  policies.brawl = {
    key: "brawl", role: "brawl", kind: "station", v: brawlSpeed, R: brawlRadius,
    solutions: true, evasion: true, label: `brawl station ${brawlRadius} su @ ${brawlSpeed}`,
  };
  ORBIT_FRACTIONS.forEach((fraction, orbitRole) => {
    const v = +(safe * fraction).toFixed(3);
    const key = `orbit${v}`;
    policies[key] = {
      key, role: "orbit", orbitRole, kind: "station", v, R: radius,
      solutions: true, evasion: true, label: `orbit ${radius} su @ ${v}`,
    };
  });
  return policies;
}

/**
 * The shipped scenario matrix, written against policy *roles* rather than keys or speeds. The
 * template is hull-independent; the keys, ids and labels it resolves to are not, so a hull with a
 * different safe velocity or gun range produces the same fourteen engagements under its own names.
 */
const SCENARIO_TEMPLATE = [
  [0, "hover", "hover", "hover mirror"],
  [0, "brawl", "hover", "brawl vs hover"],
  [0, "orbit0", "hover", "orbit {v0} vs hover"],
  [0, "orbit1", "hover", "orbit {v1} vs hover"],
  [0, "orbit2", "hover", "orbit {v2} vs hover"],
  [0, "orbit3", "hover", "orbit {v3} vs hover"],
  [0, "orbit1", "orbit1", "orbit {v1} mirror"],
  [0, "brawl", "orbit1", "brawl vs orbit {v1}"],
  [0, "brawl", "brawl", "brawl mirror"],
  [1, "hover", "hover", "{alt} hover mirror"],
  [1, "brawl", "hover", "{alt} brawl vs hover"],
  [1, "orbit1", "hover", "{alt} orbit {v1} vs hover"],
  [1, "orbit1", "orbit1", "{alt} orbit {v1} mirror"],
  [1, "brawl", "orbit1", "{alt} brawl vs orbit {v1}"],
];

function buildScenarios({ policies, altKey }) {
  const orbits = Object.values(policies)
    .filter((policy) => policy.role === "orbit")
    .sort((left, right) => left.orbitRole - right.orbitRole);
  const speeds = orbits.map((policy) => policy.v);
  const keyFor = (role) => (role.startsWith("orbit") ? orbits[Number(role.slice(5))].key : policies[role].key);
  return SCENARIO_TEMPLATE.map(([variantIndex, roleA, roleB, template], index) => {
    const variant = variantIndex === 0 ? "base" : altKey;
    const policyA = keyFor(roleA);
    const policyB = keyFor(roleB);
    const label = template
      .replace("{alt}", altKey)
      .replace(/\{v(\d)\}/g, (_, position) => String(speeds[Number(position)]));
    return { index, id: `${variant}:${policyA}-${policyB}`, variant, policyA, policyB, label, match: `${policyA} vs ${policyB}` };
  });
}

/* ------------------------------------------------------------------ *
 * Environment — built once, read by every policy below
 * ------------------------------------------------------------------ */

/**
 * Turn a loaded build into everything the sweep reads: the materialized config, the hull's shield
 * pool keys, its two operators, its loadouts and variants, its policies and its scenario matrix.
 * Pure: the environment is returned and threaded through the callers, never held in module state.
 * @param {object} build result of `loadBuild`
 * @param {{thrust?:string,quick?:boolean}} [options]
 */
export function configureSimulation(build, { thrust = THRUST_KEY, quick = QUICK } = {}) {
  if (!(thrust in THRUST_PACKAGES)) throw new Error(`unknown thrust package ${thrust}`);
  const config = build.config ?? materializeShipConfig(build.hull, build.componentSources);
  // The state the engine itself ships for this hull: its initial Power routing is what decides how
  // many weapons can be online, and its roster is who the operations below may address.
  const shipped = createInitialState(config);
  const weaponsPower = Number(shipped.power?.weapons ?? 0);
  const weapons = config.components?.weapons ?? [];
  const primary = (config.weaponPriority ?? [])[0] ?? weapons[0]?.id ?? null;
  const baseOnline = onlineWeapons(config, weaponsPower);
  const swapOnline = onlineWeapons(config, weaponsPower, primary);
  const swappedIn = swapOnline.find((id) => !baseOnline.includes(id));
  const swappedOut = baseOnline.find((id) => !swapOnline.includes(id));
  const swapWeapon = weapons.find((weapon) => weapon.id === (swappedIn ?? swappedOut));
  const altKey = swapWeapon ? shortName(swapWeapon) : "alt";
  const nameOf = (id) => shortName(weapons.find((weapon) => weapon.id === id));
  const thrustConfig = THRUST_PACKAGES[thrust];
  const suffix = thrustConfig ? " (retuned drives)" : "";
  const loadouts = {
    base: { label: baseOnline.map(nameOf).join(" + "), online: baseOnline },
    [altKey]: { label: swapOnline.map(nameOf).join(" + "), online: swapOnline },
  };
  const variants = {
    base: { key: "base", label: `${loadouts.base.label}${suffix}`, thrust: thrustConfig, loadout: "base" },
    [altKey]: { key: altKey, label: `${loadouts[altKey].label}${suffix}`, thrust: thrustConfig, loadout: altKey },
  };
  const policies = buildPolicies(config);
  const operators = operatorsFor(config);
  const commandOperators = Array.isArray(shipped.roster?.command) ? shipped.roster.command.length : 0;
  const env = {
    build,
    hull: build.hull,
    componentSources: build.componentSources,
    config,
    sectors: shieldSectors(config),
    geometrySectors: [...GEOMETRY_SECTORS],
    directional: Boolean(config.components?.shield) && config.components.shield.topology !== "bubble",
    operators,
    attackers: [...new Set([operators.gunner?.id, operators.pilot?.id].filter(Boolean))],
    loadouts,
    variants,
    policies,
    scenarios: buildScenarios({ policies, altKey }),
    thrustKey: thrust,
    quick,
    simulation: {
      rounds: ROUNDS,
      startRange: START_RANGE,
      runsPer: quick ? 20 : 120,
      // One console for the whole hull: the roles collapse, so the turn is serialized below.
      oneConsole: operators.pilot != null && operators.pilot.id === operators.gunner?.id,
      commandOperators,
      // A hull with a single command operator has one console for helm, sensing and shooting: its
      // Action economy needs the fighter doctrine, not the corvette's gunner-owned sensor chain.
      doctrine: commandOperators <= 1 ? "fighter" : "corvette",
    },
  };
  return env;
}

/* ------------------------------------------------------------------ *
 * Movement policies
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
  standOff: 0.04,     // hold this fraction inside the nominal radius (keeps the primary gun's edge)
  settleTurns: 4,     // sustained samples skipped after the ship first reaches station speed
};

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
const emptySectors = (sectors = []) => Object.fromEntries(sectors.map((sector) => [sector, 0]));

/**
 * The encounter state for one ship, built by the engine's own initializer: hull, Heat, the shipped
 * Power routing, the shield pool's distribution (equal split for a directional deflector, the whole
 * budget for a Bubble Shield), the roster and the readiness each weapon's own type carries. The
 * harness only overlays the scenario position/facing, the GM identity every operator gets, and the
 * variant's online weapon set — never a hand-written number that a hull config already owns.
 */
function makeShip(uuid, x, y, rotation, variant, env) {
  const config = materializeShipConfig(env.hull, env.componentSources);
  if (variant.thrust) {
    config.components.drives.main.base.thrust = variant.thrust.main;
    config.components.drives.reverse.base.thrust = variant.thrust.retro;
    config.components.drives.portLateral.base.thrust = variant.thrust.lateral;
    config.components.drives.starboardLateral.base.thrust = variant.thrust.lateral;
  }
  const state = createInitialState(structuredClone(config));
  state.position = { x, y };
  state.facing = rotation;
  const online = new Set(env.loadouts[variant.loadout].online);
  for (const [id, weapon] of Object.entries(state.weapons)) {
    weapon.status = online.has(id) ? "online" : "off";
    weapon.mode = "nominal";
    weapon.bootCounter = 0;
  }
  for (const operator of config.operators) operator.userId = "gm";
  for (const kind of ["command", "crew"]) for (const actor of state.roster[kind]) actor.userId = "gm";
  return { uuid, config, state, token: { uuid, x, y, rotation, width: 2 } };
}

class Duel {
  constructor(env, seed, variant) {
    this.env = env;
    this.rng = mulberry32(seed);
    this.variant = variant;
    this.ships = {
      A: makeShip("A", 0, 0, 0, variant, env),
      B: makeShip("B", env.simulation.startRange, 0, 180, variant, env),
    };
    this.round = 0;
    this.stats = {
      rounds: 0, ttkA: null, ttkB: null, collapse: {}, shieldDamage: { A: 0, B: 0 }, hullDamage: { A: 0, B: 0 },
      attacks: { A: 0, B: 0 }, rangeSamples: [], motionSamples: [],
      solutionUses: 0, rammed: 0, rejects: {}, hangfire: { A: 0, B: 0 },
      orbit: { A: [], B: [] },
      weaponBands: { A: {}, B: {} },
      strikes: { A: emptySectors(env.geometrySectors), B: emptySectors(env.geometrySectors) },
      shieldLoss: { A: emptySectors(env.sectors), B: emptySectors(env.sectors) },
      shieldRegen: { A: emptySectors(env.sectors), B: emptySectors(env.sectors) },
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
    if (Math.abs(applied) > 0.5) this.tryCall(OPERATION_TYPES.ROTATE, u, [], { operatorId: this.env.operators.pilot.id, rotation: applied });
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
    // Whoever can shoot: the hull's gunner first, then its pilot (a single-seat craft is both).
    const operator = this.env.attackers.find((id) => {
      if ((this.state(u).resources.actions?.[id] ?? 0) <= 0) return false;
      const profile = this.config(u).operators.find((entry) => entry.id === id);
      return (profile?.ratings?.gunnery ?? 0) > 0;
    });
    if (!operator) {
      // The gun was online, ready and bearing; nobody had an Action left to pull the trigger. That
      // is the hangfire this hull's Action economy costs it, counted rather than hidden.
      if (this.env.attackers.every((id) => (this.state(u).resources.actions?.[id] ?? 0) <= 0)) {
        this.stats.hangfire[u] += 1;
      }
      return false;
    }
    const pools = this.env.sectors;
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
    const sectorLoss = emptySectors(pools);
    for (const sector of pools) {
      sectorLoss[sector] = Math.max(0, (before.hp[sector] ?? 0) - (after.shields.hp[sector] ?? 0));
      shieldLoss += sectorLoss[sector];
    }
    // The struck sector is target geometry (armor is directional even under a Bubble Shield); the
    // damage itself lands on whichever pool keys this hull has.
    const struck = detail?.commitment?.geometry?.sector ?? expectedSector;
    const band = detail?.commitment?.range?.band
      ?? calculateRangeBand(this.distance(u, target), this.weaponProfile(u, weaponId)?.range?.optimal ?? 0, this.weaponProfile(u, weaponId)?.range?.maximum ?? 1).band;
    this.stats.strikes[target][struck] += 1;
    this.stats.roundSectorLoss[target][this.round] ??= emptySectors(pools);
    for (const sector of pools) {
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
  /** Remaining Actions for an operator on this ship (0 when the pool is empty). */
  actionsLeft(u, operatorId) { return this.state(u).resources.actions?.[operatorId] ?? 0; }
  trackState(u, target) { return this.state(u).tracks?.[target]?.state ?? null; }
  /**
   * PING/ACQUIRE pass. `always` is the shipped two-console flow: any untargeted track gets a fresh
   * Ping (which also refreshes the target's active-contact lifetime) and then an Acquire. `advance`
   * is the one-console flow: the hull has three Actions for helm, sensing and shooting, so it spends
   * only on the operation that moves the track forward and never re-pings a contact it already holds.
   */
  sensorPass(u, target, gunner, mode) {
    if (mode === "advance") {
      if (this.trackState(u, target) !== "contact" && this.trackState(u, target) !== "targeted") {
        this.tryCall(OPERATION_TYPES.PING, u, [target], { operatorId: gunner });
      }
      if (this.trackState(u, target) === "contact") this.tryCall(OPERATION_TYPES.ACQUIRE, u, [target], { operatorId: gunner });
      return;
    }
    if (this.trackState(u, target) !== "targeted") {
      this.tryCall(OPERATION_TYPES.PING, u, [target], { operatorId: gunner });
      this.tryCall(OPERATION_TYPES.ACQUIRE, u, [target], { operatorId: gunner });
    }
  }
  /** The one-use Firing Solution lives on the track and is worth +4 on the attacks it precedes. */
  solutionPass(u, target, gunner) {
    const track = this.state(u).tracks?.[target];
    if (track?.state === "targeted" && !track.firingSolution) {
      if (this.tryCall(OPERATION_TYPES.FIRING_SOLUTION, u, [target], { operatorId: gunner })) this.stats.solutionUses += 1;
    }
  }
  /** Fire every online, ready weapon that bears. While inserting the hull is flying an approach. */
  firePass(u, target, inserting) {
    if (inserting || this.trackState(u, target) !== "targeted") return;
    for (const weaponId of this.env.loadouts[this.variant.loadout].online) {
      const weapon = this.state(u).weapons[weaponId];
      if (!weapon || weapon.status !== "online" || weapon.readiness <= 0) continue;
      this.attack(u, target, weaponId, barrageRounds(this.weaponProfile(u, weaponId)));
    }
  }
  recordRegeneration(u, result) {
    const events = (result?.gmEvents ?? []).flatMap((event) => event.detail?.events ?? []);
    const regeneration = events.find((event) => event.type === "shieldRegeneration")?.regeneration;
    if (!regeneration?.planned) return;
    for (const sector of this.env.sectors) this.stats.shieldRegen[u][sector] += regeneration.planned[sector] ?? 0;
  }
  /**
   * The regeneration funnel this hull can actually run: the facet the incoming fire is coming
   * through — taken from the target's *current* attitude, before it manoeuvres — at the hull's own
   * per-facet cap. A Bubble Shield has no facets: the engine gives the single pool the whole budget
   * regardless of any staged weight, so this returns null and the turn loop skips the Control
   * Action that would buy nothing.
   */
  defensePlan(u, target) {
    if (!this.env.directional) return null;
    const sector = calculateStruckSector({
      attackerPosition: this.state(target).position,
      targetPosition: this.state(u).position,
      targetFacing: this.state(u).facing,
    });
    const cap = Math.min(100, Number(this.config(u).regenerationWeightCap ?? 100));
    return {
      sector,
      staged: {
        regenerationAllocation: Object.fromEntries(this.env.sectors.map((pool) => [pool, pool === sector ? cap : 0])),
      },
      operatorId: (this.env.operators.gunner ?? this.env.operators.pilot).id,
    };
  }
  /** Actions a defense route still needs: the Control Action when the console is unheld, plus the route. */
  defenseCost(u) { return (this.state(u).controls.defense == null ? 1 : 0) + 1; }
  /**
   * Commit a defense plan. Quoted as the funnel this hull ran, so the sector is recorded only once
   * ROUTE_DEFENSE actually commits: a route that was refused (nobody could pay for the console) must
   * not be counted as regeneration that went somewhere.
   * @returns {boolean} whether regeneration was re-routed
   */
  applyDefensePlan(u, plan) {
    if (this.state(u).controls.defense == null) {
      const taken = this.tryCall(OPERATION_TYPES.TAKE_CONTROL, u, [], { operatorId: plan.operatorId, control: "defense" });
      if (!taken) return false;
    }
    const routed = this.tryCall(OPERATION_TYPES.ROUTE_DEFENSE, u, [], { operatorId: plan.operatorId, staged: plan.staged });
    if (routed) this.stats.funnelSector[u][this.round] = plan.sector;
    return Boolean(routed);
  }
  /** Attribute the round's damage to the sector its owner funnelled regeneration into. */
  closeRound(round) {
    const pools = this.env.sectors;
    for (const uuid of ["A", "B"]) {
      const loss = this.stats.roundSectorLoss[uuid][round] ?? emptySectors(pools);
      const total = pools.reduce((sum, sector) => sum + (loss[sector] ?? 0), 0);
      const routed = this.stats.funnelSector[uuid][round];
      const funnel = this.stats.funnel[uuid];
      funnel.rounds += 1;
      funnel.damage += total;
      funnel.captured += routed ? loss[routed] ?? 0 : 0;
      if (this.env.directional && total > 0 && (!routed || (loss[routed] ?? 0) <= 0)) funnel.missedRounds += 1;
      const touched = pools.filter((sector) => (loss[sector] ?? 0) > 0).length;
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
  const thrust = Number(duel.config(u).components.drives?.main?.base?.thrust ?? 0);
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

/**
 * The station-keeping phase: face the target (or fly the orbit insertion) and spend one curved
 * pivot maneuver on whatever timeline the Evasive Protocol left unreserved. Returns whether the hull
 * is still flying its approach.
 */
function stationKeeping(duel, u, target, policy) {
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
    const payload = { operatorId: duel.env.operators.pilot.id, deltaV: { forward: plan.deltaV, lateral: 0 }, pivot };
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
  return inserting;
}

/**
 * One ship-turn, driven only through operations the hull's own operators are eligible for.
 *
 * Two doctrines, selected by the hull's own command roster:
 *
 * `corvette` (two or more command operators) is the shipped flow: take Helm, plan the regeneration
 * funnel, manoeuvre, then sense — Ping, Acquire — compute the one-use Firing Solution, and fire.
 * The gunner owns the sensors and the shots; the pilot's Actions sit behind the shooting order.
 *
 * `fighter` (a single command operator — one console for the whole hull) has three Actions total and
 * a hull that cannot hold Helm and Defense at once, so it serializes the turn: Helm and the
 * manoeuvre first, then the single operation that advances its track, then *all* its guns, and only a
 * spare Action left over buys a Firing Solution for the next turn. It routes its regeneration funnel
 * last, and only when a shot is not competing for that Action — manoeuvring, sensing and shooting
 * genuinely compete on a one-seat hull, and the hangfire metric counts every gun that lost.
 */
function runTurn(duel, u, policy, target) {
  const env = duel.env;
  const pilot = env.operators.pilot.id;
  const gunner = (env.operators.gunner ?? env.operators.pilot).id;
  const oneConsole = env.simulation.oneConsole;
  const fighter = env.simulation.doctrine === "fighter";
  const started = duel.tryCall(OPERATION_TYPES.START_PHASE, u);
  duel.recordRegeneration(u, started);
  if (duel.state(u).phase !== "active") return;
  duel.tryCall(OPERATION_TYPES.TAKE_CONTROL, u, [], { operatorId: pilot, control: "helm" });
  if (policy.evasion && !duel.state(u).evasion?.armed) {
    // Standard protocol: the shipped tier the dispatcher can arm. It reserves 20 % of the timeline,
    // which is why the station maneuver only ever gets 80 % of an activation.
    duel.tryCall(OPERATION_TYPES.ARM_EVASION, u, [], { operatorId: pilot });
  }
  // Regeneration goes where the fire is coming from — at most the hull's own per-facet cap. A Bubble
  // Shield gets no plan: its single pool already receives the whole budget. The plan is read from the
  // attitude the turn opens with, whichever doctrine places it.
  const defense = duel.defensePlan(u, target);
  if (defense && !oneConsole) duel.applyDefensePlan(u, defense);
  const inserting = stationKeeping(duel, u, target, policy);
  if (defense && oneConsole && !fighter) duel.applyDefensePlan(u, defense);
  duel.sensorPass(u, target, gunner, fighter ? "advance" : "always");
  if (!fighter && policy.solutions) duel.solutionPass(u, target, gunner);
  duel.firePass(u, target, inserting);
  // A spare Action is the fighter's only route to a Firing Solution: it is spent *after* the guns
  // have had theirs, so the solution can never cost this turn's shot, only buy next turn's accuracy.
  if (fighter && policy.solutions && duel.actionsLeft(u, gunner) > 0) duel.solutionPass(u, target, gunner);
  if (defense && oneConsole && fighter && duel.actionsLeft(u, defense.operatorId) >= duel.defenseCost(u)) {
    duel.applyDefensePlan(u, defense);
  }
  duel.stats.pivotSpent[u].push(duel.state(u).pivotSpent ?? 0);
  if (TRACE) {
    const state = duel.state(u);
    console.log(`r${duel.round} ${u} T=${state.timeline.toFixed(2)} face=${state.facing.toFixed(0)} piv=${(state.pivotSpent ?? 0).toFixed(0)} spd=${duel.speed(u).toFixed(2)} pos=(${state.position.x.toFixed(1)},${state.position.y.toFixed(1)}) range=${duel.distance(u, target).toFixed(1)} track=${state.tracks?.[target]?.state ?? "-"} acts=${state.resources.actions?.[pilot]}/${state.resources.actions?.[gunner]}`);
  }
  duel.tryCall(OPERATION_TYPES.COAST, u, [], { operatorId: pilot });
  duel.tryCall(OPERATION_TYPES.END_PHASE, u);
}

export function runDuel(env, seed, variantName, policyA, policyB, { maxRounds = env.simulation.rounds } = {}) {
  const duel = new Duel(env, seed, env.variants[variantName]);
  duel.tryCall(OPERATION_TYPES.ENTER_COMBAT, "A", [], { turnKey: "r1" });
  duel.tryCall(OPERATION_TYPES.ENTER_COMBAT, "B", [], { turnKey: "r1" });
  const policies = { A: env.policies[policyA], B: env.policies[policyB] };
  for (let round = 1; round <= maxRounds; round++) {
    duel.round = round;
    for (const [u, target] of [["A", "B"], ["B", "A"]]) {
      if (duel.state(u).hull <= 0) continue;
      runTurn(duel, u, policies[u], target);
      const foe = target;
      if (duel.stats.collapse[foe] == null && env.sectors.some((sector) => (duel.state(foe).shields.hp[sector] ?? 0) <= 0)) {
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
/* `strikes` is keyed by target geometry, the shield totals by the hull's own pool keys; accumulate
 * whichever keys the pick actually carries so a single-pool Bubble Shield needs no special case. */
const sumSectors = (runs, pick) => runs.reduce((acc, duel) => {
  for (const [sector, value] of Object.entries(pick(duel))) acc[sector] = (acc[sector] ?? 0) + value;
  return acc;
}, {});

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

function weaponSummary(bands, variant, env) {
  const summary = {};
  for (const weaponId of env.loadouts[variant.loadout].online) {
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

function sectorSummary(strikes, loss, regen, funnel, rotation, env) {
  const pools = env.sectors;
  const damageTotal = pools.reduce((sum, sector) => sum + (loss[sector] ?? 0), 0);
  const top = pools.length ? Math.max(...pools.map((sector) => loss[sector] ?? 0)) : 0;
  return {
    struck: strikes,
    damage: loss,
    regen,
    damageTotal,
    regenTotal: pools.reduce((sum, sector) => sum + (regen[sector] ?? 0), 0),
    // A Bubble Shield has no facets to funnel into: the engine hands its single pool the whole
    // budget, so capture and missed rounds are not a measurement, they are a category error.
    funnelCapture: env.directional && damageTotal > 0 ? +(funnel.captured / damageTotal).toFixed(3) : null,
    funnelMissedRounds: env.directional ? funnel.missedRounds : null,
    funnelRounds: funnel.rounds,
    distinctSectorsDamaged: pools.filter((sector) => (loss[sector] ?? 0) > 0).length,
    topSectorShare: damageTotal > 0 ? +(top / damageTotal).toFixed(3) : null,
    sectorsPerDamagedRound: rotation.roundsWithDamage > 0 ? +(rotation.distinctSum / rotation.roundsWithDamage).toFixed(2) : null,
    multiSectorRoundShare: rotation.roundsWithDamage > 0 ? +(rotation.multiSectorRounds / rotation.roundsWithDamage).toFixed(3) : null,
  };
}

export function runScenario(scenario, runsPer, env) {
  const runs = [];
  for (let index = 0; index < runsPer; index += 1) {
    runs.push(runDuel(env, 7000 + index * 7919, scenario.variant, scenario.policyA, scenario.policyB));
  }
  const ttks = runs
    .map((duel) => (duel.stats.ttkA != null || duel.stats.ttkB != null ? Math.min(duel.stats.ttkA ?? 99, duel.stats.ttkB ?? 99) : null))
    .filter((value) => value != null);
  const side = (uuid) => {
    const policyKey = uuid === "A" ? scenario.policyA : scenario.policyB;
    const policy = env.policies[policyKey];
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
      weapons: weaponSummary(bands, runs[0].variant, env),
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
        env,
      ),
      speed: mean(runs.map((duel) => duel.stats.speed[uuid]), 2),
      hangfire: runs.reduce((count, duel) => count + duel.stats.hangfire[uuid], 0),
      hangfirePerTurn: mean(runs.map((duel) => duel.stats.hangfire[uuid] / duel.stats.rounds)),
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
    hangfirePerTurn: mean(runs.map((duel) => (duel.stats.hangfire.A + duel.stats.hangfire.B) / (2 * duel.stats.rounds))),
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

export function sweep(scenarios, runsPer, env) {
  const results = [];
  for (const scenario of scenarios) {
    const started = Date.now();
    results.push(runScenario(scenario, runsPer, env));
    console.error(`  ${scenario.label.padEnd(28)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return {
    runsPer,
    quick: env.quick,
    generatedAt: new Date().toISOString(),
    thrust: env.thrustKey,
    hull: { id: env.build.id, label: env.build.label, source: env.build.source },
    sectors: [...env.sectors],
    directional: env.directional,
    doctrine: env.simulation.doctrine,
    results,
  };
}

/** The mirror engagements (both sides on the same policy) of the hull's own scenario matrix. */
export function mirrorScenarios(env) {
  return env.scenarios.filter((scenario) => scenario.policyA === scenario.policyB);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main() {
  const build = await loadBuild({ hull: HULL_ARG, hullFile: HULL_FILE, componentsFile: COMPONENTS_FILE });
  const env = configureSimulation(build, { thrust: THRUST_KEY, quick: QUICK });
  const out = argumentValue("--out")
    ?? join(HERE, build.id === DEFAULT_REFERENCE_BUILD_ID ? "results.json" : `results-${outputSlug(build.id)}.json`);
  const runsPer = env.simulation.runsPer;
  const scenarios = env.scenarios.filter((scenario) => matchesOnly(scenario, ONLY));
  if (!scenarios.length) throw new Error(`--only=${ONLY} matched no scenario`);
  if (TRACE || DEBUG) {
    const scenario = scenarios[0];
    const duel = runDuel(env, 11, scenario.variant, scenario.policyA, scenario.policyB, { maxRounds: DEBUG ? 20 : 14 });
    console.log("rejects:", JSON.stringify(duel.stats.rejects, null, DEBUG ? 1 : 0));
    console.log("rounds:", duel.stats.rounds, "hull:", duel.stats.hullRemaining, "speed:", duel.stats.speed, "minRange:", duel.stats.minRange);
    console.log("shieldDamage:", JSON.stringify(duel.stats.shieldDamage), "hullDamage:", JSON.stringify(duel.stats.hullDamage));
    console.log("strikes:", JSON.stringify(duel.stats.strikes));
    console.log("round losses:", JSON.stringify(duel.stats.roundSectorLoss));
    console.log("funnel:", JSON.stringify(duel.stats.funnel));
    console.log("rotation:", JSON.stringify(duel.stats.rotation));
    console.log("regen:", JSON.stringify(duel.stats.shieldRegen));
    for (const uuid of ["A", "B"]) {
      const policy = env.policies[uuid === "A" ? scenario.policyA : scenario.policyB];
      console.log(uuid, policy.label, "orbit:", JSON.stringify(orbitSummary(duel.stats.orbit[uuid], policy.R ?? 0)));
    }
    return;
  }
  if (ONLY || NO_PARALLEL) {
    const payload = sweep(scenarios, runsPer, env);
    writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`);
    console.log(JSON.stringify(payload, null, 1));
    return;
  }
  // One process per scenario, bounded by the CPU count: each duel clones and validates full ship
  // states, so sharding is the difference between a two-minute and a twelve-minute sweep.
  const jobs = Math.max(1, Math.min(scenarios.length, Number(process.env.VIRA_SIM_JOBS) || cpus().length));
  const dir = mkdtempSync(join(tmpdir(), "vira-sim-"));
  const script = fileURLToPath(import.meta.url);
  const hullArgs = HULL_FILE
    ? [`--hull-file=${HULL_FILE}`, ...(COMPONENTS_FILE ? [`--components-file=${COMPONENTS_FILE}`] : [])]
    : HULL_ARG ? [`--hull=${HULL_ARG}`] : [];
  const chunks = Array.from({ length: jobs }, (_, index) => scenarios.filter((_, position) => position % jobs === index)).filter((chunk) => chunk.length);
  const children = chunks.map((chunk, index) => {
    const file = join(dir, `shard-${index}.json`);
    const args = [
      process.execPath,
      script,
      `--only=${chunk.map((scenario) => scenario.id).join(",")}`,
      `--out=${file}`,
      ...(QUICK ? ["--quick"] : []),
      ...(THRUST_KEY !== "shipped" ? [`--thrust=${THRUST_KEY}`] : []),
      ...hullArgs,
    ];
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
    return { child, args, file };
  });
  const payloads = [];
  for (const { child, args, file } of children) {
    const exit = await child.exited;
    if (exit !== 0) {
      const stdout = await new Response(child.stdout).text();
      // The shard's own stderr is inherited (and already on screen); name the command it came from so
      // the failure is actionable instead of an empty payload.
      throw new Error(`sweep shard failed (${exit}) for \`${args.join(" ")}\` — see its stderr above.\n${stdout.slice(-2000)}`);
    }
    payloads.push(JSON.parse(readFileSync(file, "utf8")));
  }
  rmSync(dir, { recursive: true, force: true });
  const merged = {
    runsPer,
    quick: env.quick,
    generatedAt: new Date().toISOString(),
    thrust: env.thrustKey,
    jobs: chunks.length,
    hull: { id: build.id, label: build.label, source: build.source },
    sectors: [...env.sectors],
    directional: env.directional,
    doctrine: env.simulation.doctrine,
    results: env.scenarios.flatMap((scenario) => payloads.flatMap((payload) => payload.results.filter((row) => row.id === scenario.id))),
  };
  writeFileSync(out, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(JSON.stringify(merged, null, 1));
}

if (import.meta.main) await main();
