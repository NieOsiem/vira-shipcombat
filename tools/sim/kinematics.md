# Kinematics — the shipped Vector Authority pivot

Generated deterministically by `tools/sim/kinematics.mjs` (repo root: `/mnt/sataSSD/fvtt/viraV14/Data/modules/vira-shipcombat`).

## Units and provenance

- Scene units (**su**) for position, range and radius; **su/turn** for Velocity and Δv; **deg/turn** for pivot rate ω (rad/turn where labelled); **turns** for time (one ship activation = one turn = normalized timeline `T` of 1.0).
- Thrust packages: **6** = forward 6 / retro 3 / lateral 2 per side / rotation 60 (the shipped *Canadensis* drives); **10** = forward 10 / retro 5 / lateral 3 per side / rotation 60 (the harness's retuned-thrust variant). The pivot ceiling is the hull's own: the Inertial Anchor Mk II at Inertia power 2 gives **60 deg/turn**, so the ω = 75 rows are above what the shipped drive can request — they bracket the ceiling for the analysis, not a shippable configuration.
- **Real repo functions** (imported and executed): `getDriveCapabilities`, `getManeuverTime`, `integrateBurn` (parts c, d and every thrust budget/duration), `calculateRangeBand` (parts b, c), `calculateRelativeMotion` (part f), `createDefaultShipData`/`createInitialState` (ship config + state).
- **The pivot curve is the engine's**: `pivotIntegrate` is only a per-turn wrapper around `integrateBurn` with `pivot` set, because the engine caps one segment at one activation (duration ≤ 1). Parts 1, (a), (b) and (e) therefore measure the shipped integrator rather than a model of it.

## Headline answers

1. Integrator vs closed form: worst radius deviation **0.0017 %** at 64 sub-steps and **0.1986 %** at 6 sub-steps; worst period deviation **0 %**. All within the 2 % bound.
2. Pivot radius is r = v/ω, so the tightest circle always sits at the lowest speed; inward lateral thrust tightens it to r = v/(ω + a_lat/v) (min 6.527 su for package 6, 8.841 su for package 10, at v = 6 su/turn).
3. A ship can hold an orbit inside a weapon's Optimal Range iff v ≤ ω·(Optimal) for the pivot alone (inward thrust helps); at ω = 60 deg/turn that is 31.4 / 41.9 / 62.8 su/turn for the 30 / 40 / 60 su weapons.
4. Closing from 120 su at rest: package 6 crosses every weapon optimum on turn 4; package 10 on turn 3 (and passes through).
5. Braking drift = v0²/2a; reversal takes ceil(2·v0/a) turns and drifts the same v0²/2a past the turn-around point.
6. Pursuit: maximum speed a pursuer can hold range R with is **v_p,max = v_r + ω·R** (expected identical hulls, both pivoting at ω).

## 1. Integrator verification — sustained turn radius vs closed form r = v/ω

Radius measured by Kasa circle fit over one full period after a one-turn settle; period measured from the polar angle about the fitted centre. `6 sub-steps` is a deliberately coarse integration (the engine runs 64 per interval) and shows how much the step count is worth.

| v (su/turn) | ω (deg/turn) | ω (rad/turn) | r closed v/ω (su) | r measured 64 sub-steps (su) | deviation % | r measured 6 sub-steps (su) | dev % | period closed (turns) | period measured (turns) | period dev % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 30 | 0.5236 | 11.459 | 11.459 | 0.0003 | 11.463 | 0.0317 | 12 | 12 | 0 |
| 12 | 30 | 0.5236 | 22.918 | 22.918 | 0.0003 | 22.926 | 0.0317 | 12 | 12 | 0 |
| 18 | 30 | 0.5236 | 34.377 | 34.378 | 0.0003 | 34.388 | 0.0317 | 12 | 12 | 0 |
| 24 | 30 | 0.5236 | 45.837 | 45.837 | 0.0003 | 45.851 | 0.0317 | 12 | 12 | 0 |
| 30 | 30 | 0.5236 | 57.296 | 57.296 | 0.0003 | 57.314 | 0.0317 | 12 | 12 | 0 |
| 36 | 30 | 0.5236 | 68.755 | 68.755 | 0.0003 | 68.777 | 0.0317 | 12 | 12 | 0 |
| 6 | 45 | 0.7854 | 7.639 | 7.639 | 0.0006 | 7.645 | 0.0714 | 8 | 8 | 0 |
| 12 | 45 | 0.7854 | 15.279 | 15.279 | 0.0006 | 15.29 | 0.0714 | 8 | 8 | 0 |
| 18 | 45 | 0.7854 | 22.918 | 22.918 | 0.0006 | 22.935 | 0.0714 | 8 | 8 | 0 |
| 24 | 45 | 0.7854 | 30.558 | 30.558 | 0.0006 | 30.58 | 0.0714 | 8 | 8 | 0 |
| 30 | 45 | 0.7854 | 38.197 | 38.197 | 0.0006 | 38.224 | 0.0714 | 8 | 8 | 0 |
| 36 | 45 | 0.7854 | 45.837 | 45.837 | 0.0006 | 45.869 | 0.0714 | 8 | 8 | 0 |
| 6 | 60 | 1.0472 | 5.73 | 5.73 | 0.0011 | 5.737 | 0.127 | 6 | 6 | 0 |
| 12 | 60 | 1.0472 | 11.459 | 11.459 | 0.0011 | 11.474 | 0.127 | 6 | 6 | 0 |
| 18 | 60 | 1.0472 | 17.189 | 17.189 | 0.0011 | 17.211 | 0.127 | 6 | 6 | 0 |
| 24 | 60 | 1.0472 | 22.918 | 22.919 | 0.0011 | 22.947 | 0.127 | 6 | 6 | 0 |
| 30 | 60 | 1.0472 | 28.648 | 28.648 | 0.0011 | 28.684 | 0.127 | 6 | 6 | 0 |
| 36 | 60 | 1.0472 | 34.377 | 34.378 | 0.0011 | 34.421 | 0.127 | 6 | 6 | 0 |
| 6 | 75 | 1.309 | 4.584 | 4.584 | 0.0017 | 4.593 | 0.1986 | 4.8 | 4.8 | 0 |
| 12 | 75 | 1.309 | 9.167 | 9.167 | 0.0017 | 9.186 | 0.1986 | 4.8 | 4.8 | 0 |
| 18 | 75 | 1.309 | 13.751 | 13.751 | 0.0017 | 13.778 | 0.1986 | 4.8 | 4.8 | 0 |
| 24 | 75 | 1.309 | 18.335 | 18.335 | 0.0017 | 18.371 | 0.1986 | 4.8 | 4.8 | 0 |
| 30 | 75 | 1.309 | 22.918 | 22.919 | 0.0017 | 22.964 | 0.1986 | 4.8 | 4.8 | 0 |
| 36 | 75 | 1.309 | 27.502 | 27.502 | 0.0017 | 27.557 | 0.1986 | 4.8 | 4.8 | 0 |

## (a) Achievable turn radius vs speed, ω and thrust package

`r_pivot` = radius of the sustained circle from the pivot alone (closed form v/ω, measured by the integrator). `r_tight` = tightest circle at that speed: pivot plus the package's full inward lateral Δv (closed form v/(ω + a_lat/v), measured). `v after 1 fwd turn` = speed at the end of one full turn of forward thrust while pivoting (measured by the integrator); `r after 1 fwd turn` = that speed divided by ω.

### (a.1) Thrust package 6 — forward 6 / retro 3 / lateral 2 per side / rotation 60

| v (su/turn) | ω (deg/turn) | r_pivot closed (su) | r_pivot measured (su) | dev % | r_tight closed (su) | r_tight measured (su) | dev % | v after 1 fwd turn (su/turn) | r after 1 fwd turn (su) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 30 | 11.459 | 11.459 | 0 | 7.002 | 30.159 | 330.742 | 12 | 22.918 |
| 6 | 45 | 7.639 | 7.639 | 0.001 | 5.363 | 14.593 | 172.098 | 12 | 15.279 |
| 6 | 60 | 5.73 | 5.73 | 0.001 | 4.346 | 9.118 | 109.806 | 12 | 11.459 |
| 6 | 75 | 4.584 | 4.584 | 0.002 | 3.653 | 6.527 | 78.654 | 12 | 9.167 |
| 12 | 30 | 22.918 | 22.918 | 0 | 17.385 | 33.166 | 90.778 | 18 | 34.377 |
| 12 | 45 | 15.279 | 15.279 | 0.001 | 12.604 | 18.308 | 45.254 | 18 | 22.918 |
| 12 | 60 | 11.459 | 11.459 | 0.001 | 9.886 | 12.696 | 28.428 | 18 | 17.189 |
| 12 | 75 | 9.167 | 9.167 | 0.002 | 8.132 | 9.778 | 20.248 | 18 | 13.751 |
| 18 | 30 | 34.377 | 34.378 | 0 | 28.359 | 39.815 | 40.395 | 24 | 45.837 |
| 18 | 45 | 22.918 | 22.918 | 0.001 | 20.078 | 24.095 | 20.009 | 24 | 30.558 |
| 18 | 60 | 17.189 | 17.189 | 0.001 | 15.54 | 17.491 | 12.557 | 24 | 22.918 |
| 18 | 75 | 13.751 | 13.751 | 0.002 | 12.675 | 13.811 | 8.965 | 24 | 18.334 |
| 24 | 30 | 45.837 | 45.837 | 0 | 39.543 | 48.444 | 22.51 | 30 | 57.296 |
| 24 | 45 | 30.558 | 30.558 | 0.001 | 27.626 | 30.702 | 11.133 | 30 | 38.197 |
| 24 | 60 | 22.918 | 22.919 | 0.001 | 21.229 | 22.716 | 7.006 | 30 | 28.648 |
| 24 | 75 | 18.335 | 18.335 | 0.002 | 17.237 | 18.104 | 5.03 | 30 | 22.918 |
| 30 | 30 | 57.296 | 57.296 | 0 | 50.825 | 58.067 | 14.249 | 36 | 68.755 |
| 30 | 45 | 38.197 | 38.197 | 0.001 | 35.209 | 37.692 | 7.054 | 36 | 45.837 |
| 30 | 60 | 28.648 | 28.648 | 0.001 | 26.933 | 28.135 | 4.461 | 36 | 34.377 |
| 30 | 75 | 22.918 | 22.919 | 0.002 | 21.808 | 22.511 | 3.224 | 36 | 27.502 |
| 36 | 30 | 68.755 | 68.755 | 0 | 62.16 | 68.245 | 9.79 | 42 | 80.214 |
| 36 | 45 | 45.837 | 45.837 | 0.001 | 42.809 | 44.89 | 4.861 | 42 | 53.476 |
| 36 | 60 | 34.377 | 34.378 | 0.001 | 32.646 | 33.655 | 3.093 | 42 | 40.107 |
| 36 | 75 | 27.502 | 27.502 | 0.002 | 26.382 | 26.976 | 2.249 | 42 | 32.085 |

### (a.2) Thrust package 10 — forward 10 / retro 5 / lateral 3 per side / rotation 60

| v (su/turn) | ω (deg/turn) | r_pivot closed (su) | r_pivot measured (su) | dev % | r_tight closed (su) | r_tight measured (su) | dev % | v after 1 fwd turn (su/turn) | r after 1 fwd turn (su) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 30 | 11.459 | 11.459 | 0 | 5.862 | 45.201 | 671.126 | 16 | 30.558 |
| 6 | 45 | 7.639 | 7.639 | 0.001 | 4.668 | 21.261 | 355.475 | 16 | 20.372 |
| 6 | 60 | 5.73 | 5.73 | 0.001 | 3.878 | 12.809 | 230.291 | 16 | 15.279 |
| 6 | 75 | 4.584 | 4.584 | 0.002 | 3.317 | 8.841 | 166.541 | 16 | 12.223 |
| 12 | 30 | 22.918 | 22.918 | 0 | 15.512 | 46.006 | 196.584 | 22 | 42.017 |
| 12 | 45 | 15.279 | 15.279 | 0.001 | 11.59 | 23.203 | 100.206 | 22 | 28.011 |
| 12 | 60 | 11.459 | 11.459 | 0.001 | 9.251 | 15.107 | 63.307 | 22 | 21.008 |
| 12 | 75 | 9.167 | 9.167 | 0.002 | 7.697 | 11.174 | 45.166 | 22 | 16.807 |
| 18 | 30 | 34.377 | 34.378 | 0 | 26.077 | 49.749 | 90.778 | 28 | 53.476 |
| 18 | 45 | 22.918 | 22.918 | 0.001 | 18.906 | 27.462 | 45.254 | 28 | 35.651 |
| 18 | 60 | 17.189 | 17.189 | 0.001 | 14.829 | 19.044 | 28.428 | 28 | 26.738 |
| 18 | 75 | 13.751 | 13.751 | 0.002 | 12.198 | 14.668 | 20.248 | 28 | 21.39 |
| 24 | 30 | 45.837 | 45.837 | 0 | 37.003 | 55.957 | 51.225 | 34 | 64.935 |
| 24 | 45 | 30.558 | 30.558 | 0.001 | 26.362 | 33.058 | 25.399 | 34 | 43.29 |
| 24 | 60 | 22.918 | 22.919 | 0.001 | 20.474 | 23.738 | 15.938 | 34 | 32.467 |
| 24 | 75 | 18.335 | 18.335 | 0.002 | 16.736 | 18.638 | 11.364 | 34 | 25.974 |
| 30 | 30 | 57.296 | 57.296 | 0 | 48.108 | 63.805 | 32.63 | 40 | 76.394 |
| 30 | 45 | 38.197 | 38.197 | 0.001 | 33.883 | 39.355 | 16.15 | 40 | 50.929 |
| 30 | 60 | 28.648 | 28.648 | 0.001 | 26.151 | 28.803 | 10.141 | 40 | 38.197 |
| 30 | 75 | 22.918 | 22.919 | 0.002 | 21.292 | 22.836 | 7.252 | 40 | 30.557 |
| 36 | 30 | 68.755 | 68.755 | 0 | 59.315 | 72.666 | 22.51 | 46 | 87.853 |
| 36 | 45 | 45.837 | 45.837 | 0.001 | 41.44 | 46.053 | 11.133 | 46 | 58.569 |
| 36 | 60 | 34.377 | 34.378 | 0.001 | 31.843 | 34.074 | 7.006 | 46 | 43.927 |
| 36 | 75 | 27.502 | 27.502 | 0.002 | 25.856 | 27.156 | 5.03 | 46 | 35.141 |

### (a.3) Tightest circle per configuration (over the analyzed speed envelope)

| package | ω (deg/turn) | tightest r (su): pivot + inward lateral | at speed (su/turn) | tightest r (su): pivot only | at speed (su/turn) |
| --- | --- | --- | --- | --- | --- |
| 6 | 75 | 6.527 | 6 | 4.584 | 6 |
| 10 | 75 | 8.841 | 6 | 4.584 | 6 |

**Does thrusting while pivoting change the radius? Yes.** (i) Inward lateral thrust tightens the circle to r = v/(ω + a_lat/v); outward lateral thrust opens it symmetrically. (ii) Forward thrust raises speed, and the pivot radius scales as r = v/ω, so the circle opens as speed grows. (iii) At any given speed the pivot radius is the *minimum*, because the operator can always pivot slower to fly any r ≥ v/ω. Because r grows with v, the tightest circle inside the analyzed envelope always sits at the lowest analyzed speed (v = 6 su/turn) and approaches 0 as v → 0. *Note: the r_tight relation is first-order in a_lat/v — the integrator measures up to ~1.4 % tighter than the closed form where a_lat is a large fraction of v (low speed, package 10); the measured column is authoritative.*

## (b) Orbit feasibility inside each weapon's Optimal Range (30 / 40 / 60)

`r_min` = tightest achievable orbit radius at that speed (pivot + full inward lateral thrust). Band = `[r_min, Optimal]` is the set of orbit radii that keep a stationary centred target at or inside the weapon's Optimal Range. Feasible iff `r_min ≤ Optimal` (pivot-only: `v ≤ ω·Optimal`). `chord dip` is the dimensionless inward range drop of a one-chord-per-turn discrete model, `1 − cos(ω/2)`.

### (b.1) Thrust package 6

| v (su/turn) | ω (deg/turn) | r_min (su) | coast tail @ 20 % reserve (su) | Macrocannon 30 optimal band (su) | Pulse Laser 40 optimal band (su) | Railgun 60 optimal band (su) |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | 30 | 7 | 0.06 | [7, 30] ok | [7, 40] ok | [7, 60] ok |
| 6 | 45 | 5.36 | 0.09 | [5.36, 30] ok | [5.36, 40] ok | [5.36, 60] ok |
| 6 | 60 | 4.35 | 0.13 | [4.35, 30] ok | [4.35, 40] ok | [4.35, 60] ok |
| 6 | 75 | 3.65 | 0.16 | [3.65, 30] ok | [3.65, 40] ok | [3.65, 60] ok |
| 12 | 30 | 17.38 | 0.13 | [17.38, 30] ok | [17.38, 40] ok | [17.38, 60] ok |
| 12 | 45 | 12.6 | 0.19 | [12.6, 30] ok | [12.6, 40] ok | [12.6, 60] ok |
| 12 | 60 | 9.89 | 0.25 | [9.89, 30] ok | [9.89, 40] ok | [9.89, 60] ok |
| 12 | 75 | 8.13 | 0.31 | [8.13, 30] ok | [8.13, 40] ok | [8.13, 60] ok |
| 18 | 30 | 28.36 | 0.19 | [28.36, 30] ok | [28.36, 40] ok | [28.36, 60] ok |
| 18 | 45 | 20.08 | 0.28 | [20.08, 30] ok | [20.08, 40] ok | [20.08, 60] ok |
| 18 | 60 | 15.54 | 0.38 | [15.54, 30] ok | [15.54, 40] ok | [15.54, 60] ok |
| 18 | 75 | 12.68 | 0.47 | [12.68, 30] ok | [12.68, 40] ok | [12.68, 60] ok |
| 24 | 30 | 39.54 | 0.25 | infeasible (39.54 > 30) | [39.54, 40] ok | [39.54, 60] ok |
| 24 | 45 | 27.63 | 0.38 | [27.63, 30] ok | [27.63, 40] ok | [27.63, 60] ok |
| 24 | 60 | 21.23 | 0.5 | [21.23, 30] ok | [21.23, 40] ok | [21.23, 60] ok |
| 24 | 75 | 17.24 | 0.63 | [17.24, 30] ok | [17.24, 40] ok | [17.24, 60] ok |
| 30 | 30 | 50.82 | 0.31 | infeasible (50.82 > 30) | infeasible (50.82 > 40) | [50.82, 60] ok |
| 30 | 45 | 35.21 | 0.47 | infeasible (35.21 > 30) | [35.21, 40] ok | [35.21, 60] ok |
| 30 | 60 | 26.93 | 0.63 | [26.93, 30] ok | [26.93, 40] ok | [26.93, 60] ok |
| 30 | 75 | 21.81 | 0.79 | [21.81, 30] ok | [21.81, 40] ok | [21.81, 60] ok |
| 36 | 30 | 62.16 | 0.38 | infeasible (62.16 > 30) | infeasible (62.16 > 40) | infeasible (62.16 > 60) |
| 36 | 45 | 42.81 | 0.57 | infeasible (42.81 > 30) | infeasible (42.81 > 40) | [42.81, 60] ok |
| 36 | 60 | 32.65 | 0.75 | infeasible (32.65 > 30) | [32.65, 40] ok | [32.65, 60] ok |
| 36 | 75 | 26.38 | 0.94 | [26.38, 30] ok | [26.38, 40] ok | [26.38, 60] ok |

### (b.2) Thrust package 10

| v (su/turn) | ω (deg/turn) | r_min (su) | coast tail @ 20 % reserve (su) | Macrocannon 30 optimal band (su) | Pulse Laser 40 optimal band (su) | Railgun 60 optimal band (su) |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | 30 | 5.86 | 0.06 | [5.86, 30] ok | [5.86, 40] ok | [5.86, 60] ok |
| 6 | 45 | 4.67 | 0.09 | [4.67, 30] ok | [4.67, 40] ok | [4.67, 60] ok |
| 6 | 60 | 3.88 | 0.13 | [3.88, 30] ok | [3.88, 40] ok | [3.88, 60] ok |
| 6 | 75 | 3.32 | 0.16 | [3.32, 30] ok | [3.32, 40] ok | [3.32, 60] ok |
| 12 | 30 | 15.51 | 0.13 | [15.51, 30] ok | [15.51, 40] ok | [15.51, 60] ok |
| 12 | 45 | 11.59 | 0.19 | [11.59, 30] ok | [11.59, 40] ok | [11.59, 60] ok |
| 12 | 60 | 9.25 | 0.25 | [9.25, 30] ok | [9.25, 40] ok | [9.25, 60] ok |
| 12 | 75 | 7.7 | 0.31 | [7.7, 30] ok | [7.7, 40] ok | [7.7, 60] ok |
| 18 | 30 | 26.08 | 0.19 | [26.08, 30] ok | [26.08, 40] ok | [26.08, 60] ok |
| 18 | 45 | 18.91 | 0.28 | [18.91, 30] ok | [18.91, 40] ok | [18.91, 60] ok |
| 18 | 60 | 14.83 | 0.38 | [14.83, 30] ok | [14.83, 40] ok | [14.83, 60] ok |
| 18 | 75 | 12.2 | 0.47 | [12.2, 30] ok | [12.2, 40] ok | [12.2, 60] ok |
| 24 | 30 | 37 | 0.25 | infeasible (37 > 30) | [37, 40] ok | [37, 60] ok |
| 24 | 45 | 26.36 | 0.38 | [26.36, 30] ok | [26.36, 40] ok | [26.36, 60] ok |
| 24 | 60 | 20.47 | 0.5 | [20.47, 30] ok | [20.47, 40] ok | [20.47, 60] ok |
| 24 | 75 | 16.74 | 0.63 | [16.74, 30] ok | [16.74, 40] ok | [16.74, 60] ok |
| 30 | 30 | 48.11 | 0.31 | infeasible (48.11 > 30) | infeasible (48.11 > 40) | [48.11, 60] ok |
| 30 | 45 | 33.88 | 0.47 | infeasible (33.88 > 30) | [33.88, 40] ok | [33.88, 60] ok |
| 30 | 60 | 26.15 | 0.63 | [26.15, 30] ok | [26.15, 40] ok | [26.15, 60] ok |
| 30 | 75 | 21.29 | 0.79 | [21.29, 30] ok | [21.29, 40] ok | [21.29, 60] ok |
| 36 | 30 | 59.31 | 0.38 | infeasible (59.31 > 30) | infeasible (59.31 > 40) | [59.31, 60] ok |
| 36 | 45 | 41.44 | 0.57 | infeasible (41.44 > 30) | infeasible (41.44 > 40) | [41.44, 60] ok |
| 36 | 60 | 31.84 | 0.75 | infeasible (31.84 > 30) | [31.84, 40] ok | [31.84, 60] ok |
| 36 | 75 | 25.86 | 0.94 | [25.86, 30] ok | [25.86, 40] ok | [25.86, 60] ok |

**Wall against 'orbit drifts out of range'.** Feasibility is a hard bound: at speed v the ship cannot fly an orbit tighter than `r_min(v)`, and a centred orbit of radius R puts the target at range R, so once `r_min(v) > Optimal` the target *must* sit outside optimal range at every stable orbit radius. For the pivot alone the bound is `v ≤ ω·Optimal`; at the Inertial Anchor Mk II ceiling of ω = 60 deg/turn = 1.0472 rad/turn that is 31.4 / 41.9 / 62.8 su/turn for the 30 / 40 / 60 weapons. The engine integrates the pivot curve in 64 steps per interval, so a sustained orbit is a smooth arc with no chord dip; the only straight leg is the mandatory end-of-activation coast, whose outward excursion `(reserve·v)²/2R` is the last column — at the standard 20 % reserve it is 0.6 su on a 30 su station at v = 30, and the duel controller answers it by holding 4 % inside the nominal radius. Per-row `maxSpeedInOptimal30/40/60` values are in `kinematics.json`.

## (c) Closure timelines — two ships, at rest, 120 su apart, both burning in

Both ships spend the full normalized timeline on max forward thrust every turn (real `getManeuverTime` duration = 1.0, real `integrateBurn` path). Range is centre-to-centre after each turn. Weapons: Macrocannon optimal 30 / max 60, Pulse Laser 40 / 80, Twin Railgun 60 / 120 (`calculateRangeBand`). Range is an absolute distance, so the tables fold at the pass-through; ship-ship collision is not modelled in this kinematic run (real collision lives in `resolveShipImpact`).

### (c.1) Thrust package 6 — forward 6 su/turn, retro 3

| turn | range (su) | ship A speed (su/turn) | ship B speed (su/turn) | Macrocannon 30 band | Pulse Laser 40 band | Railgun 60 band |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 120 | 0 | 0 | — | — | — |
| 1 | 114 | 6 | 6 | beyondMaximum | beyondMaximum | extended4 (-4) |
| 2 | 96 | 12 | 12 | beyondMaximum | beyondMaximum | extended3 (-3) |
| 3 | 66 | 18 | 18 | beyondMaximum | extended3 (-3) | extended1 (-1) |
| 4 | 24 | 24 | 24 | optimal (+2) | optimal (+2) | optimal (+2) |
| 5 | 30 | 30 | 30 | optimal (+2) | optimal (+2) | optimal (+2) |
| 6 | 96 | 36 | 36 | beyondMaximum | beyondMaximum | extended3 (-3) |
| 7 | 174 | 42 | 42 | beyondMaximum | beyondMaximum | beyondMaximum |
| 8 | 264 | 48 | 48 | beyondMaximum | beyondMaximum | beyondMaximum |

| weapon | optimal (su) | max (su) | inside Optimal Range (turns) | inside Maximum Range (turns) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) | 30 | 60 | turns 4–5 | turns 4–5 |
| Pulse Laser | 40 | 80 | turns 4–5 | turns 3–5 |
| Twin Railgun | 60 | 120 | turns 4–5 | turns 1–6 |

