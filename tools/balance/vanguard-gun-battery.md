# Vanguard Gun Battery (vanguard-gun-battery) — balance report

- Build source: hull file `world-data/hulls/vanguard.js` + components file `world-data/components/medium-components.js` through materializeShipConfig
- Components: 36 supplied component sources, 14 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 60 of 60, shields fore 15 · port 15 · starboard 15 · aft 15) at the shipped power commit (engines 3 · shields 3 · sensors 2 · cooling 3 · inertia 2 · weapons 10)
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
| safe velocity `v_safe` | 18 su |
| forward Δv / turn | 6 su |
| retro Δv / turn | 3 su |
| port / starboard Δv / turn | 2 / 2 su |
| rotation / turn | 60° |
| pivot `ω` / turn | 60° = 1.047 rad |
| tightest circle `r_min = v_safe/ω` | 17.19 su |
| acceleration distance to `v_safe` | 27 su |
| closure from 60 su at 6 su/turn (target stationary) | 4.83 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Broadside Macrocannon | 40 su | 41.89 su | +23.89 | yes |
| Broadside Macrocannon | 40 su | 41.89 su | +23.89 | yes |
| Broadside Macrocannon | 40 su | 41.89 su | +23.89 | yes |
| Broadside Macrocannon | 40 su | 41.89 su | +23.89 | yes |
| Corvette Turret | 45 su | 47.12 su | +29.12 | yes |

Kinetic evasion at `v_safe`: a hull crossing the line at 18 su reads as medium 18 → band >12 (-8), fast 13.5 → band >12 (-8) on incoming fire.

Pass geometry: turnaround 3 turns, separation after the pass 108 su against a mirror opponent (closing at 36 su/turn), re-merge 9 turns.

**Verdict:** holds an Optimal band at `v_safe` = 18 su (5 of 5 guns clear their ceiling; the tightest, Broadside Macrocannon, is holdable up to 41.89 su); re-merge costs 9 turns, inside the 40-turn encounter clock, after closing 60 su in 4.83 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile | band at 46.1 su |
| --- | --- | --- | --- | --- | --- |
| Broadside Macrocannon | 7 | 2 | 14 | 4-round barrage, -2 to hit | extended1 (-1) |
| Broadside Macrocannon | 7 | 2 | 14 | 4-round barrage, -2 to hit | extended1 (-1) |
| Broadside Macrocannon | 7 | 2 | 14 | 4-round barrage, -2 to hit | extended1 (-1) |
| Broadside Macrocannon | 7 | 2 | 14 | 4-round barrage, -2 to hit | extended1 (-1) |
| Corvette Turret | 5 | 1 | 5 | single shot | extended1 (-1) |
| **total** | — | — | **61** | — | — |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 3 |
| tier regeneration / turn | 8 |
| most-exposed facet | fore — the most-struck facet across the 5 mirror scenarios (94.9%) |
| weight given to that facet | 50 (= min(100, hull cap 50)) |
| `allocateRegeneration` per turn on that facet | 4 |

Ceiling margin: 61 − 4 = **+57** shield damage per turn.

Mirror cross-check (5 mirror scenarios): 3.192 shield damage/turn dealt vs 3.03 shield regeneration/turn repaired → **+0.161**/turn, measured over 1.51 landed attacks/turn at a mean range of 46.1 su; funnel capture 0.96 (96% of the damage landed on the sector regeneration was routed to).

The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes 9 hits a turn where the mirror landed 1.51 attacks/turn.

**Verdict:** **out-damages** — sustained fire beats the funnel: +0.161 net shield damage/turn against 3.03 regenerated/turn (measured in the §5 mirrors), so the shields can be collapsed.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Port Battery (Fore) — Broadside Macrocannon | -60° | 165° | -142.5°…22.5° | 45.8% | 40 / 80 su | 1.63 / 0.44 |
| Port Battery (Aft) — Broadside Macrocannon | -80° | 165° | -162.5°…2.5° | 45.8% | 40 / 80 su | 1.63 / 0.44 |
| Starboard Battery (Fore) — Broadside Macrocannon | 60° | 165° | -22.5°…142.5° | 45.8% | 40 / 80 su | 1.63 / 0.44 |
| Starboard Battery (Aft) — Broadside Macrocannon | 80° | 165° | -2.5°…162.5° | 45.8% | 40 / 80 su | 1.63 / 0.44 |
| Fore Turret — Corvette Turret | 0° | 120° | -60°…60° | 33.3% | 45 / 90 su | 2 / 0.67 |

