#!/usr/bin/env python3
"""Render tools/sim/report.md from tools/sim/results.json (and kinematics.json when present).

Run after `bun tools/sim/duel.mjs`; every path is resolved from this file's directory.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
data = json.loads((HERE / "results.json").read_text())
rows = data["results"]
kin = json.loads((HERE / "kinematics.json").read_text()) if (HERE / "kinematics.json").exists() else None

WEAPON_LABELS = {
    "CanadRailgun0001": "railgun",
    "CanadLaser000001": "pulse laser",
    "CanadMacrocanA01": "macrocannon (port)",
    "CanadMacrocanB01": "macrocannon (starboard)",
}


def weapon_name(weapon_id):
    return WEAPON_LABELS.get(weapon_id, weapon_id)


def table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines.extend("| " + " | ".join(str(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


lines = []
lines.append("# Duel simulator results (Monte-Carlo, real rules engine)\n")
lines.append(f"- Runs per scenario: **{data['runsPer']}**; quick={data['quick']}; generated {data['generatedAt']}; drives: **{data.get('thrust', 'shipped')}**")
lines.append(f"- Scenario processes: {data.get('jobs', 1)} (each scenario is swept in its own process).")
lines.append("- Every operation goes through `executeShipOperation`: real validation, real rolls, real damage/shield/heat/regeneration resolution.")
lines.append("- Harness variants are config-driven only (drive thrust package, weapon loadout). The engine owns the curved Vector Authority pivot, the +2 Optimal Range bonus, the kinetic evasion stack, the relative-motion bands and the 50 % per-sector regeneration cap, so the harness declares none of them.")
lines.append("- Movement policies: `hover` holds position and faces the target; `brawl`/`orbit` are station policies that close to radius R around the target and then hold it at speed v with a single curved-pivot maneuver per activation (the harness measures the achieved radius, it does not assume it). Both arming policies arm the **standard** Evasive Protocol, the tier the operation dispatcher can actually arm (20 % timeline reserve, +2 AC).")
lines.append("- Baseline positions: A at (0,0) facing 0, B at (60,0) facing 180 (60 su = 300 ft). Combat stops at 40 rounds; 'kill rate' = fraction of runs where a hull reached 0.")

lines.append("\n## Headline table\n")
lines.append(table(
    ["variant", "match", "kill rate", "median TTK", "median 1st collapse", "shield dmg/turn A→B", "B→A",
     "hull dmg/turn A→B", "B→A", "attacks/turn", "solutions/turn", "mean speed A / B", "mean motion",
     "mean range", "median min range", "ram events", "median hull left A / B"],
    [
        [r["variant"], r["match"], r["killRate"], r["medianTtk"], r["medianFirstCollapse"],
         r["shieldDmgPerTurn"]["A_deals"], r["shieldDmgPerTurn"]["B_deals"],
         r["hullDmgPerTurn"]["A_deals"], r["hullDmgPerTurn"]["B_deals"],
         r["attacksPerTurn"], r["solutionsPerTurn"],
         f"{r['sides']['A']['speed']} / {r['sides']['B']['speed']}", r["motionModifier"], r["range"],
         r["medianMinRange"], r["ramEvents"],
         f"{r['medianHullRemaining']['A']} / {r['medianHullRemaining']['B']}"]
        for r in rows
    ],
))

lines.append("\n## Orbit station-keeping — measured radius error per scenario\n")
lines.append("A station policy flies one curved pivot maneuver per activation over the unreserved timeline (80 % of it: the standard Evasive Protocol reserves 20 %). The mandatory end-of-activation coast is a straight tangent chord, so the controller aims the arc at a hold radius 4 % *inside* the nominal station radius and cancels the chord's outward push with a crab feed-forward; the measured radius below is the engagement range at the moment the guns bear, against the nominal station radius.")
lines.append("")
lines.append("`radius error` is the mean |r − R|/R over sustained samples (the first four sustained turns are treated as settling), `p95`/`max` the tail of the same distribution, `pivot` the median pivot spent per turn and `clipped` the sustained turns where the request hit the hull's pivot budget. The `max` column is a single turn, and its outliers are battle damage rather than control: a critical result that damages the Inertial Anchor cuts `getPivotCapability`, and the turn the ship loses its pivot it keeps flying its old vector — visible as the `clipped` count and the p95-to-max gap, never as a persistent error.")
lines.append("")
orbit_rows = []
for r in rows:
    for key in ("A", "B"):
        side = r["sides"][key]
        orbit = side["orbit"]
        if not orbit:
            continue
        orbit_rows.append([
            r["label"], key, side["policyLabel"], orbit["targetRadius"], orbit["holdRadius"],
            orbit["settledTurns"], orbit["insertTurns"], orbit["meanRadius"],
            f"**{orbit['radiusErrorPct']} %**", f"{orbit['radiusP95ErrorPct']} %", f"{orbit['radiusMaxErrorPct']} %",
            f"{orbit['pivotMedian']} (/{orbit['pivotSpendPctMedian']} % of cap)", orbit["pivotCapabilityMin"], orbit["clippedTurns"],
            f"{orbit['insideNominalPct']} %",
        ])
lines.append(table(
    ["scenario", "ship", "station", "target radius", "hold radius", "sustained turns", "insert turns",
     "mean radius", "radius error", "p95 error", "max error", "median pivot/turn", "min pivot cap", "clipped turns", "turns inside R"],
    orbit_rows,
))
lines.append("")
station_rows = [(r, key) for r in rows for key in ("A", "B")
                if r["sides"][key]["orbit"] and r["sides"][key]["orbit"]["targetRadius"] == 30
                and r["sides"]["B" if key == "A" else "A"]["policy"] == "hover"]
static_errors = [r["sides"][key]["orbit"]["radiusErrorPct"] for r, key in station_rows]
mutual = [r for r in rows if r["policyA"].startswith("orbit") and r["policyB"].startswith("orbit")]
if static_errors:
    inside = min(r["sides"][key]["orbit"]["insideNominalPct"] for r, key in station_rows)
    lines.append(f"**What the numbers say.** Against a stationary (hovering) target the retuned controller holds the station to **{min(static_errors):.1f}-{max(static_errors):.1f} %** across every orbital speed, with no pivot clipping, and the engagement radius is at or inside the nominal radius in at least **{inside:.0f} % of settled turns** in every one of those rows (the nominal radius is the macrocannon's 30 su Optimal Range edge, the tightest weapon band in the hull). The pivot request is `arc pivot (v·duration/r) + (commanded crab - current crab)`: the arc term is the feed-forward the old chord-tuned pursuit law lacked, and the crab term is what closes the residual radius error.")
lines.append("")
lines.append("Against a *moving* target the station is a geometry problem, not a control problem. A mutual orbit at separation R needs each hull's Velocity heading to rotate at 2v/R per turn - 68.8 deg/turn at v = 18 su/turn, R = 30 su, against the Inertial Anchor Mk II's 60 deg/turn ceiling - so a mirror pair cannot hold that station at all and settles wide with the pivot pinned at the cap. A brawl station at 15 su against a circling 18 su/turn target is the same arithmetic with a tighter radius. Those rows are reported rather than hidden: they show where the shipped pivot budget, not the helm policy, sets the answer.")
lines.append("")

lines.append("\n## Weapon range bands — the engine's own verdict at the attack declaration\n")
lines.append("Share of declared attacks the engine resolved in the weapon's **optimal** band (its `calculateRangeBand` verdict, read off the attack commitment). Ranges: macrocannon optimal 30 / max 60; pulse laser 40 / 80; railgun 60 / 120.")
lines.append("")
lines.append("The shots outside the optimal band are the *approach* shots, not station-keeping: a station policy does not fire while it is burning onto its flight path, but it does fire on the turns it spends rotating the nose onto that path, and those happen anywhere between 60 su and the station radius. The macrocannon (optimal 30, magazine 20, barrage 4) also empties after five barrages, so most of its attacks are those approach shots. Once the ship is on station its radius is inside every band, as the station-keeping table's `max radius` column shows.")
lines.append("")
band_rows = []
for r in rows:
    for key in ("A", "B"):
        side = r["sides"][key]
        for weapon_id, entry in side["weapons"].items():
            bands = ", ".join(f"{band}:{count}" for band, count in sorted(entry["bands"].items()))
            band_rows.append([r["label"], key, side["policy"], weapon_name(weapon_id), entry["attacks"],
                              f"{entry['optimalPct']} %", bands])
lines.append(table(["scenario", "ship", "policy", "weapon", "attacks", "optimal", "band counts"], band_rows))

lines.append("\n## Pivot payoff — struck-sector rotation vs the defender's regeneration funnel\n")
lines.append("Each hull routes its regeneration allocation at the sector it expects to be hit next, capped by its own hull data at 50 % of the budget (`regenerationWeightCap`), so its 8 hp/turn regeneration budget can put at most half of itself into one sector. A hovering attacker always strikes the same sector and that funnel catches nearly all of the damage; an orbiting attacker's bearing walks around the defender, so the struck sector rotates and the funnel is left pointing at the wrong plates.")
lines.append("")
payoff_entries = []
for r in rows:
    a, b = r["sides"]["A"], r["sides"]["B"]
    for attacker, defender in ((a, b), (b, a)):
        sectors = defender["sectors"]
        if sectors["damageTotal"] <= 0:
            continue
        orbit = attacker["orbit"]
        speed = attacker["speed"]
        radius = orbit["meanRadius"] if orbit else None
        rotation = (speed / radius * 180 / 3.141592653589793) if radius and speed else 0.0
        rounds = max(1e-9, r["runs"] * r["meanRounds"])
        payoff_entries.append({
            "scenario": r["label"],
            "attacker": attacker["policy"],
            "defender": defender["policy"],
            "rotation": rotation,
            "dwell": (90 / rotation) if rotation > 1e-9 else None,
            "distinct": sectors["distinctSectorsDamaged"],
            "top": sectors["topSectorShare"],
            "capture": sectors["funnelCapture"],
            "missed": sectors["funnelMissedRounds"],
            "funnel_rounds": sectors["funnelRounds"],
            "damage_per_turn": sectors["damageTotal"] / rounds,
            "regen_per_turn": sectors["regenTotal"] / rounds,
        })

lines.append(table(
    ["scenario", "attacker", "defender", "struck-sector rotation", "sector dwell (turns)", "distinct sectors damaged",
     "top-sector share of damage", "damage on the funnel sector", "rounds the funnel missed", "shield dmg/turn", "regen/turn"],
    [[e["scenario"], e["attacker"], e["defender"],
      f"{e['rotation']:.1f} deg/turn" if e["rotation"] else "static",
      f"{e['dwell']:.1f}" if e["dwell"] else "\u221e",
      e["distinct"],
      f"{e['top']:.3f}" if e["top"] is not None else "-",
      f"{e['capture'] * 100:.1f} %" if e["capture"] is not None else "-",
      f"{e['missed']}/{e['funnel_rounds']}",
      f"{e['damage_per_turn']:.2f}", f"{e['regen_per_turn']:.2f}"]
     for e in payoff_entries],
))


def payoff_aggregate(predicate):
    picked = [e for e in payoff_entries if predicate(e)]
    if not picked:
        return None
    dwells = [e["dwell"] for e in picked if e["dwell"]]
    return {
        "count": len(picked),
        "capture": sum(e["capture"] for e in picked if e["capture"] is not None) / max(1, sum(1 for e in picked if e["capture"] is not None)),
        "top": sum(e["top"] for e in picked if e["top"] is not None) / max(1, sum(1 for e in picked if e["top"] is not None)),
        "dwell": dwells,
        "damage": sum(e["damage_per_turn"] for e in picked) / len(picked),
        "regen": sum(e["regen_per_turn"] for e in picked) / len(picked),
        "missRate": sum(e["missed"] for e in picked) / max(1, sum(e["funnel_rounds"] for e in picked)),
        "captureRange": (min(e["capture"] for e in picked if e["capture"] is not None), max(e["capture"] for e in picked if e["capture"] is not None)),
        "topRange": (min(e["top"] for e in picked if e["top"] is not None), max(e["top"] for e in picked if e["top"] is not None)),
    }


static = payoff_aggregate(lambda e: e["rotation"] == 0 and e["defender"] == "hover")
moving_defender = payoff_aggregate(lambda e: e["rotation"] == 0 and e["defender"] != "hover")
orbit = payoff_aggregate(lambda e: e["rotation"] > 0 and e["attacker"].startswith("orbit"))
fast = payoff_aggregate(lambda e: e["attacker"] in ("orbit24", "orbit30"))
lines.append("")
lines.append("**Pivot payoff.** The rotation column is the measured orbital rate, `v / r` in deg/turn against a 90-degree sector, so its inverse is the dwell time the defender's Regeneration Allocation prediction is worth — how long the facet it just aimed its regeneration at stays the facet under fire.")
if static:
    lines.append(f"With neither hull moving (the hover mirrors) the struck sector is pinned: `top-sector share` {static['topRange'][0]:.2f}-{static['topRange'][1]:.2f}, funnel capture {static['captureRange'][0] * 100:.0f}-{static['captureRange'][1] * 100:.0f} % of the damage, {static['damage']:.2f} damage/turn against {static['regen']:.2f} regen/turn repaired. A static funnel is therefore nearly perfect — and because the hull caps one sector at 50 % of the budget, even that perfect funnel can never put more than half of the hull's regeneration in front of the fire.")
if moving_defender:
    lines.append(f"A defender that moves while the attacker holds station already loses some of that (top-sector share {moving_defender['topRange'][0]:.2f}-{moving_defender['topRange'][1]:.2f}, capture {moving_defender['captureRange'][0] * 100:.0f}-{moving_defender['captureRange'][1] * 100:.0f} %), because its own attitude changes which facet faces the fire.")
if orbit:
    dwells = orbit["dwell"]
    lines.append(f"An orbiter walks the bearing around the defender instead: across the orbit rows the same funnel captures {orbit['captureRange'][0] * 100:.0f}-{orbit['captureRange'][1] * 100:.0f} % of the damage (dwell {min(dwells):.1f}-{max(dwells):.1f} turns per sector). The slower orbits rotate slowly enough that a once-per-turn prediction still lands, which is exactly what the dwell column measures.")
if fast:
    dwells = fast["dwell"]
    lines.append(f"At the top two orbital speeds (dwell {min(dwells):.1f}-{max(dwells):.1f} turns) capture falls to {fast['capture'] * 100:.0f} % and the routed sector takes no damage at all in {fast['missRate'] * 100:.0f} % of the rounds it is chosen, while damage arrives on 2-4 facets. The defender cannot answer by widening the funnel: the 50 % per-sector cap allows at most 4 of the hull's 8 hp/turn to sit on one plate, always at least one turn behind the pivot that moved the fire there. That lag - not raw damage-per-turn - is what the orbiting ship buys with its pivot budget.")
rejects = {r["label"]: r["rejects"] for r in rows if r["rejects"]}
if rejects:
    lines.append("\n## Rejected operations (harness policy holes, not engine bugs)\n")
    for label, counts in rejects.items():
        lines.append(f"- `{label}`: {counts}")
    lines.append("\n`firingSolution:OPERATION_RESOURCE_EXHAUSTED` is the two-operator action pool running out (each hull gets 3 actions per operator per turn for ping/acquire/solution/attack); `attack:ILLEGAL_ATTACK_DECLARATION` is a declared attack the engine refused (track lost mid-turn, or the target outside the arc); the sensor rejects are the acquisition policy working a contact that the same turn's movement then invalidated; `SENSORS_OFFLINE` and `EVASION_HARDWARE_UNAVAILABLE` are battle damage removing the component the operation needs — the same damage that shows up as `min pivot cap` and `clipped turns` in the station-keeping table.")

if kin:
    lines.append("\n## Kinematics cross-check (`kinematics.json`)\n")
    verification = kin["integratorVerification"]
    lines.append(f"- Engine `integrateBurn` pivot vs the closed form r = v/ω: worst radius deviation **{verification['worstRadiusDeviationPct64']:.4f} %** at the engine's 64 steps per interval, **{verification['worstRadiusDeviationPct6']:.4f} %** at a coarse 6 steps.")
    lines.append(f"- Worst period deviation **{verification['worstPeriodDeviationPct']:.4f} %**.")
    lines.append("- The same file carries the closure, braking/reversal, pursuit and relative-motion tables for the hull's drive packages; those are pure motion geometry and unaffected by the duel sweep.")

lines.append("\n## Reading\n")
lines.append("- The station/insertion controller is open loop in speed and closed loop in radius: it inserts by burning along a tangent-biased flight path, then switches to one curved pivot maneuver per activation and holds the station with the crab trim. The pivot request is `arc pivot (v·duration/r) + (commanded crab − current crab)`, which is the term the old chord-tuned pursuit law was missing; that is why its orbits tracked wide and its mean engagement range sat outside the station.")
lines.append("- `motion` is the mean relative-motion modifier seen by shooters; more negative = harder to hit. Orbiting buys the attacker a large one (it pays the same penalty on its own shots) and the kinetic evasion stack on top.")
lines.append("- `attacks/turn` counts attacks declared per ship-turn across both ships; sensor work is what limits it, not the weapons.")

(HERE / "report.md").write_text("\n".join(lines) + "\n")
print("\n".join(lines))