Closest approach: 24 su at turn 4; the two centres pass through each other (this kinematic run models no ship-ship collision).

### (c.2) Thrust package 10 — forward 10 su/turn, retro 5

| turn | range (su) | ship A speed (su/turn) | ship B speed (su/turn) | Macrocannon 30 band | Pulse Laser 40 band | Railgun 60 band |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 120 | 0 | 0 | — | — | — |
| 1 | 110 | 10 | 10 | beyondMaximum | beyondMaximum | extended4 (-4) |
| 2 | 80 | 20 | 20 | beyondMaximum | extended4 (-4) | extended2 (-2) |
| 3 | 30 | 30 | 30 | optimal (+2) | optimal (+2) | optimal (+2) |
| 4 | 40 | 40 | 40 | extended2 (-2) | optimal (+2) | optimal (+2) |
| 5 | 130 | 50 | 50 | beyondMaximum | beyondMaximum | beyondMaximum |
| 6 | 240 | 60 | 60 | beyondMaximum | beyondMaximum | beyondMaximum |
| 7 | 370 | 70 | 70 | beyondMaximum | beyondMaximum | beyondMaximum |
| 8 | 520 | 80 | 80 | beyondMaximum | beyondMaximum | beyondMaximum |

| weapon | optimal (su) | max (su) | inside Optimal Range (turns) | inside Maximum Range (turns) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) | 30 | 60 | turn 3 | turns 3–4 |
| Pulse Laser | 40 | 80 | turns 3–4 | turns 2–4 |
| Twin Railgun | 60 | 120 | turns 3–4 | turns 1–4 |

