# Ballista Sniper Corvette (ballista-sniper-corvette) — balance report

- Build source: hull file `world-data/hulls/ballista.js` + components file `world-data/components/medium-components.js` through materializeShipConfig
- Components: 36 supplied component sources, 12 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 44 of 44, shields fore 15 · port 15 · starboard 15 · aft 15) at the shipped power commit (engines 3 · shields 3 · sensors 2 · cooling 2 · inertia 2 · weapons 7)
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
| safe velocity `v_safe` | 24 su |
| forward Δv / turn | 6 su |
| retro Δv / turn | 3 su |
| port / starboard Δv / turn | 2 / 2 su |
| rotation / turn | 60° |
| pivot `ω` / turn | 60° = 1.047 rad |
| tightest circle `r_min = v_safe/ω` | 22.92 su |
| acceleration distance to `v_safe` | 48 su |
| closure from 60 su at 6 su/turn (target stationary) | 4.5 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Spinal Railgun | 90 su | 94.25 su | +70.25 | yes |
| Chaser Laser | 45 su | 47.12 su | +23.12 | yes |
| Chaser Laser | 45 su | 47.12 su | +23.12 | yes |

Kinetic evasion at `v_safe`: a hull crossing the line at 24 su reads as fast 18 → band >12 (-8), instant 12 → band >10-12 (-6) on incoming fire.

Pass geometry: turnaround 3 turns, separation after the pass 144 su against a mirror opponent (closing at 48 su/turn), re-merge 9 turns.

**Verdict:** holds an Optimal band at `v_safe` = 24 su (3 of 3 guns clear their ceiling; the tightest, Chaser Laser, is holdable up to 47.12 su); re-merge costs 9 turns, inside the 40-turn encounter clock, after closing 60 su in 4.5 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile | band at 44.3 su |
| --- | --- | --- | --- | --- | --- |
| Spinal Railgun | 9 | 1 | 9 | single shot | optimal (+2) |
| Chaser Laser | 3 | 1 | 3 | single shot | optimal (+2) |
| Chaser Laser | 3 | 1 | 3 | single shot | optimal (+2) |
| **total** | — | — | **15** | — | — |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 3 |
| tier regeneration / turn | 8 |
| most-exposed facet | fore — the most-struck facet across the 5 mirror scenarios (97.9%) |
| weight given to that facet | 50 (= min(100, hull cap 50)) |
| `allocateRegeneration` per turn on that facet | 4 |

Ceiling margin: 15 − 4 = **+11** shield damage per turn.

Mirror cross-check (5 mirror scenarios): 1.872 shield damage/turn dealt vs 1.446 shield regeneration/turn repaired → **+0.426**/turn, measured over 0.48 landed attacks/turn at a mean range of 44.3 su; funnel capture 0.955 (95.5% of the damage landed on the sector regeneration was routed to).

The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes 3 hits a turn where the mirror landed 0.48 attacks/turn.

**Verdict:** **out-damages** — sustained fire beats the funnel: +0.426 net shield damage/turn against 1.446 regenerated/turn (measured in the §5 mirrors), so the shields can be collapsed.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Spinal Mount — Spinal Railgun | 0° | 45° | -22.5°…22.5° | 12.5% | 90 / 180 su | 2.63 / 1.15 |
| Port Chaser — Chaser Laser | -90° | 30° | -105°…-75° | 8.3% | 45 / 90 su | 2.75 / 1.26 |
| Starboard Chaser — Chaser Laser | 90° | 30° | 75°…105° | 8.3% | 45 / 90 su | 2.75 / 1.26 |

| coverage | value |
| --- | --- |
| union coverage | 29.2% of the circle (105°) |
| blind arcs | 22.5°…75° and 105°…255° and 285°…337.5° |
| blind arc total | 255° (70.8%) |
| blind arcs strike | aft, port, fore, starboard |
| damage-weighted coverage | 10.8% |
| own nose (0°) / own aft (180°) | covered / blind |
| worst turns-to-bear (best gun per bearing) | 1.25 turns |
| mean turns-to-bear (best gun per bearing) | 0.32 turns |

