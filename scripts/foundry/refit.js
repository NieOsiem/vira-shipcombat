import {
  COMPONENT_ITEM_TYPE,
  INTERNAL_REFIT_OPTION,
  INTERNAL_UPDATE_OPTION,
  RuleViolation,
  SECTORS,
} from "../constants.js";
import { CANADENSIS_HULL_CONFIG } from "../data/canadensis.js";
import { CANADENSIS_DEFAULT_COMPONENT_SOURCES } from "../data/canadensis-components.js";
import { createInitialState } from "../model/defaults.js";
import {
  materializeShipConfig,
  normalizeComponentItem,
} from "../model/equipment.js";
import { nativeVehicleFieldValues } from "../model/native-vehicle.js";
import {
  validateComponentItem,
  validateEffectiveLoadout,
} from "../model/validation.js";
import { validateRoster } from "../rules/operators.js";
import { applyPowerShedding } from "../rules/power.js";
import { applyShieldCapacityClamping } from "../rules/shields.js";
import { isActiveGM } from "../socket.js";

const actorQueues = new Map();

function clone(value) {
  if (value === undefined) return undefined;
  if (globalThis.foundry?.utils?.deepClone) {
    return globalThis.foundry.utils.deepClone(value);
  }
  return structuredClone(value);
}

function values(collection) {
  if (!collection) return [];
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection);
}

function componentItems(actor) {
  return values(actor?.items).filter((item) => (
    (item?.type ?? item?._source?.type) === COMPONENT_ITEM_TYPE
  ));
}

function itemId(item) {
  return item?.id ?? item?._id ?? null;
}

function sourceOf(item) {
  if (typeof item?.toObject === "function") return item.toObject(false);
  return item;
}

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function forcedReplacement(value) {
  return globalThis.foundry.data.operators.ForcedReplacement.create(value);
}

function refitOptions(extra = {}) {
  return {
    ...extra,
    [INTERNAL_REFIT_OPTION]: true,
    [INTERNAL_UPDATE_OPTION]: true,
  };
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

function requireRefit(actor) {
  const denial = getRefitDenial(actor);
  if (denial) fail("REFIT_DENIED", denial);
  const { phase, revision } = actor.system.shipCombat.state;
  return { phase, revision };
}

function assertCurrent(actor, observed) {
  requireRefit(actor);
  const current = actor.system.shipCombat.state;
  if (
    current.phase !== observed.phase || current.revision !== observed.revision
  ) {
    fail(
      "STALE_REVISION",
      "Ship state changed while the refit was being prepared. Reload the ship and try again.",
      {
        expected: observed,
        actual: { phase: current.phase, revision: current.revision },
      },
    );
  }
}

function requireStagedRevision(expected) {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    fail(
      "REVISION_REQUIRED",
      "A nonnegative expected ship state revision is required.",
      { expected },
    );
  }
  return expected;
}

function assertStagedRevision(observed, expected) {
  requireStagedRevision(expected);
  if (expected !== observed.revision) {
    fail(
      "STALE_REVISION",
      "Ship state changed after this edit was staged. Close and reopen the editor to reload the current revision.",
      {
        expected,
        actual: observed.revision,
      },
    );
  }
}

function requireValid(validation, code, label) {
  if (!validation.valid) {
    fail(
      code,
      `${label}: ${
        validation.errors.map(({ path, message }) => `${path}: ${message}`)
          .join("; ")
      }`,
      validation.errors,
    );
  }
}

function candidateConfig(actor, hull, items) {
  const effective = materializeShipConfig(hull, items);
  requireValid(
    validateEffectiveLoadout(effective, {
      tokenWidth: actor.token?.width ?? actor.prototypeToken?.width,
    }),
    "INVALID_SHIP_CONFIG",
    "The refit would invalidate this ship",
  );
  return effective;
}

function mountReference(mount) {
  return mount.kind === "slot" ? mount.value.itemId : mount.value.weaponId;
}

