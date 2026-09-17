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

/** Values mirrored into the native D&D5e vehicle sheet from persisted ship config/state. */
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

function resolvePath(source, path) {
  // A tiny local resolver keeps this model module testable without Foundry utilities.
  let value = source;
  for (const key of path.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

/** Return only native vehicle fields whose stored value differs from the authoritative ship data. */
export function nativeVehicleFieldChanges(actor, config, state) {
  const values = nativeVehicleFieldValues(config, state);
  return Object.fromEntries(
    Object.entries(values).filter(([path, value]) => (
      resolvePath(actor, path) !== value
    )),
  );
}

function changedValue(changes, path) {
  if (Object.hasOwn(changes, path)) return changes[path];
  let value = changes;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/** Translate explicit native sheet edits into a sparse ship update; never mutate the inputs. */
export function shipFieldsFromNativeVehicleChanges(
  changes,
  config,
  state,
  { allowConfig = true } = {},
) {
  const update = {};
  const ac = finite(changedValue(changes, "system.attributes.ac.flat"), NaN);
  if (allowConfig && ac > 0 && ac !== config.ac) {
    update["system.shipCombat.config.ac"] = ac;
  }

  const maxHp = finite(changedValue(changes, "system.attributes.hp.max"), NaN);
  const maxHull = allowConfig && maxHp > 0 ? maxHp : config.maxHull;
  if (maxHull !== config.maxHull) {
    update["system.shipCombat.config.maxHull"] = maxHull;
  }
  const hp = finite(changedValue(changes, "system.attributes.hp.value"), NaN);
  if (Number.isFinite(hp) || maxHull !== config.maxHull) {
    const hull = Math.max(
      0,
      Math.min(maxHull, Number.isFinite(hp) ? hp : state.hull),
    );
    if (hull !== state.hull) update["system.shipCombat.state.hull"] = hull;
  }

  const sizeId = changedValue(changes, "system.traits.size");
  const size = Object.keys(SIZE_IDS).find((key) => SIZE_IDS[key] === sizeId);
  if (allowConfig && size && size !== config.size) {
    update["system.shipCombat.config.size"] = size;
  }
  return update;
}
