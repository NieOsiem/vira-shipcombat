# Peregrinus Interceptor (peregrinus-interceptor) — balance report

- Build source: bundled reference build `peregrinus-interceptor` (scripts/data/reference-builds.js)
- Components: 11 supplied component sources, 11 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 25 of 25, shields bubble 30) at the shipped power commit (engines 3 · shields 2 · sensors 1 · cooling 1 · inertia 2 · weapons 2)
- Thrust package: `shipped` (component base thrust)
- Mirror duel: 40 runs per scenario, encounter clock 40 turns, opening range 60 su
- Engine: drive/pivot capabilities, range band + firing arc + relative motion + struck sector, shield regeneration apportionment, power state and maintained Heat from the module's rules; the mirror section is the duel engine itself (tools/sim/duel.mjs)

## 1. Dogfight rule

Nose-fixed guns make a dogfight a geometry problem: a hull circling at speed `v` with pivot
authority `ω` flies a circle of radius `r = v/ω`, so each weapon's Optimal Range sets a hard speed
ceiling `v_ceiling = ω·optimal` — the fastest the hull may fly while still holding that gun's
Optimal band. Above it the hull must fly straighter than its own gun wants or accept the extended
band. `ω` is converted to radians here (this hull: 60°/turn = 1.047 rad/turn): the
pivot ceiling is quoted in degrees, the circle geometry is not. The second half is the merge: after
a pass the hull needs rotation to come back around.

| quantity at the shipped state | value |
| --- | --- |
| safe velocity `v_safe` | 40 su |
| forward Δv / turn | 8 su |
| retro Δv / turn | 4 su |
| port / starboard Δv / turn | 3 / 3 su |
| rotation / turn | 90° |
| pivot `ω` / turn | 60° = 1.047 rad |
| tightest circle `r_min = v_safe/ω` | 38.2 su |
| acceleration distance to `v_safe` | 100 su |
| closure from 60 su at 8 su/turn (target stationary) | 3.87 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Light Cannon | 30 su | 31.42 su | -8.58 | no |
| Light Cannon | 30 su | 31.42 su | -8.58 | no |

Kinetic evasion at `v_safe`: a hull crossing the line at 40 su reads as fast 30 → band >12 (-8) on incoming fire.

Pass geometry: turnaround 2 turns, separation after the pass 160 su against a mirror opponent (closing at 80 su/turn), re-merge 6 turns.

**Verdict:** cannot hold any Optimal band at `v_safe` = 40 su — the widest gun (Light Cannon) is holdable only below 31.42 su, so the hull must trade away speed or its Optimal band; re-merge costs 6 turns, inside the 40-turn encounter clock, after closing 60 su in 3.87 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile | band at 33.4 su |
| --- | --- | --- | --- | --- | --- |
| Light Cannon | 4 | 1 | 4 | single shot | extended1 (-1) |
| Light Cannon | 4 | 1 | 4 | single shot | extended1 (-1) |
| **total** | — | — | **8** | — | — |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 2 |
| tier regeneration / turn | 3 |
| most-exposed facet | bubble — the single pool — `regenerationWeightCap` (100) is inert under a bubble |
| weight given to that facet | 100 (whole budget, one pool) |
| `allocateRegeneration` per turn on that facet | 3 |

Ceiling margin: 8 − 3 = **+5** shield damage per turn.

Mirror cross-check (5 mirror scenarios): 0.093 shield damage/turn dealt vs 0.089 shield regeneration/turn repaired → **+0.003**/turn, measured over 0.25 landed attacks/turn at a mean range of 33.4 su; regeneration has no funnel to capture — the whole budget lands on the single pool.

The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes 2 hits a turn where the mirror landed 0.25 attacks/turn.

**Verdict:** **marginal** — the margin is positive but not material (+0.003 net shield damage/turn against 0.089 regenerated/turn (measured in the §5 mirrors), inside the 0.05/turn noise of a fight that ends without collapsing anything); the shields are not beaten, they are merely scratched.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Prow — Light Cannon | 0° | 90° | -45°…45° | 25% | 30 / 60 su | 1.5 / 0.56 |
| Dorsal — Light Cannon | 0° | 90° | -45°…45° | 25% | 30 / 60 su | 1.5 / 0.56 |