function findMount(hull, mountId) {
  const slots = (hull?.slots ?? []).filter((slot) => slot?.id === mountId)
    .map((value) => ({ kind: "slot", value }));
  const hardpoints = (hull?.hardpoints ?? []).filter((hardpoint) =>
    hardpoint?.id === mountId
  )
    .map((value) => ({ kind: "hardpoint", value }));
  const matches = [...slots, ...hardpoints];
  if (matches.length === 0) {
    fail("MOUNT_NOT_FOUND", `Ship mount '${mountId}' does not exist.`, {
      mountId,
    });
  }
  if (matches.length !== 1) {
    fail("DUPLICATE_HULL_SLOT", `Ship mount ID '${mountId}' is duplicated.`, {
      mountId,
    });
  }
  return matches[0];
}

function setMountReference(hull, mountId, reference) {
  const mount = findMount(hull, mountId);
  if (mount.kind === "slot") mount.value.itemId = reference;
  else mount.value.weaponId = reference;
  return mount;
}

function componentSourceForCopy(sourceItem) {
  const raw = sourceOf(sourceItem);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("INVALID_COMPONENT_ITEM", "A ship component Item is required.");
  }
  if (raw.type !== COMPONENT_ITEM_TYPE) {
    fail(
      "INVALID_COMPONENT_ITEM_TYPE",
      "Only ship component Items can be installed.",
    );
  }
  const source = clone({
    name: raw.name,
    img: raw.img,
    type: raw.type,
    system: raw.system,
  });
  const identified = { ...source, _id: raw.id ?? raw._id };
  const normalized = normalizeComponentItem(identified);
  requireValid(
    validateComponentItem(identified),
    "INVALID_COMPONENT_ITEM",
    "The component cannot be installed",
  );
  return { source, catalogId: normalized.id, component: normalized };
}

function installedComponentSource(componentId, sourceItem) {
  const raw = sourceOf(sourceItem);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("INVALID_COMPONENT_ITEM", "A ship component Item source is required.");
  }
  const supplied = raw.id ?? raw._id;
  if (supplied != null && supplied !== componentId) {
    fail(
      "COMPONENT_ID_MISMATCH",
      "An installed component edit must keep its existing Item identity.",
      { itemId: componentId, supplied },
    );
  }
  return componentSourceForCopy({
    ...raw,
    _id: componentId,
    type: raw.type ?? COMPONENT_ITEM_TYPE,
  });
}

function assertCompatible(mount, component) {
  const system = component.system;
  if (mount.kind === "hardpoint") {
    if (system.componentClass !== "weapon") {
      fail(
        "INCOMPATIBLE_COMPONENT_CLASS",
        `Only weapons can occupy hardpoint '${mount.value.id}'.`,
      );
    }
    if (system.size !== mount.value.mountSize) {
      fail(
        "HARDPOINT_INCOMPATIBLE",
        `Weapon size does not match hardpoint '${mount.value.id}'.`,
      );
    }
    if (
      mount.value.category !== "hardpoint" ||
      system.definition.category !== mount.value.category
    ) {
      fail(
        "HARDPOINT_INCOMPATIBLE",
        `Weapon category does not match hardpoint '${mount.value.id}'.`,
      );
    }
    return;
  }

  if (system.componentClass !== mount.value.class) {
    fail(
      "INCOMPATIBLE_COMPONENT_CLASS",
      `Component class does not match slot '${mount.value.id}'.`,
    );
  }
  if (system.size !== mount.value.size) {
    fail(
      "INCOMPATIBLE_COMPONENT_SIZE",
      `Component size does not match slot '${mount.value.id}'.`,
    );
  }
  if (mount.value.class === "drive") {
    const requiredRole =
      ["portLateral", "starboardLateral"].includes(mount.value.driveRole)
        ? "lateral"
        : mount.value.driveRole;
    if (system.driveRole !== requiredRole) {
      fail(
        "INCOMPATIBLE_DRIVE_ROLE",
        `Drive role does not match slot '${mount.value.id}'.`,
      );
    }
  }
}

function mountRecords(hull) {
  return [
    ...(hull?.slots ?? []).map((mount) => ({
      id: mount.id,
      componentClass: mount.class,
      reference: mount.itemId ?? null,
    })),
    ...(hull?.hardpoints ?? []).map((mount) => ({
      id: mount.id,
      componentClass: "weapon",
      reference: mount.weaponId ?? null,
    })),
  ];
}

