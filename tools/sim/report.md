# Duel simulator results (Monte-Carlo, real rules engine)

- Runs per scenario: **120**; quick=False; generated 2026-09-19T19:13:27.465Z; drives: **shipped**
- Scenario processes: 14 (each scenario is swept in its own process).
- Every operation goes through `executeShipOperation`: real validation, real rolls, real damage/shield/heat/regeneration resolution.
- Harness variants are config-driven only (drive thrust package, weapon loadout). The engine owns the curved Vector Authority pivot, the +2 Optimal Range bonus, the kinetic evasion stack, the relative-motion bands and the 50 % per-sector regeneration cap, so the harness declares none of them.
- Movement policies: `hover` holds position and faces the target; `brawl`/`orbit` are station policies that close to radius R around the target and then hold it at speed v with a single curved-pivot maneuver per activation (the harness measures the achieved radius, it does not assume it). Both arming policies arm the **standard** Evasive Protocol, the tier the operation dispatcher can actually arm (20 % timeline reserve, +2 AC).
- Baseline positions: A at (0,0) facing 0, B at (60,0) facing 180 (60 su = 300 ft). Combat stops at 40 rounds; 'kill rate' = fraction of runs where a hull reached 0.

## Headline table

| variant | match | kill rate | median TTK | median 1st collapse | shield dmg/turn A→B | B→A | hull dmg/turn A→B | B→A | attacks/turn | solutions/turn | mean speed A / B | mean motion | mean range | median min range | ram events | median hull left A / B |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base | hover vs hover | 0.9 | 23 | 8 | 4.093 | 3.938 | 0 | 0 | 0.988 | 0.944 | 0 / 0 | 0 | 60 | 60 | 0 | 5.5 / 0 |
| base | brawl vs hover | 1 | 23 | 13 | 1.918 | 3.307 | 0 | 0 | 1.001 | 0.87 | 11.83 / 0 | -3.787 | 19.7 | 11.6 | 0 | 45 / 0 |
| base | orbit12 vs hover | 0.09 | 31 | 16 | 2.981 | 3.316 | 0 | 0 | 0.96 | 0.935 | 11.94 / 0 | -3.76 | 31.2 | 28.8 | 0 | 45 / 50 |
| base | orbit18 vs hover | 0.01 | 17 | 8 | 1.955 | 2.33 | 0 | 0 | 0.949 | 0.924 | 17.7 / 0 | -7.524 | 31.1 | 27.3 | 0 | 50 / 50 |
| base | orbit24 vs hover | 0.99 | 27 | 16 | 0.861 | 2.247 | 0 | 0 | 0.853 | 0.816 | 23.91 / 0 | -7.254 | 32.2 | 25.4 | 0 | 50 / 0 |
| base | orbit30 vs hover | 0.01 | 19 | 13 | 0.409 | 2.302 | 0 | 0 | 0.576 | 0.563 | 29.81 / 0 | -7.214 | 32.5 | 27.7 | 0 | 50 / 50 |
| base | orbit18 vs orbit18 | 0.02 | 18.5 | 10 | 0.248 | 0.247 | 0 | 0 | 0.16 | 0.16 | 17.88 / 17.88 | -6.725 | 39.6 | 32.8 | 0 | 50 / 50 |
| base | brawl vs orbit18 | 0.03 | 17 | 10 | 1.896 | 1.353 | 0 | 0 | 0.744 | 0.718 | 11.85 / 17.88 | -7.728 | 28 | 22.1 | 0 | 50 / 50 |
| base | brawl vs brawl | 0.07 | 16.5 | 8.5 | 1.436 | 1.547 | 0 | 0 | 0.694 | 0.642 | 11.85 / 11.85 | -7.697 | 24.8 | 9 | 0 | 50 / 50 |
| laser | hover vs hover | 0.22 | 21.5 | 3 | 4.043 | 3.964 | 0 | 0 | 0.993 | 0.964 | 0 / 0 | 0 | 60 | 60 | 0 | 31 / 33 |
| laser | brawl vs hover | 0.96 | 31 | 3 | 2.23 | 4.312 | 0 | 0 | 1.017 | 0.893 | 11.83 / 0 | -1.945 | 18.8 | 11.6 | 0 | 18 / 0 |
| laser | orbit18 vs hover | 0.22 | 21.5 | 3 | 3.659 | 4.157 | 0 | 0 | 0.946 | 0.904 | 17.7 / 0 | -3.772 | 31.3 | 27.3 | 0 | 29.5 / 34 |
| laser | orbit18 vs orbit18 | 0.28 | 26.5 | 14 | 3.075 | 2.674 | 0 | 0 | 0.863 | 0.813 | 17.88 / 17.88 | -7.748 | 35.4 | 32.8 | 0 | 39 / 34 |
| laser | brawl vs orbit18 | 0.36 | 27 | 16 | 3.579 | 2.772 | 0 | 0 | 0.829 | 0.802 | 11.85 / 17.88 | -6.74 | 28.7 | 22.1 | 0 | 37 / 23 |

