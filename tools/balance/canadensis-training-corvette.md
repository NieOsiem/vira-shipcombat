# Canadensis Training Corvette (canadensis-training-corvette) — balance report

- Build source: bundled reference build `canadensis-training-corvette` (scripts/data/reference-builds.js)
- Components: 13 supplied component sources, 13 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 50 of 50, shields fore 15 · port 15 · starboard 15 · aft 15) at the shipped power commit (engines 3 · shields 3 · sensors 2 · cooling 1 · inertia 2 · weapons 3)
- Thrust package: `shipped` (component base thrust)
- Mirror duel: 0 runs per scenario, encounter clock 40 turns, opening range 60 su
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
| safe velocity `v_safe` | 30 su |
| forward Δv / turn | 6 su |
| retro Δv / turn | 3 su |
| port / starboard Δv / turn | 2 / 2 su |
| rotation / turn | 60° |
| pivot `ω` / turn | 60° = 1.047 rad |
| tightest circle `r_min = v_safe/ω` | 28.65 su |
| acceleration distance to `v_safe` | 75 su |
| closure from 60 su at 6 su/turn (target stationary) | 4.47 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Twin Railgun | 60 su | 62.83 su | +32.83 | yes |
| Pulse Laser | 40 su | 41.89 su | +11.89 | yes |
| Training Macrocannon | 30 su | 31.42 su | +1.42 | yes |
| Training Macrocannon | 30 su | 31.42 su | +1.42 | yes |

Kinetic evasion at `v_safe`: a hull crossing the line at 30 su reads as fast 22.5 → band >12 (-8), instant 15 → band >12 (-8), medium 30 → band >12 (-8) on incoming fire.

Pass geometry: turnaround 3 turns, separation after the pass 180 su against a mirror opponent (closing at 60 su/turn), re-merge 9 turns.

**Verdict:** holds an Optimal band at `v_safe` = 30 su (4 of 4 guns clear their ceiling; the tightest, Training Macrocannon, is holdable up to 31.42 su); re-merge costs 9 turns, inside the 40-turn encounter clock, after closing 60 su in 4.47 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile |
| --- | --- | --- | --- | --- |
| Twin Railgun | 6 | 1 | 6 | single shot |
| Training Macrocannon | 7 | 2 | 14 | 4-round barrage, -2 to hit |
| **total** | — | — | **20** | — |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 3 |
| tier regeneration / turn | 8 |
| most-exposed facet | fore — the heaviest shipped regeneration weight (25%) |
| weight given to that facet | 50 (= min(100, hull cap 50)) |
| `allocateRegeneration` per turn on that facet | 4 |

Ceiling margin: 20 − 4 = **+16** shield damage per turn.

Mirror cross-check: not run (no duel), so this section stands on the unattainable ceiling alone.

**Verdict:** **out-damages** — sustained fire beats the funnel: +16 net shield damage/turn against 4 regenerated/turn (the hull's static facet budget, no duel ran), so the shields can be collapsed.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Prow — Twin Railgun | 0° | 90° | -45°…45° | 25% | 60 / 120 su | 2.25 / 0.84 |
| Dorsal — Pulse Laser | 0° | 180° | -90°…90° | 50% | 40 / 80 su | 1.5 / 0.38 |
| Port — Training Macrocannon | -90° | 120° | -150°…-30° | 33.3% | 30 / 60 su | 2 / 0.67 |
| Starboard — Training Macrocannon | 90° | 120° | 30°…150° | 33.3% | 30 / 60 su | 2 / 0.67 |

| coverage | value |
| --- | --- |
| union coverage | 83.3% of the circle (300°) |
| blind arcs | 150°…210° |
| blind arc total | 60° (16.7%) |
| blind arcs strike | aft |
| damage-weighted coverage | 38% |
| own nose (0°) / own aft (180°) | covered / blind |
| worst turns-to-bear (best gun per bearing) | 0.5 turns |
| mean turns-to-bear (best gun per bearing) | 0.04 turns |

**Verdict:** 83.3% of the circle is covered (300° of 360°); the blind arc is 150°…210° (60°), which exposes the aft armor to any threat sitting there; own nose (0°) is covered and own aft (180°) is blind; worst turns-to-bear 2.25 gun-level (0.5 with the best gun at each bearing).

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | canadensis-slot-reactor | reactor / medium | Academy Reactor |
| Shield | canadensis-slot-shield | shield / medium | Training Deflector |
| Sensor | canadensis-slot-sensor | sensor / medium | Academy Sensor Array |
| Cooling | canadensis-slot-cooling | cooling / medium | Training Cooling Array |
| Main Drive | canadensis-slot-main-drive | drive / medium | Training Main Drive |
| Reverse Drive | canadensis-slot-reverse-drive | drive / medium | Training Reverse Drive |
| Port Lateral Drive | canadensis-slot-port-lateral-drive | drive / medium | Training Lateral Drive |
| Starboard Lateral Drive | canadensis-slot-starboard-lateral-drive | drive / medium | Training Lateral Drive |
| Inertial Anchor | canadensis-slot-inertia | inertia / medium | Inertial Anchor Mk II |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Prow | 0° | fore | Twin Railgun |
| Dorsal | 0° | fore | Pulse Laser |
| Port | -90° | port | Training Macrocannon |
| Starboard | 90° | starboard | Training Macrocannon |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 6 / retro 3 / lateral 2 su, rotation 60°/turn |
| shields | 3 | 8 regeneration/turn |
| sensors | 2 | passive 100 su / strength 10, active 150 su / 0 |
| cooling | 1 | 4 Heat cooled per Start |
| inertia | 2 | 60° pivot/turn |
| weapons | 3 | 3 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 14 / 14 / 16 |
| unused (to reactor maximum) | 2 |
| redlining | no |
| legal commit | yes |
| emission band | high (-2 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |
| Prow — Twin Railgun | 2 (overclock 3) | 2 | online |
| Dorsal — Pulse Laser | 2 (overclock 3) | 0 | off |
| Port — Training Macrocannon | 1 (overclock 2) | 1 | online |
| Starboard — Training Macrocannon | 1 (overclock 2) | 0 | off |

Every installed gun online needs 6 Weapons Power against 3 committed; the shipped state has 2 of 4 online (Twin Railgun, Training Macrocannon).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 4 |
| net Heat per Start | -4 |
| Heat Capacity | 20 |
| vent | 10 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (20 Heat Capacity) would clear in 5 Start(s) of passive cooling alone; Emergency Vent removes at most 10 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 14 of 14 nominal (redline 16, headroom 2); 2 of 4 guns online, and every installed gun online would need 6 of the 3 committed Weapons Power; heat is stable without venting (-4 per Start).

## 5. Mirror duel

Duel skipped: `--runs=0`. 5 mirror scenario(s) available: hover mirror, orbit 18 mirror, brawl mirror, laser hover mirror, laser orbit 18 mirror.

**Verdict:** no duel ran, so mirror resolution is untested by this report.

report written to tools/balance/canadensis-training-corvette.md