Closest approach: 30 su at turn 3; the two centres pass through each other (this kinematic run models no ship-ship collision).

## (d) Braking and reversal (real `getManeuverTime` + `integrateBurn`)

Braking burns full retro Δv per turn with an exact final partial burn, so the ship reaches rest with no overshoot; drift = straight-line distance travelled until rest. Reversal keeps burning retro through zero until velocity equals the original speed on the opposite course; `drift to turnaround` is the maximum displacement (the v = 0 instant, taken from the fine `integrateBurn` path).

### (d.1) Thrust package 6 — retro capability 3 su/turn

| v0 (su/turn) | turns to rest | drift to rest (su) | analytic v0²/2a (su) | turns to reverse course | drift to turnaround (su) | analytic v0²/2a (su) | total path to reverse (su) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 4 | 24 | 24 | 8 | 24 | 24 | 48 |
| 18 | 6 | 54 | 54 | 12 | 54 | 54 | 108 |
| 24 | 8 | 96 | 96 | 16 | 96 | 96 | 192 |
| 30 | 10 | 150 | 150 | 20 | 150 | 150 | 300 |
| 36 | 12 | 216 | 216 | 24 | 216 | 216 | 432 |

### (d.2) Thrust package 10 — retro capability 5 su/turn

| v0 (su/turn) | turns to rest | drift to rest (su) | analytic v0²/2a (su) | turns to reverse course | drift to turnaround (su) | analytic v0²/2a (su) | total path to reverse (su) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 3 | 14.4 | 14.4 | 5 | 14.4 | 14.4 | 30.4 |
| 18 | 4 | 32.4 | 32.4 | 8 | 32.4 | 32.4 | 78.4 |
| 24 | 5 | 57.6 | 57.6 | 10 | 57.6 | 57.6 | 124.6 |
| 30 | 6 | 90 | 90 | 12 | 90 | 90 | 180 |
| 36 | 8 | 129.6 | 129.6 | 15 | 129.6 | 129.6 | 280.6 |

