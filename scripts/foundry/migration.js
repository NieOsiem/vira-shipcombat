import {
  COMPONENT_ITEM_TYPE,
  INTERNAL_UPDATE_OPTION as INTERNAL_UPDATE,
  INTERNAL_REFIT_OPTION,
  MODULE_ID,
  MOUNT_SIZES,
  SCHEMA_VERSION,
  SHIP_TYPE,
} from "../constants.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "../data/canadensis-components.js";
import { createDefaultShipSystemData } from "../model/defaults.js";
import { isActiveGM } from "../socket.js";

export const INTERNAL_MIGRATION_OPTION = "viraShipCombatMigration";
export { INTERNAL_REFIT_OPTION } from "../constants.js";

const MIGRATION_FLAG = "migration";
const REFERENCE_HULL_ID = "canadensis-training-corvette";
const actorQueues = new Map();

const REFERENCE_ITEM_IDS = Object.freeze({
  reactor: "CanadReactor0001",
  shield: "CanadShield00001",
  sensor: "CanadSensor00001",
  cooling: "CanadCooling0001",
  main: "CanadMainDrive01",
  reverse: "CanadRevDrive001",
  portLateral: "CanadLateralA001",
  starboardLateral: "CanadLateralB001",
  prow: "CanadRailgun0001",
  dorsal: "CanadLaser000001",
  port: "CanadMacrocanA01",
  starboard: "CanadMacrocanB01",
});

const REFERENCE_SLOT_IDS = Object.freeze({
  reactor: "canadensis-slot-reactor",
  shield: "canadensis-slot-shield",
  sensor: "canadensis-slot-sensor",
  cooling: "canadensis-slot-cooling",
  main: "canadensis-slot-main-drive",
  reverse: "canadensis-slot-reverse-drive",
  portLateral: "canadensis-slot-port-lateral-drive",
  starboardLateral: "canadensis-slot-starboard-lateral-drive",
});

const DEFAULT_SLOT_REGIONS = Object.freeze({
  reactor: Object.freeze(["aft"]),
  shield: Object.freeze(["fore", "port", "starboard", "aft"]),
  sensor: Object.freeze(["fore"]),
  cooling: Object.freeze(["aft"]),
  main: Object.freeze(["aft"]),
  reverse: Object.freeze(["fore"]),
  portLateral: Object.freeze(["port", "aft"]),
  starboardLateral: Object.freeze(["starboard", "aft"]),
});

function clone(value) {
  if (value === undefined) return undefined;
  if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(value);
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function values(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection);
}

function itemId(item) {
  return item?.id ?? item?._id ?? null;
}

function itemType(item) {
  return item?.type ?? item?._source?.type ?? null;
}

function itemFlag(item) {
  if (typeof item?.getFlag === "function") return item.getFlag(MODULE_ID, MIGRATION_FLAG);
  return item?.flags?.[MODULE_ID]?.[MIGRATION_FLAG]
    ?? item?._source?.flags?.[MODULE_ID]?.[MIGRATION_FLAG]
    ?? null;
}

function queueKey(actor) {
  return actor?.uuid ?? actor?.id ?? actor;
}

function serializeActor(actor, task) {
  const key = queueKey(actor);
  const previous = actorQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  actorQueues.set(key, current);
  return current.finally(() => {
    if (actorQueues.get(key) === current) actorQueues.delete(key);
  });
}

function migrationOptions(extra = {}) {
  return {
    ...extra,
    [INTERNAL_UPDATE]: true,
    [INTERNAL_MIGRATION_OPTION]: true,
  };
}

function forcedReplacement(value) {
  return globalThis.foundry.data.operators.ForcedReplacement.create(value);
}

function warnDegradedMigration(actor) {
  globalThis.ui?.notifications?.warn?.(
    `${actor?.name ?? "Ship"}: unsupported or stale legacy references were removed during migration.`,
  );
}

function defaultSystemPayload() {
  const payload = createDefaultShipSystemData();
  if (!payload || typeof payload !== "object") {
    throw new Error("The default ship system-data helper returned no data.");
  }
  if (payload.shipCombat) {
    return { shipCombat: clone(payload.shipCombat), items: clone(payload.items ?? []) };
  }
  const { items = [], ...shipCombat } = payload;
  return { shipCombat: clone(shipCombat), items: clone(items) };
}

