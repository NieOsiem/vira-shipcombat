# Blank Hull — Broadside (blank-broadside) — balance report

- Build source: hull file `world-data/hulls/blank-broadside.js` + components file `world-data/components/medium-components.js` through materializeShipConfig
- Components: 36 supplied component sources, 0 installed
- Encounter state: materializeShipConfig + createInitialState — full health (hull 46 of 46, shields ) at the shipped power commit (engines 0 · shields 0 · sensors 0 · cooling 0 · inertia 0 · weapons 0)
- Thrust package: `shipped` (component base thrust)
- Mirror duel: 40 runs per scenario, encounter clock 40 turns, opening range 60 su
- Engine: drive/pivot capabilities, range band + firing arc + relative motion + struck sector, shield regeneration apportionment, power state and maintained Heat from the module's rules; the mirror section is the duel engine itself (tools/sim/duel.mjs)

## 1. Dogfight rule

Nose-fixed guns make a dogfight a geometry problem: a hull circling at speed `v` with pivot
authority `ω` flies a circle of radius `r = v/ω`, so each weapon's Optimal Range sets a hard speed
ceiling `v_ceiling = ω·optimal` — the fastest the hull may fly while still holding that gun's
Optimal band. Above it the hull must fly straighter than its own gun wants or accept the extended
band. `ω` is converted to radians here (this hull: 0°/turn = 0 rad/turn): the
pivot ceiling is quoted in degrees, the circle geometry is not. The second half is the merge: after
a pass the hull needs rotation to come back around.

| quantity at the shipped state | value |
| --- | --- |
| safe velocity `v_safe` | 24 su |
| forward Δv / turn | 0 su |
| retro Δv / turn | 0 su |
| port / starboard Δv / turn | 0 / 0 su |
| rotation / turn | 0° |
| pivot `ω` / turn | 0° = 0 rad |
| tightest circle `r_min = v_safe/ω` | — (no pivot authority) |
| acceleration distance to `v_safe` | — (no forward thrust) |
| closure from 60 su at 0 su/turn (target stationary) | — (no forward thrust) |

| weapon | optimal | fastest holdable `v_ceiling = ω·optimal` | margin at `v_safe` | holds at `v_safe` |
| --- | --- | --- | --- | --- |

Pass geometry: no rotation authority, so a parallel pass cannot come back around — only the pivot (0°/turn) can turn the nose.

**Verdict:** carries no weapons, so the Optimal band is moot; it has no rotation authority to re-merge with.

## 2. Anti-regeneration check

Decision 91/92's attrition maths needs a shield to test. This hull installs none: there is no
regeneration budget, no facet to route it into, and no shield layer for sustained fire to out-
damage. Every hit resolves against armor and hull instead.

**Verdict:** not applicable — a shieldless hull has no regeneration funnel.

## 3. Bearing coverage