## (e) Pursuit maths — identical hulls, both pivoting at ω

The runner holds a circle of radius r_r = v_r/ω; a pursuer at speed v_p pivoting at the same ω traces a circle of radius r_p = v_p/ω. A **constant** range R requires the two circles to be concentric and traversed at the same angular rate, i.e. `R = |r_p − r_r|` → **v_p = v_r ± ωR**. The outer station **v_p,max = v_r + ωR** is the maximum speed at which a pursuer can hold range R; a slower pursuer can hold the same R from the inner station v_r − ωR. The simulation starts the pursuer at range R on the runner's bearing with both ships at max pivot rate; `sustained` statistics are taken over the final full period.

### (e) ω = 60 deg/turn, runner v_r = 24 su/turn, hold range R = 10 su

r_r = 22.918 su · runner period = 6 turns · **v_p,max = v_r + ωR = 34.472 su/turn** · inner station v_r − ωR = 13.528 su/turn

| v_p / v_p,max | v_p (su/turn) | range after 1 turn (su) | sustained min (su) | sustained max (su) | sustained mean (su) | concentric separation |v_p−v_r|/ω (su) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.7 | 24.13 | 9.937 | 9.751 | 10 | 9.894 | 0.125 | closes inside R |
| 1 | 34.472 | 9.858 | 9.858 | 10.143 | 10.001 | 10 | closes inside R |
| 1.3 | 44.814 | 17.05 | 10 | 29.755 | 19.526 | 19.875 | opens outside R |

