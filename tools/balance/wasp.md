# Wasp (wasp) — balance report

- Build source: hull file `world-data/hulls/wasp.js` + components file `world-data/components/small-components.js` through materializeShipConfig
- Components: 24 supplied component sources, 10 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 28 of 28, shields fore 9 · port 9 · starboard 9 · aft 9) at the shipped power commit (engines 3 · shields 2 · sensors 1 · cooling 2 · inertia 1 · weapons 1)
- Thrust package: `shipped` (component base thrust)
- Mirror duel: 40 runs per scenario, encounter clock 40 turns, opening range 60 su
- Engine: drive/pivot capabilities, range band + firing arc + relative motion + struck sector, shield regeneration apportionment, power state and maintained Heat from the module's rules; the mirror section is the duel engine itself (tools/sim/duel.mjs)

## 1. Dogfight rule

Nose-fixed guns make a dogfight a geometry problem: a hull circling at speed `v` with pivot
authority `ω` flies a circle of radius `r = v/ω`, so each weapon's Optimal Range sets a hard speed
ceiling `v_ceiling = ω·optimal` — the fastest the hull may fly while still holding that gun's
Optimal band. Above it the hull must fly straighter than its own gun wants or accept the extended
band. `ω` is converted to radians here (this hull: 45°/turn = 0.785 rad/turn): the
pivot ceiling is quoted in degrees, the circle geometry is not. The second half is the merge: after
a pass the hull needs rotation to come back around.

| quantity at the shipped state | value |
| --- | --- |
| safe velocity `v_safe` | 30 su |
| forward Δv / turn | 6 su |
| retro Δv / turn | 4 su |
| port / starboard Δv / turn | 2 / 2 su |
| rotation / turn | 60° |
| pivot `ω` / turn | 45° = 0.785 rad |
| tightest circle `r_min = v_safe/ω` | 38.2 su |
| acceleration distance to `v_safe` | 75 su |
| closure from 60 su at 6 su/turn (target stationary) | 4.47 turns |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |
| Storm Barrage Gun | 25 su | 19.63 su | -10.37 | no |

Kinetic evasion at `v_safe`: a hull crossing the line at 30 su reads as medium 30 → band >12 (-8) on incoming fire.

Pass geometry: turnaround 3 turns, separation after the pass 180 su against a mirror opponent (closing at 60 su/turn), re-merge 9 turns.

**Verdict:** cannot hold any Optimal band at `v_safe` = 30 su — the widest gun (Storm Barrage Gun) is holdable only below 19.63 su, so the hull must trade away speed or its Optimal band; re-merge costs 9 turns, inside the 40-turn encounter clock, after closing 60 su in 4.47 turns.

## 2. Anti-regeneration check

Decision 91/92's attrition maths: can sustained fire out-damage the regeneration funnel? The
`shield dmg/turn` column is an **unattainable ceiling** — every online gun landing every turn, at
Optimal Range with no attack, motion or Evasion penalty, all of it on one facet. It bounds the
question but it does not answer it, so the verdict below is driven by the §5 mirror measurement
whenever a duel ran and only falls back to the ceiling when none did.

| attacker weapon (online) | shield dmg/hit | hits/turn | shield dmg/turn | profile | band at 46.7 su |
| --- | --- | --- | --- | --- | --- |
| Storm Barrage Gun | 5 | 2 | 10 | 4-round barrage, -2 to hit | extended2 (-2) |

| regeneration at the shipped shield Power | value |
| --- | --- |
| shield Power committed | 2 |
| tier regeneration / turn | 3 |
| most-exposed facet | fore — the most-struck facet across the 5 mirror scenarios (68.6%) |
| weight given to that facet | 100 (= min(100, hull cap 100)) |
| `allocateRegeneration` per turn on that facet | 3 |

Ceiling margin: 10 − 3 = **+7** shield damage per turn.

Mirror cross-check (5 mirror scenarios): 0.383 shield damage/turn dealt vs 0.289 shield regeneration/turn repaired → **+0.094**/turn, measured over 0.55 landed attacks/turn at a mean range of 46.7 su; funnel capture 0 (0% of the damage landed on the sector regeneration was routed to).

The gap between the two figures is the attack problem, not the shield maths: the ceiling assumes 2 hits a turn where the mirror landed 0.55 attacks/turn.