function embeddedItems(actor) {
  return values(actor?.items);
}

function configReferences(config) {
  const ids = new Set();
  for (const slot of config?.slots ?? []) {
    if (typeof slot?.itemId === "string" && slot.itemId) ids.add(slot.itemId);
  }
  for (const hardpoint of config?.hardpoints ?? []) {
    if (typeof hardpoint?.weaponId === "string" && hardpoint.weaponId) ids.add(hardpoint.weaponId);
  }
  return ids;
}

function sourceWithProvenance(source, provenance, desiredId = null) {
  const result = clone(source);
  if (desiredId) result._id = desiredId;
  else delete result._id;
  result.flags ??= {};
  result.flags[MODULE_ID] ??= {};
  result.flags[MODULE_ID][MIGRATION_FLAG] = {
    schemaVersion: SCHEMA_VERSION,
    key: provenance,
  };
  return result;
}

async function createMissingItems(actor, specs) {
  const existing = embeddedItems(actor)
    .filter((item) => typeof itemId(item) === "string" && itemId(item))
    .sort((left, right) => itemId(left).localeCompare(itemId(right)));
  const byId = new Map();
  const byProvenance = new Map();
  for (const item of existing) {
    if (!byId.has(itemId(item))) byId.set(itemId(item), item);
    const provenance = itemFlag(item)?.key;
    if (typeof provenance === "string" && provenance) {
      const matches = byProvenance.get(provenance) ?? [];
      matches.push(item);
      byProvenance.set(provenance, matches);
    }
  }

  const uniqueSpecs = [];
  const specKeys = new Set();
  const desiredIds = new Set();
  for (const rawSpec of specs) {
    if (!rawSpec || typeof rawSpec.key !== "string" || !rawSpec.key || specKeys.has(rawSpec.key)) continue;
    specKeys.add(rawSpec.key);
    const spec = { ...rawSpec };
    if (spec.desiredId && desiredIds.has(spec.desiredId)) spec.desiredId = null;
    if (spec.desiredId) desiredIds.add(spec.desiredId);
    uniqueSpecs.push(spec);
  }

  const compatibleItem = (item, spec) =>
    itemType(item) === COMPONENT_ITEM_TYPE
    && item?.system?.componentClass === spec.source?.system?.componentClass
    && (spec.source?.system?.componentClass !== "drive"
      || item?.system?.driveRole === spec.source?.system?.driveRole);
  const resolved = new Map();
  const pendingSpecs = [];
  for (const spec of uniqueSpecs) {
    let item = (byProvenance.get(spec.key) ?? []).find((candidate) => compatibleItem(candidate, spec));
    if (!item && spec.desiredId) {
      const desired = byId.get(spec.desiredId);
      if (compatibleItem(desired, spec)) item = desired;
      else if (desired) spec.desiredId = null;
    }
    if (item) {
      resolved.set(spec.key, item);
      continue;
    }
    pendingSpecs.push(spec);
  }

  if (pendingSpecs.length) {
    const sources = pendingSpecs.map((spec) => sourceWithProvenance(spec.source, spec.key, spec.desiredId));
    const created = values(await actor.createEmbeddedDocuments("Item", sources, migrationOptions({ keepId: true })));
    if (created.length !== pendingSpecs.length) {
      throw new Error(`Ship component migration created ${created.length} of ${pendingSpecs.length} requested Items.`);
    }
    for (const [index, spec] of pendingSpecs.entries()) {
      const item = created[index];
      if (itemType(item) !== COMPONENT_ITEM_TYPE) {
        throw new Error(`Ship component migration returned a non-component Item for ${spec.key}.`);
      }
      resolved.set(spec.key, item);
    }
  }

  for (const spec of uniqueSpecs) {
    const item = resolved.get(spec.key);
    if (!item || typeof itemId(item) !== "string" || !itemId(item)) {
      throw new Error(`Ship component migration did not return an Item for ${spec.key}.`);
    }
  }
  return resolved;
}

