import { COMPONENT_CLASSES, COMPONENT_ITEM_TYPE, DRIVE_ROLES, MOUNT_SIZES, SCHEMA_VERSION, SECTORS } from "../constants.js";

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function sourceOf(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.toObject === "function") return item.toObject(false);
  return item;
}

function fail(code, message, details = undefined) {
  const error = new TypeError(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/** Return a detached, uniform component source from an Item document or plain source. */
export function normalizeComponentItem(item) {
  const source = sourceOf(item);
  if (!source) fail("INVALID_COMPONENT_ITEM", "Component item must be an Item document or plain source.");
  const id = source.id ?? source._id;
  const system = source.system;
  if (typeof id !== "string" || id.trim() === "") fail("COMPONENT_ID_REQUIRED", "Component item requires an ID.");
  if (source.type !== undefined && source.type !== COMPONENT_ITEM_TYPE) {
    fail("INVALID_COMPONENT_ITEM_TYPE", `Item '${id}' is not a ship component.`);
  }
  if (!system || typeof system !== "object" || Array.isArray(system)) {
    fail("INVALID_COMPONENT_SYSTEM", `Component item '${id}' requires system data.`);
  }
  if (system.schemaVersion !== SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA_VERSION", `Component item '${id}' uses unsupported schema version '${system.schemaVersion}'.`);
  }
  if (!COMPONENT_CLASSES.includes(system.componentClass)) {
    fail("INVALID_COMPONENT_CLASS", `Component item '${id}' has an invalid component class.`);
  }
  if (!MOUNT_SIZES.includes(system.size)) fail("INVALID_COMPONENT_SIZE", `Component item '${id}' has an invalid size.`);
  if (!system.definition || typeof system.definition !== "object" || Array.isArray(system.definition)) {
    fail("COMPONENT_DEFINITION_REQUIRED", `Component item '${id}' requires a definition.`);
  }
  if (system.componentClass === "weapon" && system.definition.category !== "hardpoint") {
    fail("UNSUPPORTED_SPECIAL_WEAPON", `Component item '${id}' is not an ordinary hardpoint weapon.`);
  }
  if (system.componentClass === "drive") {
    if (!DRIVE_ROLES.includes(system.driveRole) || system.driveRole === "") {
      fail("INVALID_DRIVE_ROLE", `Drive item '${id}' has an invalid role.`);
    }
  } else if (system.driveRole !== undefined && system.driveRole !== "") {
    fail("INVALID_DRIVE_ROLE", `Non-drive item '${id}' cannot define a drive role.`);
  }
  return {
    id,
    name: typeof source.name === "string" && source.name.trim() ? source.name : id,
    type: source.type ?? COMPONENT_ITEM_TYPE,
    system: clone(system),
  };
}

/** Normalize component Items into a detached ID map, rejecting duplicate IDs. */
export function normalizeComponentItems(items = []) {
  const byId = new Map();
  for (const raw of items ?? []) {
    const item = normalizeComponentItem(raw);
    if (byId.has(item.id)) fail("DUPLICATE_COMPONENT_ID", `Component item ID '${item.id}' is duplicated.`);
    byId.set(item.id, item);
  }
  return byId;
}

function installedItem(ref, path, itemById) {
  if (ref === null || ref === undefined || ref === "") return null;
  if (typeof ref !== "string") fail("INVALID_INSTALLATION_REFERENCE", `${path} must be an Item ID or null.`);
  const item = itemById.get(ref);
  if (!item) fail("DANGLING_INSTALLATION", `${path} references missing component Item '${ref}'.`);
  return item;
}

function assertSlot(slot, seen) {
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) fail("INVALID_HULL_SLOT", "Hull slots must be objects.");
  if (typeof slot.id !== "string" || !slot.id.trim()) fail("HULL_SLOT_ID_REQUIRED", "Hull slot requires an ID.");
  if (seen.has(slot.id)) fail("DUPLICATE_HULL_SLOT", `Hull slot ID '${slot.id}' is duplicated.`);
  seen.add(slot.id);
  if (!["reactor", "drive", "shield", "sensor", "cooling", "inertia"].includes(slot.class)) {
    fail("INVALID_HULL_SLOT_CLASS", `Hull slot '${slot.id}' has unsupported class '${slot.class}'.`);
  }
  if (!MOUNT_SIZES.includes(slot.size)) fail("INVALID_HULL_SLOT_SIZE", `Hull slot '${slot.id}' has an invalid size.`);
  if (!Array.isArray(slot.regions) || slot.regions.some((region) => !SECTORS.includes(region)) || new Set(slot.regions).size !== slot.regions.length) {
    fail("INVALID_HULL_SLOT_REGIONS", `Hull slot '${slot.id}' requires valid, unique regions.`);
  }
  if (slot.class === "drive") {
    if (!["main", "reverse", "portLateral", "starboardLateral"].includes(slot.driveRole)) {
      fail("INVALID_HULL_DRIVE_ROLE", `Drive slot '${slot.id}' requires an exact drive role.`);
    }
  } else if (slot.driveRole !== undefined) {
    fail("INVALID_HULL_DRIVE_ROLE", `Non-drive slot '${slot.id}' cannot define a drive role.`);
  }
}

function componentFromSlot(slot, item) {
  if (item.system.componentClass !== slot.class) {
    fail("INCOMPATIBLE_COMPONENT_CLASS", `Item '${item.id}' cannot occupy ${slot.class} slot '${slot.id}'.`);
  }
  if (item.system.size !== slot.size) {
    fail("INCOMPATIBLE_COMPONENT_SIZE", `Item '${item.id}' size does not match slot '${slot.id}'.`);
  }
  const itemRole = ["portLateral", "starboardLateral"].includes(slot.driveRole) ? "lateral" : slot.driveRole;
  if (slot.class === "drive" && item.system.driveRole !== itemRole) {
    fail("INCOMPATIBLE_DRIVE_ROLE", `Drive '${item.id}' role does not match slot '${slot.id}'.`);
  }
  if (slot.regions.length === 0) {
    fail("INSTALLED_COMPONENT_REGIONS_REQUIRED", `Occupied slot '${slot.id}' requires at least one region.`);
  }
  return {
    ...clone(item.system.definition),
    id: item.id,
    label: item.name,
    class: slot.class,
    slotId: slot.id,
    ...(slot.class === "drive" ? { driveRole: slot.driveRole } : {}),
    regions: clone(slot.regions),
  };
}

function commonEngineTiers(drives) {
  if (drives.length === 0) return [];
  const tierMaps = drives.map((drive) => new Map((drive.tiers ?? []).map((tier) => [tier.power, tier])));
  const powers = [...tierMaps[0].keys()].filter((power) => tierMaps.every((tiers) => tiers.has(power))).sort((a, b) => a - b);
  return powers.map((power) => {
    const tiers = tierMaps.map((map) => map.get(power));
    const first = tiers[0];
    const tier = clone(first);
    for (const candidate of tiers.slice(1)) {
      for (const key of ["multiplier", "online", "overclock"]) {
        if ((candidate[key] ?? false) !== (first[key] ?? false)) {
          fail("INCOMPATIBLE_DRIVE_TIERS", `Installed drives disagree at engine Power ${power}.`);
        }
      }
    }
    const overclockHeat = tiers.reduce((sum, candidate) => sum + (candidate.overclockHeat ?? 0), 0);
    if (overclockHeat > 0) tier.overclockHeat = overclockHeat;
    else delete tier.overclockHeat;
    return tier;
  });
}


function mappedCriticalPools(pools, slotItems, hardpointItems, slotIds, hardpointIds) {
  return Object.fromEntries(SECTORS.map((region) => [region, (pools?.[region] ?? []).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("INVALID_CRITICAL_REFERENCE", `criticalPools.${region}[${index}] must be an object.`);
    }
    if (entry.kind !== "fault") return [clone(entry)];
    const hasSlot = typeof entry.slotId === "string" && entry.slotId !== "";
    const hasHardpoint = typeof entry.hardpointId === "string" && entry.hardpointId !== "";
    if (hasSlot === hasHardpoint) {
      fail("INVALID_CRITICAL_REFERENCE", `criticalPools.${region}[${index}] must reference exactly one slot or hardpoint.`);
    }
    if (hasSlot && !slotIds.has(entry.slotId)) {
      fail("DANGLING_CRITICAL_REFERENCE", `criticalPools.${region}[${index}] references unknown slot '${entry.slotId}'.`);
    }
    if (hasHardpoint && !hardpointIds.has(entry.hardpointId)) {
      fail("DANGLING_CRITICAL_REFERENCE", `criticalPools.${region}[${index}] references unknown hardpoint '${entry.hardpointId}'.`);
    }
    const component = hasSlot ? slotItems.get(entry.slotId) : hardpointItems.get(entry.hardpointId);
    if (!component) return [];
    const mapped = { ...clone(entry), componentId: component.id };
    delete mapped.slotId;
    delete mapped.hardpointId;
    mapped.id = `${mapped.channelId}:${component.id}${mapped.sector ? `:${mapped.sector}` : ""}`;
    return [mapped];
  })]));
}