**Verdict:** **out-damages** — sustained fire beats the funnel: +0.094 net shield damage/turn against 0.289 regenerated/turn (measured in the §5 mirrors), so the shields can be collapsed.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |
| Prow — Storm Barrage Gun | 0° | 270° | -135°…135° | 75% | 25 / 75 su | 0.75 / 0.09 |

| coverage | value |
| --- | --- |
| union coverage | 75% of the circle (270°) |
| blind arcs | 135°…225° |
| blind arc total | 90° (25%) |
| blind arcs strike | aft |
| damage-weighted coverage | 75% |
| own nose (0°) / own aft (180°) | covered / blind |
| worst turns-to-bear (best gun per bearing) | 0.75 turns |
| mean turns-to-bear (best gun per bearing) | 0.09 turns |

**Verdict:** 75% of the circle is covered (270° of 360°); the blind arc is 135°…225° (90°), which exposes the aft armor to any threat sitting there; own nose (0°) is covered and own aft (180°) is blind; worst turns-to-bear 0.75 gun-level (0.75 with the best gun at each bearing).

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | wasp-slot-reactor | reactor / small | Light Reactor |
| Shield | wasp-slot-shield | shield / small | Segment Deflector |
| Sensor | wasp-slot-sensor | sensor / small | Long-Base Sensor Array |
| Cooling | wasp-slot-cooling | cooling / small | Compact Cooling Array |
| Main Drive | wasp-slot-main-drive | drive / small | Cutter Main Drive |
| Reverse Drive | wasp-slot-reverse-drive | drive / small | Light Reverse Drive |
| Port Lateral Drive | wasp-slot-port-lateral-drive | drive / small | Cutter Lateral Drive |
| Starboard Lateral Drive | wasp-slot-starboard-lateral-drive | drive / small | Cutter Lateral Drive |
| Inertial Anchor | wasp-slot-inertia | inertia / small | Inertial Anchor Mk I |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Prow | 0° | fore | Storm Barrage Gun |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 3 | ×1 — main 6 / retro 4 / lateral 2 su, rotation 60°/turn |
| shields | 2 | 3 regeneration/turn |
| sensors | 1 | passive 80 su / strength 8, active 120 su / -2 |
| cooling | 2 | 4 Heat cooled per Start |
| inertia | 1 | 45° pivot/turn |
| weapons | 1 | 1 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 10 / 11 / 13 |
| unused (to reactor maximum) | 3 |
| redlining | no |
| legal commit | yes |
| emission band | high (-2 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |
| Prow — Storm Barrage Gun | 1 (overclock 2) | 1 | online |

Every installed gun online needs 1 Weapons Power against 1 committed; the shipped state has 1 of 1 online (Storm Barrage Gun).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 4 |
| net Heat per Start | -4 |
| Heat Capacity | 14 |
| vent | 8 Heat, 2-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (14 Heat Capacity) would clear in 4 Start(s) of passive cooling alone; Emergency Vent removes at most 8 Heat a use, so a full bar costs 2 vents spaced 2 Start(s) apart.

**Verdict:** power commit is legal — 10 of 11 nominal (redline 13, headroom 3); 1 of 1 guns online, and every installed gun online would need 1 of the 1 committed Weapons Power; heat is stable without venting (-4 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `fighter`: the hull has 1 command operator, so one console flies, senses and shoots — it manoeuvres first, spends its sensing Actions only on what advances its track (Ping, then Acquire), fires every bearing gun, and only a spare Action buys a Firing Solution.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 55% | 34.5 | 4 | 0.98 / 0 | 1.1 / 0 | 0 | 0.94 | 0.01 | 60 | 0 | 0 | 0 | none |
| orbit 18 mirror | 40 | 0% | — | 20.5 | 0.33 / 0 | 0.3 / 0 | 0 | 0.88 | 0 | 47.9 | -7.89 | 17.8 | 0 | none |
| brawl mirror | 40 | 0% | — | 12 | 0.39 / 0 | 0.74 / 0 | 0 | 0.91 | 0 | 32.1 | -7.85 | 11.75 | 0 | none |
| gun hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | — | 0 | 0 | — | — | 0 | 0 | none |
| gun orbit 18 mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | — | 0 | 0 | — | — | 17.8 | 0 | none |

**Verdict:** 1 of 5 mirrors resolve inside the 40-turn clock — kill rates run 0%–55%, with a median TTK of 34.5 turns where a kill lands (best: hover mirror at 55%). What decides it is attrition — 0.383 shield damage/turn against 0.289 regenerated, with the mirrors funnelling 0% of their damage into the most-struck fore facet.

report written to tools/balance/wasp.md