function changedHardware(beforeHull, afterHull) {
  const before = new Map(
    mountRecords(beforeHull).map((mount) => [mount.id, mount]),
  );
  const after = new Map(
    mountRecords(afterHull).map((mount) => [mount.id, mount]),
  );
  const beforeClasses = new Map();
  const afterClasses = new Map();
  for (const mount of before.values()) {
    if (mount.reference) {
      beforeClasses.set(mount.reference, mount.componentClass);
    }
  }
  for (const mount of after.values()) {
    if (mount.reference) {
      afterClasses.set(mount.reference, mount.componentClass);
    }
  }
  const removedIds = new Set(
    [...beforeClasses.keys()].filter((reference) =>
      !afterClasses.has(reference)
    ),
  );
  const addedIds = new Set(
    [...afterClasses.keys()].filter((reference) =>
      !beforeClasses.has(reference)
    ),
  );
  const replacements = new Map();
  const resetClasses = new Set();

  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldMount = before.get(id);
    const newMount = after.get(id);
    if (oldMount?.reference === newMount?.reference) continue;
    if (
      removedIds.has(oldMount?.reference) && addedIds.has(newMount?.reference)
    ) {
      replacements.set(oldMount.reference, newMount.reference);
    }
    if (removedIds.has(oldMount?.reference)) {
      resetClasses.add(oldMount.componentClass);
    }
    if (addedIds.has(newMount?.reference)) {
      resetClasses.add(newMount.componentClass);
    }
  }
  return { removedIds, replacements, resetClasses };
}

function stringReferences(value, ids) {
  if (typeof value !== "string") return false;
  for (const id of ids) {
    if (value === id || value.split(":").includes(id)) return true;
  }
  return false;
}

function recordReferences(value, ids, seen = new Set()) {
  if (stringReferences(value, ids)) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((child) => recordReferences(child, ids, seen));
  }
  return Object.entries(value).some(([key, child]) =>
    stringReferences(key, ids) ||
    recordReferences(child, ids, seen)
  );
}

function shieldSectors(shield) {
  if (!shield) return [];
  if (shield.topology === "bubble") return [shield.sectors?.[0] ?? "bubble"];
  return [...(shield.sectors ?? SECTORS)];
}

function shieldSectorCap(shield, sector) {
  const value = typeof shield?.sectorCap === "object"
    ? shield.sectorCap?.[sector]
    : shield?.sectorCap;
  const fallback = shield?.topology === "bubble" ? shield?.totalBudget : 0;
  const cap = Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  return Number.isSafeInteger(cap) && cap >= 0 ? cap : 0;
}