| turn | range at v_p = 0.7·v_p,max (su) | range at v_p = v_p,max (su) | range at v_p = 1.3·v_p,max (su) |
| --- | --- | --- | --- |
| 0 | 10 | 10 | 10 |
| 1 | 9.937 | 9.858 | 17.05 |
| 2 | 9.812 | 9.86 | 26.141 |
| 3 | 9.751 | 10.004 | 29.755 |
| 4 | 9.816 | 10.143 | 26.356 |
| 5 | 9.94 | 10.142 | 17.377 |
| 6 | 10 | 10 | 10 |
| 7 | 9.937 | 9.858 | 17.05 |

### (e) ω = 60 deg/turn, runner v_r = 12 su/turn, hold range R = 30 su

r_r = 11.459 su · runner period = 6 turns · **v_p,max = v_r + ωR = 43.416 su/turn** · inner station v_r − ωR = -19.416 su/turn

| v_p / v_p,max | v_p (su/turn) | range after 1 turn (su) | sustained min (su) | sustained max (su) | sustained mean (su) | concentric separation |v_p−v_r|/ω (su) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.7 | 30.391 | 25.821 | 5.154 | 30 | 21.236 | 17.562 | closes inside R |
| 1 | 43.416 | 29.575 | 29.575 | 30.43 | 30.003 | 30 | closes inside R |
| 1.3 | 56.441 | 37.31 | 30 | 54.885 | 41.449 | 42.438 | opens outside R |