| coverage | value |
| --- | --- |
| union coverage | 90.3% of the circle (325°) |
| blind arcs | 162.5°…197.5° |
| blind arc total | 35° (9.7%) |
| blind arcs strike | aft |
| damage-weighted coverage | 43.9% |
| own nose (0°) / own aft (180°) | covered / blind |
| worst turns-to-bear (best gun per bearing) | 0.29 turns |
| mean turns-to-bear (best gun per bearing) | 0.01 turns |

**Verdict:** 90.3% of the circle is covered (325° of 360°); the blind arc is 162.5°…197.5° (35°), which exposes the aft armor to any threat sitting there; own nose (0°) is covered and own aft (180°) is blind; worst turns-to-bear 2 gun-level (0.29 with the best gun at each bearing).

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | vanguard-slot-reactor | reactor / medium | Battery Reactor |
| Shield | vanguard-slot-shield | shield / medium | Corvette Deflector |
| Sensor | vanguard-slot-sensor | sensor / medium | Corvette Sensor Array |
| Cooling | vanguard-slot-cooling | cooling / medium | Battery Cooling Array |
| Main Drive | vanguard-slot-main-drive | drive / medium | Corvette Main Drive |
| Reverse Drive | vanguard-slot-reverse-drive | drive / medium | Corvette Reverse Drive |
| Port Lateral Drive | vanguard-slot-port-lateral-drive | drive / medium | Corvette Lateral Drive |
| Starboard Lateral Drive | vanguard-slot-starboard-lateral-drive | drive / medium | Corvette Lateral Drive |
| Inertial Anchor | vanguard-slot-inertia | inertia / medium | Inertial Anchor Mk II |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Port Battery (Fore) | -60° | port | Broadside Macrocannon |
| Port Battery (Aft) | -80° | port | Broadside Macrocannon |
| Starboard Battery (Fore) | 60° | starboard | Broadside Macrocannon |
| Starboard Battery (Aft) | 80° | starboard | Broadside Macrocannon |
| Fore Turret | 0° | fore | Corvette Turret |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 6 / retro 3 / lateral 2 su, rotation 60°/turn |
| shields | 3 | 8 regeneration/turn |
| sensors | 2 | passive 100 su / strength 11, active 160 su / 0 |
| cooling | 3 | 16 Heat cooled per Start |
| inertia | 2 | 60° pivot/turn |
| weapons | 10 | 10 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 23 / 26 / 32 |
| unused (to reactor maximum) | 9 |
| redlining | no |
| legal commit | yes |
| emission band | normal (0 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |
| Port Battery (Fore) — Broadside Macrocannon | 2 (overclock 3) | 2 | online |
| Port Battery (Aft) — Broadside Macrocannon | 2 (overclock 3) | 2 | online |
| Starboard Battery (Fore) — Broadside Macrocannon | 2 (overclock 3) | 2 | online |
| Starboard Battery (Aft) — Broadside Macrocannon | 2 (overclock 3) | 2 | online |
| Fore Turret — Corvette Turret | 2 (overclock 3) | 2 | online |

Every installed gun online needs 10 Weapons Power against 10 committed; the shipped state has 5 of 5 online (Broadside Macrocannon, Broadside Macrocannon, Broadside Macrocannon, Broadside Macrocannon, Corvette Turret).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 16 |
| net Heat per Start | -16 |
| Heat Capacity | 34 |
| vent | 18 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (34 Heat Capacity) would clear in 3 Start(s) of passive cooling alone; Emergency Vent removes at most 18 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 23 of 26 nominal (redline 32, headroom 9); 5 of 5 guns online, and every installed gun online would need 10 of the 10 committed Weapons Power; heat is stable without venting (-16 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `corvette`: the hull has 2 command operators, so the gunner owns Ping/Acquire/Solution and the shots while the pilot flies.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

Refusals (the engine declining an operation the policy attempted; none of them spends a resource or a roll): `acquire:SENSORS_OFFLINE` — battle damage took the Sensor array offline; `acquire:SENSOR_LIVE_CONTACT_REQUIRED` — the track was not a live Contact to acquire; `acquire:SENSOR_TARGET_OUT_OF_RANGE` — the target left Active Range between the Ping and the Acquire; `armEvasion:EVASION_HARDWARE_UNAVAILABLE` — battle damage disabled the Evasion-capable hardware, or Engines Power fell to 0; `attack:ILLEGAL_ATTACK_DECLARATION` — a declaration the engine refused — the target was already at 0 hull this turn, or the track/arc was lost mid-turn; `firingSolution:OPERATION_RESOURCE_EXHAUSTED` — the operator's Action pool was already spent; `ping:SENSORS_OFFLINE` — battle damage took the Sensor array offline.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 30% | 14 | 2 | 3.79 / 0 | 3.8 / 0 | 0.97 | 1.82 | 0.64 | 60 | 0 | 0 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×81, acquire:SENSOR_LIVE_CONTACT_REQUIRED×27, acquire:SENSOR_TARGET_OUT_OF_RANGE×1, attack:ILLEGAL_ATTACK_DECLARATION×8, armEvasion:EVASION_HARDWARE_UNAVAILABLE×2, ping:SENSORS_OFFLINE×1, acquire:SENSORS_OFFLINE×1 |
| orbit 10.8 mirror | 40 | 5% | 14 | 2 | 2.56 / 0 | 2.73 / 0 | 0.95 | 1.37 | 0.18 | 43.1 | -7.56 | 10.79 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, acquire:SENSOR_LIVE_CONTACT_REQUIRED×25, attack:ILLEGAL_ATTACK_DECLARATION×5, ping:SENSORS_OFFLINE×2, acquire:SENSORS_OFFLINE×2 |
| brawl mirror | 40 | 13% | 14 | 4 | 3.23 / 0 | 3.18 / 0 | 0.94 | 1.46 | 0.21 | 24.2 | -6.71 | 7.06 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, acquire:SENSOR_LIVE_CONTACT_REQUIRED×25, attack:ILLEGAL_ATTACK_DECLARATION×3, armEvasion:EVASION_HARDWARE_UNAVAILABLE×2, ping:SENSORS_OFFLINE×1, acquire:SENSORS_OFFLINE×1 |
| macrocannon hover mirror | 40 | 17% | 12 | 2 | 3.73 / 0 | 3.74 / 0 | 0.98 | 1.54 | 0.29 | 60 | 0 | 0 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×81, acquire:SENSOR_LIVE_CONTACT_REQUIRED×27, attack:ILLEGAL_ATTACK_DECLARATION×3, ping:SENSORS_OFFLINE×1, acquire:SENSORS_OFFLINE×1, armEvasion:EVASION_HARDWARE_UNAVAILABLE×1 |
| macrocannon orbit 10.8 mirror | 40 | 10% | 15.5 | 2 | 2.63 / 0 | 2.74 / 0 | 0.96 | 1.34 | 0.02 | 43 | -7.62 | 10.79 | 0 | firingSolution:OPERATION_RESOURCE_EXHAUSTED×80, acquire:SENSOR_LIVE_CONTACT_REQUIRED×25, attack:ILLEGAL_ATTACK_DECLARATION×4, ping:SENSORS_OFFLINE×2, acquire:SENSORS_OFFLINE×2, armEvasion:EVASION_HARDWARE_UNAVAILABLE×4 |

**Verdict:** every mirror resolves inside the 40-turn clock — kill rates run 5%–30%, with a median TTK of 12–15.5 turns where a kill lands (best: hover mirror at 30%). What decides it is attrition — 3.192 shield damage/turn against 3.03 regenerated, with the mirrors funnelling 96% of their damage into the most-struck fore facet. 1 of 5 mirrors are Action-starved — hover mirror hung 0.64 guns/turn each.

report written to tools/balance/vanguard-gun-battery.md