function positiveCharge(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function projectShieldCharge(
  beforeCharge,
  beforeSectors,
  sectors,
  caps,
  budget,
) {
  const charge = Object.fromEntries(sectors.map((sector) => [sector, 0]));
  let carried = 0;
  let orphaned = 0;
  for (const sector of beforeSectors) {
    const value = positiveCharge(beforeCharge?.[sector]);
    if (!sectors.includes(sector)) {
      orphaned += value;
      continue;
    }
    const kept = Math.min(value, caps[sector]);
    charge[sector] = kept;
    carried += kept;
  }
  const spare = sectors.reduce(
    (sum, sector) => sum + Math.max(0, caps[sector] - charge[sector]),
    0,
  );
  let remaining = Math.min(orphaned, Math.max(0, budget - carried), spare);
  let cursor = 0;
  let guard = remaining * sectors.length + sectors.length;
  while (remaining > 0 && guard > 0) {
    const sector = sectors[cursor % sectors.length];
    if (charge[sector] < caps[sector]) {
      charge[sector] += 1;
      remaining -= 1;
    }
    cursor += 1;
    guard -= 1;
  }
  return charge;
}

function projectShieldAllocation(beforeAllocation, shield, sectors) {
  if (sectors.length === 0) return {};
  if (shield.topology === "bubble") return { [sectors[0]]: 100 };
  const valid = sectors.every((sector) => {
    const weight = beforeAllocation?.[sector];
    return Number.isSafeInteger(weight) && weight >= 0 && weight <= 100;
  }) && sectors.reduce((sum, sector) =>
        sum + beforeAllocation[sector], 0) === 100;
  if (valid) {
    return Object.fromEntries(
      sectors.map((sector) => [sector, beforeAllocation[sector]]),
    );
  }
  const allocation = Object.fromEntries(sectors.map((sector) => [sector, 0]));
  for (let index = 0; index < 100; index += 1) {
    allocation[sectors[index % sectors.length]] += 1;
  }
  return allocation;
}

function projectShieldCollapse(beforeCollapse, beforeSectors, sectors) {
  const unchanged = sectors.length === beforeSectors.length &&
    sectors.every((sector) => beforeSectors.includes(sector));
  if (unchanged) {
    return Object.fromEntries(
      sectors.map((
        sector,
      ) => [sector, positiveCharge(beforeCollapse?.[sector])]),
    );
  }
  const counter = beforeSectors.reduce(
    (highest, sector) =>
      Math.max(highest, positiveCharge(beforeCollapse?.[sector])),
    0,
  );
  return Object.fromEntries(sectors.map((sector) => [sector, counter]));
}

function shieldLayout(shield) {
  return JSON.stringify({
    topology: shield.topology,
    sectors: shieldSectors(shield),
    totalBudget: shield.totalBudget,
    sectorCap: shield.sectorCap,
  });
}

function reconcileShieldDefinition(state, beforeConfig, config) {
  const beforeShield = beforeConfig?.components?.shield;
  const shield = config?.components?.shield;
  if (
    !beforeShield || !shield ||
    shieldLayout(beforeShield) === shieldLayout(shield)
  ) return;
  const beforeSectors = shieldSectors(beforeShield);
  const sectors = shieldSectors(shield);
  const caps = Object.fromEntries(
    sectors.map((sector) => [sector, shieldSectorCap(shield, sector)]),
  );
  const budget =
    Number.isSafeInteger(shield.totalBudget) && shield.totalBudget >= 0
      ? shield.totalBudget
      : 0;
  state.shields ??= {};
  state.shields.charge = projectShieldCharge(
    state.shields.charge,
    beforeSectors,
    sectors,
    caps,
    budget,
  );
  applyShieldCapacityClamping(config, state);
  state.shields.regenerationAllocation = projectShieldAllocation(
    state.shields.regenerationAllocation,
    shield,
    sectors,
  );
  state.shields.collapse = projectShieldCollapse(
    state.shields.collapse,
    beforeSectors,
    sectors,
  );
}

function reconcileWeaponDefinitions(state, beforeConfig, config) {
  const previous = new Map(
    (beforeConfig?.components?.weapons ?? []).map((
      weapon,
    ) => [weapon.id, weapon]),
  );
  if (previous.size === 0) return;
  for (const weapon of config?.components?.weapons ?? []) {
    if (!previous.has(weapon.id)) continue;
    const current = state.weapons?.[weapon.id];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      continue;
    }
    const capacity = Number.isSafeInteger(weapon.readiness?.capacity) &&
        weapon.readiness.capacity > 0
      ? weapon.readiness.capacity
      : 0;
    current.readiness = Math.min(positiveCharge(current.readiness), capacity);
    if (current.readiness >= capacity) current.reloadProgress = 0;
    if (current.mode === "overclock" && !weapon.modes?.overclock) {
      current.mode = "nominal";
    }
  }
}

