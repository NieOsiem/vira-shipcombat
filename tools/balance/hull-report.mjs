#!/usr/bin/env bun
/**
 * Per-hull balance report for Vira ship combat.
 *
 * One hull in, one five-section report out: the dogfight rule (§1), the anti-regeneration attrition
 * check (§2), bearing coverage (§3), fit & power (§4) and the mirror duel (§5). Every static figure is
 * the module's own rules code run on the shipped encounter state — drive and pivot capabilities, the
 * range band / firing arc / relative motion / struck sector helpers, the shield-regeneration
 * apportionment and the power state — and the mirror section is the real duel engine. Nothing here
 * re-implements a rule the module owns, and nothing is a hardcoded hull value.
 *
 * The two figures that most easily lie are handled explicitly: §1 converts the pivot ceiling to
 * radians before multiplying by a range (a degree-per-turn budget is not an angular rate per unit of
 * Velocity), and §2 prints its static fire as an unattainable ceiling, then lets the verdict follow the
 * measured §5 mirror margin whenever a duel ran.
 *
 * Usage: bun tools/balance/hull-report.mjs [--hull=<id>] [--hull-file=<hull.json|module.js>]
 *                                         [--components-file=<items.json|module.js>] [--runs=<n>]
 *                                         [--out=<file>] [--thrust=shipped|retune]
 * Prints the document to stdout and writes it to tools/balance/<hullId>.md (or --out).
 * `--runs=0` keeps the static sections usable without running any duel.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { TRAIT_IDS } from "../../scripts/constants.js";
import { createInitialState } from "../../scripts/model/defaults.js";
import {
  BARRAGE_PROFILES,
  calculateRangeBand,
  calculateRelativeMotion,
  calculateStruckSector,
  isWithinFiringArc,
} from "../../scripts/rules/combat.js";
import { forwardVector, normalizeAngle } from "../../scripts/rules/math.js";
import { getDriveCapabilities, getPivotCapability } from "../../scripts/rules/movement.js";
import { applyMaintainedOverclockHeat, getPowerState } from "../../scripts/rules/power.js";
import { getSensorStats } from "../../scripts/rules/sensors.js";
import { allocateRegeneration } from "../../scripts/rules/shields.js";
import {
  THRUST_PACKAGES,
  configureSimulation,
  loadBuild,
  mirrorScenarios,
  outputSlug,
  runScenario,
} from "../sim/duel.mjs";

const HERE = import.meta.dir;
const DEFAULT_RUNS = 40;
const BEARING_STEP = 5;
/**
 * Shield HP per ship-turn below which a damage-minus-regeneration margin is not a trend anything can
 * act on: at these numbers it is the residue of a fight that ends without collapsing a shield, so the
 * verdict says `marginal` instead of claiming attrition.
 */
const MARGIN_NOISE = 0.05;
/** The barrage round count the duel policy declares: the smallest standard profile above one round. */
const DECLARED_BARRAGE_ROUNDS = Math.min(...Object.keys(BARRAGE_PROFILES).map(Number).filter((rounds) => rounds > 1));
const SYSTEMS = ["engines", "shields", "sensors", "cooling", "inertia", "weapons"];

const FLAGS = {
  hull: argumentValue("--hull"),
  hullFile: argumentValue("--hull-file"),
  componentsFile: argumentValue("--components-file"),
  runs: argumentValue("--runs"),
  out: argumentValue("--out"),
  thrust: argumentValue("--thrust"),
};

function argumentValue(flag) {
  const prefix = `${flag}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const num = (value, digits = 2) => (Number.isFinite(value) ? `${+Number(value).toFixed(digits)}` : "—");
const signed = (value, digits = 2) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${+Number(value).toFixed(digits)}` : "—");
const pct = (fraction, digits = 1) => (Number.isFinite(fraction) ? `${+(100 * fraction).toFixed(digits)}%` : "—");
const text = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => text(cell)).join(" | ")} |`),
  ];
}

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

function thrustKey() {
  const key = FLAGS.thrust ?? "shipped";
  if (!(key in THRUST_PACKAGES)) {
    throw new Error(`unknown --thrust=${key} (expected ${Object.keys(THRUST_PACKAGES).join("|")})`);
  }
  return key;
}

function runCount() {
  if (FLAGS.runs === undefined) return DEFAULT_RUNS;
  const runs = Number(FLAGS.runs);
  if (!Number.isInteger(runs) || runs < 0) throw new Error(`--runs must be a nonnegative integer, got '${FLAGS.runs}'`);
  return runs;
}

/**
 * The report runs on a detached copy of the duel environment's config, because the harness carries
 * `--thrust` per variant rather than in `env.config`; applying the package here keeps the static
 * sections on the same drives the mirror duels fly without disturbing the environment they read.
 * The package holds absolute thrust values, so re-applying one is harmless.
 */
function reportConfig(env) {
  const config = structuredClone(env.config);
  const thrust = THRUST_PACKAGES[env.thrustKey ?? "shipped"];
  if (thrust) {
    const drives = config.components?.drives ?? {};
    for (const [role, value] of [["main", thrust.main], ["reverse", thrust.retro], ["portLateral", thrust.lateral], ["starboardLateral", thrust.lateral]]) {
      if (drives[role]?.base) drives[role].base.thrust = value;
    }
  }
  return config;
}

const sourceLine = (build) => {
  if (FLAGS.hullFile || FLAGS.componentsFile) {
    const files = [
      FLAGS.hullFile ? `hull file \`${FLAGS.hullFile}\`` : null,
      FLAGS.componentsFile ? `components file \`${FLAGS.componentsFile}\`` : null,
    ].filter(Boolean);
    return `${files.join(" + ")} through materializeShipConfig`;
  }
  if (FLAGS.hull) return `bundled reference build \`${FLAGS.hull}\` (scripts/data/reference-builds.js)`;
  return `default bundled reference build \`${build.id}\` (scripts/data/reference-builds.js)`;
};

const powerLine = (state) => SYSTEMS.map((system) => `${system} ${num(state.power?.[system], 0)}`).join(" · ");

/* ------------------------------------------------------------------ *
 * §1 Dogfight rule
 * ------------------------------------------------------------------ */