/**
 * Materialize a detached rules snapshot from a schema-v2 hull and installed component Items.
 * Authoritative drive components are in `components.drives` and engine tiers are shared.
 */
export function materializeShipConfig(hullConfig, items = []) {
  if (!hullConfig || typeof hullConfig !== "object" || Array.isArray(hullConfig)) fail("HULL_CONFIG_REQUIRED", "Hull config must be an object.");
  if (hullConfig.schemaVersion !== SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA_VERSION", `Expected hull schema version ${SCHEMA_VERSION}.`);
  const hull = clone(hullConfig);
  const itemById = normalizeComponentItems(items);
  const usedItems = new Set();
  const slotItems = new Map();
  const components = { reactor: null, shield: null, sensor: null, cooling: null, drives: {}, weapons: [] };
  const slotIds = new Set();
  const singletonClasses = new Set();

  if (!Array.isArray(hull.slots)) fail("HULL_SLOTS_REQUIRED", "Hull config requires a slots array.");
  for (const slot of hull.slots) {
    assertSlot(slot, slotIds);
    if (slot.class !== "drive") {
      if (singletonClasses.has(slot.class)) fail("DUPLICATE_SINGLETON_SLOT", `Hull defines more than one ${slot.class} slot.`);
      singletonClasses.add(slot.class);
    }
    const item = installedItem(slot.itemId, `slots.${slot.id}.itemId`, itemById);
    if (!item) continue;
    if (usedItems.has(item.id)) fail("DUPLICATE_INSTALLATION", `Component Item '${item.id}' is installed more than once.`);
    usedItems.add(item.id);
    const component = componentFromSlot(slot, item);
    slotItems.set(slot.id, component);
    if (slot.class !== "drive") components[slot.class] = component;
    else {
      const key = slot.driveRole;
      if (components.drives[key]) fail("DUPLICATE_DRIVE_ROLE", `More than one drive occupies '${key}'.`);
      components.drives[key] = component;
    }
  }

  const hardpointItems = new Map();
  const hardpointIds = new Set();
  const hardpoints = [];
  for (const raw of hull.hardpoints ?? []) {
    const hardpoint = clone(raw);
    if (!hardpoint || typeof hardpoint !== "object" || Array.isArray(hardpoint) || typeof hardpoint.id !== "string" || !hardpoint.id.trim()) {
      fail("HARDPOINT_ID_REQUIRED", "Hardpoint requires an ID.");
    }
    if (hardpointIds.has(hardpoint.id) || slotIds.has(hardpoint.id)) fail("DUPLICATE_HULL_SLOT", `Hull mount ID '${hardpoint.id}' is duplicated.`);
    hardpointIds.add(hardpoint.id);
    if (hardpoint.category !== "hardpoint") fail("UNSUPPORTED_SPECIAL_WEAPON", `Hardpoint '${hardpoint.id}' has unsupported category.`);
    if (!MOUNT_SIZES.includes(hardpoint.mountSize)) fail("INVALID_MOUNT_SIZE", `Hardpoint '${hardpoint.id}' has invalid size.`);
    if (!Array.isArray(hardpoint.regions) || hardpoint.regions.some((region) => !SECTORS.includes(region)) || new Set(hardpoint.regions).size !== hardpoint.regions.length) {
      fail("INVALID_HARDPOINT_REGIONS", `Hardpoint '${hardpoint.id}' requires valid, unique regions.`);
    }
    const item = installedItem(hardpoint.weaponId, `hardpoints.${hardpoint.id}.weaponId`, itemById);
    if (!item) {
      hardpoint.weaponId = null;
      hardpoints.push(hardpoint);
      continue;
    }
    if (hardpoint.regions.length === 0) fail("INSTALLED_COMPONENT_REGIONS_REQUIRED", `Occupied hardpoint '${hardpoint.id}' requires at least one region.`);
    if (usedItems.has(item.id)) fail("DUPLICATE_INSTALLATION", `Component Item '${item.id}' is installed more than once.`);
    usedItems.add(item.id);
    if (item.system.componentClass !== "weapon") fail("INCOMPATIBLE_COMPONENT_CLASS", `Item '${item.id}' is not a weapon.`);
    if (item.system.size !== hardpoint.mountSize) fail("HARDPOINT_INCOMPATIBLE", `Weapon '${item.id}' size does not match hardpoint '${hardpoint.id}'.`);
    if (item.system.definition.category !== hardpoint.category) fail("HARDPOINT_INCOMPATIBLE", `Weapon '${item.id}' category does not match hardpoint '${hardpoint.id}'.`);
    const weapon = {
      ...clone(item.system.definition),
      id: item.id,
      label: item.name,
      class: "weapon",
      hardpointId: hardpoint.id,
      mountSize: hardpoint.mountSize,
      regions: clone(hardpoint.regions),
    };
    components.weapons.push(weapon);
    hardpoint.weaponId = item.id;
    hardpointItems.set(hardpoint.id, weapon);
    hardpoints.push(hardpoint);
  }

  if (components.shield) {
    const sectors = components.shield.topology === "bubble" ? ["bubble"] : components.shield.sectors;
    components.shield.emitters = sectors.map((sector) => ({
      id: `${components.shield.id}:${sector}`,
      sector,
      regions: sector === "bubble" ? clone(components.shield.regions) : [sector],
    }));
  }

  const installedDrives = Object.values(components.drives);
  const engineTiers = commonEngineTiers(installedDrives);
  const capabilityProfile = clone(hull.capabilityProfile ?? {});
  capabilityProfile.evasionHardware = (hull.capabilityProfile?.evasionHardware ?? []).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.slotId !== "string" || entry.slotId === "") {
      fail("INVALID_EVASION_HARDWARE", `capabilityProfile.evasionHardware[${index}] requires a slot reference.`);
    }
    if (!slotIds.has(entry.slotId)) {
      fail("DANGLING_EVASION_HARDWARE", `capabilityProfile.evasionHardware[${index}] references unknown slot '${entry.slotId}'.`);
    }
    const component = slotItems.get(entry.slotId);
    return component ? [{ componentId: component.id, channel: entry.channel }] : [];
  });
  const weaponPriority = (hull.weaponPriority ?? []).flatMap((hardpointId, index) => {
    if (typeof hardpointId !== "string" || !hardpointIds.has(hardpointId)) {
      fail("DANGLING_WEAPON_PRIORITY", `weaponPriority[${index}] references an unknown hardpoint.`);
    }
    const weapon = hardpointItems.get(hardpointId);
    return weapon ? [weapon.id] : [];
  });

  const effective = {
    ...hull,
    capabilityProfile,
    components,
    hardpoints,
    weaponPriority,
    criticalPools: mappedCriticalPools(hull.criticalPools, slotItems, hardpointItems, slotIds, hardpointIds),
    powerSystems: { ...clone(hull.powerSystems ?? {}), engines: { tiers: clone(engineTiers) } },
  };
  delete effective.slots;
  return effective;
}
