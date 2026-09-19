import { CANADENSIS_HULL_CONFIG } from "./canadensis.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "./canadensis-components.js";
import { deepFreeze } from "./component-source.js";
import { PEREGRINUS_HULL_CONFIG } from "./peregrinus.js";
import { PEREGRINUS_DEFAULT_COMPONENT_SOURCES } from "./peregrinus-components.js";

/**
 * Every bundled reference build: one hull configuration plus the component copies a fresh
 * installation receives. A hull config whose ID is absent here is a custom hull and installs
 * nothing by itself.
 */
export const REFERENCE_BUILDS = deepFreeze([
  {
    id: CANADENSIS_HULL_CONFIG.id,
    label: CANADENSIS_HULL_CONFIG.label,
    hull: CANADENSIS_HULL_CONFIG,
    componentSources: CANADENSIS_DEFAULT_COMPONENT_SOURCES,
  },
  {
    id: PEREGRINUS_HULL_CONFIG.id,
    label: PEREGRINUS_HULL_CONFIG.label,
    hull: PEREGRINUS_HULL_CONFIG,
    componentSources: PEREGRINUS_DEFAULT_COMPONENT_SOURCES,
  },
]);

/** Build a blank ship Actor receives, and the fallback for every build-agnostic caller. */
export const DEFAULT_REFERENCE_BUILD_ID = CANADENSIS_HULL_CONFIG.id;

const byHullId = new Map(REFERENCE_BUILDS.map((build) => [build.id, build]));

/** @returns {{id:string,label:string,hull:object,componentSources:object[]}|null} */
export function referenceBuild(hullId) {
  return byHullId.get(hullId) ?? null;
}

/** @returns {{id:string,label:string}[]} Selectable builds for UI surfaces. */
export function referenceBuildChoices() {
  return REFERENCE_BUILDS.map(({ id, label }) => ({ id, label }));
}
