import { COMPONENT_ITEM_TYPE, SCHEMA_VERSION } from "../constants.js";

/** Recursively freeze bundled reference data so no consumer can mutate a shared source. */
export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Bundled component Item source. `size` is the exact mount size the copy fits: a reference
 * build installs only components whose size matches every hull slot it is mounted in.
 */
export function componentSource({
  _id,
  name,
  componentClass,
  size = "medium",
  driveRole = "",
  definition,
}) {
  return deepFreeze({
    _id,
    name,
    type: COMPONENT_ITEM_TYPE,
    img: "icons/svg/item-bag.svg",
    system: {
      schemaVersion: SCHEMA_VERSION,
      componentClass,
      size,
      driveRole,
      definition,
    },
  });
}

/** Engines-Power tier ladder shared by every drive blueprint; only Overclock Heat differs. */
export function driveTiers(overclockHeat) {
  return [
    { power: 0, multiplier: 0, online: false },
    { power: 1, multiplier: 0.5, online: true },
    { power: 2, multiplier: 0.75, online: true },
    { power: 3, multiplier: 1, online: true },
    { power: 4, multiplier: 1.25, online: true, overclock: true, overclockHeat },
  ];
}

/** Independent installed copy of a reusable blueprint, carrying its own Item ID. */
export function installationSource(source, _id) {
  return deepFreeze({ ...structuredClone(source), _id });
}