function reconcileState(beforeState, config, hardware, previousConfig = null) {
  const state = clone(beforeState ?? {});
  const initial = createInitialState(config);
  const { removedIds, replacements, resetClasses } = hardware;

  const profiles = new Map(
    config.operators.map((operator) => [operator.id, operator]),
  );
  const roster = { ...state.roster };
  for (const kind of ["command", "crew"]) {
    roster[kind] = (state.roster?.[kind] ?? []).map((entry, index) => ({
      ...(typeof entry === "string" ? { operatorId: entry } : entry),
      slot: entry?.slot ?? index,
    })).filter((entry) => {
      const profile = profiles.get(entry.operatorId ?? entry.id);
      return profile && entry.slot < config[`${kind}Capacity`] &&
        ["actorId", "userId"].every((key) =>
          entry[key] == null || profile[key] == null ||
          entry[key] === profile[key]
        );
    });
  }
  const validatedRoster = validateRoster(config, roster);
  state.roster = {
    ...roster,
    command: validatedRoster.command,
    crew: validatedRoster.crew,
  };

  const removedConditionIds = new Set();
  state.conditions = Object.fromEntries(
    Object.entries(state.conditions ?? {}).filter(([key, condition]) => {
      const remove = stringReferences(key, removedIds) ||
        recordReferences(condition, removedIds);
      if (remove) {
        removedConditionIds.add(key);
        if (typeof condition?.id === "string") {
          removedConditionIds.add(condition.id);
        }
      }
      return !remove;
    }),
  );

  const removedRecoveryIdentities = new Set([
    ...removedIds,
    ...removedConditionIds,
  ]);
  state.work = Object.fromEntries(
    Object.entries(state.work ?? {}).filter(([key, job]) => (
      !stringReferences(key, removedRecoveryIdentities) &&
      !recordReferences(job, removedRecoveryIdentities)
    )),
  );
  if (Array.isArray(state.effects)) {
    state.effects = state.effects.filter((effect) =>
      !recordReferences(effect, removedIds)
    );
  }

  const configuredWeaponIds = new Set(
    (config.components?.weapons ?? []).map((weapon) => weapon.id),
  );
  const previousWeapons = state.weapons && typeof state.weapons === "object" &&
      !Array.isArray(state.weapons)
    ? state.weapons
    : {};
  state.weapons = Object.fromEntries([...configuredWeaponIds].map((id) => [
    id,
    Object.hasOwn(previousWeapons, id) && !removedIds.has(id)
      ? clone(previousWeapons[id])
      : clone(initial.weapons[id]),
  ]));

  const priority = [];
  for (const id of state.weaponPriority ?? []) {
    const mapped = replacements.get(id) ?? id;
    if (configuredWeaponIds.has(mapped) && !priority.includes(mapped)) {
      priority.push(mapped);
    }
  }
  for (const id of config.weaponPriority ?? []) {
    if (!priority.includes(id)) priority.push(id);
  }
  state.weaponPriority = priority;

  if (previousConfig) reconcileWeaponDefinitions(state, previousConfig, config);

  if (resetClasses.has("shield")) state.shields = clone(initial.shields);
  else if (previousConfig) {
    reconcileShieldDefinition(state, previousConfig, config);
  }

  if (resetClasses.has("sensor")) state.tracks = {};
  if (resetClasses.has("cooling")) state.ventCooldown = 0;

  state.power = state.power && typeof state.power === "object" &&
      !Array.isArray(state.power)
    ? state.power
    : {};
  const installed = {
    engines: Object.values(config.components?.drives ?? {}).some(Boolean),
    shields: Boolean(config.components?.shield),
    sensors: Boolean(config.components?.sensor),
    cooling: Boolean(config.components?.cooling),
  };
  const tierSources = {
    engines: config.powerSystems?.engines,
    shields: config.components?.shield,
    sensors: config.components?.sensor,
    cooling: config.components?.cooling,
  };
  for (const system of ["engines", "shields", "sensors", "cooling"]) {
    const current = state.power[system];
    const tiers = tierSources[system]?.tiers ?? [];
    const valid = installed[system] &&
      Number.isSafeInteger(current) &&
      current >= 0 &&
      tiers.some((tier) => tier.power === current);
    if (valid) continue;
    if (!installed[system]) {
      state.power[system] = 0;
      continue;
    }
    const preferred = initial.power[system];
    state.power[system] = tiers.some((tier) => tier.power === preferred)
      ? preferred
      : tiers.map((tier) => tier.power)
        .filter((power) => Number.isSafeInteger(power) && power >= 0)
        .sort((left, right) => left - right)[0];
  }
  if (!Number.isSafeInteger(state.power.weapons) || state.power.weapons < 0) {
    state.power.weapons = initial.power.weapons;
  }

  const preservedHeat = state.heat;
  state.power.redlining = true;
  applyPowerShedding(config, state);
  state.heat = preservedHeat;
  state.revision = Number.isInteger(beforeState?.revision)
    ? beforeState.revision + 1
    : 1;
  return state;
}