Static geometry from the hull's mounts. Own-frame bearings: `0°` is the hull's own nose and `+`
runs to starboard; a window is `orientation ± arc/2` by rules §9.2, and `isWithinFiringArc` (the
engine's own predicate) decides the sampled bearings below. Dark arcs that cross the stern are
printed as one 0…360 range (`180°` dead astern).

| mount | orientation | arc | covered window | circle | reaches to (optimal / max) | turns-to-bear worst / mean |
| --- | --- | --- | --- | --- | --- | --- |

| coverage | value |
| --- | --- |
| union coverage | 0% of the circle (0°) |
| blind arcs | 180°…540° |
| blind arc total | 360° (100%) |
| blind arcs strike | aft, port, fore, starboard |
| damage-weighted coverage | — |
| own nose (0°) / own aft (180°) | blind / blind |
| worst turns-to-bear (best gun per bearing) | — |
| mean turns-to-bear (best gun per bearing) | — |

No rotation authority at the shipped state: a hull with no rotation must pivot instead (`ω` = 0°/turn), so turns-to-bear have no value.

**Verdict:** no mounted weapon, so the hull has no bearing coverage at all; no rotation authority, so bearing is bought with the pivot instead of turns.

## 4. Fit & power

**Mounts**

| system slot | slot id | class / size | installed |
| --- | --- | --- | --- |
| Reactor | blank-broadside-slot-reactor | reactor / medium | empty |
| Shield | blank-broadside-slot-shield | shield / medium | empty |
| Sensor | blank-broadside-slot-sensor | sensor / medium | empty |
| Cooling | blank-broadside-slot-cooling | cooling / medium | empty |
| Main Drive | blank-broadside-slot-main-drive | drive / medium | empty |
| Reverse Drive | blank-broadside-slot-reverse-drive | drive / medium | empty |
| Port Lateral Drive | blank-broadside-slot-port-lateral-drive | drive / medium | empty |
| Starboard Lateral Drive | blank-broadside-slot-starboard-lateral-drive | drive / medium | empty |
| Inertial Anchor | blank-broadside-slot-inertia | inertia / medium | empty |

| hardpoint | orientation | regions | weapon |
| --- | --- | --- | --- |
| Port Broadside | -90° | port | empty |
| Starboard Broadside | 90° | starboard | empty |
| Fore (light) | 0° | fore | empty |

**Power**

| system | committed | tier effect at that Value |
| --- | --- | --- |
| engines | 0 | ×0 — main 0 / retro 0 / lateral 0 su, rotation 0°/turn |
| shields | 0 | 0 regeneration/turn |
| sensors | 0 | offline at this Power |
| cooling | 0 | 0 Heat cooled per Start |
| inertia | 0 | 0° pivot/turn |
| weapons | 0 | 0 reserved for the online guns |

| power state | value |
| --- | --- |
| committed / nominal / redline | 0 / 0 / 0 |
| unused (to reactor maximum) | 0 |
| redlining | no |
| legal commit | yes |
| emission band | dark (+4 signature) |

**Weapons**

| weapon | powerRating (online) | reserved | shipped status |
| --- | --- | --- | --- |

Every installed gun online needs 0 Weapons Power against 0 committed; the shipped state has 0 of 0 online (none).

**Heat**

| heat per Start | value |
| --- | --- |
| maintained Overclock Heat | 0 |
| heat sources | none |
| passive cooling at the committed Cooling Power | 0 |
| net Heat per Start | 0 |
| Heat Capacity | 24 |
| vent | — Heat, —-Start cooldown |

Heat figures assume healthy hardware (fault multipliers are 1). At this commit a full Heat bar (24 Heat Capacity) would clear in — Start(s) of passive cooling alone. Emergency Vent removes nothing at this fit.

**Verdict:** power commit is legal — 0 of 0 nominal (redline 0, headroom 0); 0 of 0 guns online, and every installed gun online would need 0 of the 0 committed Weapons Power; heat is stable without venting (0 per Start).

## 5. Mirror duel

5 mirror scenario(s), 40 runs each, encounter clock 40 turns. Damage is per turn: shield / hull.

Turn doctrine `corvette`: the hull has 2 command operators, so the gunner owns Ping/Acquire/Solution and the shots while the pilot flies.

`hangfire` counts **bearing, online, ready guns that could not fire because the hull's Actions ran
out** — the price a one-console hull pays for its third job, whether that is the track it had to
re-establish or a shot it had to choose instead. A rejected operation is not hangfire; this is
fire that was never asked for.

Refusals (the engine declining an operation the policy attempted; none of them spends a resource or a roll): `acquire:SENSORS_OFFLINE` — battle damage took the Sensor array offline; `armEvasion:EVASION_ENGINES_UNPOWERED` — see the engine's rule code; `ping:SENSORS_OFFLINE` — battle damage took the Sensor array offline.

| mirror scenario | runs | kill rate | med TTK | med 1st collapse | shield/hull dmg per turn A→B | B→A | funnel | attacks/turn | hangfire/turn | mean range | motion mod | mean speed | rams | rejects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 0 | — | — | 0 | 0 | armEvasion:EVASION_ENGINES_UNPOWERED×3200, ping:SENSORS_OFFLINE×3200, acquire:SENSORS_OFFLINE×3200 |
| orbit 14.4 mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 0 | — | — | 0 | 0 | armEvasion:EVASION_ENGINES_UNPOWERED×3200, ping:SENSORS_OFFLINE×3200, acquire:SENSORS_OFFLINE×3200 |
| brawl mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 0 | — | — | 0 | 0 | armEvasion:EVASION_ENGINES_UNPOWERED×3200, ping:SENSORS_OFFLINE×3200, acquire:SENSORS_OFFLINE×3200 |
| alt hover mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 0 | — | — | 0 | 0 | armEvasion:EVASION_ENGINES_UNPOWERED×3200, ping:SENSORS_OFFLINE×3200, acquire:SENSORS_OFFLINE×3200 |
| alt orbit 14.4 mirror | 40 | 0% | — | — | 0 / 0 | 0 / 0 | pool | 0 | 0 | — | — | 0 | 0 | armEvasion:EVASION_ENGINES_UNPOWERED×3200, ping:SENSORS_OFFLINE×3200, acquire:SENSORS_OFFLINE×3200 |

**Verdict:** no mirror resolves inside the 40-turn clock: an empty clock — 5 of 5 mirrors never land an attack, at 0 landed attacks/turn.

report written to tools/balance/blank-broadside.md