| turn | range at v_p = 0.7·v_p,max (su) | range at v_p = v_p,max (su) | range at v_p = 1.3·v_p,max (su) |
| --- | --- | --- | --- |
| 0 | 30 | 30 | 30 |
| 1 | 25.821 | 29.575 | 37.31 |
| 2 | 15.165 | 29.58 | 49.48 |
| 3 | 5.154 | 30.011 | 54.885 |
| 4 | 16.12 | 30.43 | 50.204 |
| 5 | 26.393 | 30.425 | 38.265 |
| 6 | 30 | 30 | 30 |
| 7 | 25.821 | 29.575 | 37.31 |

### (e) ω = 75 deg/turn, runner v_r = 24 su/turn, hold range R = 10 su

r_r = 18.335 su · runner period = 4.8 turns · **v_p,max = v_r + ωR = 37.09 su/turn** · inner station v_r − ωR = 10.91 su/turn

| v_p / v_p,max | v_p (su/turn) | range after 1 turn (su) | sustained min (su) | sustained max (su) | sustained mean (su) | concentric separation |v_p−v_r|/ω (su) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.7 | 25.963 | 8.973 | 7.262 | 10 | 8.62 | 1.5 | closes inside R |
| 1 | 37.09 | 9.803 | 9.823 | 10.198 | 9.997 | 10 | closes inside R |
| 1.3 | 48.217 | 18.053 | 10 | 26.286 | 19.142 | 18.5 | opens outside R |

