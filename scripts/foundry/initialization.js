import {
  COMPONENT_ITEM_TYPE,
  INTERNAL_REFIT_OPTION,
  INTERNAL_UPDATE_OPTION,
  MODULE_ID,
  RuleViolation,
  SCHEMA_VERSION,
  SHIP_TYPE,
} from "../constants.js";
import { referenceBuild } from "../data/reference-builds.js";
import {
  createDefaultShipSystemData,
  createInitialState,
} from "../model/defaults.js";
import { materializeShipConfig } from "../model/equipment.js";
import { isActiveGM } from "../socket.js";

const INTERNAL_INITIALIZATION_OPTION = "viraShipCombatInitialization";
const actorQueues = new Map();

function clone(value) {
  return globalThis.foundry?.utils?.deepClone
    ? globalThis.foundry.utils.deepClone(value)
    : structuredClone(value);
}

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  return typeof collection.values === "function"
    ? [...collection.values()]
    : Array.from(collection);
}

function itemId(item) {
  return item?.id ?? item?._id;
}

function blankConfig(config) {
  return config == null ||
    (typeof config === "object" && !Array.isArray(config) &&
      Object.keys(config).every((key) => key === "schemaVersion"));
}

/** Reject obsolete persisted data even when prepared data has inherited current defaults. */
export function assertCurrentShipSchema(actor) {
  for (
    const data of [
      actor?._source?.system?.shipCombat,
      actor?.system?.shipCombat,
    ]
  ) {
    if (!data) continue;
    const obsolete = [
      data.schemaVersion,
      data.config?.schemaVersion,
      data.state?.schemaVersion,
    ]
      .some((version) => version !== undefined && version !== SCHEMA_VERSION);
    if (
      obsolete || data.config?.components !== undefined ||
      (!blankConfig(data.config) &&
        data.config?.schemaVersion !== SCHEMA_VERSION)
    ) {
      throw new RuleViolation(
        "UNSUPPORTED_SCHEMA_VERSION",
        "This ship has incompatible persisted data. Ask the active GM to inspect its schema and installed components; the original data has not been deleted.",
        {
          actorUuid: actor?.uuid,
        },
      );
    }
  }
}

function initializationOptions(extra = {}) {
  return {
    ...extra,
    [INTERNAL_UPDATE_OPTION]: true,
    [INTERNAL_INITIALIZATION_OPTION]: true,
  };
}

async function installReferencedDefaults(actor, config) {
  const build = referenceBuild(config.id);
  if (!build) return false;
  const references = new Set([
    ...(config.slots ?? []).map((slot) => slot.itemId),
    ...(config.hardpoints ?? []).map((hardpoint) => hardpoint.weaponId),
  ]);
  const existing = values(actor.items);
  const byId = new Map(existing.map((item) => [itemId(item), item]));
  const missing = [];
  for (const source of build.componentSources) {
    if (!references.has(source._id)) continue;
    const item = byId.get(source._id);
    if (item) {
      if (item.type !== COMPONENT_ITEM_TYPE) {
        throw new Error(
          `Ship component ID '${source._id}' is occupied by a non-component Item.`,
        );
      }
    } else missing.push(clone(source));
  }
  // Validate existing custom components and their mount compatibility before creating anything.
  materializeShipConfig(config, [
    ...existing.filter((item) => item.type === COMPONENT_ITEM_TYPE),
    ...missing,
  ]);
  if (!missing.length) return false;
  const created = values(
    await actor.createEmbeddedDocuments(
      "Item",
      missing,
      initializationOptions({ keepId: true }),
    ),
  );
  const createdIds = new Set(created.map(itemId));
  if (
    created.length !== missing.length || createdIds.size !== missing.length ||
    missing.some((source) => !createdIds.has(source._id)) ||
    created.some((item) => item.type !== COMPONENT_ITEM_TYPE)
  ) {
    throw new Error(
      "Ship component initialization did not create the requested Item IDs.",
    );
  }
  materializeShipConfig(
    config,
    values(actor.items).filter((item) => item.type === COMPONENT_ITEM_TYPE),
  );
  return true;
}

