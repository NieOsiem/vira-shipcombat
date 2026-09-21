# Aegis Escort (aegis-escort) — balance report

- Build source: hull file `world-data/hulls/aegis.js` + components file `world-data/components/medium-components.js` through materializeShipConfig
- Components: 36 supplied component sources, 12 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 48 of 48, shields fore 15 · port 15 · starboard 15 · aft 15) at the shipped power commit (engines 3 · shields 3 · sensors 2 · cooling 2 · inertia 2 · weapons 7)
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
| safe velocity `v_safe` | 26 su |
| forward Δv / turn | 6 su |
| retro Δv / turn | 3 su |
| port / starboard Δv / turn | 2 / 2 su |
| rotation / turn | 60° |
| pivot `ω` / turn | 60° = 1.047 rad |
| tightest circle `r_min = v_safe/ω` | 24.83 su |
| acceleration distance to `v_safe` | 56.33 su |
| closure from 60 su at 6 su/turn (target stationary) | 4.47 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Breaker Lance | 45 su | 47.12 su | +21.12 | yes |
| Escort Battery | 40 su | 41.89 su | +15.89 | yes |
| Escort Battery | 40 su | 41.89 su | +15.89 | yes |

Kinetic evasion at `v_safe`: a hull crossing the line at 26 su reads as instant 13 → band >12 (-8), medium 26 → band >12 (-8) on incoming fire.

Pass geometry: turnaround 3 turns, separation after the pass 156 su against a mirror opponent (closing at 52 su/turn), re-merge 9 turns.

**Verdict:** holds an Optimal band at `v_safe` = 26 su (3 of 3 guns clear their ceiling; the tightest, Escort Battery, is holdable up to 41.89 su); re-merge costs 9 turns, inside the 40-turn encounter clock, after closing 60 su in 4.47 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile | band at 47.4 su |
| --- | --- | --- | --- | --- | --- |
| Breaker Lance | 6 | 1 | 6 | single shot | extended1 (-1) |
| Escort Battery | 7 | 2 | 14 | 4-round barrage, -2 to hit | extended1 (-1) |
| Escort Battery | 7 | 2 | 14 | 4-round barrage, -2 to hit | extended1 (-1) |
| **total** | — | — | **34** | — | — |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 3 |
| tier regeneration / turn | 8 |
| most-exposed facet | fore — the most-struck facet across the 5 mirror scenarios (60.8%) |
| weight given to that facet | 50 (= min(100, hull cap 50)) |
| `allocateRegeneration` per turn on that facet | 4 |

Ceiling margin: 34 − 4 = **+30** shield damage per turn.

Mirror cross-check (5 mirror scenarios): 2.143 shield damage/turn dealt vs 1.607 shield regeneration/turn repaired → **+0.535**/turn, measured over 1.39 landed attacks/turn at a mean range of 47.4 su; funnel capture 0.868 (86.8% of the damage landed on the sector regeneration was routed to).

The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes 5 hits a turn where the mirror landed 1.39 attacks/turn.

**Verdict:** **out-damages** — sustained fire beats the funnel: +0.535 net shield damage/turn against 1.607 regenerated/turn (measured in the §5 mirrors), so the shields can be collapsed.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Breaker Lance — Breaker Lance | 0° | 210° | -105°…105° | 58.3% | 45 / 90 su | 1.25 / 0.26 |
| Port Battery — Escort Battery | -90° | 240° | 150°…30° | 66.7% | 40 / 80 su | 1 / 0.17 |
| Starboard Battery — Escort Battery | 90° | 240° | -30°…-150° | 66.7% | 40 / 80 su | 1 / 0.17 |

| coverage | value |
| --- | --- |
| union coverage | 100% of the circle (360°) |
| blind arcs | none |
| blind arc total | 0° (0%) |
| blind arcs strike | — |
| damage-weighted coverage | 64.2% |
| own nose (0°) / own aft (180°) | covered / covered |
| worst turns-to-bear (best gun per bearing) | 0 turns |
| mean turns-to-bear (best gun per bearing) | 0 turns |