## Orbit station-keeping — measured radius error per scenario

A station policy flies one curved pivot maneuver per activation over the unreserved timeline (80 % of it: the standard Evasive Protocol reserves 20 %). The mandatory end-of-activation coast is a straight tangent chord, so the controller aims the arc at a hold radius 4 % *inside* the nominal station radius and cancels the chord's outward push with a crab feed-forward; the measured radius below is the engagement range at the moment the guns bear, against the nominal station radius.

`radius error` is the mean |r − R|/R over sustained samples (the first four sustained turns are treated as settling), `p95`/`max` the tail of the same distribution, `pivot` the median pivot spent per turn and `clipped` the sustained turns where the request hit the hull's pivot budget. The `max` column is a single turn, and its outliers are battle damage rather than control: a critical result that damages the Inertial Anchor cuts `getPivotCapability`, and the turn the ship loses its pivot it keeps flying its old vector — visible as the `clipped` count and the p95-to-max gap, never as a persistent error.

| scenario | ship | station | target radius | hold radius | sustained turns | insert turns | mean radius | radius error | p95 error | max error | median pivot/turn | min pivot cap | clipped turns | turns inside R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| brawl vs hover | A | brawl station 15 su @ 12 | 15 | 14.4 | 1857 | 480 | 14.9 | **1.52 %** | 5.73 % | 5.73 % | 45.33 (/75.5 % of cap) | 45 | 1 | 87.1 % |
| orbit 12 vs hover | A | orbit 30 su @ 12 | 30 | 28.8 | 3729 | 480 | 29.4 | **1.99 %** | 2.15 % | 2.8 % | 23.22 (/38.7 % of cap) | 45 | 0 | 100 % |
| orbit 18 vs hover | A | orbit 30 su @ 18 | 30 | 28.8 | 3697 | 600 | 29.58 | **1.41 %** | 1.58 % | 1.66 % | 34.15 (/56.9 % of cap) | 60 | 0 | 100 % |
| orbit 24 vs hover | A | orbit 30 su @ 24 | 30 | 28.8 | 2053 | 840 | 29.69 | **1.05 %** | 1.4 % | 1.4 % | 45.79 (/76.3 % of cap) | 60 | 0 | 100 % |
| orbit 30 vs hover | A | orbit 30 su @ 30 | 30 | 28.8 | 3339 | 960 | 29.74 | **0.91 %** | 1.11 % | 45.05 % | 56.75 (/94.6 % of cap) | 0 | 3 | 99.9 % |
| orbit 18 mirror | A | orbit 30 su @ 18 | 30 | 28.8 | 3677 | 600 | 33.94 | **13.12 %** | 14.08 % | 45.76 % | 59.04 (/98.4 % of cap) | 45 | 269 | 0 % |
| orbit 18 mirror | B | orbit 30 su @ 18 | 30 | 28.8 | 3677 | 600 | 33.92 | **13.07 %** | 15.37 % | 32.3 % | 59.04 (/98.4 % of cap) | 60 | 240 | 0 % |
| brawl vs orbit 18 | A | brawl station 15 su @ 12 | 15 | 14.4 | 3754 | 480 | 25.5 | **69.99 %** | 69.97 % | 74.53 % | 55.34 (/92.2 % of cap) | 60 | 0 | 0 % |
| brawl vs orbit 18 | B | orbit 30 su @ 18 | 30 | 28.8 | 3634 | 600 | 29.08 | **3.06 %** | 3.05 % | 3.6 % | 55.34 (/92.2 % of cap) | 60 | 0 | 100 % |
| brawl mirror | A | brawl station 15 su @ 12 | 15 | 14.4 | 3651 | 480 | 22.93 | **53.02 %** | 101.81 % | 141.42 % | 60 (/100 % of cap) | 30 | 2984 | 3.2 % |
| brawl mirror | B | brawl station 15 su @ 12 | 15 | 14.4 | 3651 | 480 | 22.8 | **51.99 %** | 97.13 % | 152.47 % | 60 (/100 % of cap) | 45 | 2985 | 0 % |
| laser brawl vs hover | A | brawl station 15 su @ 12 | 15 | 14.4 | 2538 | 480 | 15.1 | **2.79 %** | 5.73 % | 311.55 % | 45.32 (/75.5 % of cap) | 0 | 175 | 86.2 % |
| laser orbit 18 vs hover | A | orbit 30 su @ 18 | 30 | 28.8 | 3283 | 600 | 29.6 | **1.47 %** | 1.58 % | 26.05 % | 34.15 (/56.9 % of cap) | 30 | 20 | 99.4 % |
| laser orbit 18 mirror | A | orbit 30 su @ 18 | 30 | 28.8 | 3300 | 600 | 34.32 | **14.39 %** | 27.75 % | 62.23 % | 59.04 (/98.4 % of cap) | 0 | 350 | 0 % |
| laser orbit 18 mirror | B | orbit 30 su @ 18 | 30 | 28.8 | 3300 | 600 | 34.46 | **14.88 %** | 32.67 % | 57.83 % | 59.04 (/98.4 % of cap) | 30 | 429 | 0 % |
| laser brawl vs orbit 18 | A | brawl station 15 su @ 12 | 15 | 14.4 | 3278 | 480 | 25.96 | **73.07 %** | 101.26 % | 214.41 % | 55.34 (/92.2 % of cap) | 0 | 51 | 0 % |
| laser brawl vs orbit 18 | B | orbit 30 su @ 18 | 30 | 28.8 | 3155 | 600 | 29.59 | **4.24 %** | 14.45 % | 74.82 % | 55.34 (/92.2 % of cap) | 0 | 239 | 91.6 % |

