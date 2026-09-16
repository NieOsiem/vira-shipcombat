const SIZE_IDS = Object.freeze({
  tiny: "tiny",
  small: "sm",
  medium: "med",
  large: "lg",
  huge: "huge",
  gargantuan: "grg",
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Values mirrored into the native D&D5e vehicle sheet. Ship combat config/state remain authoritative. */
export function nativeVehicleFieldValues(config, state) {
  const maxHull = Math.max(0, finite(config?.maxHull));
  const hull = Math.max(0, finite(state?.hull));
  return {
    "system.attributes.ac.calc": "flat",
    "system.attributes.ac.flat": finite(config?.ac, 10),
    "system.attributes.hp.value": hull,
    "system.attributes.hp.max": maxHull,
    "system.traits.size": SIZE_IDS[config?.size] ?? "med",
    "system.details.type": "space",
  };
}

/** Return only native vehicle fields whose stored value differs from the authoritative ship data. */
export function nativeVehicleFieldChanges(actor, config, state) {
  const values = nativeVehicleFieldValues(config, state);
  return Object.fromEntries(Object.entries(values).filter(([path, value]) => (
    globalThis.foundry?.utils?.getProperty(actor, path) !== value
  )));
}