function isLegacyConfig(config) {
  return Boolean(config?.components && !Array.isArray(config?.slots));
}

function isUninitializedConfig(config) {
  if (!config || typeof config !== "object") return true;
  return !config.id && !Array.isArray(config.slots) && !config.components;
}

function cleanDefinition(component, extraHullKeys = []) {
  const definition = clone(component ?? {});
  for (const key of [
    "id", "label", "name", "class", "size", "mountSize", "regions", "region",
    "hardpointId", "orientation", "driveRole", ...extraHullKeys,
  ]) delete definition[key];
  return definition;
}

function mountSize(...candidates) {
  return candidates.find((candidate) => MOUNT_SIZES.includes(candidate)) ?? "medium";
}

function componentSource(component, componentClass, definition, driveRole = "", desiredId = null, size = "medium") {
  return {
    ...(desiredId ? { _id: desiredId } : {}),
    name: component?.label ?? component?.name ?? `${componentClass[0].toUpperCase()}${componentClass.slice(1)} Component`,
    type: COMPONENT_ITEM_TYPE,
    img: component?.img ?? "icons/svg/item-bag.svg",
    system: {
      schemaVersion: SCHEMA_VERSION,
      componentClass,
      size,
      driveRole,
      definition,
    },
  };
}

function safeId(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || fallback;
}

function legacySlotId(config, component, componentClass) {
  if (config?.id === REFERENCE_HULL_ID && REFERENCE_SLOT_IDS[componentClass]) return REFERENCE_SLOT_IDS[componentClass];
  return `${safeId(component?.id, componentClass)}-slot`;
}

function legacyDriveSlotId(config, component, role) {
  if (config?.id === REFERENCE_HULL_ID) return REFERENCE_SLOT_IDS[role];
  return `${safeId(component?.id, "drive")}-slot-${safeId(role, "drive")}`;
}

function slotRegions(component, role = null, componentClass = null) {
  const regions = Array.isArray(component?.regions) ? [...component.regions] : [];
  const fallback = DEFAULT_SLOT_REGIONS[role ?? componentClass] ?? [];
  if (!role) return regions.length ? regions : [...fallback];
  if (role === "main" || role === "reverse") {
    const axial = regions.filter((region) => region === (role === "main" ? "aft" : "fore"));
    return axial.length ? axial : regions.length ? regions : [...fallback];
  }
  const sector = role === "portLateral" ? "port" : "starboard";
  const lateral = regions.filter((region) => region === sector || region === "aft");
  return lateral.length ? lateral : regions.length ? regions : [...fallback];
}

function emptySlotRecord(id, componentClass, role = null, size = "medium") {
  const driveRole = role;
  return {
    id,
    label: `${role ?? componentClass} Slot`,
    class: componentClass,
    size,
    regions: [...(DEFAULT_SLOT_REGIONS[role ?? componentClass] ?? ["aft"])],
    ...(driveRole ? { driveRole } : {}),
    ...(role === "portLateral" ? { orientation: -90 } : {}),
    ...(role === "starboardLateral" ? { orientation: 90 } : {}),
    itemId: null,
  };
}

function slotRecord(id, component, componentClass, itemKey, role = null, size = "medium") {
  const driveRole = role;
  return {
    id,
    label: component?.label ? `${component.label} Slot` : `${componentClass} Slot`,
    class: componentClass,
    size,
    regions: slotRegions(component, role, componentClass),
    ...(driveRole ? { driveRole } : {}),
    ...(role === "portLateral" ? { orientation: -90 } : {}),
    ...(role === "starboardLateral" ? { orientation: 90 } : {}),
    itemId: { itemKey },
  };
}

function distributeDriveTiers(tiers, role) {
  return (tiers ?? []).map((tier) => {
    const result = clone(tier);
    if (result.overclockHeat !== undefined && role !== "main") result.overclockHeat = 0;
    return result;
  });
}