function dogfightRule(state, env) {
  const config = env.config;
  const capabilities = getDriveCapabilities(config, state);
  // Pivot authority is quoted in degrees per turn, but r = v/ω and v = ω·optimal are angle-in-radians
  // relations: 60°/turn of pivot is ω = 1.047 rad/turn, which is what a hull actually turns through
  // per unit of Velocity. Multiplying the degree figure by an Optimal Range is a units error.
  const pivotDegrees = getPivotCapability(config, state);
  const omega = (pivotDegrees * Math.PI) / 180;
  const safe = Number(config.safeVelocity ?? 0);
  const rotation = capabilities.rotation;
  const startRange = Number(env.simulation.startRange);
  const rounds = Number(env.simulation.rounds);

  const weapons = (config.components.weapons ?? []).map((weapon) => {
    const optimal = Number(weapon.range?.optimal ?? 0);
    return { label: weapon.label, projectile: weapon.projectileClass, optimal, ceiling: omega * optimal, holds: safe <= omega * optimal };
  });

  const radius = omega > 0 ? safe / omega : null;
  const forward = capabilities.forward;
  const accelDistance = forward > 0 ? (safe * safe) / (2 * forward) : null;
  const closingTurns = forward > 0 && safe > 0
    ? (startRange <= accelDistance
      ? Math.sqrt((2 * startRange) / forward)
      : safe / forward + (startRange - accelDistance) / safe)
    : null;
  const turnaroundTurns = rotation > 0 ? Math.max(1, 180 / rotation) : null;
  const separation = turnaroundTurns === null ? null : (safe + safe) * turnaroundTurns;
  const reMergeTurns = turnaroundTurns === null ? null : turnaroundTurns + separation / Math.max(safe, 1e-9);

  const motion = [...new Set(weapons.map((weapon) => weapon.projectile))]
    .filter((projectileClass) => typeof projectileClass === "string")
    .map((projectileClass) => ({
      projectileClass,
      ...calculateRelativeMotion({
        shooterPosition: { x: 0, y: 0 },
        targetPosition: { x: 0, y: -startRange },
        shooterVelocity: { x: 0, y: 0 },
        targetVelocity: { x: safe, y: 0 },
        projectileClass,
      }),
    }));

  const lines = [
    "Nose-fixed guns make a dogfight a geometry problem: a hull circling at speed `v` with pivot",
    "authority `ω` flies a circle of radius `r = v/ω`, so each weapon's Optimal Range sets a hard speed",
    "ceiling `v_ceiling = ω·optimal` — the fastest the hull may fly while still holding that gun's",
    `Optimal band. Above it the hull must fly straighter than its own gun wants or accept the extended`,
    `band. \`ω\` is converted to radians here (this hull: ${num(pivotDegrees)}°/turn = ${num(omega, 3)} rad/turn): the`,
    "pivot ceiling is quoted in degrees, the circle geometry is not. The second half is the merge: after",
    "a pass the hull needs rotation to come back around.",
    "",
    ...table(["quantity at the shipped state", "value"], [
      ["safe velocity `v_safe`", `${num(safe)} su`],
      ["forward Δv / turn", `${num(forward)} su`],
      ["retro Δv / turn", `${num(capabilities.retro)} su`],
      ["port / starboard Δv / turn", `${num(capabilities.port)} / ${num(capabilities.starboard)} su`],
      ["rotation / turn", `${num(rotation)}°`],
      ["pivot `ω` / turn", `${num(pivotDegrees)}° = ${num(omega, 3)} rad`],
      ["tightest circle `r_min = v_safe/ω`", radius === null ? "— (no pivot authority)" : `${num(radius)} su`],
      ["acceleration distance to `v_safe`", accelDistance === null ? "— (no forward thrust)" : `${num(accelDistance)} su`],
      [`closure from ${num(startRange)} su at ${num(forward)} su/turn (target stationary)`, closingTurns === null ? "— (no forward thrust)" : `${num(closingTurns)} turns`],
    ]),
    "",
    ...table(["weapon", "optimal", "fastest holdable `v_ceiling = ω·optimal`", "margin at `v_safe`", "holds at `v_safe`"], weapons.map((weapon) => [
      weapon.label,
      `${num(weapon.optimal)} su`,
      `${num(weapon.ceiling)} su`,
      signed(weapon.ceiling - safe),
      weapon.holds ? "yes" : "no",
    ])),
    "",
  ];

  if (motion.length) {
    lines.push(
      `Kinetic evasion at \`v_safe\`: a hull crossing the line at ${num(safe)} su reads as `
      + motion.map((sample) => `${sample.projectileClass} ${num(sample.effectiveMotion)} → band ${text(sample.band)} (${signed(sample.modifier, 0)})`).join(", ")
      + " on incoming fire.",
      "",
    );
  }
  lines.push(
    turnaroundTurns === null
      ? `Pass geometry: no rotation authority, so a parallel pass cannot come back around — only the pivot (${num(pivotDegrees)}°/turn) can turn the nose.`
      : `Pass geometry: turnaround ${num(turnaroundTurns)} turns, separation after the pass ${num(separation)} su against a mirror opponent (closing at ${num(safe * 2)} su/turn), re-merge ${num(reMergeTurns)} turns.`,
    "",
  );

  const holders = weapons.filter((weapon) => weapon.holds);
  const tightest = [...weapons].sort((left, right) => left.ceiling - right.ceiling)[0] ?? null;
  const widest = [...weapons].sort((left, right) => right.ceiling - left.ceiling)[0] ?? null;
  const ceilingClause = holders.length
    ? `holds an Optimal band at \`v_safe\` = ${num(safe)} su (${num(holders.length, 0)} of ${num(weapons.length, 0)} guns clear their ceiling; the tightest, ${tightest.label}, is holdable up to ${num(tightest.ceiling)} su)`
    : widest
      ? `cannot hold any Optimal band at \`v_safe\` = ${num(safe)} su — the widest gun (${widest.label}) is holdable only below ${num(widest.ceiling)} su, so the hull must trade away speed or its Optimal band`
      : "carries no weapons, so the Optimal band is moot";
  const mergeClause = reMergeTurns === null
    ? "it has no rotation authority to re-merge with"
    : reMergeTurns <= rounds
      ? `re-merge costs ${num(reMergeTurns)} turns, inside the ${num(rounds, 0)}-turn encounter clock`
      : `re-merge costs ${num(reMergeTurns)} turns, outside the ${num(rounds, 0)}-turn encounter clock`;
  lines.push(`**Verdict:** ${ceilingClause}; ${mergeClause}${closingTurns === null ? "" : `, after closing ${num(startRange)} su in ${num(closingTurns)} turns`}.`);

  return { lines };
}