| turn | range at v_p = 0.7·v_p,max (su) | range at v_p = v_p,max (su) | range at v_p = 1.3·v_p,max (su) |
| --- | --- | --- | --- |
| 0 | 10 | 10 | 10 |
| 1 | 8.973 | 9.803 | 18.053 |
| 2 | 7.22 | 9.902 | 26.142 |
| 3 | 7.545 | 10.148 | 25.348 |
| 4 | 9.369 | 10.177 | 16.245 |
| 5 | 9.949 | 9.947 | 10.429 |
| 6 | 8.596 | 9.796 | 20.177 |
| 7 | 7.052 | 9.952 | 26.77 |

Below v_p,max the pursuer's own circle is tighter than the runner's station, so a pursuer flying at max pivot cuts inside and the range falls below R; at v_p,max the two circles are exactly concentric and the range holds at R indefinitely; above v_p,max the pursuer's tightest circle is wider than r_r + R, so it can never get back to R and the range opens.

## (f) Relative-motion profile of an orbiter vs a stationary target (real `calculateRelativeMotion`)

Rows: the orbiter holds radius R around a stationary target at speed v, so the pivot rate is ω = v/R and the engine's curved pivot keeps the Velocity tangential all the way round. A centred orbit therefore shows the target pure transverse motion: transverse = v, radial = 0, rawMotion = v (rawMotion = transverse + 0.25·radial), and the modifier band is constant across the whole orbit — it depends only on the projectile class (instant ×0.5, fast ×0.75, medium ×1) — so a held orbit cannot drift across a relative-motion breakpoint. The last column is the one straight leg left in an activation: the mandatory end-of-activation coast, which with the standard 20 % Evasive Protocol reserve drifts the ship (0.2·v)²/2R outside the circle its maneuver tracked.