function driveDefinition(component, role) {
  const base = component?.base ?? {};
  const rotation = Number(base.rotation ?? 0);
  const thrust = role === "main"
    ? Number(base.forward ?? base.thrust ?? 0)
    : role === "reverse"
      ? Number(base.retro ?? base.reverse ?? 0)
      : Number(base[role === "portLateral" ? "port" : "starboard"] ?? base.lateral ?? 0);
  const recovery = component?.recoveryWork;
  const recoveryWork = recovery && typeof recovery === "object"
    ? Number(recovery[role === "main" || role === "reverse" ? "drive" : "maneuveringThrusters"] ?? 0)
    : Number(recovery ?? 0);
  return {
    base: {
      thrust: Number.isFinite(thrust) ? thrust : 0,
      ...((role === "portLateral" || role === "starboardLateral")
        ? { rotation: Number.isFinite(rotation) ? rotation / 2 : 0 }
        : {}),
    },
    tiers: distributeDriveTiers(component?.tiers, role),
    recoveryWork: Number.isFinite(recoveryWork) ? recoveryWork : 0,
  };
}

function referenceDesiredId(componentClass, role = null, hardpoint = null) {
  if (componentClass === "drive") return REFERENCE_ITEM_IDS[role];
  if (componentClass !== "weapon") return REFERENCE_ITEM_IDS[componentClass];
  const label = String(hardpoint?.label ?? "").toLowerCase();
  if (label.includes("prow")) return REFERENCE_ITEM_IDS.prow;
  if (label.includes("dorsal")) return REFERENCE_ITEM_IDS.dorsal;
  if (label.includes("starboard")) return REFERENCE_ITEM_IDS.starboard;
  if (label.includes("port")) return REFERENCE_ITEM_IDS.port;
  return null;
}