function hullWithoutComponentPayload(hullConfig) {
  if (
    !hullConfig || typeof hullConfig !== "object" || Array.isArray(hullConfig)
  ) {
    fail("HULL_CONFIG_REQUIRED", "Hull config must be an object.");
  }
  if (Object.hasOwn(hullConfig, "components")) {
    fail(
      "HULL_COMPONENT_PAYLOAD_FORBIDDEN",
      "Hull JSON cannot contain raw component definitions.",
    );
  }
  return clone(hullConfig);
}

function itemsIncluding(actor, created = []) {
  const byId = new Map(
    componentItems(actor).map((item) => [itemId(item), item]),
  );
  for (const item of created) byId.set(itemId(item), item);
  return [...byId.values()];
}

async function deleteItems(actor, ids) {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (unique.length === 0) return [];
  return actor.deleteEmbeddedDocuments("Item", unique, refitOptions());
}

async function deleteReplacedItems(actor, ids) {
  try {
    await deleteItems(actor, ids);
  } catch (cause) {
    const error = new Error(
      "Refit applied; removing the replaced Item failed — remove it from the ship sheet",
      { cause },
    );
    error.code = "REFIT_CLEANUP_FAILED";
    throw error;
  }
}

async function createFreshItems(actor, prepared) {
  const created = await actor.createEmbeddedDocuments(
    "Item",
    prepared.map(({ source }) => source),
    refitOptions(),
  );
  if (!Array.isArray(created) || created.length !== prepared.length) {
    const ids = values(created).map(itemId).filter(Boolean);
    await deleteItems(actor, ids);
    fail(
      "COMPONENT_COPY_FAILED",
      "Foundry did not create every requested component copy.",
    );
  }
  const ids = created.map(itemId);
  if (
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => id === prepared[index].catalogId)
  ) {
    await deleteItems(actor, ids);
    fail(
      "COMPONENT_COPY_NOT_FRESH",
      "Installed components must receive fresh independent IDs.",
    );
  }
  return { created, prepared };
}

async function updateShip(
  actor,
  hull,
  state,
  effective,
  observed,
  itemUpdates = null,
) {
  assertCurrent(actor, observed);
  const updated = await actor.update({
    "system.shipCombat.config": forcedReplacement(hull),
    "system.shipCombat.state": forcedReplacement(state),
    ...(itemUpdates ? { items: itemUpdates } : {}),
    ...nativeVehicleFieldValues(effective, state),
  }, refitOptions({ diff: false }));
  if (!updated) {
    throw new RuleViolation(
      "REFIT_UPDATE_FAILED",
      "Foundry did not persist the ship refit.",
    );
  }
}

function referencedItemIds(hull) {
  return mountRecords(hull).map((mount) => mount.reference).filter(Boolean);
}

function installedMountId(hull, componentId) {
  const mount = mountRecords(hull).find((candidate) =>
    candidate.reference === componentId
  );
  return mount?.id ?? null;
}

/** Return a user-facing denial, or an empty string when this client may refit the ship. */
export function getRefitDenial(actor) {
  if (!isActiveGM()) return "Only the active GM may refit ship components.";
  if (actor?.system?.shipCombat?.state?.phase !== "outsideCombat") {
    return "Ship components can only be refitted outside combat.";
  }
  return "";
}

/** Materialize the Actor's detached effective rules configuration from its embedded component Items. */
export function materializeActorConfig(actor) {
  return materializeShipConfig(
    actor?.system?.shipCombat?.config,
    componentItems(actor),
  );
}