/* ------------------------------------------------------------------ *
 * §2 Anti-regeneration check
 * ------------------------------------------------------------------ */

function exposedFacet(state, env, mirror) {
  if (!env.directional) {
    const pool = env.sectors[0];
    return { name: pool, basis: `the single pool — \`regenerationWeightCap\` (${num(env.config.regenerationWeightCap, 0)}) is inert under a bubble` };
  }
  if (mirror?.topSector) {
    return { name: mirror.topSector, basis: `the most-struck facet across the ${mirror.label} (${pct(mirror.topShare)})` };
  }
  const weights = state.shields?.regenerationAllocation ?? {};
  const ranked = [...env.sectors].sort((left, right) => Number(weights[right] ?? 0) - Number(weights[left] ?? 0));
  return { name: ranked[0], basis: `the heaviest shipped regeneration weight (${num(weights[ranked[0]] ?? 0, 0)}%)` };
}

/**
 * Fire the hull's online guns could put into a facet in one turn. The barrage figure is the profile
 * the duel policy declares — the smallest standard profile above a single round, i.e. the cheapest way
 * to get more than one round in the air (rules §9.5: the attacker declares the round count) — read from
 * the engine's own table (`BARRAGE_PROFILES`), which is what validates the declaration and caps the
 * effective hits. A component trait's own profile list is never consulted by the engine.
 */
function attackerFire(config, state) {
  return (config.components.weapons ?? [])
    .filter((weapon) => state.weapons?.[weapon.id]?.status === "online")
    .map((weapon) => {
      const barrage = (weapon.traits ?? []).some((trait) => trait.id === TRAIT_IDS.barrage);
      const declared = barrage ? BARRAGE_PROFILES[DECLARED_BARRAGE_ROUNDS] ?? null : null;
      const hits = declared ? Number(declared.maximumEffectiveHits ?? 1) : 1;
      const damage = Number(weapon.damage?.shield ?? 0);
      return {
        weapon,
        label: weapon.label,
        damage,
        hits,
        perTurn: damage * hits,
        profile: declared ? `${num(declared.rounds, 0)}-round barrage, ${signed(declared.penalty, 0)} to hit` : "single shot",
      };
    });
}

function antiRegeneration(state, env, mirror = null) {
  const config = env.config;
  const shield = config.components.shield ?? null;
  if (!shield) {
    return {
      lines: [
        "Decision 91/92's attrition maths needs a shield to test. This hull installs none: there is no",
        "regeneration budget, no facet to route it into, and no shield layer for sustained fire to out-",
        "damage. Every hit resolves against armor and hull instead.",
        "",
        "**Verdict:** not applicable — a shieldless hull has no regeneration funnel.",
      ],
    };
  }
  const shieldPower = Number(state.power?.shields ?? 0);
  const tier = (shield?.tiers ?? []).find((candidate) => candidate.power === shieldPower) ?? null;
  const budget = Number(tier?.regeneration ?? 0);
  const facet = exposedFacet(state, env, mirror);
  const weight = env.directional ? Math.min(100, Number(config.regenerationWeightCap ?? 100)) : 100;
  const assigned = allocateRegeneration(budget, { [facet.name]: weight });
  const facetRegen = Number(assigned[facet.name] ?? 0);

  const attackers = attackerFire(config, state);
  const perTurn = attackers.reduce((sum, attacker) => sum + attacker.perTurn, 0);
  const net = perTurn - facetRegen;

  const bands = Boolean(mirror?.engaged && Number.isFinite(mirror.meanRange));
  const headers = ["attacker weapon (online)", "shield dmg/hit", "hits/turn", "shield dmg/turn", "profile"];
  if (bands) headers.push(`band at ${num(mirror.meanRange, 1)} su`);
  const rows = attackers.map((attacker) => {
    const row = [attacker.label, `${num(attacker.damage)}`, `${num(attacker.hits, 0)}`, `${num(attacker.perTurn)}`, attacker.profile];
    if (bands) {
      const optimal = Number(attacker.weapon.range?.optimal ?? 0);
      const maximum = Number(attacker.weapon.range?.maximum ?? optimal);
      const band = calculateRangeBand(mirror.meanRange, optimal, maximum);
      row.push(band.valid ? `${band.band} (${signed(band.modifier, 0)})` : band.band);
    }
    return row;
  });
  if (rows.length > 1) rows.push(["**total**", "", "", `**${num(perTurn)}**`, ""].concat(bands ? ["—"] : []));

  const lines = [
    "Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The",
    "`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at",
    "Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the",
    "question but it does not answer it, so the verdict below is driven by the §5 mirror measurement",
    "whenever a duel ran and only falls back to the ceiling when none did.",
    "",
    ...table(headers, rows),
    "",
    ...table(["regeneration at the shipped shield Power", "value"], [
      ["shield Power committed", num(shieldPower, 0)],
      ["tier regeneration / turn", num(budget, 0)],
      ["most-exposed facet", `${facet.name} — ${facet.basis}`],
      ["weight given to that facet", env.directional ? `${num(weight, 0)} (= min(100, hull cap ${num(config.regenerationWeightCap, 0)}))` : `${num(weight, 0)} (whole budget, one pool)`],
      ["`allocateRegeneration` per turn on that facet", num(facetRegen, 0)],
    ]),
    "",
    `Ceiling margin: ${num(perTurn)} − ${num(facetRegen)} = **${signed(net)}** shield damage per turn.`,
    "",
  ];

  let measured = null;
  if (mirror?.engaged) {
    measured = mirror.dealt - mirror.repaired;
    lines.push(
      `Mirror cross-check (${mirror.label}): ${num(mirror.dealt, 3)} shield damage/turn dealt vs ${num(mirror.repaired, 3)} shield regeneration/turn repaired → **${signed(measured, 3)}**/turn, measured over ${num(mirror.attacksPerTurn)} landed attacks/turn at a mean range of ${num(mirror.meanRange, 1)} su; `
      + (env.directional
        ? `funnel capture ${num(mirror.capture, 3)} (${pct(mirror.capture)} of the damage landed on the sector regeneration was routed to).`
        : "regeneration has no funnel to capture — the whole budget lands on the single pool."),
      "",
      `The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes `
      + `${num(attackers.reduce((sum, attacker) => sum + attacker.hits, 0), 0)} hits a turn where the mirror landed ${num(mirror.attacksPerTurn)} attacks/turn.`,
      "",
    );
  } else if (mirror) {
    lines.push(
      `Mirror cross-check (${mirror.label}): the mirrors landed no attacks at all, so there is no measured margin — the ceiling above is the only evidence, and it is an upper bound on fire that never happened.`,
      "",
    );
  } else {
    lines.push("Mirror cross-check: not run (no duel), so this section stands on the unattainable ceiling alone.", "");
  }

  const margin = measured === null ? net : measured;
  // Quote the regeneration figure from the same source as the margin, so the sentence and §5 agree:
  // the measured repair rate when a duel ran, the hull's own facet budget otherwise.
  const regenerated = measured === null
    ? `${num(facetRegen)} regenerated/turn (the hull's static facet budget, no duel ran)`
    : `${num(mirror.repaired, 3)} regenerated/turn (measured in the §5 mirrors)`;
  const verdict = attackers.length === 0
    ? "**out-healed** — the shipped state has no online weapons, so nothing contests the regeneration funnel"
    : margin <= 0
      ? `**out-healed** — the decision-92 failure mode: the funnel keeps up (${signed(margin, 3)} net shield damage/turn against ${regenerated}), so sustained fire cannot collapse the shields`
      : margin < MARGIN_NOISE
        ? `**marginal** — the margin is positive but not material (${signed(margin, 3)} net shield damage/turn against ${regenerated}, inside the ${num(MARGIN_NOISE)}/turn noise of a fight that ends without collapsing anything); the shields are not beaten, they are merely scratched`
        : `**out-damages** — sustained fire beats the funnel: ${signed(margin, 3)} net shield damage/turn against ${regenerated}, so the shields can be collapsed`;
  lines.push(`**Verdict:** ${verdict}.`);

  return { lines };
}