| coverage | value |
| --- | --- |
| union coverage | 25% of the circle (90°) |
| blind arcs | 45°…315° |
| blind arc total | 270° (75%) |
| blind arcs strike | aft, port, starboard |
| damage-weighted coverage | 25% |
| own nose (0°) / own aft (180°) | covered / blind |
| worst turns-to-bear (best gun per bearing) | 1.5 turns |
| mean turns-to-bear (best gun per bearing) | 0.56 turns |

**Verdict:** 25% of the circle is covered (90° of 360°); the blind arc is 45°…315° (270°), which exposes the aft / port / starboard armor to any threat sitting there; own nose (0°) is covered and own aft (180°) is blind; worst turns-to-bear 1.5 gun-level (1.5 with the best gun at each bearing).

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | peregrinus-slot-reactor | reactor / small | Light Reactor |
| Shield | peregrinus-slot-shield | shield / small | Bubble Deflector |
| Sensor | peregrinus-slot-sensor | sensor / small | Light Sensor Array |
| Cooling | peregrinus-slot-cooling | cooling / small | Compact Cooling Array |
| Main Drive | peregrinus-slot-main-drive | drive / small | Light Main Drive |
| Reverse Drive | peregrinus-slot-reverse-drive | drive / small | Light Reverse Drive |
| Port Lateral Drive | peregrinus-slot-port-lateral-drive | drive / small | Light Lateral Drive |
| Starboard Lateral Drive | peregrinus-slot-starboard-lateral-drive | drive / small | Light Lateral Drive |
| Inertial Anchor | peregrinus-slot-inertia | inertia / small | Compact Inertial Anchor |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Prow | 0° | fore | Light Cannon |
| Dorsal | 0° | fore | Light Cannon |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 8 / retro 4 / lateral 3 su, rotation 90°/turn |
| shields | 2 | 3 regeneration/turn |
| sensors | 1 | passive 40 su / strength 6, active 60 su / -2 |
| cooling | 1 | 2 Heat cooled per Start |
| inertia | 2 | 60° pivot/turn |
| weapons | 2 | 2 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 11 / 11 / 13 |
| unused (to reactor maximum) | 2 |
| redlining | no |
| legal commit | yes |
| emission band | high (-2 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |
| Prow — Light Cannon | 1 (overclock 2) | 1 | online |
| Dorsal — Light Cannon | 1 (overclock 2) | 1 | online |

Every installed gun online needs 2 Weapons Power against 2 committed; the shipped state has 2 of 2 online (Light Cannon, Light Cannon).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 2 |
| net Heat per Start | -2 |
| Heat Capacity | 12 |
| vent | 8 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (12 Heat Capacity) would clear in 6 Start(s) of passive cooling alone; Emergency Vent removes at most 8 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 11 of 11 nominal (redline 13, headroom 2); 2 of 2 guns online, and every installed gun online would need 2 of the 2 committed Weapons Power; heat is stable without venting (-2 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `fighter`: the hull has 1 command operator, so one console flies, senses and shoots — it manoeuvres first, spends its sensing Actions only on what advances its track (Ping, then Acquire), fires every bearing gun, and only a spare Action buys a Firing Solution.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 1.02 | — | — | 0 | 0 | none |
| orbit 24 mirror | 40 | 0% | — | — | 0.06 / 0 | 0.07 / 0 | pool | 0.38 | 0.67 | 35.4 | -8 | 23.69 | 0 | none |
| brawl mirror | 40 | 0% | — | — | 0.33 / 0 | 0.32 / 0 | pool | 0.69 | 0.37 | 29.5 | -8 | 15.75 | 0 | none |
| cannon hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 0.51 | — | — | 0 | 0 | none |
| cannon orbit 24 mirror | 40 | 0% | — | — | 0.08 / 0 | 0.07 / 0 | pool | 0.19 | 0.33 | 35.2 | -8 | 23.69 | 0 | none |

**Verdict:** no mirror resolves inside the 40-turn clock: a stalemate — 0.093 shield damage/turn against 0.089 regenerated, a margin inside the 0.05/turn noise floor, at 0.25 landed attacks/turn. 3 of 5 mirrors are Action-starved — hover mirror, orbit 24 mirror, cannon hover mirror hung 0.73 guns/turn each.

report written to tools/balance/peregrinus-interceptor.md
