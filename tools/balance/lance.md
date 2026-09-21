# Lance (lance) — balance report

- Build source: hull file `world-data/hulls/lance.js` + components file `world-data/components/small-components.js` through materializeShipConfig
- Components: 24 supplied component sources, 10 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 22 of 22, shields fore 12 · port 12 · starboard 12 · aft 12) at the shipped power commit (engines 3 · shields 2 · sensors 1 · cooling 2 · inertia 2 · weapons 2)
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
| safe velocity `v_safe` | 32 su |
| forward Δv / turn | 7 su |
| retro Δv / turn | 4 su |
| port / starboard Δv / turn | 3 / 3 su |
| rotation / turn | 90° |
| pivot `ω` / turn | 60° = 1.047 rad |
| tightest circle `r_min = v_safe/ω` | 30.56 su |
| acceleration distance to `v_safe` | 73.14 su |
| closure from 60 su at 7 su/turn (target stationary) | 4.14 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Light Railgun | 60 su | 62.83 su | +30.83 | yes |

Kinetic evasion at `v_safe`: a hull crossing the line at 32 su reads as fast 24 → band >12 (-8) on incoming fire.

Pass geometry: turnaround 2 turns, separation after the pass 128 su against a mirror opponent (closing at 64 su/turn), re-merge 6 turns.

**Verdict:** holds an Optimal band at `v_safe` = 32 su (1 of 1 guns clear their ceiling; the tightest, Light Railgun, is holdable up to 62.83 su); re-merge costs 6 turns, inside the 40-turn encounter clock, after closing 60 su in 4.14 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile | band at 52.7 su |
| --- | --- | --- | --- | --- | --- |
| Light Railgun | 5 | 1 | 5 | single shot | optimal (+2) |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 2 |
| tier regeneration / turn | 4 |
| most-exposed facet | fore — the most-struck facet across the 5 mirror scenarios (97%) |
| weight given to that facet | 100 (= min(100, hull cap 100)) |
| `allocateRegeneration` per turn on that facet | 4 |

Ceiling margin: 5 − 4 = **+1** shield damage per turn.

Mirror cross-check (5 mirror scenarios): 0.611 shield damage/turn dealt vs 0.209 shield regeneration/turn repaired → **+0.402**/turn, measured over 0.47 landed attacks/turn at a mean range of 52.7 su; funnel capture 0.018 (1.8% of the damage landed on the sector regeneration was routed to).

The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes 1 hits a turn where the mirror landed 0.47 attacks/turn.

**Verdict:** **out-damages** — sustained fire beats the funnel: +0.402 net shield damage/turn against 0.209 regenerated/turn (measured in the §5 mirrors), so the shields can be collapsed.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Prow — Light Railgun | 0° | 90° | -45°…45° | 25% | 60 / 120 su | 1.5 / 0.56 |

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
| Reactor | lance-slot-reactor | reactor / small | Long-Base Reactor |
| Shield | lance-slot-shield | shield / small | Vector Deflector |
| Sensor | lance-slot-sensor | sensor / small | Long-Base Sensor Array |
| Cooling | lance-slot-cooling | cooling / small | Deep-Core Cooling Array |
| Main Drive | lance-slot-main-drive | drive / small | Vector Main Drive |
| Reverse Drive | lance-slot-reverse-drive | drive / small | Light Reverse Drive |
| Port Lateral Drive | lance-slot-port-lateral-drive | drive / small | Light Lateral Drive |
| Starboard Lateral Drive | lance-slot-starboard-lateral-drive | drive / small | Light Lateral Drive |
| Inertial Anchor | lance-slot-inertia | inertia / small | Inertial Anchor Mk II |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Prow | 0° | fore | Light Railgun |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 7 / retro 4 / lateral 3 su, rotation 90°/turn |
| shields | 2 | 4 regeneration/turn |
| sensors | 1 | passive 80 su / strength 8, active 120 su / -2 |
| cooling | 2 | 6 Heat cooled per Start |
| inertia | 2 | 60° pivot/turn |
| weapons | 2 | 2 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 12 / 14 / 16 |
| unused (to reactor maximum) | 4 |
| redlining | no |
| legal commit | yes |
| emission band | normal (0 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |
| Prow — Light Railgun | 2 (overclock 3) | 2 | online |

Every installed gun online needs 2 Weapons Power against 2 committed; the shipped state has 1 of 1 online (Light Railgun).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 6 |
| net Heat per Start | -6 |
| Heat Capacity | 12 |
| vent | 10 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (12 Heat Capacity) would clear in 2 Start(s) of passive cooling alone; Emergency Vent removes at most 10 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 12 of 14 nominal (redline 16, headroom 4); 1 of 1 guns online, and every installed gun online would need 2 of the 2 committed Weapons Power; heat is stable without venting (-6 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `fighter`: the hull has 1 command operator, so one console flies, senses and shoots — it manoeuvres first, spends its sensing Actions only on what advances its track (Ping, then Acquire), fires every bearing gun, and only a spare Action buys a Firing Solution.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

Refusals (the engine declining an operation the policy attempted; none of them spends a resource or a roll): `ping:SENSORS_OFFLINE` — battle damage took the Sensor array offline.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 100% | 8.5 | 5 | 1.69 / 0 | 2.08 / 0 | 0 | 0.83 | 0.06 | 60 | 0 | 0 | 0 | none |
| orbit 19.2 mirror | 40 | 78% | 29 | 21.5 | 0.34 / 0 | 0.5 / 0 | 0.01 | 0.76 | 0.01 | 64.3 | -7.83 | 19.16 | 0 | ping:SENSORS_OFFLINE×16 |
| brawl mirror | 40 | 100% | 18 | 12 | 0.76 / 0 | 0.89 / 0 | 0.05 | 0.74 | 0.01 | 33.8 | -7.71 | 12.75 | 0 | none |
| railgun hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | — | 0 | 0 | — | — | 0 | 0 | none |
| railgun orbit 19.2 mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | — | 0 | 0 | — | — | 19.16 | 0 | none |

**Verdict:** 3 of 5 mirrors resolve inside the 40-turn clock — kill rates run 0%–100%, with a median TTK of 8.5–29 turns where a kill lands (best: hover mirror at 100%). What decides it is attrition — 0.611 shield damage/turn against 0.209 regenerated, with the mirrors funnelling 1.8% of their damage into the most-struck fore facet.

report written to tools/balance/lance.md