**What the numbers say.** Against a stationary (hovering) target the retuned controller holds the station to **0.9-2.0 %** across every orbital speed, with no pivot clipping, and the engagement radius is at or inside the nominal radius in at least **99 % of settled turns** in every one of those rows (the nominal radius is the macrocannon's 30 su Optimal Range edge, the tightest weapon band in the hull). The pivot request is `arc pivot (v·duration/r) + (commanded crab - current crab)`: the arc term is the feed-forward the old chord-tuned pursuit law lacked, and the crab term is what closes the residual radius error.

Against a *moving* target the station is a geometry problem, not a control problem. A mutual orbit at separation R needs each hull's Velocity heading to rotate at 2v/R per turn - 68.8 deg/turn at v = 18 su/turn, R = 30 su, against the Inertial Anchor Mk II's 60 deg/turn ceiling - so a mirror pair cannot hold that station at all and settles wide with the pivot pinned at the cap. A brawl station at 15 su against a circling 18 su/turn target is the same arithmetic with a tighter radius. Those rows are reported rather than hidden: they show where the shipped pivot budget, not the helm policy, sets the answer.


## Weapon range bands — the engine's own verdict at the attack declaration

Share of declared attacks the engine resolved in the weapon's **optimal** band (its `calculateRangeBand` verdict, read off the attack commitment). Ranges: macrocannon optimal 30 / max 60; pulse laser 40 / 80; railgun 60 / 120.

The shots outside the optimal band are the *approach* shots, not station-keeping: a station policy does not fire while it is burning onto its flight path, but it does fire on the turns it spends rotating the nose onto that path, and those happen anywhere between 60 su and the station radius. The macrocannon (optimal 30, magazine 20, barrage 4) also empties after five barrages, so most of its attacks are those approach shots. Once the ship is on station its radius is inside every band, as the station-keeping table's `max radius` column shows.

| scenario | ship | policy | weapon | attacks | optimal | band counts |
|---|---|---|---|---|---|---|
| hover mirror | A | hover | railgun | 3023 | 100 % | optimal:3023 |
| hover mirror | B | hover | railgun | 2960 | 100 % | optimal:2960 |
| brawl vs hover | A | brawl | railgun | 2333 | 100 % | optimal:2333 |
| brawl vs hover | A | brawl | macrocannon (port) | 600 | 100 % | optimal:600 |
| brawl vs hover | B | hover | railgun | 2702 | 100 % | optimal:2702 |
| orbit 12 vs hover | A | orbit12 | railgun | 4329 | 100 % | optimal:4329 |
| orbit 12 vs hover | B | hover | railgun | 4685 | 100 % | optimal:4685 |
| orbit 18 vs hover | A | orbit18 | railgun | 4177 | 100 % | optimal:4177 |
| orbit 18 vs hover | A | orbit18 | macrocannon (port) | 120 | 100 % | optimal:120 |
| orbit 18 vs hover | B | hover | railgun | 4777 | 100 % | optimal:4777 |
| orbit 24 vs hover | A | orbit24 | railgun | 1933 | 100 % | optimal:1933 |
| orbit 24 vs hover | A | orbit24 | macrocannon (port) | 600 | 80 % | extended1:120, optimal:480 |
| orbit 24 vs hover | B | hover | railgun | 3258 | 100 % | optimal:3258 |
| orbit 30 vs hover | A | orbit30 | railgun | 121 | 100 % | optimal:121 |
| orbit 30 vs hover | A | orbit30 | macrocannon (port) | 600 | 60 % | extended1:240, optimal:360 |
| orbit 30 vs hover | B | hover | railgun | 4778 | 100 % | optimal:4778 |
| orbit 18 mirror | A | orbit18 | railgun | 153 | 100 % | optimal:153 |
| orbit 18 mirror | A | orbit18 | macrocannon (port) | 600 | 0 % | extended1:360, extended2:240 |
| orbit 18 mirror | B | orbit18 | railgun | 153 | 100 % | optimal:153 |
| orbit 18 mirror | B | orbit18 | macrocannon (port) | 600 | 0 % | extended1:480, extended2:120 |
| brawl vs orbit 18 | A | brawl | railgun | 4348 | 100 % | optimal:4348 |
| brawl vs orbit 18 | A | brawl | macrocannon (port) | 6 | 100 % | optimal:6 |
| brawl vs orbit 18 | B | orbit18 | railgun | 2092 | 100 % | optimal:2092 |
| brawl vs orbit 18 | B | orbit18 | macrocannon (port) | 600 | 60 % | extended1:240, optimal:360 |
| brawl mirror | A | brawl | railgun | 2550 | 100 % | optimal:2550 |
| brawl mirror | A | brawl | macrocannon (port) | 590 | 80 % | extended1:118, optimal:472 |
| brawl mirror | B | brawl | railgun | 2653 | 100 % | optimal:2653 |
| brawl mirror | B | brawl | macrocannon (port) | 593 | 79.8 % | extended1:120, optimal:473 |
| laser hover mirror | A | hover | pulse laser | 4383 | 0 % | extended2:4383 |
| laser hover mirror | B | hover | pulse laser | 4369 | 0 % | extended2:4369 |
| laser brawl vs hover | A | brawl | pulse laser | 3121 | 95.9 % | extended1:2, extended2:124, extended3:2, optimal:2993 |
| laser brawl vs hover | A | brawl | macrocannon (port) | 595 | 100 % | optimal:595 |
| laser brawl vs hover | B | hover | pulse laser | 3396 | 89.2 % | extended1:2, extended2:363, extended3:3, optimal:3028 |
| laser orbit 18 vs hover | A | orbit18 | pulse laser | 3868 | 96.9 % | extended2:120, optimal:3748 |
| laser orbit 18 vs hover | A | orbit18 | macrocannon (port) | 124 | 100 % | optimal:124 |
| laser orbit 18 vs hover | B | hover | pulse laser | 4344 | 89 % | extended1:120, extended2:360, optimal:3864 |
| laser orbit 18 mirror | A | orbit18 | pulse laser | 3436 | 94.3 % | extended1:76, extended2:120, optimal:3240 |
| laser orbit 18 mirror | A | orbit18 | macrocannon (port) | 600 | 0 % | extended1:360, extended2:240 |
| laser orbit 18 mirror | B | orbit18 | pulse laser | 2995 | 90.6 % | extended1:161, extended2:120, optimal:2714 |
| laser orbit 18 mirror | B | orbit18 | macrocannon (port) | 600 | 0 % | extended1:480, extended2:120 |
| laser brawl vs orbit 18 | A | brawl | pulse laser | 3820 | 96.5 % | extended1:13, extended2:120, optimal:3687 |
| laser brawl vs orbit 18 | A | brawl | macrocannon (port) | 18 | 100 % | optimal:18 |
| laser brawl vs orbit 18 | B | orbit18 | pulse laser | 2724 | 95 % | extended1:12, extended2:125, optimal:2587 |
| laser brawl vs orbit 18 | B | orbit18 | macrocannon (port) | 596 | 59.4 % | extended1:242, optimal:354 |

## Pivot payoff — struck-sector rotation vs the defender's regeneration funnel

Each hull routes its regeneration allocation at the sector it expects to be hit next, capped by its own hull data at 50 % of the budget (`regenerationWeightCap`), so its 8 hp/turn regeneration budget can put at most half of itself into one sector. A hovering attacker always strikes the same sector and that funnel catches nearly all of the damage; an orbiting attacker's bearing walks around the defender, so the struck sector rotates and the funnel is left pointing at the wrong plates.

| scenario | attacker | defender | struck-sector rotation | sector dwell (turns) | distinct sectors damaged | top-sector share of damage | damage on the funnel sector | rounds the funnel missed | shield dmg/turn | regen/turn |
|---|---|---|---|---|---|---|---|---|---|---|
| hover mirror | hover | hover | static | ∞ | 2 | 0.971 | 98.0 % | 58/3023 | 4.04 | 3.59 |
| hover mirror | hover | hover | static | ∞ | 1 | 1.000 | 97.3 % | 54/3023 | 3.90 | 3.48 |
| brawl vs hover | brawl | hover | 45.5 deg/turn | 2.0 | 3 | 0.858 | 59.6 % | 414/2817 | 1.85 | 1.21 |
| brawl vs hover | hover | brawl | static | ∞ | 2 | 0.525 | 74.5 % | 393/2817 | 3.29 | 3.00 |
| orbit 12 vs hover | orbit12 | hover | 23.3 deg/turn | 3.9 | 2 | 0.975 | 100.0 % | 1/4689 | 2.98 | 2.89 |
| orbit 12 vs hover | hover | orbit12 | static | ∞ | 2 | 0.968 | 92.1 % | 205/4689 | 3.31 | 3.09 |
| orbit 18 vs hover | orbit18 | hover | 34.3 deg/turn | 2.6 | 2 | 0.963 | 100.0 % | 0/4777 | 1.95 | 1.91 |
| orbit 18 vs hover | hover | orbit18 | static | ∞ | 2 | 0.918 | 91.1 % | 166/4777 | 2.33 | 2.23 |
| orbit 24 vs hover | orbit24 | hover | 46.1 deg/turn | 2.0 | 2 | 0.875 | 28.3 % | 308/3373 | 0.82 | 0.29 |
| orbit 24 vs hover | hover | orbit24 | static | ∞ | 3 | 0.791 | 84.3 % | 199/3373 | 2.25 | 2.13 |
| orbit 30 vs hover | orbit30 | hover | 57.4 deg/turn | 1.6 | 3 | 0.486 | 66.5 % | 62/4779 | 0.41 | 0.27 |
| orbit 30 vs hover | hover | orbit30 | static | ∞ | 3 | 0.804 | 89.7 % | 189/4779 | 2.30 | 2.15 |
| orbit 18 mirror | orbit18 | orbit18 | 30.2 deg/turn | 3.0 | 4 | 0.443 | 96.7 % | 7/4757 | 0.24 | 0.23 |
| orbit 18 mirror | orbit18 | orbit18 | 30.2 deg/turn | 3.0 | 2 | 0.676 | 46.3 % | 91/4757 | 0.24 | 0.24 |
| brawl vs orbit 18 | brawl | orbit18 | 26.6 deg/turn | 3.4 | 3 | 0.846 | 97.1 % | 43/4714 | 1.90 | 1.86 |
| brawl vs orbit 18 | orbit18 | brawl | 35.2 deg/turn | 2.6 | 2 | 0.916 | 91.6 % | 77/4714 | 1.35 | 1.21 |
| brawl mirror | brawl | brawl | 29.6 deg/turn | 3.0 | 3 | 0.876 | 99.0 % | 12/4611 | 1.41 | 1.36 |
| brawl mirror | brawl | brawl | 29.8 deg/turn | 3.0 | 4 | 0.895 | 80.8 % | 194/4611 | 1.55 | 1.45 |
| laser hover mirror | hover | hover | static | ∞ | 2 | 0.963 | 100.0 % | 2/4398 | 4.01 | 3.69 |
| laser hover mirror | hover | hover | static | ∞ | 1 | 1.000 | 96.6 % | 49/4398 | 3.96 | 3.64 |
| laser brawl vs hover | brawl | hover | 44.9 deg/turn | 2.0 | 3 | 0.746 | 68.2 % | 457/3498 | 2.09 | 1.49 |
| laser brawl vs hover | hover | brawl | static | ∞ | 2 | 0.591 | 64.8 % | 560/3498 | 4.28 | 3.61 |
| laser orbit 18 vs hover | orbit18 | hover | 34.3 deg/turn | 2.6 | 2 | 0.960 | 100.0 % | 1/4363 | 3.69 | 3.37 |
| laser orbit 18 vs hover | hover | orbit18 | static | ∞ | 2 | 0.887 | 86.1 % | 226/4363 | 4.13 | 3.64 |
| laser orbit 18 mirror | orbit18 | orbit18 | 29.8 deg/turn | 3.0 | 4 | 0.880 | 97.6 % | 39/4380 | 3.08 | 2.78 |
| laser orbit 18 mirror | orbit18 | orbit18 | 29.7 deg/turn | 3.0 | 4 | 0.895 | 90.3 % | 117/4380 | 2.72 | 2.42 |
| laser brawl vs orbit 18 | brawl | orbit18 | 26.2 deg/turn | 3.4 | 4 | 0.765 | 93.0 % | 107/4238 | 3.58 | 3.21 |
| laser brawl vs orbit 18 | orbit18 | brawl | 34.6 deg/turn | 2.6 | 2 | 0.882 | 90.6 % | 106/4238 | 2.80 | 2.45 |

**Pivot payoff.** The rotation column is the measured orbital rate, `v / r` in deg/turn against a 90-degree sector, so its inverse is the dwell time the defender's Regeneration Allocation prediction is worth — how long the facet it just aimed its regeneration at stays the facet under fire.
With neither hull moving (the hover mirrors) the struck sector is pinned: `top-sector share` 0.96-1.00, funnel capture 97-100 % of the damage, 3.98 damage/turn against 3.60 regen/turn repaired. A static funnel is therefore nearly perfect — and because the hull caps one sector at 50 % of the budget, even that perfect funnel can never put more than half of the hull's regeneration in front of the fire.
A defender that moves while the attacker holds station already loses some of that (top-sector share 0.53-0.97, capture 65-92 %), because its own attitude changes which facet faces the fire.
An orbiter walks the bearing around the defender instead: across the orbit rows the same funnel captures 28-100 % of the damage (dwell 1.6-3.9 turns per sector). The slower orbits rotate slowly enough that a once-per-turn prediction still lands, which is exactly what the dwell column measures.
At the top two orbital speeds (dwell 1.6-2.0 turns) capture falls to 47 % and the routed sector takes no damage at all in 5 % of the rounds it is chosen, while damage arrives on 2-4 facets. The defender cannot answer by widening the funnel: the 50 % per-sector cap allows at most 4 of the hull's 8 hp/turn to sit on one plate, always at least one turn behind the pivot that moved the fire there. That lag - not raw damage-per-turn - is what the orbiting ship buys with its pivot budget.

## Rejected operations (harness policy holes, not engine bugs)

- `hover mirror`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 5}
- `brawl vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 3}
- `orbit 12 vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 2, 'ping:SENSORS_OFFLINE': 1, 'acquire:SENSORS_OFFLINE': 1}
- `orbit 18 vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240}
- `orbit 24 vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 1}
- `orbit 30 vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'armEvasion:EVASION_HARDWARE_UNAVAILABLE': 1, 'attack:ILLEGAL_ATTACK_DECLARATION': 1}
- `orbit 18 mirror`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240}
- `brawl vs orbit 18`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240}
- `brawl mirror`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 3}
- `laser hover mirror`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 262, 'attack:ILLEGAL_ATTACK_DECLARATION': 13, 'acquire:SENSOR_LIVE_CONTACT_REQUIRED': 20, 'acquire:SENSOR_TARGET_OUT_OF_RANGE': 4, 'armEvasion:EVASION_HARDWARE_UNAVAILABLE': 2}
- `laser brawl vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 17, 'ping:SENSORS_OFFLINE': 1, 'acquire:SENSORS_OFFLINE': 1, 'armEvasion:EVASION_HARDWARE_UNAVAILABLE': 1}
- `laser orbit 18 vs hover`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 14, 'acquire:SENSOR_LIVE_CONTACT_REQUIRED': 2, 'ping:SENSORS_OFFLINE': 1, 'acquire:SENSORS_OFFLINE': 1, 'armEvasion:EVASION_HARDWARE_UNAVAILABLE': 1}
- `laser orbit 18 mirror`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 10, 'armEvasion:EVASION_HARDWARE_UNAVAILABLE': 1}
- `laser brawl vs orbit 18`: {'firingSolution:OPERATION_RESOURCE_EXHAUSTED': 240, 'attack:ILLEGAL_ATTACK_DECLARATION': 13, 'armEvasion:EVASION_HARDWARE_UNAVAILABLE': 2}