async function confirmComponentRemoval(actor, mount, action) {
  const reference = mountReference(mount);
  const item = values(actor.items).find((entry) => itemId(entry) === reference);
  const componentClass = mount.kind === "hardpoint"
    ? "weapon"
    : mount.value.class;
  let warning =
    "This permanently deletes the mounted component Item and its customization, conditions, recovery work, and related effects.";
  if (componentClass === "weapon") {
    warning +=
      " Its reload/readiness state is lost; a replacement starts with fresh weapon state.";
  }
  if (componentClass === "shield") {
    warning +=
      " All shield charge, allocation, collapse, and recharge state resets.";
  }
  if (componentClass === "sensor") warning += " All sensor tracks are cleared.";
  if (componentClass === "cooling") warning += " Vent cooldown resets to zero.";
  return foundry.applications.api.DialogV2.confirm({
    window: { title: `${action} ${item?.name ?? reference}?` },
    content: `<p>${warning}</p><p>Continue?</p>`,
    defaultYes: false,
    rejectClose: false,
  });
}

/** Install a fresh embedded copy of a reusable component Item into one hull mount. */
export function installShipComponent(actor, mountId, sourceItem) {
  return serializeActor(actor, async () => {
    const observed = requireRefit(actor);
    const beforeHull = clone(actor.system.shipCombat.config);
    const mount = findMount(beforeHull, mountId);
    const prepared = componentSourceForCopy(sourceItem);
    assertCompatible(mount, prepared.component);
    const oldId = mountReference(mount);
    if (oldId && !await confirmComponentRemoval(actor, mount, "Replace")) {
      return null;
    }
    assertCurrent(actor, observed);

    const { created } = await createFreshItems(actor, [prepared]);
    const fresh = created[0];
    const freshId = itemId(fresh);
    const hull = clone(beforeHull);
    setMountReference(hull, mountId, freshId);

    try {
      const effective = candidateConfig(
        actor,
        hull,
        itemsIncluding(actor, created),
      );
      const state = reconcileState(
        actor.system.shipCombat.state,
        effective,
        changedHardware(beforeHull, hull),
      );
      await updateShip(actor, hull, state, effective, observed);
    } catch (error) {
      await deleteItems(actor, [freshId]);
      throw error;
    }

    if (oldId) await deleteReplacedItems(actor, [oldId]);
    return fresh;
  });
}

/** Clear one hull mount before deleting its formerly referenced embedded Item. */
export function removeShipComponent(actor, mountId) {
  return serializeActor(actor, async () => {
    const observed = requireRefit(actor);
    const beforeHull = clone(actor.system.shipCombat.config);
    const mount = findMount(beforeHull, mountId);
    const oldId = mountReference(mount);
    if (!oldId) return null;
    const oldItem = values(actor.items).find((item) =>
      itemId(item) === oldId
    ) ?? null;
    if (!await confirmComponentRemoval(actor, mount, "Remove")) return null;
    assertCurrent(actor, observed);
    const hull = clone(beforeHull);
    setMountReference(hull, mountId, null);
    const effective = candidateConfig(actor, hull, componentItems(actor));
    const state = reconcileState(
      actor.system.shipCombat.state,
      effective,
      changedHardware(beforeHull, hull),
    );
    await updateShip(actor, hull, state, effective, observed);
    await deleteReplacedItems(actor, [oldId]);
    return oldItem;
  });
}

/** Persist hull-only advanced JSON and reconcile only state local to changed hardware. Requires the state revision captured with the staged hull draft. */
export function saveShipHull(actor, hullConfig, expectedRevision) {
  return serializeActor(actor, async () => {
    const observed = requireRefit(actor);
    assertStagedRevision(observed, expectedRevision);
    const beforeHull = clone(actor.system.shipCombat.config);
    const hull = hullWithoutComponentPayload(hullConfig);
    const effective = candidateConfig(actor, hull, componentItems(actor));
    const state = reconcileState(
      actor.system.shipCombat.state,
      effective,
      changedHardware(beforeHull, hull),
    );
    await updateShip(actor, hull, state, effective, observed);
    return effective;
  });
}