/* ------------------------------------------------------------------ *
 * §3 Bearing coverage
 * ------------------------------------------------------------------ */

const inArcAt = (orientation, arc, bearing) => isWithinFiringArc({
  shooterPosition: { x: 0, y: 0 },
  targetPosition: forwardVector(bearing),
  shooterFacing: 0,
  hardpointOrientation: orientation,
  arcWidth: arc,
});

/**
 * Covered half-width of a mount's window. An arc is a full width centred on the hardpoint
 * orientation (rules §9.2), and the engine's predicate is `|bearing − centre| ≤ width/2`, so the
 * window is `orientation ± arc/2` in closed form — `inArcAt` is still what decides whether a bearing
 * is covered when the tool samples one.
 */
const arcHalfWidth = (arc) => Math.max(0, Math.min(180, Number(arc ?? 0) / 2));

function windowIntervals(center, half) {
  if (half >= 180) return [[-180, 180]];
  if (half <= 0) return [];
  const start = normalizeAngle(center - half);
  const end = normalizeAngle(center + half);
  return start <= end ? [[start, end]] : [[start, 180], [-180, end]];
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1e-9) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function complementIntervals(merged) {
  const gaps = [];
  let cursor = -180;
  for (const [start, end] of merged) {
    if (start > cursor + 1e-9) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < 180 - 1e-9) gaps.push([cursor, 180]);
  return gaps;
}

/**
 * Own-frame bearings run -180…180, so a dark arc across the stern arrives split into two intervals.
 * Fold it back into one 0…360 reading (`150°…210°`) so the page says "dead astern" instead of making
 * the reader stitch the wrap together.
 */
function blindLabel(gaps) {
  if (!gaps.length) return "none";
  const shifted = gaps.map(([start, end]) => (start < 0 ? [start + 360, end + 360] : [start, end]));
  const merged = mergeIntervals(shifted.sort((left, right) => left[0] - right[0]));
  const first = merged[0];
  const last = merged.at(-1);
  if (merged.length > 1 && first[0] === 0 && last[1] === 360) {
    merged.splice(0, 1, [last[0], first[1] + 360]);
    merged.pop();
  }
  return merged.map(([start, end]) => `${num(start)}°…${num(end)}°`).join(" and ");
}