function buildLegacyConversion(shipCombat) {
  const config = clone(shipCombat.config);
  const state = clone(shipCombat.state ?? {});
  const components = config.components ?? {};
  const specs = [];
  const slots = [];
  const legacyToItemKey = new Map();
  const driveItemKeys = new Map();
  const legacyToHullRef = new Map();
  const hardpointByLegacyWeapon = new Map();
  const droppedLegacyIds = new Set();
  const desiredIds = new Set();
  const reference = config.id === REFERENCE_HULL_ID;
  let degraded = false;

  function addLegacyMapping(legacyId, key, hullRef) {
    if (typeof legacyId !== "string" || !legacyId) return;
    if (legacyToItemKey.has(legacyId) || legacyToHullRef.has(legacyId)) {
      degraded = true;
      return;
    }
    legacyToItemKey.set(legacyId, key);
    legacyToHullRef.set(legacyId, hullRef);
  }

  function reserveDesiredId(desiredId) {
    if (!desiredId || desiredIds.has(desiredId)) {
      if (desiredId) degraded = true;
      return null;
    }
    desiredIds.add(desiredId);
    return desiredId;
  }

  for (const componentClass of ["reactor", "shield", "sensor", "cooling"]) {
    const component = components[componentClass];
    const slotId = legacySlotId(config, component, componentClass);
    const size = mountSize(component?.size, component?.mountSize, config.size);
    if (!component) {
      slots.push(emptySlotRecord(slotId, componentClass, null, size));
      continue;
    }
    const key = `legacy:${componentClass}:${component.id ?? componentClass}`;
    const desiredId = reserveDesiredId(reference ? referenceDesiredId(componentClass) : null);
    specs.push({
      key,
      desiredId,
      source: componentSource(component, componentClass, cleanDefinition(component), "", desiredId, size),
    });
    slots.push(slotRecord(slotId, component, componentClass, key, null, size));
    addLegacyMapping(component.id, key, { slotId });
  }

  const drive = components.drive;
  const driveRoles = ["main", "reverse", "portLateral", "starboardLateral"];
  const driveSize = mountSize(drive?.size, drive?.mountSize, config.size);
  for (const role of driveRoles) {
    const slotId = legacyDriveSlotId(config, drive, role);
    if (!drive) {
      slots.push(emptySlotRecord(slotId, "drive", role, driveSize));
      continue;
    }
    const key = `legacy:drive:${drive.id ?? "drive"}:${role}`;
    const desiredId = reserveDesiredId(reference ? referenceDesiredId("drive", role) : null);
    const itemDriveRole = role === "portLateral" || role === "starboardLateral" ? "lateral" : role;
    driveItemKeys.set(role, key);
    specs.push({
      key,
      desiredId,
      source: componentSource(drive, "drive", driveDefinition(drive, role), itemDriveRole, desiredId, driveSize),
    });
    slots.push(slotRecord(slotId, drive, "drive", key, role, driveSize));
  }
  if (drive?.id) {
    addLegacyMapping(
      drive.id,
      `legacy:drive:${drive.id}:main`,
      { slotId: legacyDriveSlotId(config, drive, "main") },
    );
  }

  const legacyWeapons = Array.isArray(components.weapons) ? components.weapons : [];
  const hardpoints = [];
  const installedWeaponIds = new Set();
  for (const hardpoint of config.hardpoints ?? []) {
    const result = clone(hardpoint);
    const legacyWeaponId = typeof hardpoint?.weaponId === "string" && hardpoint.weaponId
      ? hardpoint.weaponId
      : null;
    const matches = legacyWeaponId
      ? legacyWeapons.filter((candidate) => candidate?.id === legacyWeaponId)
      : [];
    const weapon = matches[0];
    if (matches.length > 1) degraded = true;
    const size = mountSize(
      hardpoint?.mountSize,
      hardpoint?.size,
      weapon?.size,
      weapon?.mountSize,
      config.size,
    );
    const declaredWeaponSize = [weapon?.size, weapon?.mountSize]
      .find((candidate) => MOUNT_SIZES.includes(candidate));
    if (declaredWeaponSize && declaredWeaponSize !== size) degraded = true;
    result.category = "hardpoint";
    result.mountSize = size;
    result.regions = Array.isArray(result.regions) && result.regions.length
      ? result.regions
      : clone(weapon?.regions ?? DEFAULT_SLOT_REGIONS.main);
    delete result.size;

    const supportedMount = !hardpoint?.category || hardpoint.category === "hardpoint";
    const supportedWeapon = weapon && (!weapon.category || weapon.category === "hardpoint");
    const duplicateInstallation = Boolean(legacyWeaponId && installedWeaponIds.has(legacyWeaponId));
    if (!supportedMount || !supportedWeapon || duplicateInstallation) {
      if (legacyWeaponId || weapon || !supportedMount) degraded = true;
      result.weaponId = null;
      hardpoints.push(result);
      continue;
    }

    const key = `legacy:weapon:${weapon.id ?? hardpoint.id}`;
    const desiredId = reserveDesiredId(reference ? referenceDesiredId("weapon", null, hardpoint) : null);
    specs.push({
      key,
      desiredId,
      source: componentSource(weapon, "weapon", cleanDefinition(weapon), "", desiredId, size),
    });
    result.weaponId = { itemKey: key };
    hardpoints.push(result);
    if (legacyWeaponId) {
      installedWeaponIds.add(legacyWeaponId);
      addLegacyMapping(legacyWeaponId, key, { hardpointId: hardpoint.id });
      if (!hardpointByLegacyWeapon.has(legacyWeaponId)) {
        hardpointByLegacyWeapon.set(legacyWeaponId, hardpoint.id);
      }
    }
  }

  for (const weapon of legacyWeapons) {
    const legacyId = typeof weapon?.id === "string" && weapon.id ? weapon.id : null;
    if (legacyId && installedWeaponIds.has(legacyId)) continue;
    degraded = true;
    if (legacyId && !legacyToItemKey.has(legacyId)) droppedLegacyIds.add(legacyId);
  }
  for (const hardpoint of config.hardpoints ?? []) {
    const legacyId = typeof hardpoint?.weaponId === "string" && hardpoint.weaponId ? hardpoint.weaponId : null;
    if (legacyId && !legacyToItemKey.has(legacyId)) droppedLegacyIds.add(legacyId);
  }

  const hull = clone(config);
  delete hull.components;
  hull.schemaVersion = SCHEMA_VERSION;
  hull.slots = slots;
  hull.hardpoints = hardpoints;
  hull.weaponPriority = [...new Set((config.weaponPriority ?? [])
    .map((weaponId) => hardpointByLegacyWeapon.get(weaponId))
    .filter(Boolean))];

  if (Array.isArray(hull.capabilityProfile?.evasionHardware)) {
    hull.capabilityProfile.evasionHardware = hull.capabilityProfile.evasionHardware.flatMap((entry) => {
      const legacyId = entry?.componentId;
      const mapped = legacyToHullRef.get(legacyId);
      if (!mapped) {
        degraded = true;
        return [];
      }
      const roles = legacyId === drive?.id && entry?.channel === "maneuveringThrusters"
        ? ["portLateral", "starboardLateral"]
        : [null];
      return roles.map((role) => {
        const result = {
          ...clone(entry),
          ...(role ? { slotId: legacyDriveSlotId(config, drive, role) } : mapped),
        };
        delete result.componentId;
        return result;
      });
    });
  }
  hull.criticalPools = Object.fromEntries(Object.entries(hull.criticalPools ?? {}).map(([region, entries]) => [
    region,
    !Array.isArray(entries) ? entries : entries.flatMap((entry) => {
      if (entry?.kind !== "fault") return [clone(entry)];
      const legacyId = entry.componentId ?? entry.targetId;
      const mapped = legacyToHullRef.get(legacyId);
      if (!mapped) {
        degraded = true;
        if (typeof legacyId === "string" && legacyId) droppedLegacyIds.add(legacyId);
        return [];
      }
      const channel = entry.channelId ?? entry.conditionId;
      const roles = legacyId !== drive?.id
        ? [null]
        : channel === "maneuveringThrusterFailure"
          ? ["portLateral", "starboardLateral"]
          : channel === "driveFailure"
            ? ["main", "reverse"]
            : ["main"];
      return roles.map((role) => {
        const result = {
          ...clone(entry),
          ...(role ? { slotId: legacyDriveSlotId(config, drive, role) } : mapped),
        };
        delete result.componentId;
        delete result.targetId;
        return result;
      });
    }),
  ]));

  return {
    hull,
    state,
    specs,
    legacyToItemKey,
    legacyDriveId: typeof drive?.id === "string" && drive.id ? drive.id : null,
    driveItemKeys,
    droppedLegacyIds,
    degraded,
  };
}