### (f) R = 30 su, v = 12 su/turn → ω = 22.918 deg/turn, period = 15.71 turns, pivot feasible (≤ 60 deg/turn)

| weapon (projectile) | transverse / radial (su/turn) | band (modifier) | effective motion | coast tail @ 20 % reserve (su) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) (medium) | 12 / 0 | >10-12 (-6) | 12 | 0.1 |
| Pulse Laser (instant) | 12 / 0 | >4-6 (+0) | 6 | 0.1 |
| Twin Railgun (fast) | 12 / 0 | >8-10 (-4) | 9 | 0.1 |

### (f) R = 30 su, v = 24 su/turn → ω = 45.837 deg/turn, period = 7.85 turns, pivot feasible (≤ 60 deg/turn)

| weapon (projectile) | transverse / radial (su/turn) | band (modifier) | effective motion | coast tail @ 20 % reserve (su) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) (medium) | 24 / 0 | >12 (-8) | 24 | 0.38 |
| Pulse Laser (instant) | 24 / 0 | >10-12 (-6) | 12 | 0.38 |
| Twin Railgun (fast) | 24 / 0 | >12 (-8) | 18 | 0.38 |

### (f) R = 30 su, v = 30 su/turn → ω = 57.296 deg/turn, period = 6.28 turns, pivot feasible (≤ 60 deg/turn)

| weapon (projectile) | transverse / radial (su/turn) | band (modifier) | effective motion | coast tail @ 20 % reserve (su) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) (medium) | 30 / 0 | >12 (-8) | 30 | 0.6 |
| Pulse Laser (instant) | 30 / 0 | >12 (-8) | 15 | 0.6 |
| Twin Railgun (fast) | 30 / 0 | >12 (-8) | 22.5 | 0.6 |

### (f) R = 60 su, v = 12 su/turn → ω = 11.459 deg/turn, period = 31.42 turns, pivot feasible (≤ 60 deg/turn)

| weapon (projectile) | transverse / radial (su/turn) | band (modifier) | effective motion | coast tail @ 20 % reserve (su) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) (medium) | 12 / 0 | >10-12 (-6) | 12 | 0.05 |
| Pulse Laser (instant) | 12 / 0 | >4-6 (+0) | 6 | 0.05 |
| Twin Railgun (fast) | 12 / 0 | >8-10 (-4) | 9 | 0.05 |

### (f) R = 60 su, v = 24 su/turn → ω = 22.918 deg/turn, period = 15.71 turns, pivot feasible (≤ 60 deg/turn)

| weapon (projectile) | transverse / radial (su/turn) | band (modifier) | effective motion | coast tail @ 20 % reserve (su) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) (medium) | 24 / 0 | >12 (-8) | 24 | 0.19 |
| Pulse Laser (instant) | 24 / 0 | >10-12 (-6) | 12 | 0.19 |
| Twin Railgun (fast) | 24 / 0 | >12 (-8) | 18 | 0.19 |

### (f) R = 60 su, v = 30 su/turn → ω = 28.648 deg/turn, period = 12.57 turns, pivot feasible (≤ 60 deg/turn)

| weapon (projectile) | transverse / radial (su/turn) | band (modifier) | effective motion | coast tail @ 20 % reserve (su) |
| --- | --- | --- | --- | --- |
| Macrocannon (x2) (medium) | 30 / 0 | >12 (-8) | 30 | 0.3 |
| Pulse Laser (instant) | 30 / 0 | >12 (-8) | 15 | 0.3 |
| Twin Railgun (fast) | 30 / 0 | >12 (-8) | 22.5 | 0.3 |

**Reading.** A centred orbit is geometrically stable: the transverse band is fixed purely by the orbit speed, radial motion is identically zero, and the band therefore cannot drift across a relative-motion breakpoint while the orbit is held — the engine's 64-step integration of the pivot curve reproduces the closed-form circle to well under a tenth of a percent (§1). The only straight leg is the mandatory end-of-activation coast, and the duel controller compensates its outward excursion by holding its station 4 % inside the nominal radius.