function bearingCoverage(state, env) {
  const config = env.config;
  const capabilities = getDriveCapabilities(config, state);
  const rotation = capabilities.rotation;
  const mounts = (config.components.weapons ?? []).map((weapon) => {
    const hardpoint = (config.hardpoints ?? []).find((entry) => entry.id === weapon.hardpointId) ?? {};
    const orientation = Number(hardpoint.orientation ?? 0);
    const arc = Number(weapon.arc ?? 0);
    const half = arcHalfWidth(arc);
    return {
      label: `${text(hardpoint.label ?? weapon.hardpointId)} — ${weapon.label}`,
      orientation,
      arc,
      half,
      width: half * 2,
      window: half >= 180 ? "all bearings" : `${num(normalizeAngle(orientation - half))}°…${num(normalizeAngle(orientation + half))}°`,
      optimal: Number(weapon.range?.optimal ?? 0),
      maximum: Number(weapon.range?.maximum ?? 0),
      damage: Number(weapon.damage?.shield ?? 0),
    };
  });

  const merged = mergeIntervals(mounts.flatMap((mount) => windowIntervals(mount.orientation, mount.half)));
  const coveredDegrees = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  const blind = complementIntervals(merged);
  const blindDegrees = blind.reduce((sum, [start, end]) => sum + (end - start), 0);
  const struckSectorAt = (bearing) => calculateStruckSector({
    attackerPosition: forwardVector(bearing),
    targetPosition: { x: 0, y: 0 },
    targetFacing: 0,
  });
  // Sample the *interior* of each dark arc (half-step offsets), not its edges: an arc edge sits on a
  // sector boundary, and counting a boundary would report the covered nose as blind.
  const blindSectors = [...new Set(blind.flatMap(([start, end]) => {
    const bearings = [];
    for (let bearing = start + BEARING_STEP / 2; bearing <= end - 1e-9; bearing += BEARING_STEP) bearings.push(bearing);
    if (!bearings.length) bearings.push((start + end) / 2);
    return bearings.map((bearing) => struckSectorAt(normalizeAngle(bearing)));
  }))];
  const covers = (bearing) => mounts.some((mount) => inArcAt(mount.orientation, mount.arc, bearing));

  const damageTotal = mounts.reduce((sum, mount) => sum + mount.damage, 0);
  const weighted = damageTotal > 0
    ? mounts.reduce((sum, mount) => sum + mount.damage * (mount.width / 360), 0) / damageTotal
    : null;

  const bearings = Array.from({ length: Math.round(360 / BEARING_STEP) }, (_, index) => -180 + index * BEARING_STEP);
  const needed = (bearing, mount) => Math.max(0, Math.abs(normalizeAngle(bearing - mount.orientation)) - mount.half);
  const perMount = mounts.map((mount) => {
    const values = bearings.map((bearing) => needed(bearing, mount));
    return {
      worst: Math.max(...values),
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
  });
  const bestPerBearing = bearings.map((bearing) => Math.min(...mounts.map((mount) => needed(bearing, mount))));

  const lines = [
    "Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`",
    "runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the",
    "engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are",
    "printed as one 0…360 range (`180°` dead astern).",
    "",
    ...table(
      ["mount", "orientation", "arc", "covered window", "circle", "reaches to (optimal / max)", "turns-to-bear worst / mean"],
      mounts.map((mount, index) => [
        mount.label,
        `${num(mount.orientation)}°`,
        `${num(mount.arc)}°`,
        mount.window,
        pct(mount.width / 360),
        `${num(mount.optimal)} / ${num(mount.maximum)} su`,
        rotation > 0 ? `${num(perMount[index].worst / rotation)} / ${num(perMount[index].mean / rotation)}` : "—",
      ]),
    ),
    "",
    ...table(["coverage", "value"], [
      ["union coverage", `${pct(coveredDegrees / 360)} of the circle (${num(coveredDegrees)}°)`],
      ["blind arcs", blindLabel(blind)],
      ["blind arc total", `${num(blindDegrees)}° (${pct(blindDegrees / 360)})`],
      ["blind arcs strike", blindSectors.length ? blindSectors.join(", ") : "—"],
      ["damage-weighted coverage", weighted === null ? "—" : pct(weighted)],
      ["own nose (0°) / own aft (180°)", `${covers(0) ? "covered" : "blind"} / ${covers(180) || covers(-180) ? "covered" : "blind"}`],
      ["worst turns-to-bear (best gun per bearing)", rotation > 0 && Number.isFinite(bestPerBearing[0]) ? `${num(Math.max(...bestPerBearing) / rotation)} turns` : "—"],
      ["mean turns-to-bear (best gun per bearing)", rotation > 0 && Number.isFinite(bestPerBearing[0]) ? `${num((bestPerBearing.reduce((sum, value) => sum + value, 0) / bestPerBearing.length) / rotation)} turns` : "—"],
    ]),
    "",
  ];

  if (rotation <= 0) {
    lines.push(`No rotation authority at the shipped state: a hull with no rotation must pivot instead (\`ω\` = ${num(getPivotCapability(config, state))}°/turn), so turns-to-bear have no value.`, "");
  }

  const aft = covers(180) || covers(-180);
  const worstGun = perMount.length ? Math.max(...perMount.map((entry) => entry.worst)) : null;
  const verdict = mounts.length === 0
    ? "no mounted weapon, so the hull has no bearing coverage at all"
    : `${pct(coveredDegrees / 360)} of the circle is covered (${num(coveredDegrees)}° of 360°); `
      + (blind.length
        ? `the blind arc is ${blindLabel(blind)} (${num(blindDegrees)}°), which exposes the ${blindSectors.join(" / ")} armor to any threat sitting there`
        : "nothing is blind")
      + `; own nose (0°) is ${covers(0) ? "covered" : "blind"} and own aft (180°) is ${aft ? "covered" : "blind"}`;
  lines.push(
    `**Verdict:** ${verdict}${rotation > 0 && Number.isFinite(bestPerBearing[0]) && worstGun !== null ? `; worst turns-to-bear ${num(worstGun / rotation)} gun-level (${num(Math.max(...bestPerBearing) / rotation)} with the best gun at each bearing)` : rotation <= 0 ? "; no rotation authority, so bearing is bought with the pivot instead of turns" : ""}.`,
  );

  return { lines };
}

/* ------------------------------------------------------------------ *
 * §4 Fit & power
 * ------------------------------------------------------------------ */

function tierAt(component, power) {
  return (component?.tiers ?? []).find((tier) => Number(tier.power) === Number(power)) ?? null;
}

function fitAndPower(state, env) {
  const config = env.config;
  const components = config.components ?? {};
  const installed = new Map();
  for (const component of [components.reactor, components.shield, components.sensor, components.cooling, components.inertia, ...Object.values(components.drives ?? {})]) {
    if (component?.slotId) installed.set(component.slotId, component.label);
  }
  const weaponsByHardpoint = new Map((components.weapons ?? []).map((weapon) => [weapon.hardpointId, weapon]));

  const slotRows = (env.hull?.slots ?? []).map((slot) => [slot.label ?? slot.id, slot.id, `${slot.class} / ${slot.size}`, installed.get(slot.id) ?? "empty"]);
  const hardpointRows = (env.hull?.hardpoints ?? []).map((hardpoint) => [
    hardpoint.label ?? hardpoint.id,
    `${num(hardpoint.orientation ?? 0)}°`,
    (hardpoint.regions ?? []).join(", "),
    weaponsByHardpoint.get(hardpoint.id)?.label ?? "empty",
  ]);

  const powerState = getPowerState(config, state);
  const allocation = powerState.allocation;
  const capabilities = getDriveCapabilities(config, state);
  const sensors = getSensorStats(config, state);
  const engineTier = tierAt(config.powerSystems?.engines, allocation.engines);
  const shieldTier = tierAt(components.shield, allocation.shields);
  const coolingTier = tierAt(components.cooling, allocation.cooling);
  const inertiaTier = tierAt(components.inertia, allocation.inertia);
  const cooling = components.cooling ?? {};

  const tierRows = [
    ["engines", `×${num(engineTier?.multiplier ?? 0)} — main ${num(capabilities.forward)} / retro ${num(capabilities.retro)} / lateral ${num(capabilities.port)} su, rotation ${num(capabilities.rotation)}°/turn`],
    ["shields", `${num(shieldTier?.regeneration ?? 0)} regeneration/turn`],
    ["sensors", sensors.online
      ? `passive ${num(sensors.passiveRange)} su / strength ${num(sensors.passiveStrength)}, active ${num(sensors.activeRange)} su / ${signed(sensors.activeModifier, 0)}`
      : "offline at this Power"],
    ["cooling", `${num(coolingTier?.cooling ?? coolingTier?.output ?? 0)} Heat cooled per Start`],
    ["inertia", `${num(inertiaTier?.pivot ?? 0)}° pivot/turn`],
    ["weapons", `${num(powerState.weaponReserved)} reserved for the online guns`],
  ].map(([system, effect]) => [system, num(allocation[system], 0), effect]);

  const weapons = components.weapons ?? [];
  const ratedTotal = weapons.reduce((sum, weapon) => sum + Number(weapon.powerRating ?? 0), 0);
  const online = weapons.filter((weapon) => state.weapons?.[weapon.id]?.status === "online");
  const weaponRows = weapons.map((weapon) => {
    const hardpoint = (config.hardpoints ?? []).find((entry) => entry.id === weapon.hardpointId) ?? {};
    return [
      `${text(hardpoint.label ?? weapon.hardpointId)} — ${weapon.label}`,
      `${num(weapon.powerRating ?? 0)} (overclock ${num(weapon.modes?.overclock?.overrides?.powerRating ?? weapon.powerRating ?? 0)})`,
      `${num(powerState.weaponReservations?.[weapon.id] ?? 0)}`,
      text(state.weapons?.[weapon.id]?.status),
    ];
  });

  const heat = applyMaintainedOverclockHeat(config, structuredClone(state));
  const cooled = Number(coolingTier?.cooling ?? coolingTier?.output ?? 0);
  const netHeat = Number(heat.heatAdded ?? 0) - cooled;

  const lines = [
    "**Mounts**",
    "",
    ...table(["system slot", "slot id", "class / size", "installed"], slotRows),
    "",
    ...table(["hardpoint", "orientation", "regions", "weapon"], hardpointRows),
    "",
    "**Power**",
    "",
    ...table(["system", "committed", "tier effect at that Value"], tierRows),
    "",
    ...table(["power state", "value"], [
      ["committed / nominal / redline", `${num(powerState.committed, 0)} / ${num(powerState.ceilings.nominal, 0)} / ${num(powerState.ceilings.redline, 0)}`],
      ["unused (to reactor maximum)", num(powerState.unused, 0)],
      ["redlining", powerState.redlining ? "yes" : "no"],
      ["legal commit", powerState.legal ? "yes" : "no"],
      ["emission band", `${text(powerState.emission?.band)} (${signed(powerState.emission?.signatureModifier, 0)} signature)`],
    ]),
    "",
    "**Weapons**",
    "",
    ...table(["weapon", "powerRating (online)", "reserved", "shipped status"], weaponRows),
    "",
    `Every installed gun online needs ${num(ratedTotal)} Weapons Power against ${num(allocation.weapons, 0)} committed; the shipped state has ${num(online.length, 0)} of ${num(weapons.length, 0)} online (${online.map((weapon) => weapon.label).join(", ") || "none"}).`,
    "",
    "**Heat**",
    "",
    ...table(["heat per Start", "value"], [
      ["maintained Overclock Heat", num(heat.heatAdded ?? 0, 0)],
      ["heat sources", heat.sources?.length ? heat.sources.map((source) => `${source.system} ${num(source.heat, 0)}`).join(", ") : "none"],
      ["passive cooling at the committed Cooling Power", num(cooled, 0)],
      ["net Heat per Start", signed(netHeat, 0)],
      ["Heat Capacity", num(config.heatCapacity, 0)],
      ["vent", `${num(cooling.ventAmount, 0)} Heat, ${num(cooling.ventCooldown, 0)}-Start cooldown`],
    ]),
    "",
    `Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (${num(config.heatCapacity, 0)} Heat Capacity) would clear in ${num(cooled > 0 ? Math.ceil(Number(config.heatCapacity) / cooled) : null, 0)} Start(s) of passive cooling alone`
    + (Number(cooling.ventAmount ?? 0) > 0
      ? `; Emergency Vent removes at most ${num(cooling.ventAmount, 0)} Heat a use, so a full bar costs ${num(Math.ceil(Number(config.heatCapacity) / Number(cooling.ventAmount)), 0)} vents spaced ${num(cooling.ventCooldown, 0)} Start(s) apart.`
      : ". Emergency Vent removes nothing at this fit."),
    "",
  ];

  const verdict = `power commit is ${powerState.legal ? "legal" : "illegal"} — ${num(powerState.committed, 0)} of ${num(powerState.ceilings.nominal, 0)} nominal (redline ${num(powerState.ceilings.redline, 0)}, headroom ${num(powerState.unused, 0)}${powerState.redlining ? ", redlining" : ""}); `
    + `${num(online.length, 0)} of ${num(weapons.length, 0)} guns online, and every installed gun online would need ${num(ratedTotal, 0)} of the ${num(allocation.weapons, 0)} committed Weapons Power; `
    + (netHeat <= 0
      ? `heat is stable without venting (${signed(netHeat, 0)} per Start)`
      : `heat rises ${signed(netHeat, 0)} per Start, so it must vent (${num(cooling.ventAmount, 0)} Heat) every ${num(cooling.ventCooldown, 0)} Start(s)`);
  lines.push(`**Verdict:** ${verdict}.`);

  return { lines };
}

/* ------------------------------------------------------------------ *
 * §5 Mirror duel
 * ------------------------------------------------------------------ */

const sectorDamage = (row) => row.sides.A.sectors.damageTotal + row.sides.B.sectors.damageTotal;
const sectorRegen = (row) => row.sides.A.sectors.regenTotal + row.sides.B.sectors.regenTotal;
const captureOf = (row) => {
  const captures = [row.sides.A.sectors.funnelCapture, row.sides.B.sectors.funnelCapture].filter((value) => Number.isFinite(value));
  return captures.length ? captures.reduce((sum, value) => sum + value, 0) / captures.length : null;
};

function mirrorCrossCheck(rows) {
  const perRow = rows.map((row) => {
    const turns = row.runs * row.meanRounds;
    const attacks = Number(row.attacksPerTurn ?? 0);
    return {
      attacks,
      dealt: turns > 0 ? sectorDamage(row) / (2 * turns) : null,
      repaired: turns > 0 ? sectorRegen(row) / (2 * turns) : null,
      capture: captureOf(row),
      range: attacks > 0 ? row.range : null,
    };
  });
  const average = (pick) => {
    const values = perRow.map(pick).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const struckTotals = {};
  for (const row of rows) {
    for (const side of [row.sides.A.sectors.struck, row.sides.B.sectors.struck]) {
      for (const [sector, count] of Object.entries(side)) struckTotals[sector] = (struckTotals[sector] ?? 0) + count;
    }
  }
  const struckTotal = Object.values(struckTotals).reduce((sum, count) => sum + count, 0);
  const [topSector, topCount] = Object.entries(struckTotals).sort((left, right) => right[1] - left[1])[0] ?? [null, 0];
  return {
    label: `${rows.length} mirror scenario${rows.length === 1 ? "" : "s"}`,
    engaged: average((row) => row.attacks) > 0,
    attacksPerTurn: average((row) => row.attacks),
    dealt: average((row) => row.dealt),
    repaired: average((row) => row.repaired),
    capture: average((row) => row.capture),
    meanRange: average((row) => row.range),
    topSector: struckTotal > 0 ? topSector : null,
    topShare: struckTotal > 0 ? topCount / struckTotal : null,
  };
}

/** What the observed refusals mean, so the reject column is readable without the engine's source. */
const REJECT_GLOSSARY = {
  "firingSolution:OPERATION_RESOURCE_EXHAUSTED": "the operator's Action pool was already spent",
  "ping:OPERATION_RESOURCE_EXHAUSTED": "the operator's Action pool was already spent",
  "acquire:OPERATION_RESOURCE_EXHAUSTED": "the operator's Action pool was already spent",
  "attack:ILLEGAL_ATTACK_DECLARATION": "a declaration the engine refused — the target was already at 0 hull this turn, or the track/arc was lost mid-turn",
  "acquire:SENSOR_LIVE_CONTACT_REQUIRED": "the track was not a live Contact to acquire",
  "acquire:SENSOR_TARGET_OUT_OF_RANGE": "the target left Active Range between the Ping and the Acquire",
  "ping:SENSORS_OFFLINE": "battle damage took the Sensor array offline",
  "acquire:SENSORS_OFFLINE": "battle damage took the Sensor array offline",
  "armEvasion:EVASION_HARDWARE_UNAVAILABLE": "battle damage disabled the Evasion-capable hardware, or Engines Power fell to 0",
  "routeDefense:MISSING_SHIELD": "the hull has no shield to route",
  "maneuver:TOKEN_REQUIRED": "the hull has no placed token",
};

function rejectLegend(rows) {
  const codes = [...new Set(rows.flatMap((row) => Object.entries(row.rejects ?? {}).filter(([, count]) => count > 0).map(([code]) => code)))].sort();
  if (!codes.length) return [];
  return [
    "",
    `Refusals (the engine declining an operation the policy attempted; none of them spends a resource or a roll): ${codes.map((code) => `\`${code}\` — ${REJECT_GLOSSARY[code] ?? "see the engine's rule code"}`).join("; ")}.`,
  ];
}

function mirrorDuel(env, runs) {
  const scenarios = mirrorScenarios(env);
  const rounds = Number(env.simulation.rounds);

  if (!scenarios.length) {
    return { lines: ["No mirror scenarios are defined for this hull's policy set.", "", "**Verdict:** nothing to run."], summary: null };
  }
  if (runs === 0) {
    return {
      lines: [
        `Duel skipped: \`--runs=0\`. ${scenarios.length} mirror scenario(s) available: ${scenarios.map((scenario) => scenario.label).join(", ")}.`,
        "",
        "**Verdict:** no duel ran, so mirror resolution is untested by this report.",
      ],
      summary: null,
    };
  }

  const rows = scenarios.map((scenario) => runScenario(scenario, runs, env));
  const summary = mirrorCrossCheck(rows);
  const doctrine = env.simulation.doctrine;
  const doctrineLine = doctrine === "fighter"
    ? `Turn doctrine \`fighter\`: the hull has ${num(env.simulation.commandOperators, 0)} command operator, so one console flies, senses and shoots — it manoeuvres first, spends its sensing Actions only on what advances its track (Ping, then Acquire), fires every bearing gun, and only a spare Action buys a Firing Solution.`
    : `Turn doctrine \`corvette\`: the hull has ${num(env.simulation.commandOperators, 0)} command operators, so the gunner owns Ping/Acquire/Solution and the shots while the pilot flies.`;
  const lines = [
    `${rows.length} mirror scenario(s), ${num(runs, 0)} runs each, encounter clock ${num(rounds, 0)} turns. Damage is per turn: shield / hull.`,
    "",
    doctrineLine,
    "",
    "`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran",
    "out** — the price a one-console hull pays for its third job, whether that is the track it had to",
    "re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is",
    "fire that was never asked for.",
    ...rejectLegend(rows),
    "",
    ...table(["mirror scenario", "runs", "kill rate", "med TTK", "med 1st collapse", "shield/hull dmg per turn A→B", "B→A", "funnel", "attacks/turn", "hangfire/turn", "mean range", "motion mod", "mean speed", "rams", "rejects"], rows.map((row) => [
      row.label,
      num(row.runs, 0),
      pct(row.killRate, 0),
      num(row.medianTtk),
      num(row.medianFirstCollapse),
      `${num(row.shieldDmgPerTurn.A_deals)} / ${num(row.hullDmgPerTurn.A_deals)}`,
      `${num(row.shieldDmgPerTurn.B_deals)} / ${num(row.hullDmgPerTurn.B_deals)}`,
      env.directional ? num(captureOf(row), 2) : "pool",
      num(row.attacksPerTurn),
      num(row.hangfirePerTurn),
      // Range and motion samples are taken per landed attack, so a mirror that never fired has no
      // measurement here — a 0 would read as "closed to zero range".
      Number(row.attacksPerTurn) > 0 ? num(row.range, 1) : "—",
      Number(row.attacksPerTurn) > 0 ? num(row.motionModifier) : "—",
      num((Number(row.sides.A.speed) + Number(row.sides.B.speed)) / 2),
      num(row.ramEvents, 0),
      Object.entries(row.rejects ?? {}).filter(([, count]) => count > 0).map(([code, count]) => `${code}×${count}`).join(", ") || "none",
    ])),
    "",
  ];

  const killed = rows.filter((row) => row.killRate > 0);
  const stalled = rows.filter((row) => !(Number(row.attacksPerTurn) > 0));
  const starved = rows.filter((row) => Number(row.hangfirePerTurn) >= 0.5);
  const hungGuns = starved.length
    ? starved.reduce((sum, row) => sum + Number(row.hangfirePerTurn ?? 0), 0) / starved.length
    : 0;
  const rates = rows.map((row) => row.killRate).sort((left, right) => left - right);
  const ttks = rows.map((row) => row.medianTtk).filter(Number.isFinite).sort((left, right) => left - right);
  const best = [...rows].sort((left, right) => right.killRate - left.killRate)[0] ?? null;
  const rateRange = rates[0] === rates.at(-1) ? pct(rates[0], 0) : `${pct(rates[0], 0)}–${pct(rates.at(-1), 0)}`;
  const ttkRange = ttks.length === 0 ? "—" : ttks[0] === ttks.at(-1) ? num(ttks[0]) : `${num(ttks[0])}–${num(ttks.at(-1))}`;
  const mirrorMargin = summary.dealt === null || summary.repaired === null ? null : summary.dealt - summary.repaired;
  const decider = !summary.engaged
    ? `an empty clock — ${num(stalled.length, 0)} of ${num(rows.length, 0)} mirrors never land an attack`
    : mirrorMargin === null
      ? "an unfinished clock"
      : mirrorMargin >= MARGIN_NOISE
        ? `attrition — ${num(summary.dealt, 3)} shield damage/turn against ${num(summary.repaired, 3)} regenerated`
        : mirrorMargin <= -MARGIN_NOISE
          ? `survival — shield regeneration (${num(summary.repaired, 3)}/turn) against ${num(summary.dealt, 3)} shield damage/turn`
          : `a stalemate — ${num(summary.dealt, 3)} shield damage/turn against ${num(summary.repaired, 3)} regenerated, a margin inside the ${num(MARGIN_NOISE, 3)}/turn noise floor`;
  const clock = `the ${num(rounds, 0)}-turn clock`;
  const starveClause = starved.length
    ? ` ${num(starved.length, 0)} of ${num(rows.length, 0)} mirrors are Action-starved — ${starved.map((row) => row.label).join(", ")} hung ${num(hungGuns)} guns/turn each.`
    : "";
  lines.push(
    killed.length === 0
      ? `**Verdict:** no mirror resolves inside ${clock}: ${decider}, at ${num(summary.attacksPerTurn)} landed attacks/turn.${starveClause}`
      : `${killed.length === rows.length ? "**Verdict:** every mirror resolves inside" : `**Verdict:** ${num(killed.length, 0)} of ${num(rows.length, 0)} mirrors resolve inside`} ${clock} — kill rates run ${rateRange}, with a median TTK of ${ttkRange} turns where a kill lands (best: ${best.label} at ${pct(best.killRate, 0)}). What decides it is ${decider}`
        + `${env.directional && Number.isFinite(summary.capture) ? `, with the mirrors funnelling ${pct(summary.capture)} of their damage into the most-struck ${summary.topSector} facet` : ""}.${starveClause}`,
  );

  return { lines, summary };
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