function resolveItemReferences(value, itemByKey) {
  if (Array.isArray(value)) return value.map((entry) => resolveItemReferences(entry, itemByKey));
  if (!value || typeof value !== "object") return value;
  if (Object.keys(value).length === 1 && typeof value.itemKey === "string") {
    return itemId(itemByKey.get(value.itemKey));
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveItemReferences(child, itemByKey)]));
}

function remapExactIdentity(value, idMap) {
  if (typeof value !== "string" || !value || !idMap.has(value)) return value;
  const replacement = idMap.get(value);
  return typeof replacement === "string" && replacement ? replacement : value;
}

function compoundSegments(value) {
  return typeof value === "string" ? value.split(":") : [];
}

function containsIdentity(value, identity) {
  return typeof identity === "string"
    && Boolean(identity)
    && (value === identity || compoundSegments(value).includes(identity));
}

function remapCompoundIdentity(value, idMap) {
  if (typeof value !== "string" || !value) return value;
  const exact = remapExactIdentity(value, idMap);
  if (exact !== value) return exact;
  return compoundSegments(value)
    .map((segment) => remapExactIdentity(segment, idMap))
    .join(":");
}

function remapExactStateReferences(value, idMap) {
  if (Array.isArray(value)) return value.map((entry) => remapExactStateReferences(entry, idMap));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (["componentId", "weaponId", "itemId", "aimedComponentId"].includes(key)) {
      return [key, remapExactIdentity(child, idMap)];
    }
    if (key === "targetId") return [key, remapExactIdentity(child, idMap)];
    return [key, remapExactStateReferences(child, idMap)];
  }));
}

function remapRecord(value, idMap, compoundFields) {
  const result = remapExactStateReferences(value, idMap);
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  for (const field of compoundFields) {
    if (typeof result[field] === "string") result[field] = remapCompoundIdentity(result[field], idMap);
  }
  return result;
}