/** Edit one installed component's definition while preserving its embedded Item identity. Requires the state revision captured with the staged component draft. */
export function saveInstalledShipComponent(
  actor,
  itemIdValue,
  sourceItem,
  expectedRevision,
) {
  return serializeActor(actor, async () => {
    const observed = requireRefit(actor);
    assertStagedRevision(observed, expectedRevision);
    if (typeof itemIdValue !== "string" || itemIdValue === "") {
      fail(
        "COMPONENT_ID_REQUIRED",
        "An installed component Item ID is required.",
      );
    }
    const beforeHull = clone(actor.system.shipCombat.config);
    const mountId = installedMountId(beforeHull, itemIdValue);
    if (!mountId) {
      fail(
        "COMPONENT_NOT_INSTALLED",
        `Component Item '${itemIdValue}' is not installed on this ship.`,
        { itemId: itemIdValue },
      );
    }
    const itemExists = () =>
      values(actor.items).some((candidate) =>
        itemId(candidate) === itemIdValue
      );
    if (!itemExists()) {
      fail(
        "COMPONENT_ITEM_MISSING",
        `Component Item '${itemIdValue}' does not exist.`,
        { itemId: itemIdValue },
      );
    }
    const prepared = installedComponentSource(itemIdValue, sourceItem);
    assertCompatible(findMount(beforeHull, mountId), prepared.component);
    const beforeEffective = materializeShipConfig(
      beforeHull,
      componentItems(actor),
    );
    const hull = clone(beforeHull);
    const prospective = { ...prepared.source, _id: itemIdValue };
    const effective = candidateConfig(
      actor,
      hull,
      itemsIncluding(actor, [prospective]),
    );
    const state = reconcileState(
      actor.system.shipCombat.state,
      effective,
      changedHardware(beforeHull, hull),
      beforeEffective,
    );
    if (
      !itemExists() ||
      installedMountId(actor.system.shipCombat.config, itemIdValue) !== mountId
    ) {
      fail(
        "STALE_REVISION",
        "Component Item installation changed while the edit was being prepared. Reload the ship and try again.",
        {
          itemId: itemIdValue,
          mountId,
        },
      );
    }
    await updateShip(actor, hull, state, effective, observed, [{
      _id: itemIdValue,
      name: prepared.source.name,
      img: prepared.source.img,
      "system.schemaVersion": prepared.source.system.schemaVersion,
      "system.componentClass": prepared.source.system.componentClass,
      "system.size": prepared.source.system.size,
      "system.driveRole": prepared.source.system.driveRole,
      "system.definition": forcedReplacement(prepared.source.system.definition),
    }]);
    return values(actor.items).find((candidate) =>
      itemId(candidate) === itemIdValue
    ) ?? null;
  });
}

/** Replace every mount with fresh copies of the twelve bundled Canadensis component sources. */
export function resetShipToCanadensis(actor) {
  return serializeActor(actor, async () => {
    const observed = requireRefit(actor);
    const beforeHull = clone(actor.system.shipCombat.config);
    const { created, prepared } = await createFreshItems(
      actor,
      CANADENSIS_DEFAULT_COMPONENT_SOURCES.map(componentSourceForCopy),
    );
    const freshIds = new Map(
      prepared.map((
        { catalogId },
        index,
      ) => [catalogId, itemId(created[index])]),
    );
    const hull = clone(CANADENSIS_HULL_CONFIG);
    for (const slot of hull.slots) slot.itemId = freshIds.get(slot.itemId);
    for (const hardpoint of hull.hardpoints) {
      hardpoint.weaponId = freshIds.get(hardpoint.weaponId);
    }

    let effective;
    try {
      effective = candidateConfig(actor, hull, itemsIncluding(actor, created));
      const state = reconcileState(
        actor.system.shipCombat.state,
        effective,
        changedHardware(beforeHull, hull),
      );
      await updateShip(actor, hull, state, effective, observed);
    } catch (error) {
      await deleteItems(actor, created.map(itemId));
      throw error;
    }

    const freshIdSet = new Set(created.map(itemId));
    await deleteReplacedItems(
      actor,
      referencedItemIds(beforeHull).filter((id) => !freshIdSet.has(id)),
    );
    return effective;
  });
}
