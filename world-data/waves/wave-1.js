/**
 * Wave 1 of the world-only ship catalogue: mid-tier hulls a crew can buy and build into.
 *
 * Nothing here is shipped with the module. These hull configs are deliberately absent from
 * `scripts/data/reference-builds.js`, so the module treats them as **custom hulls**: a fresh copy
 * installs no components by itself and the crew fits it out from the parts catalogue.
 *
 * Consumed by `tools/world/install-catalogue.js`, which validates every entry and emits a pasteable
 * installer script for the GM client.
 */
import { SMALL_COMPONENT_SOURCES } from "../components/small-components.js";
import { MEDIUM_COMPONENT_SOURCES } from "../components/medium-components.js";

import { LANCE_HULL_CONFIG, LANCE_DEFAULT_COMPONENT_SOURCES } from "../hulls/lance.js";
import { WASP_HULL_CONFIG, WASP_DEFAULT_COMPONENT_SOURCES } from "../hulls/wasp.js";
import { BALLISTA_HULL_CONFIG, BALLISTA_DEFAULT_COMPONENT_SOURCES } from "../hulls/ballista.js";
import { AEGIS_HULL_CONFIG, AEGIS_DEFAULT_COMPONENT_SOURCES } from "../hulls/aegis.js";
import { VANGUARD_HULL_CONFIG, VANGUARD_DEFAULT_COMPONENT_SOURCES } from "../hulls/vanguard.js";
import { BLANK_BALANCED_HULL_CONFIG, BLANK_BALANCED_DEFAULT_COMPONENT_SOURCES } from "../hulls/blank-balanced.js";
import { BLANK_FAST_HULL_CONFIG, BLANK_FAST_DEFAULT_COMPONENT_SOURCES } from "../hulls/blank-fast.js";
import { BLANK_HEAVY_HULL_CONFIG, BLANK_HEAVY_DEFAULT_COMPONENT_SOURCES } from "../hulls/blank-heavy.js";
import { BLANK_BROADSIDE_HULL_CONFIG, BLANK_BROADSIDE_DEFAULT_COMPONENT_SOURCES } from "../hulls/blank-broadside.js";
import { BLANK_TRADER_HULL_CONFIG, BLANK_TRADER_DEFAULT_COMPONENT_SOURCES } from "../hulls/blank-trader.js";

/** Every component source the wave can install, de-duplicated by id. */
export const WAVE_1_COMPONENT_SOURCES = Object.freeze(
  [...new Map(
    [...SMALL_COMPONENT_SOURCES, ...MEDIUM_COMPONENT_SOURCES].map((source) => [source._id, source]),
  ).values()],
);

/** @typedef {{hull: object, sources: object[], role: "ready"|"blank", intent: string}} WaveHull */

/** @type {WaveHull[]} */
export const WAVE_1_HULLS = Object.freeze([
  { hull: LANCE_HULL_CONFIG, sources: LANCE_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Small long-gun sniper fighter: holds its Optimal band and picks at range." },
  { hull: WASP_HULL_CONFIG, sources: WASP_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Small knife brawler: short-optimal barrage gun, tough for its class." },
  { hull: BALLISTA_HULL_CONFIG, sources: BALLISTA_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Medium sniper corvette: heavy railgun, thin close-in coverage." },
  { hull: AEGIS_HULL_CONFIG, sources: AEGIS_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Medium escort: wide-arc coverage and shield-bypass pressure, no blind arc." },
  { hull: VANGUARD_HULL_CONFIG, sources: VANGUARD_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Medium gun battery: four broadside barrage mounts, minimal fore armament." },
  { hull: BLANK_BALANCED_HULL_CONFIG, sources: BLANK_BALANCED_DEFAULT_COMPONENT_SOURCES, role: "blank", intent: "Generalist medium template." },
  { hull: BLANK_FAST_HULL_CONFIG, sources: BLANK_FAST_DEFAULT_COMPONENT_SOURCES, role: "blank", intent: "Fast medium template: higher safe velocity, lighter armour." },
  { hull: BLANK_HEAVY_HULL_CONFIG, sources: BLANK_HEAVY_DEFAULT_COMPONENT_SOURCES, role: "blank", intent: "Heavy medium template: three hardpoints, more hull and armour, slower." },
  { hull: BLANK_BROADSIDE_HULL_CONFIG, sources: BLANK_BROADSIDE_DEFAULT_COMPONENT_SOURCES, role: "blank", intent: "Broadside medium template: side mounts, weak fore armament." },
  { hull: BLANK_TRADER_HULL_CONFIG, sources: BLANK_TRADER_DEFAULT_COMPONENT_SOURCES, role: "blank", intent: "Armed trader medium template: few mounts, generous reactor, weak shields." },
]);

export const WAVE_1 = Object.freeze({
  id: "wave-1",
  label: "Shipyard Wave 1 — mid-tier hulls and parts",
  componentSources: WAVE_1_COMPONENT_SOURCES,
  hulls: WAVE_1_HULLS,
});

export default WAVE_1;