function referencesAnyIdentity(key, value, identities) {
  const candidates = [
    key,
    value?.id,
    value?.componentId,
    value?.weaponId,
    value?.targetId,
    value?.conditionId,
    value?.jobId,
    value?.sourceId,
    value?.category,
    value?.poolId,
  ];
  return [...identities].some((identity) =>
    candidates.some((candidate) => containsIdentity(candidate, identity)));
}

function driveRolesForStateValue(key, value, legacyDriveId) {
  if (!legacyDriveId) return [];
  const identities = [key, value?.id, value?.componentId, value?.targetId, value?.jobId, value?.poolId];
  if (!identities.some((identity) => containsIdentity(identity, legacyDriveId))) return [];
  const channels = [
    value?.channelId,
    value?.conditionId,
    value?.channel,
    ...compoundSegments(key),
    ...compoundSegments(value?.id),
  ];
  if (channels.includes("maneuveringThrusterFailure")) return ["portLateral", "starboardLateral"];
  if (channels.includes("driveFailure")) return ["main", "reverse"];
  return ["main"];
}

function remapLegacyState(state, idMap, legacyDriveId, driveIds, droppedLegacyIds) {
  const remapped = remapExactStateReferences(state, idMap);
  let degraded = false;

  if (Array.isArray(state?.weaponPriority)) {
    remapped.weaponPriority = state.weaponPriority
      .filter((id) => {
        const dropped = [...droppedLegacyIds].some((legacyId) => containsIdentity(id, legacyId));
        if (dropped) degraded = true;
        return !dropped;
      })
      .map((id) => remapExactIdentity(id, idMap));
  }

  if (Array.isArray(state?.effects)) {
    remapped.effects = state.effects.flatMap((effect) => {
      if (referencesAnyIdentity("", effect, droppedLegacyIds)) {
        degraded = true;
        return [];
      }
      const result = remapRecord(effect, idMap, ["id", "category"]);
      if (typeof result?.sourceId === "string") result.sourceId = remapExactIdentity(result.sourceId, idMap);
      return [result];
    });
  }

  if (state?.tracks && typeof state.tracks === "object" && !Array.isArray(state.tracks)) {
    remapped.tracks = Object.fromEntries(Object.entries(remapped.tracks ?? {}).map(([key, track]) => {
      const result = clone(track);
      const remembered = result?.remembered;
      if (!remembered || typeof remembered !== "object" || Array.isArray(remembered)) return [key, result];
      for (const field of ["componentIds", "identifiedSubsystems"]) {
        if (Array.isArray(remembered[field]) && remembered[field].length) {
          delete remembered[field];
          degraded = true;
        }
      }
      return [key, result];
    }));
  }

  if (state?.weapons && typeof state.weapons === "object" && !Array.isArray(state.weapons)) {
    remapped.weapons = {};
    for (const [key, weaponState] of Object.entries(state.weapons)) {
      if (referencesAnyIdentity(key, weaponState, droppedLegacyIds)) {
        degraded = true;
        continue;
      }
      remapped.weapons[remapExactIdentity(key, idMap)] = remapExactStateReferences(weaponState, idMap);
    }
  }

  if (state?.conditions && typeof state.conditions === "object" && !Array.isArray(state.conditions)) {
    remapped.conditions = {};
    for (const [key, condition] of Object.entries(state.conditions)) {
      if (referencesAnyIdentity(key, condition, droppedLegacyIds)) {
        degraded = true;
        continue;
      }
      const roles = driveRolesForStateValue(key, condition, legacyDriveId);
      if (!roles.length) {
        remapped.conditions[remapCompoundIdentity(key, idMap)] = remapRecord(
          condition,
          idMap,
          ["id", "targetId", "poolId"],
        );
        continue;
      }
      for (const role of roles) {
        const targetId = driveIds.get(role);
        if (typeof targetId !== "string" || !targetId) continue;
        const roleMap = new Map(idMap);
        roleMap.set(legacyDriveId, targetId);
        remapped.conditions[remapCompoundIdentity(key, roleMap)] = remapRecord(
          condition,
          roleMap,
          ["id", "targetId", "poolId"],
        );
      }
    }
  }

  if (state?.work && typeof state.work === "object" && !Array.isArray(state.work)) {
    remapped.work = {};
    for (const [key, work] of Object.entries(state.work)) {
      if (referencesAnyIdentity(key, work, droppedLegacyIds)) {
        degraded = true;
        continue;
      }
      const roles = driveRolesForStateValue(key, work, legacyDriveId);
      const role = roles[0];
      const workMap = new Map(idMap);
      if (role && driveIds.get(role)) workMap.set(legacyDriveId, driveIds.get(role));
      remapped.work[remapCompoundIdentity(key, workMap)] = remapRecord(
        work,
        workMap,
        ["id", "targetId", "conditionId", "jobId", "poolId"],
      );
    }
  }
  return { state: remapped, degraded };
}