**Verdict:** 100% of the circle is covered (360° of 360°); nothing is blind; own nose (0°) is covered and own aft (180°) is covered; worst turns-to-bear 1.25 gun-level (0 with the best gun at each bearing).

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | aegis-slot-reactor | reactor / medium | Corvette Reactor |
| Shield | aegis-slot-shield | shield / medium | Corvette Deflector |
| Sensor | aegis-slot-sensor | sensor / medium | Corvette Sensor Array |
| Cooling | aegis-slot-cooling | cooling / medium | Corvette Cooling Array |
| Main Drive | aegis-slot-main-drive | drive / medium | Corvette Main Drive |
| Reverse Drive | aegis-slot-reverse-drive | drive / medium | Corvette Reverse Drive |
| Port Lateral Drive | aegis-slot-port-lateral-drive | drive / medium | Corvette Lateral Drive |
| Starboard Lateral Drive | aegis-slot-starboard-lateral-drive | drive / medium | Corvette Lateral Drive |
| Inertial Anchor | aegis-slot-inertia | inertia / medium | Inertial Anchor Mk II |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Breaker Lance | 0° | fore | Breaker Lance |
| Port Battery | -90° | port | Escort Battery |
| Starboard Battery | 90° | starboard | Escort Battery |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 6 / retro 3 / lateral 2 su, rotation 60°/turn |
| shields | 3 | 8 regeneration/turn |
| sensors | 2 | passive 100 su / strength 11, active 160 su / 0 |
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
| Breaker Lance — Breaker Lance | 3 (overclock 4) | 3 | online |
| Port Battery — Escort Battery | 2 (overclock 3) | 2 | online |
| Starboard Battery — Escort Battery | 2 (overclock 3) | 2 | online |

Every installed gun online needs 7 Weapons Power against 7 committed; the shipped state has 3 of 3 online (Breaker Lance, Escort Battery, Escort Battery).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 9 |
| net Heat per Start | -9 |
| Heat Capacity | 24 |
| vent | 12 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (24 Heat Capacity) would clear in 3 Start(s) of passive cooling alone; Emergency Vent removes at most 12 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 19 of 20 nominal (redline 24, headroom 5); 3 of 3 guns online, and every installed gun online would need 7 of the 7 committed Weapons Power; heat is stable without venting (-9 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `corvette`: the hull has 2 command operators, so the gunner owns Ping/Acquire/Solution and the shots while the pilot flies.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

Refusals (the engine declining an operation the policy attempted; none of them spends a resource or a roll): `acquire:SENSORS_OFFLINE` — battle damage took the Sensor array offline; `acquire:SENSOR_LIVE_CONTACT_REQUIRED` — the track was not a live Contact to acquire; `attack:ILLEGAL_ATTACK_DECLARATION` — a declaration the engine refused — the target was already at 0 hull this turn, or the track/arc was lost mid-turn; `firingSolution:OPERATION_RESOURCE_EXHAUSTED` — the operator's Action pool was already spent; `ping:SENSORS_OFFLINE` — battle damage took the Sensor array offline.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 100% | 7 | 2.5 | 4.73 / 0 | 4.25 / 0 | 0.88 | 2.6 | 0.14 | 60 | 0 | 0 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, attack:ILLEGAL_ATTACK_DECLARATION×55 |
| orbit 15.6 mirror | 40 | 100% | 15 | 6 | 2.16 / 0 | 2.23 / 0 | 0.85 | 1.55 | 0.07 | 45.3 | -7 | 15.57 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, attack:ILLEGAL_ATTACK_DECLARATION×37 |
| brawl mirror | 40 | 100% | 13 | 7 | 2.55 / 0 | 2.74 / 0 | 0.8 | 1.82 | 0.08 | 25.7 | -6.57 | 10.36 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, attack:ILLEGAL_ATTACK_DECLARATION×38 |
| lance hover mirror | 40 | 15% | 11 | 3 | 1.25 / 0 | 1.26 / 0 | 0.93 | 0.56 | 0 | 60 | 0 | 0 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, acquire:SENSOR_LIVE_CONTACT_REQUIRED×2, ping:SENSORS_OFFLINE×1, acquire:SENSORS_OFFLINE×1 |
| lance orbit 15.6 mirror | 40 | 5% | 17.5 | 4.5 | 0.46 / 0 | 0.62 / 0 | 0.88 | 0.42 | 0 | 45.9 | -6.75 | 15.57 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, attack:ILLEGAL_ATTACK_DECLARATION×1 |

**Verdict:** every mirror resolves inside the 40-turn clock — kill rates run 5%–100%, with a median TTK of 7–17.5 turns where a kill lands (best: hover mirror at 100%). What decides it is attrition — 2.143 shield damage/turn against 1.607 regenerated, with the mirrors funnelling 86.8% of their damage into the most-struck fore facet.

report written to tools/balance/aegis-escort.md