/** Preserve stale synthetic inline data before using an already-complete mounted hull. */
async function repairInlineComponentRemnant(actor) {
  const persisted = actor?._source?.system?.shipCombat;
  const current = actor?.system?.shipCombat;
  if (persisted?.config?.components === undefined) return false;
  // Prepared defaults alone cannot prove that a legacy hull has been migrated.
  if (
    [persisted, current].some((data) =>
      data?.schemaVersion !== SCHEMA_VERSION ||
      data.config?.schemaVersion !== SCHEMA_VERSION ||
      data.state?.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(data.config?.slots) ||
      !Array.isArray(data.config?.hardpoints)
    )
  ) return false;
  const config = clone(current.config);
  delete config.components;
  const persistedConfig = clone(persisted.config);
  delete persistedConfig.components;
  const items = values(actor.items).filter((item) =>
    item.type === COMPONENT_ITEM_TYPE
  );
  // No default installation: every mounted reference must already resolve correctly.
  try {
    materializeShipConfig(persistedConfig, items);
    materializeShipConfig(config, items);
  } catch (cause) {
    throw new RuleViolation(
      "UNSUPPORTED_SCHEMA_VERSION",
      `The mixed ship data cannot be repaired: ${cause.message} Original inline data has been retained; correct the mounted components and retry.`,
      { actorUuid: actor.uuid, cause: cause.message },
    );
  }
  const legacy = clone(persisted.config.components);
  const archive = actor.getFlag?.(MODULE_ID, "legacyInlineComponents") ??
    actor.flags?.[MODULE_ID]?.legacyInlineComponents;
  if (
    archive !== undefined && JSON.stringify(archive) !== JSON.stringify(legacy)
  ) {
    throw new Error(
      "A different legacy component backup already exists. Preserve both versions before repairing this ship.",
    );
  }
  const changes = {
    "system.shipCombat.config": globalThis.foundry.data.operators
      .ForcedReplacement.create(config),
  };
  if (archive === undefined) {
    changes[`flags.${MODULE_ID}.legacyInlineComponents`] = legacy;
  }
  const updated = await actor.update(
    changes,
    initializationOptions({ diff: false }),
  );
  if (!updated) {
    throw new Error(
      "Legacy component repair did not update the Actor; retry initialization.",
    );
  }
  globalThis.ui?.notifications?.info?.(
    `${actor.name ?? "Ship"} (${
      actor.uuid ?? actor.id
    }): restored mounted-component data. Original inline definitions are preserved in the ship's legacyInlineComponents flag.`,
  );
  return true;
}

async function initializeActor(actor) {
  if (!isActiveGM()) return false;
  const repaired = await repairInlineComponentRemnant(actor);
  assertCurrentShipSchema(actor);
  const current = actor.system?.shipCombat;
  if (repaired) return true;
  if (!blankConfig(current?.config)) {
    return installReferencedDefaults(actor, current.config);
  }
  const data = createDefaultShipSystemData();
  await installReferencedDefaults(actor, data.config);
  data.state = createInitialState(
    materializeShipConfig(
      data.config,
      values(actor.items).filter((item) => item.type === COMPONENT_ITEM_TYPE),
    ),
  );
  const updated = await actor.update({
    "system.shipCombat": globalThis.foundry.data.operators.ForcedReplacement
      .create(data),
  }, initializationOptions({ diff: false }));
  if (!updated) {
    throw new Error("Ship initialization did not update the Actor.");
  }
  return true;
}

/** Initialize current-schema world and synthetic ships, serialized by Actor UUID. */
export function initializeShipActor(actor) {
  if (actor?.type !== SHIP_TYPE || !isActiveGM()) return Promise.resolve(false);
  const key = actor.uuid ?? actor.id ?? actor;
  const previous = actorQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() =>
    initializeActor(actor)
  );
  actorQueues.set(key, current);
  return current.finally(() => {
    if (actorQueues.get(key) === current) actorQueues.delete(key);
  });
}

/** Whether an embedded component mutation is module-owned initialization or refit. */
export function isInternalComponentMutation(options) {
  return options?.[INTERNAL_INITIALIZATION_OPTION] === true ||
    options?.[INTERNAL_REFIT_OPTION] === true;
}