async function migrateLegacy(actor, shipCombat) {
  const conversion = buildLegacyConversion(shipCombat);
  const itemByKey = await createMissingItems(actor, conversion.specs);
  const hull = resolveItemReferences(conversion.hull, itemByKey);
  const idMap = new Map();
  for (const [legacyId, key] of conversion.legacyToItemKey) {
    const runtimeId = itemId(itemByKey.get(key));
    if (typeof legacyId === "string" && legacyId && typeof runtimeId === "string" && runtimeId) {
      idMap.set(legacyId, runtimeId);
    }
  }
  const driveIds = new Map([...conversion.driveItemKeys]
    .map(([role, key]) => [role, itemId(itemByKey.get(key))])
    .filter(([, id]) => typeof id === "string" && id));
  const stateResult = remapLegacyState(
    conversion.state,
    idMap,
    conversion.legacyDriveId,
    driveIds,
    conversion.droppedLegacyIds,
  );
  const state = stateResult.state;
  state.schemaVersion = SCHEMA_VERSION;
  state.revision = Number.isInteger(conversion.state?.revision) ? conversion.state.revision + 1 : 1;
  const migrated = {
    schemaVersion: SCHEMA_VERSION,
    config: hull,
    state,
  };
  await actor.update({
    "system.shipCombat": forcedReplacement(migrated),
  }, migrationOptions({ diff: false }));
  if (conversion.degraded || stateResult.degraded) warnDegradedMigration(actor);
  return true;
}

async function installReferencedDefaults(actor, config, sources = CANADENSIS_DEFAULT_COMPONENT_SOURCES) {
  if (config?.id !== REFERENCE_HULL_ID) return false;
  const references = configReferences(config);
  const specs = sources
    .filter((source) => references.has(source._id))
    .map((source) => ({
      key: `default:${source._id}`,
      desiredId: source._id,
      source,
    }));
  const before = new Set(embeddedItems(actor).map(itemId));
  await createMissingItems(actor, specs);
  return specs.some((spec) => !before.has(spec.desiredId));
}

async function initializeNewActor(actor) {
  const payload = defaultSystemPayload();
  await installReferencedDefaults(actor, payload.shipCombat.config, payload.items.length ? payload.items : CANADENSIS_DEFAULT_COMPONENT_SOURCES);
  await actor.update({
    "system.shipCombat": forcedReplacement(payload.shipCombat),
  }, migrationOptions({ diff: false }));
  return true;
}

async function migrateOrInitialize(actor) {
  if (actor?.type !== SHIP_TYPE || !isActiveGM()) return false;
  const shipCombat = clone(actor.system?.shipCombat ?? {});
  if (isLegacyConfig(shipCombat.config)) return migrateLegacy(actor, shipCombat);
  if (isUninitializedConfig(shipCombat.config)) return initializeNewActor(actor);
  return installReferencedDefaults(actor, shipCombat.config);
}

/** Migrate or initialize one world or synthetic ship Actor, serialized by Actor UUID. */
export function migrateShipActor(actor) {
  if (actor?.type !== SHIP_TYPE || !isActiveGM()) return Promise.resolve(false);
  return serializeActor(actor, () => migrateOrInitialize(actor));
}

/** Whether an embedded component mutation is an explicit module-owned migration/refit. */
export function isInternalComponentMutation(options) {
  return options?.[INTERNAL_MIGRATION_OPTION] === true || options?.[INTERNAL_REFIT_OPTION] === true;
}