**Verdict:** 29.2% of the circle is covered (105° of 360°); the blind arc is 22.5°…75° and 105°…255° and 285°…337.5° (255°), which exposes the aft / port / fore / starboard armor to any threat sitting there; own nose (0°) is covered and own aft (180°) is blind; worst turns-to-bear 2.75 gun-level (1.25 with the best gun at each bearing).

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | ballista-slot-reactor | reactor / medium | Corvette Reactor |
| Shield | ballista-slot-shield | shield / medium | Corvette Deflector |
| Sensor | ballista-slot-sensor | sensor / medium | Longbow Sensor Array |
| Cooling | ballista-slot-cooling | cooling / medium | Corvette Cooling Array |
| Main Drive | ballista-slot-main-drive | drive / medium | Corvette Main Drive |
| Reverse Drive | ballista-slot-reverse-drive | drive / medium | Corvette Reverse Drive |
| Port Lateral Drive | ballista-slot-port-lateral-drive | drive / medium | Corvette Lateral Drive |
| Starboard Lateral Drive | ballista-slot-starboard-lateral-drive | drive / medium | Corvette Lateral Drive |
| Inertial Anchor | ballista-slot-inertia | inertia / medium | Inertial Anchor Mk II |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Spinal Mount | 0° | fore | Spinal Railgun |
| Port Chaser | -90° | port | Chaser Laser |
| Starboard Chaser | 90° | starboard | Chaser Laser |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 6 / retro 3 / lateral 2 su, rotation 60°/turn |
| shields | 3 | 8 regeneration/turn |
| sensors | 2 | passive 150 su / strength 14, active 240 su / +1 |
| cooling | 2 | 9 Heat cooled per Start |
| inertia | 2 | 60° pivot/turn |
| weapons | 7 | 7 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 19 / 20 / 24 |
| unused (to reactor maximum) | 5 |
| redlining | no |
| legal commit | yes |
| emission band | high (-2 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |
| Spinal Mount — Spinal Railgun | 5 (overclock 6) | 5 | online |
| Port Chaser — Chaser Laser | 1 (overclock 2) | 1 | online |
| Starboard Chaser — Chaser Laser | 1 (overclock 2) | 1 | online |

Every installed gun online needs 7 Weapons Power against 7 committed; the shipped state has 3 of 3 online (Spinal Railgun, Chaser Laser, Chaser Laser).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 9 |
| net Heat per Start | -9 |
| Heat Capacity | 22 |
| vent | 12 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (22 Heat Capacity) would clear in 3 Start(s) of passive cooling alone; Emergency Vent removes at most 12 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 19 of 20 nominal (redline 24, headroom 5); 3 of 3 guns online, and every installed gun online would need 7 of the 7 committed Weapons Power; heat is stable without venting (-9 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `corvette`: the hull has 2 command operators, so the gunner owns Ping/Acquire/Solution and the shots while the pilot flies.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

Refusals (the engine declining an operation the policy attempted; none of them spends a resource or a roll): `attack:ILLEGAL_ATTACK_DECLARATION` — a declaration the engine refused — the target was already at 0 hull this turn, or the track/arc was lost mid-turn; `firingSolution:OPERATION_RESOURCE_EXHAUSTED` — the operator's Action pool was already spent.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 100% | 8 | 4 | 4.22 / 0 | 4.21 / 0 | 0.95 | 0.84 | 0 | 60 | 0 | 0 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80 |
| orbit 14.4 mirror | 40 | 88% | 25 | 14 | 2.4 / 0 | 2.33 / 0 | 0.96 | 0.71 | 0 | 48.1 | -8 | 14.3 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, attack:ILLEGAL_ATTACK_DECLARATION×3 |
| brawl mirror | 40 | 90% | 21 | 9 | 2.89 / 0 | 2.66 / 0 | 0.95 | 0.84 | 0 | 24.9 | -8 | 9.17 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, attack:ILLEGAL_ATTACK_DECLARATION×3 |
| railgun hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | — | 0 | 0 | — | — | 0 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80 |
| railgun orbit 14.4 mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | — | 0 | 0 | — | — | 14.3 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80 |

**Verdict:** 3 of 5 mirrors resolve inside the 40-turn clock — kill rates run 0%–100%, with a median TTK of 8–25 turns where a kill lands (best: hover mirror at 100%). What decides it is attrition — 1.872 shield damage/turn against 1.446 regenerated, with the mirrors funnelling 95.5% of their damage into the most-struck fore facet.

report written to tools/balance/ballista-sniper-corvette.md