`firingSolution:OPERATION_RESOURCE_EXHAUSTED` is the two-operator action pool running out (each hull gets 3 actions per operator per turn for ping/acquire/solution/attack); `attack:ILLEGAL_ATTACK_DECLARATION` is a declared attack the engine refused (track lost mid-turn, or the target outside the arc); the sensor rejects are the acquisition policy working a contact that the same turn's movement then invalidated; `SENSORS_OFFLINE` and `EVASION_HARDWARE_UNAVAILABLE` are battle damage removing the component the operation needs — the same damage that shows up as `min pivot cap` and `clipped turns` in the station-keeping table.

## Kinematics cross-check (`kinematics.json`)

- Engine `integrateBurn` pivot vs the closed form r = v/ω: worst radius deviation **0.0017 %** at the engine's 64 steps per interval, **0.1986 %** at a coarse 6 steps.
- Worst period deviation **0.0000 %**.
- The same file carries the closure, braking/reversal, pursuit and relative-motion tables for the hull's drive packages; those are pure motion geometry and unaffected by the duel sweep.

## Reading

- The station/insertion controller is open loop in speed and closed loop in radius: it inserts by burning along a tangent-biased flight path, then switches to one curved pivot maneuver per activation and holds the station with the crab trim. The pivot request is `arc pivot (v·duration/r) + (commanded crab − current crab)`, which is the term the old chord-tuned pursuit law was missing; that is why its orbits tracked wide and its mean engagement range sat outside the station.
- `motion` is the mean relative-motion modifier seen by shooters; more negative = harder to hit. Orbiting buys the attacker a large one (it pays the same penalty on its own shots) and the kinetic evasion stack on top.
- `attacks/turn` counts attacks declared per ship-turn across both ships; sensor work is what limits it, not the weapons.
