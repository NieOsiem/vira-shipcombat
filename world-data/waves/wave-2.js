/**
 * Wave 2 of the world-only ship catalogue: the remaining ready hulls for the small and medium
 * classes, plus the parts wave 1 flagged as gaps (a small shield-bypass gun, budget and premium
 * reactor tiers, a premium directional shield, more barrage and coverage options).
 *
 * Like wave 1, nothing here ships with the module: these hulls are absent from
 * `scripts/data/reference-builds.js`, so the module treats them as custom hulls that install nothing
 * by themselves.
 *
 * The component lists are the *whole* per-size catalogues (wave 1 parts included), because the
 * installer de-duplicates by design and skips anything already in the world; only the new hulls are
 * listed here.
 */
import { SMALL_COMPONENT_SOURCES } from "../components/small-components.js";
import { MEDIUM_COMPONENT_SOURCES } from "../components/medium-components.js";

import { SHRIKE_HULL_CONFIG, SHRIKE_DEFAULT_COMPONENT_SOURCES } from "../hulls/shrike.js";
import { GNAT_HULL_CONFIG, GNAT_DEFAULT_COMPONENT_SOURCES } from "../hulls/gnat.js";
import { SALVO_HULL_CONFIG, SALVO_DEFAULT_COMPONENT_SOURCES } from "../hulls/salvo.js";

/** Every component source the wave can install, de-duplicated by id. */
export const WAVE_2_COMPONENT_SOURCES = Object.freeze(
  [...new Map(
    [...SMALL_COMPONENT_SOURCES, ...MEDIUM_COMPONENT_SOURCES].map((source) => [source._id, source]),
  ).values()],
);

/** @type {{hull: object, sources: object[], role: "ready"|"blank", intent: string}[]} */
export const WAVE_2_HULLS = Object.freeze([
  { hull: SHRIKE_HULL_CONFIG, sources: SHRIKE_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Small shield-bypass strike fighter: its guns ignore shields, so regeneration funnels cannot stall it." },
  { hull: GNAT_HULL_CONFIG, sources: GNAT_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Small militia fighter: cheap barrage gun and cheap drives — the starter hull of the class." },
  { hull: SALVO_HULL_CONFIG, sources: SALVO_DEFAULT_COMPONENT_SOURCES, role: "ready", intent: "Medium anti-funnel corvette: two barrage mounts and a shield-bypass pincer, built to out-damage regeneration." },
]);

export const WAVE_2 = Object.freeze({
  id: "wave-2",
  label: "Shipyard Wave 2 — further hulls and parts",
  componentSources: WAVE_2_COMPONENT_SOURCES,
  hulls: WAVE_2_HULLS,
});

export default WAVE_2;