/** How many component copies the hull actually installs (a supplied-but-unreferenced Item is not one). */
function installedCount(config) {
  const components = config.components ?? {};
  const singles = [components.reactor, components.shield, components.sensor, components.cooling, components.inertia].filter(Boolean).length;
  const drives = Object.values(components.drives ?? {}).filter(Boolean).length;
  return singles + drives + (components.weapons ?? []).length;
}

function resolveOutput(hullId) {
  if (!FLAGS.out) return join(HERE, `${outputSlug(hullId)}.md`);
  return isAbsolute(FLAGS.out) ? FLAGS.out : join(process.cwd(), FLAGS.out);
}

function displayPath(path) {
  const relativePath = relative(process.cwd(), path);
  return relativePath.startsWith("..") ? path : relativePath;
}

/** No figure may reach the page unresolved. */
function assertResolved(document) {
  const offender = document.match(/^.*\b(NaN|undefined|Infinity)\b.*$/m);
  if (offender) throw new Error(`report contains '${offender[0].trim().slice(0, 200)}' — a value did not resolve`);
}

async function main() {
  const runs = runCount();
  const key = thrustKey();
  const build = await loadBuild({
    hull: FLAGS.hull,
    hullFile: FLAGS.hullFile,
    componentsFile: FLAGS.componentsFile,
  });
  const env = configureSimulation(build, { thrust: key, quick: false });
  const config = reportConfig(env);
  const state = createInitialState(config);
  const context = { ...env, config };
  const mirror = mirrorDuel(env, runs);

  const sections = [
    { heading: "1. Dogfight rule", ...dogfightRule(state, context) },
    { heading: "2. Anti-regeneration check", ...antiRegeneration(state, context, mirror.summary) },
    { heading: "3. Bearing coverage", ...bearingCoverage(state, context) },
    { heading: "4. Fit & power", ...fitAndPower(state, context) },
    { heading: "5. Mirror duel", lines: mirror.lines },
  ];

  const outPath = resolveOutput(build.id);
  const shields = Object.entries(state.shields?.hp ?? {}).map(([sector, hp]) => `${sector} ${num(hp, 0)}`).join(" · ");
  const lines = [
    `# ${build.label} (${build.id}) — balance report`,
    "",
    `- Build source: ${sourceLine(build)}`,
    `- Components: ${env.componentSources.length} supplied component sources, ${installedCount(env.config)} installed`,
    `- Encounter state: materializeShipConfig + createInitialState — full health (hull ${num(state.hull, 0)} of ${num(config.maxHull, 0)}, shields ${shields}) at the shipped power commit (${powerLine(state)})`,
    `- Thrust package: \`${key}\`${THRUST_PACKAGES[key] ? ` (main ${num(THRUST_PACKAGES[key].main, 0)} / retro ${num(THRUST_PACKAGES[key].retro, 0)} / lateral ${num(THRUST_PACKAGES[key].lateral, 0)})` : " (component base thrust)"}`,
    `- Mirror duel: ${num(runs, 0)} runs per scenario, encounter clock ${num(env.simulation.rounds, 0)} turns, opening range ${num(env.simulation.startRange)} su`,
    "- Engine: drive/pivot capabilities, range band + firing arc + relative motion + struck sector, shield regeneration apportionment, power state and maintained Heat from the module's rules; the mirror section is the duel engine itself (tools/sim/duel.mjs)",
    "",
    ...sections.flatMap((section) => [`## ${section.heading}`, "", ...section.lines, ""]),
    `report written to ${displayPath(outPath)}`,
  ];

  const document = `${lines.join("\n").trimEnd()}\n`;
  assertResolved(document);
  writeFileSync(outPath, document);
  process.stdout.write(document);
}

await main();
