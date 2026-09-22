import {
  COMPONENT_CLASSES,
  COMPONENT_ITEM_TYPE,
  DRIVE_ROLES,
  MODULE_ID,
  MOUNT_SIZES,
  PROJECTILE_CLASSES,
  READINESS_RECOVERY,
  READINESS_TYPES,
  SCHEMA_VERSION,
  SECTORS,
} from "../constants.js";
import { materializeShipConfig } from "../model/equipment.js";
import {
  validateComponentItem,
  validateEffectiveLoadout,
} from "../model/validation.js";
import { isActiveGM } from "../socket.js";
import { saveInstalledShipComponent } from "./refit.js";

const FIRING_HEAT_UNITS = Object.freeze(["shot", "physicalRound"]);
const SHIELD_TOPOLOGIES = Object.freeze(["directional", "bubble"]);

function clone(value) {
  return foundry.utils.deepClone(value ?? {});
}

function itemSystem(item) {
  return clone(
    typeof item?.system?.toObject === "function"
      ? item.system.toObject()
      : item?.system,
  );
}

function itemSource(item) {
  return { name: item?.name, img: item?.img, system: itemSystem(item) };
}

function sourceFingerprint(item) {
  return JSON.stringify(itemSource(item));
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return [...collection.values()];
  return Array.from(collection);
}

function validationError(label, validation) {
  const details = validation.errors.map(({ path, message }) =>
    `${path}: ${message}`
  ).join(" ");
  const error = new TypeError(`${label}: ${details}`);
  error.validationLabel = label;
  error.validationErrors = validation.errors;
  return error;
}

function isInstalledComponent(item) {
  const actor = item?.parent;
  const itemId = item?.id ?? item?._id;
  const hull = actor?.system?.shipCombat?.config;
  return actor?.documentName === "Actor" &&
    typeof itemId === "string" &&
    ((hull?.slots ?? []).some((slot) => slot?.itemId === itemId) ||
      (hull?.hardpoints ?? []).some((hardpoint) =>
        hardpoint?.weaponId === itemId
      ));
}

function validateProspectiveComponent(item, source, inputErrors = []) {
  const componentValidation = validateComponentItem(source);
  const errors = [...inputErrors, ...componentValidation.errors];
  if (errors.length) {
    throw validationError("Invalid ship component", { errors });
  }

  const actor = item?.parent;
  const itemId = item?.id ?? item?._id;
  const hull = actor?.system?.shipCombat?.config;
  if (!isInstalledComponent(item)) return;

  const items = collectionValues(actor.items)
    .filter((candidate) => candidate?.type === COMPONENT_ITEM_TYPE)
    .map((candidate) => (candidate.id === itemId ? source : candidate));
  const effective = materializeShipConfig(hull, items);
  const loadoutValidation = validateEffectiveLoadout(effective, {
    tokenWidth: 1,
  });
  if (!loadoutValidation.valid) {
    throw validationError(
      "Component would invalidate this ship",
      loadoutValidation,
    );
  }
}

function optionList(values, selected) {
  return values.map((value) => ({
    value,
    label: value === ""
      ? "None"
      : value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) =>
        letter.toUpperCase()),
    selected: value === selected,
  }));
}

function packIsLocked(item) {
  if (!item?.pack) return false;
  const pack = item.compendium ?? game.packs?.get(item.pack);
  return pack?.locked !== false;
}

function embeddedShipInCombat(item) {
  const actor = item?.parent;
  if (!actor || actor.documentName !== "Actor") return false;
  const phase = actor.system?.shipCombat?.state?.phase;
  return typeof phase === "string" && phase !== "outsideCombat";
}

export function componentEditDenial(item) {
  if (!isActiveGM()) return "Only the active GM may edit ship components.";
  if (packIsLocked(item)) return "This compendium is locked.";
  if (embeddedShipInCombat(item)) {
    return "Embedded ship components cannot be edited while their ship is in combat.";
  }
  return "";
}

function defaultDefinition(componentClass) {
  switch (componentClass) {
    case "reactor":
      return {
        nominalOutput: 0,
        redlineOutput: 0,
        overclockHeat: 0,
        recoveryWork: 0,
      };
    case "drive":
      return { base: { thrust: 0, rotation: 0 }, tiers: [], recoveryWork: 0 };
    case "shield":
      return {
        topology: "directional",
        sectors: [...SECTORS],
        totalBudget: 0,
        sectorCap: 0,
        rechargeDelay: 0,
        tiers: [],
        recoveryWork: 0,
      };
    case "sensor":
      return {
        base: {
          passiveRange: 0,
          passiveStrength: 0,
          activeRange: 0,
          activeModifier: 0,
          ewModifier: 0,
        },
        tiers: [],
        recoveryWork: 0,
      };
    case "cooling":
      return { tiers: [], ventAmount: 0, ventCooldown: 0, recoveryWork: 0 };
    case "inertia":
      return { tiers: [], recoveryWork: 0 };
    case "weapon":
      return {
        accuracy: 0,
        damage: { shield: 0, hull: 0, heat: 0 },
        armorPiercing: 0,
        projectileClass: "medium",
        range: { optimal: 0, maximum: 0 },
        arc: 0,
        powerRating: 0,
        bootTime: 0,
        firingHeat: { amount: 0, per: "shot" },
        signatureSpike: 0,
        recoveryWork: 0,
        readiness: {
          type: "readyShot",
          capacity: 1,
          recovery: "automaticStart",
          eligibleStarts: 1,
        },
        traits: [],
        modes: { nominal: { overrides: {} } },
      };
    default:
      return {};
  }
}

function tierDefault(componentClass) {
  switch (componentClass) {
    case "drive":
      return { power: 0, multiplier: 0, online: false };
    case "shield":
      return { power: 0, online: false, regeneration: 0 };
    case "sensor":
      return {
        power: 0,
        online: false,
        rangeMultiplier: 0,
        passiveStrength: 0,
        activeModifier: 0,
        ewModifier: 0,
      };
    case "cooling":
      return { power: 0, cooling: 0 };
    case "inertia":
      return { power: 0, online: false, pivot: 0 };
    default:
      return null;
  }
}

function field(form, name) {
  return form.elements.namedItem(name);
}

function validationField(form, path, source) {
  const name = path.replace(/^system\.definition\./, "definition.");
  const direct = field(form, name);
  if (direct) return direct;
  const tier = /^definition\.tiers(?:\[(\d+)\](?:\.(\w+))?)?$/.exec(name);
  if (tier) {
    const row = form.querySelectorAll("[data-tier-row]")[Number(tier[1] ?? 0)];
    return row?.querySelector(`[data-tier-field="${tier[2] ?? "power"}"]`) ??
      form.querySelector('[data-row-action="add-tier"]');
  }
  const trait = /^definition\.traits\[(\d+)\](?:\.(.*))?$/.exec(name);
  if (trait) {
    const id = source?.system?.definition?.traits?.[Number(trait[1])]?.id;
    const profile = /^profiles(?:\[(\d+)\](?:\.(\w+))?)?$/.exec(trait[2] ?? "");
    if (id === "barrage" && profile) {
      const row =
        form.querySelectorAll("[data-barrage-row]")[Number(profile[1] ?? 0)];
      return row?.querySelector(":invalid") ??
        row?.querySelector(
          `[data-barrage-field="${profile[2] ?? "rounds"}"]`,
        ) ??
        form.querySelector('[data-row-action="add-barrage"]');
    }
    if (id === "shieldBypass" && trait[2] === "channels") {
      return field(form, "trait.shieldBypass.hull");
    }
    return field(form, `trait.${id}`);
  }
  const mode = /^definition\.modes\.overclock(?:\.overrides(?:\.(.*))?)?$/.exec(
    name,
  );
  const group = mode ? `mode.overclock.${mode[1] ?? "enabled"}` : name;
  const controls = Array.from(form.querySelectorAll("[name]"))
    .filter((input) =>
      input.name === group || input.name.startsWith(`${group}.`)
    );
  return controls.find((input) => input.matches(":invalid")) ?? controls[0];
}

function showValidationSummary(form, error, source) {
  form.querySelector("[data-validation-summary]")?.remove();
  form.querySelectorAll('[aria-invalid="true"]').forEach((input) =>
    input.removeAttribute("aria-invalid")
  );
  const summary = document.createElement("section");
  summary.dataset.validationSummary = "";
  summary.className = "ship-component-validation";
  summary.setAttribute("role", "alert");
  summary.setAttribute("aria-label", "Component save errors");
  summary.tabIndex = -1;
  const heading = document.createElement("p");
  heading.textContent = error.validationLabel ?? error?.message ??
    String(error);
  summary.append(heading);
  let firstInvalid;
  if (error.validationErrors?.length) {
    const list = document.createElement("ul");
    for (const issue of error.validationErrors) {
      const entry = document.createElement("li");
      entry.textContent = `${issue.path}: ${issue.message}`;
      list.append(entry);
      const input = issue.control ?? validationField(form, issue.path, source);
      if (input && !input.matches(":disabled")) {
        input.setAttribute("aria-invalid", "true");
        firstInvalid ??= input;
      }
    }
    summary.append(list);
  }
  (form.querySelector("[data-component-form]") ?? form).prepend(summary);
  (firstInvalid ?? summary).focus();
}

function text(form, name, fallback = "") {
  const el = field(form, name);
  if (!el) return fallback;
  return String(el.value ?? fallback).trim();
}

function number(form, name, fallback = 0) {
  const el = field(form, name);
  if (!el) return fallback;
  const raw = el.value;
  if (raw === "" || raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(form, name) {
  const el = field(form, name);
  if (!el) return undefined;
  const raw = el.value;
  if (raw === "" || raw == null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function checked(form, name) {
  return field(form, name)?.checked === true;
}

function normalizeTiers(form, componentClass, existingTiers = []) {
  const rows = form.querySelectorAll("[data-tier-row]");
  if (!rows.length) return clone(existingTiers);
  return Array.from(rows).map(
    (row, index) => {
      const tier = clone(
        existingTiers[index] ?? tierDefault(componentClass) ?? {},
      );
      const read = (name, fallback = 0) => {
        const raw = row.querySelector(`[data-tier-field="${name}"]`)?.value;
        const parsed = Number(raw);
        return raw !== "" && Number.isFinite(parsed) ? parsed : fallback;
      };
      const bool = (name) =>
        row.querySelector(`[data-tier-field="${name}"]`)?.checked === true;
      if (componentClass === "drive") {
        tier.power = read("power");
        tier.multiplier = read("multiplier");
        tier.online = bool("online");
      } else if (componentClass === "shield") {
        tier.power = read("power");
        tier.online = bool("online");
        tier.regeneration = read("regeneration");
      } else if (componentClass === "sensor") {
        tier.power = read("power");
        tier.online = bool("online");
        tier.rangeMultiplier = read("rangeMultiplier");
        tier.passiveStrength = read("passiveStrength");
        tier.activeModifier = read("activeModifier");
        tier.ewModifier = read("ewModifier");
      } else if (componentClass === "inertia") {
        tier.power = read("power");
        tier.online = bool("online");
        tier.pivot = read("pivot");
      } else {
        tier.power = read("power");
        tier.cooling = read("cooling");
        return tier;
      }
      if (bool("overclock")) {
        tier.overclock = true;
        tier.overclockHeat = read("overclockHeat");
      } else {
        delete tier.overclock;
        delete tier.overclockHeat;
      }
      return tier;
    },
  );
}

function normalizeWeaponTraits(form, existingTraits = []) {
  if (!form.querySelector('[name^="trait."]')) return clone(existingTraits);
  const supportedIds = ["nonLethal", "shieldBypass", "barrage", "vicious"];
  const existingById = new Map();
  for (const trait of existingTraits) {
    const id = typeof trait === "string" ? trait : trait?.id;
    if (supportedIds.includes(id) && !existingById.has(id)) {
      existingById.set(id, trait);
    }
  }

  const replacements = new Map();
  if (checked(form, "trait.nonLethal")) {
    replacements.set("nonLethal", { id: "nonLethal" });
  }
  if (checked(form, "trait.shieldBypass")) {
    const existing = clone(existingById.get("shieldBypass"));
    const channels = ["hull", "heat"].filter((channel) =>
      checked(form, `trait.shieldBypass.${channel}`)
    );
    delete existing.hull;
    delete existing.heat;
    delete existing.params;
    replacements.set("shieldBypass", {
      ...existing,
      id: "shieldBypass",
      channels,
      damageShield: checked(form, "trait.shieldBypass.damageShield"),
    });
  }
  if (checked(form, "trait.barrage")) {
    const existingProfiles = existingById.get("barrage")?.profiles ?? [];
    const profiles = Array.from(form.querySelectorAll("[data-barrage-row]"))
      .map((row, index) => {
        const profile = clone(existingProfiles[index]);
        const read = (name) => {
          const raw = row.querySelector(`[data-barrage-field="${name}"]`)
            ?.value;
          const parsed = Number(raw);
          return raw !== "" && Number.isFinite(parsed) ? parsed : 0;
        };
        profile.rounds = read("rounds");
        profile.attackPenalty = read("attackPenalty");
        profile.maxEffectiveHits = read("maxEffectiveHits");
        return profile;
      });
    replacements.set("barrage", {
      ...clone(existingById.get("barrage")),
      id: "barrage",
      profiles,
    });
  }
  if (checked(form, "trait.vicious")) {
    replacements.set("vicious", { id: "vicious" });
  }

  const traits = [];
  const emitted = new Set();
  for (const trait of existingTraits) {
    const id = typeof trait === "string" ? trait : trait?.id;
    if (!supportedIds.includes(id)) {
      traits.push(clone(trait));
    } else if (!emitted.has(id) && replacements.has(id)) {
      traits.push(replacements.get(id));
      emitted.add(id);
    }
  }
  for (const id of supportedIds) {
    if (replacements.has(id) && !emitted.has(id)) {
      traits.push(replacements.get(id));
    }
  }
  return traits;
}

function setOptionalNumber(object, key, form, fieldName) {
  const el = field(form, fieldName);
  if (!el) return;
  const value = optionalNumber(form, fieldName);
  if (value === undefined) delete object[key];
  else object[key] = value;
}

function normalizeWeaponModes(form, existingModes = {}) {
  const modes = clone(existingModes);
  if (!field(form, "mode.overclock.enabled")) {
    return modes;
  }
  if (!modes.nominal || typeof modes.nominal !== "object") {
    modes.nominal = { overrides: {} };
  }
  if (!checked(form, "mode.overclock.enabled")) {
    delete modes.overclock;
    return modes;
  }

  const overclock = clone(modes.overclock);
  const overrides = clone(overclock.overrides);
  setOptionalNumber(
    overrides,
    "powerRating",
    form,
    "mode.overclock.powerRating",
  );
  setOptionalNumber(overrides, "accuracy", form, "mode.overclock.accuracy");

  const damage = clone(overrides.damage);
  for (const key of ["shield", "hull", "heat"]) {
    setOptionalNumber(damage, key, form, `mode.overclock.damage.${key}`);
  }
  if (Object.keys(damage).length) overrides.damage = damage;
  else delete overrides.damage;

  const firingHeat = clone(overrides.firingHeat);
  setOptionalNumber(
    firingHeat,
    "amount",
    form,
    "mode.overclock.firingHeat.amount",
  );
  const heatPer = text(form, "mode.overclock.firingHeat.per");
  if (heatPer) firingHeat.per = heatPer;
  else delete firingHeat.per;
  if (Object.keys(firingHeat).length) overrides.firingHeat = firingHeat;
  else delete overrides.firingHeat;

  overclock.overrides = overrides;
  modes.overclock = overclock;
  return modes;
}

function normalizeWeapon(form, existingDefinition) {
  const definition = clone(existingDefinition ?? defaultDefinition("weapon"));
  const readiness = clone(definition.readiness ?? {});
  readiness.type = text(form, "definition.readiness.type", readiness.type ?? "readyShot");
  readiness.capacity = number(form, "definition.readiness.capacity", readiness.capacity ?? 1);
  readiness.recovery = text(
    form,
    "definition.readiness.recovery",
    readiness.recovery ?? "automaticStart",
  );
  setOptionalNumber(readiness, "work", form, "definition.readiness.work");
  setOptionalNumber(
    readiness,
    "eligibleStarts",
    form,
    "definition.readiness.eligibleStarts",
  );

  definition.category = "hardpoint";
  definition.accuracy = number(form, "definition.accuracy", definition.accuracy ?? 0);
  definition.damage = clone(definition.damage ?? {});
  definition.damage.shield = number(form, "definition.damage.shield", definition.damage?.shield ?? 0);
  definition.damage.hull = number(form, "definition.damage.hull", definition.damage?.hull ?? 0);
  definition.damage.heat = number(form, "definition.damage.heat", definition.damage?.heat ?? 0);
  definition.armorPiercing = number(form, "definition.armorPiercing", definition.armorPiercing ?? 0);
  definition.projectileClass = text(
    form,
    "definition.projectileClass",
    definition.projectileClass ?? "medium",
  );
  definition.range = clone(definition.range ?? {});
  definition.range.optimal = number(form, "definition.range.optimal", definition.range?.optimal ?? 0);
  definition.range.maximum = number(form, "definition.range.maximum", definition.range?.maximum ?? 0);
  definition.arc = number(form, "definition.arc", definition.arc ?? 0);
  definition.powerRating = number(form, "definition.powerRating", definition.powerRating ?? 0);
  definition.bootTime = number(form, "definition.bootTime", definition.bootTime ?? 0);
  definition.firingHeat = clone(definition.firingHeat ?? {});
  definition.firingHeat.amount = number(form, "definition.firingHeat.amount", definition.firingHeat?.amount ?? 0);
  definition.firingHeat.per = text(form, "definition.firingHeat.per", definition.firingHeat?.per ?? "shot");
  definition.signatureSpike = number(form, "definition.signatureSpike", definition.signatureSpike ?? 0);
  definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
  definition.readiness = readiness;
  definition.traits = normalizeWeaponTraits(form, definition.traits ?? []);
  definition.modes = normalizeWeaponModes(form, definition.modes);
  return definition;
}

function normalizeDefinition(form, componentClass, existingDefinition) {
  const definition = clone(existingDefinition ?? defaultDefinition(componentClass));
  if (componentClass === "reactor") {
    definition.nominalOutput = number(form, "definition.nominalOutput", definition.nominalOutput ?? 0);
    definition.redlineOutput = number(form, "definition.redlineOutput", definition.redlineOutput ?? 0);
    definition.overclockHeat = number(form, "definition.overclockHeat", definition.overclockHeat ?? 0);
    definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
  } else if (componentClass === "drive") {
    definition.base = clone(definition.base ?? {});
    definition.base.thrust = number(form, "definition.base.thrust", definition.base?.thrust ?? 0);
    definition.base.rotation = number(form, "definition.base.rotation", definition.base?.rotation ?? 0);
    definition.tiers = normalizeTiers(form, componentClass, definition.tiers);
    definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
  } else if (componentClass === "shield") {
    definition.topology = text(form, "definition.topology", definition.topology ?? "directional");
    definition.sectors = definition.topology === "bubble"
      ? ["bubble"]
      : [...SECTORS];
    definition.totalBudget = number(form, "definition.totalBudget", definition.totalBudget ?? 0);
    definition.sectorCap = number(form, "definition.sectorCap", definition.sectorCap ?? 0);
    definition.rechargeDelay = number(form, "definition.rechargeDelay", definition.rechargeDelay ?? 0);
    definition.tiers = normalizeTiers(form, componentClass, definition.tiers);
    definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
    delete definition.emitters;
  } else if (componentClass === "sensor") {
    definition.base = clone(definition.base ?? {});
    definition.base.passiveRange = number(form, "definition.base.passiveRange", definition.base?.passiveRange ?? 0);
    definition.base.passiveStrength = number(
      form,
      "definition.base.passiveStrength",
      definition.base?.passiveStrength ?? 0,
    );
    definition.base.activeRange = number(form, "definition.base.activeRange", definition.base?.activeRange ?? 0);
    definition.base.activeModifier = number(
      form,
      "definition.base.activeModifier",
      definition.base?.activeModifier ?? 0,
    );
    definition.base.ewModifier = number(form, "definition.base.ewModifier", definition.base?.ewModifier ?? 0);
    definition.tiers = normalizeTiers(form, componentClass, definition.tiers);
    definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
  } else if (componentClass === "cooling") {
    definition.tiers = normalizeTiers(form, componentClass, definition.tiers);
    definition.ventAmount = number(form, "definition.ventAmount", definition.ventAmount ?? 0);
    definition.ventCooldown = number(form, "definition.ventCooldown", definition.ventCooldown ?? 0);
    definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
  } else if (componentClass === "inertia") {
    definition.tiers = normalizeTiers(form, componentClass, definition.tiers);
    definition.recoveryWork = number(form, "definition.recoveryWork", definition.recoveryWork ?? 0);
  } else if (componentClass === "weapon") {
    return normalizeWeapon(form, definition);
  }
  return definition;
}

function normalizeForm(form, forcedClass = null, existingSource = {}) {
  const source = clone(existingSource);
  const system = clone(source.system);
  const componentClass = forcedClass ??
    (field(form, "system.componentClass") ? text(form, "system.componentClass") : (system.componentClass ?? "reactor"));
  system.schemaVersion = SCHEMA_VERSION;
  system.componentClass = componentClass;
  system.size = field(form, "system.size") ? text(form, "system.size") : (system.size ?? "medium");
  system.driveRole = componentClass === "drive"
    ? (field(form, "system.driveRole") ? text(form, "system.driveRole") : (system.driveRole ?? ""))
    : "";
  system.definition = normalizeDefinition(
    form,
    componentClass,
    system.definition,
  );

  const descField = field(form, "system.description.value");
  const descriptionValue = descField ? descField.value : (system.description?.value ?? "");
  system.description = {
    value: descriptionValue,
    chat: system.description?.chat ?? "",
  };

  const priceVal = field(form, "system.price.value");
  system.price = {
    value: priceVal ? number(form, "system.price.value") : (system.price?.value ?? 0),
    denomination: field(form, "system.price.denomination")
      ? text(form, "system.price.denomination")
      : (system.price?.denomination ?? "gp"),
  };

  const weightVal = field(form, "system.weight.value");
  system.weight = {
    value: weightVal ? number(form, "system.weight.value") : (system.weight?.value ?? 0),
    units: field(form, "system.weight.units")
      ? text(form, "system.weight.units")
      : (system.weight?.units ?? "tn"),
  };

  const qtyVal = field(form, "system.quantity");
  system.quantity = qtyVal ? number(form, "system.quantity", 1) : (system.quantity ?? 1);

  const rarityVal = field(form, "system.rarity");
  system.rarity = rarityVal ? text(form, "system.rarity") : (system.rarity ?? "");

  const nameVal = field(form, "name");
  const imgVal = field(form, "img");

  return {
    ...source,
    name: nameVal ? text(form, "name", source.name || "Ship Component") : (source.name || "Ship Component"),
    img: imgVal ? text(form, "img", source.img || "icons/svg/item-bag.svg") : (source.img || "icons/svg/item-bag.svg"),
    system,
  };
}

function traitById(definition, id) {
  return (definition?.traits ?? []).find((trait) =>
    (typeof trait === "string" ? trait : trait?.id) === id
  );
}

function viewDefinition(system) {
  const definition = clone(
    system.definition ?? defaultDefinition(system.componentClass),
  );
  definition.tiers = (definition.tiers ?? []).map((tier, index) => ({
    ...tier,
    index,
  }));
  if (system.componentClass === "weapon") {
    const nonLethal = traitById(definition, "nonLethal");
    const shieldBypass = traitById(definition, "shieldBypass");
    const barrage = traitById(definition, "barrage");
    const vicious = traitById(definition, "vicious");
    definition.traitState = {
      nonLethal: Boolean(nonLethal),
      shieldBypass: Boolean(shieldBypass),
      bypassHull: shieldBypass?.channels?.includes?.("hull") ||
        shieldBypass?.hull === true || shieldBypass?.params?.hull === true,
      bypassHeat: shieldBypass?.channels?.includes?.("heat") ||
        shieldBypass?.heat === true || shieldBypass?.params?.heat === true,
      damageShield: shieldBypass
        ? shieldBypass.damageShield !== false &&
          shieldBypass.params?.damageShield !== false
        : true,
      barrage: Boolean(barrage),
      vicious: Boolean(vicious),
    };
    definition.barrageProfiles = (barrage?.profiles ?? []).map((
      profile,
      index,
    ) => ({ ...profile, index }));
    definition.overclock = clone(definition.modes?.overclock?.overrides ?? {});
    definition.hasOverclock = Boolean(definition.modes?.overclock);
  }
  return definition;
}

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class ShipComponentSheet
  extends HandlebarsApplicationMixin(ItemSheetV2) {
  static MODES = {
    PLAY: 1,
    EDIT: 2,
  };

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "ship-component-sheet"],
    position: { width: 685, height: 775 },
    actions: {
      toggleMode: ShipComponentSheet.#onToggleMode,
      editImage: ShipComponentSheet.#onEditImage,
      showIcon: ShipComponentSheet.#onShowIcon,
      tab: ShipComponentSheet.#onTab,
    },
    form: {
      closeOnSubmit: false,
      submitOnChange: false,
      handler: ShipComponentSheet.#handleSubmit,
    },
    window: { resizable: true },
  };

  static PARTS = {
    component: {
      template: `modules/${MODULE_ID}/templates/ship-component.hbs`,
    },
  };

  #mode = ShipComponentSheet.MODES.PLAY;
  tabGroups = {
    primary: "description",
  };

  get mode() {
    return this.#mode;
  }

  get isEditMode() {
    return this.#mode === ShipComponentSheet.MODES.EDIT;
  }

  #draft = null;
  #draftRevision = null;
  #draftFingerprint = null;
  #formDraft = null;

  #clearDraft() {
    this.#draft = null;
    this.#draftRevision = null;
    this.#formDraft = null;
    this.#draftFingerprint = null;
  }

  #setDraft(draft) {
    this.#draft = draft;
    this.#formDraft = null;
  }

  #draftSource(item) {
    if (!this.#draft) {
      this.#draft = itemSource(item);
      this.#draftRevision = isInstalledComponent(item)
        ? item.parent.system.shipCombat.state.revision
        : null;
      this.#draftFingerprint = sourceFingerprint(item);
    }
    return this.#draft;
  }

  static async #handleSubmit(_event, form) {
    await this.#submit(form);
  }

  get title() {
    const item = this.item ?? this.document;
    const cls = item?.system?.componentClass;
    const label = cls ? cls.replace(/^./, (c) => c.toUpperCase()) : "Ship";
    return `${label} Component`;
  }

  /** @override */
  _getFrameButtons(options) {
    const buttons = super._getFrameButtons(options);
    const item = this.item ?? this.document;
    const denial = componentEditDenial(item);
    if (!denial) {
      const isEdit = this.#mode === ShipComponentSheet.MODES.EDIT;
      buttons.unshift({
        icon: isEdit ? "fa-solid fa-eye" : "fa-solid fa-pen-to-square",
        label: isEdit ? "View Mode" : "Edit Mode",
        action: "toggleMode",
      });
    }
    return buttons;
  }

  /** @override */
  _getHeaderControls() {
    const controls = super._getHeaderControls();
    const item = this.item ?? this.document;
    const denial = componentEditDenial(item);
    if (!denial) {
      const isEdit = this.#mode === ShipComponentSheet.MODES.EDIT;
      controls.unshift({
        icon: isEdit ? "fa-solid fa-eye" : "fa-solid fa-pen-to-square",
        label: isEdit ? "View Mode" : "Edit Mode",
        action: "toggleMode",
      });
    }
    return controls;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const btn = this.element?.querySelector('.window-header [data-action="toggleMode"]');
    if (btn) {
      const isEdit = this.#mode === ShipComponentSheet.MODES.EDIT;
      btn.className = `header-control icon fa-solid ${isEdit ? "fa-eye" : "fa-pen-to-square"}`;
      const label = isEdit ? "View Mode" : "Edit Mode";
      btn.dataset.tooltip = label;
      btn.setAttribute("aria-label", label);
    }
  }

  /** @override */
  changeTab(tab, group, options) {
    if (this.#mode === ShipComponentSheet.MODES.EDIT && this.form) {
      try {
        const item = this.item ?? this.document;
        this.#draft = normalizeForm(this.form, null, this.#draftSource(item));
      } catch {}
    }
    return super.changeTab(tab, group, options);
  }

  static #onTab(_event, target) {
    const tab = target?.dataset?.tab;
    const group = target?.dataset?.group;
    if (tab && group) {
      this.changeTab(tab, group);
    }
  }

  static async #onToggleMode(_event, _target) {
    const item = this.item ?? this.document;
    const denial = componentEditDenial(item);
    if (denial) {
      this.#mode = ShipComponentSheet.MODES.PLAY;
      ui.notifications.warn(denial);
      return;
    }
    if (this.#mode === ShipComponentSheet.MODES.EDIT && this.form) {
      try {
        this.#draft = normalizeForm(this.form, null, this.#draftSource(item));
      } catch {}
    }
    this.#mode = this.#mode === ShipComponentSheet.MODES.EDIT
      ? ShipComponentSheet.MODES.PLAY
      : ShipComponentSheet.MODES.EDIT;
    await this.render();
  }

  static async #onEditImage(_event, _target) {
    const item = this.item ?? this.document;
    const denial = componentEditDenial(item);
    if (denial) {
      ui.notifications.warn(denial);
      return;
    }
    const draft = this.#draftSource(item);
    const FilePickerClass = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const fp = new FilePickerClass({
      type: "image",
      current: draft.img ?? item.img ?? "",
      callback: async (path) => {
        draft.img = path;
        this.#setDraft(draft);
        await this.render();
      },
    });
    return fp.browse();
  }

  static async #onShowIcon(_event, _target) {
    const item = this.item ?? this.document;
    const popout = new ImagePopout(item.img, {
      title: item.name,
      uuid: item.uuid,
    });
    return popout.render(true);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item ?? this.document;
    const source = this.#draftSource(item);
    const system = clone(source.system);
    const componentClass = system.componentClass ?? "reactor";
    system.componentClass = componentClass;
    system.driveRole ??= "";
    system.definition ??= defaultDefinition(componentClass);
    system.description ??= { value: "", chat: "" };
    system.price ??= { value: 0, denomination: "gp" };
    system.weight ??= { value: 0, units: "tn" };
    system.quantity ??= 1;
    system.rarity ??= "";

    const denial = componentEditDenial(item);
    const canEdit = !denial;
    if (!canEdit) this.#mode = ShipComponentSheet.MODES.PLAY;
    const isEditMode = canEdit && this.#mode === ShipComponentSheet.MODES.EDIT;
    const isPlayMode = !isEditMode;

    const TextEditorClass = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    const enrichedDescription = await TextEditorClass?.enrichHTML?.(
      system.description.value ?? "",
      {
        relativeTo: item,
        secrets: item.isOwner,
        rollData: item.getRollData?.() ?? {},
      },
    ) ?? (system.description.value ?? "");

    const activeTab = this.tabGroups.primary ?? "description";

    const currencies = CONFIG.DND5E?.currencies ?? {
      cp: { label: "CP" },
      sp: { label: "SP" },
      ep: { label: "EP" },
      gp: { label: "GP" },
      pp: { label: "PP" },
    };
    const currencyOptions = Object.entries(currencies).map(([key, cfg]) => ({
      value: key,
      label: cfg.label ?? key.toUpperCase(),
      selected: (system.price?.denomination ?? "gp") === key,
    }));

    const weightUnits = CONFIG.DND5E?.weightUnits ?? {
      tn: { label: "Tons", abbreviation: "tn" },
      lb: { label: "Pounds", abbreviation: "lb" },
    };
    const weightUnitOptions = Object.entries(weightUnits).map(([key, cfg]) => ({
      value: key,
      label: cfg.abbreviation ?? cfg.label ?? key,
      selected: (system.weight?.units ?? "tn") === key,
    }));

    const rarities = CONFIG.DND5E?.itemRarity ?? {
      common: "Common",
      uncommon: "Uncommon",
      rare: "Rare",
      veryRare: "Very Rare",
      legendary: "Legendary",
      artifact: "Artifact",
    };
    const rarityOptions = [
      { value: "", label: "Standard / None", selected: !system.rarity },
      ...Object.entries(rarities).map(([key, label]) => ({
        value: key,
        label,
        selected: system.rarity === key,
      })),
    ];

    const definition = viewDefinition(system);

    const classLabel = componentClass.replace(/^./, (c) => c.toUpperCase());
    const sizeLabel = `${(system.size ?? "medium").replace(/^./, (c) => c.toUpperCase())} Mount`;
    const driveRoleLabel = system.driveRole
      ? `${system.driveRole.replace(/^./, (c) => c.toUpperCase())} Drive`
      : "";
    const rarityLabel = rarities[system.rarity] ?? (system.rarity ? system.rarity.toUpperCase() : "");
    const priceFormatted = `${(system.price?.value ?? 0).toLocaleString()} ${(system.price?.denomination ?? "gp").toUpperCase()}`;
    const weightFormatted = `${system.weight?.value ?? 0} ${weightUnits[system.weight?.units]?.abbreviation ?? system.weight?.units ?? "tn"}`;

    const formatSigned = (val) => {
      const num = Number(val) || 0;
      return num > 0 ? `+${num}` : String(num);
    };

    let weaponTraitsList = [];
    if (componentClass === "weapon") {
      if (definition.traitState?.nonLethal) {
        weaponTraitsList.push({ label: "Non-lethal", desc: "Attacks disable rather than destroy" });
      }
      if (definition.traitState?.vicious) {
        weaponTraitsList.push({ label: "Vicious", desc: "Deals additional critical damage" });
      }
      if (definition.traitState?.shieldBypass) {
        const channels = [];
        if (definition.traitState.bypassHull) channels.push("Hull");
        if (definition.traitState.bypassHeat) channels.push("Heat");
        weaponTraitsList.push({
          label: `Shield Bypass${channels.length ? ` (${channels.join(", ")})` : ""}`,
          desc: definition.traitState.damageShield ? "Also damages shields" : "Does not damage shields",
        });
      }
      if (definition.traitState?.barrage) {
        weaponTraitsList.push({
          label: "Barrage",
          desc: `${definition.barrageProfiles?.length ?? 0} firing profile(s)`,
        });
      }
    }

    return foundry.utils.mergeObject(context, {
      item,
      name: source.name,
      img: source.img,
      system,
      definition,
      editable: canEdit,
      canEdit,
      denial,
      isEditMode,
      isPlayMode,
      activeTab,
      isTabDescription: activeTab === "description",
      isTabProfile: activeTab === "profile",
      enrichedDescription,
      classLabel,
      sizeLabel,
      driveRoleLabel,
      rarityLabel,
      priceFormatted,
      weightFormatted,
      currencyOptions,
      weightUnitOptions,
      rarityOptions,
      accuracyFormatted: formatSigned(definition.accuracy),
      signatureFormatted: formatSigned(definition.signatureSpike),
      weaponTraitsList,
      isReactor: componentClass === "reactor",
      isDrive: componentClass === "drive",
      isShield: componentClass === "shield",
      isSensor: componentClass === "sensor",
      isCooling: componentClass === "cooling",
      isInertia: componentClass === "inertia",
      isWeapon: componentClass === "weapon",
      componentClassOptions: optionList(COMPONENT_CLASSES, componentClass),
      sizeOptions: optionList(MOUNT_SIZES, system.size),
      driveRoleOptions: optionList(DRIVE_ROLES, system.driveRole),
      topologyOptions: optionList(
        SHIELD_TOPOLOGIES,
        system.definition.topology,
      ),
      isDirectionalShield: componentClass === "shield" &&
        system.definition.topology !== "bubble",
      projectileOptions: optionList(
        PROJECTILE_CLASSES,
        system.definition.projectileClass,
      ),
      readinessTypeOptions: optionList(
        READINESS_TYPES,
        system.definition.readiness?.type,
      ),
      readinessRecoveryOptions: optionList(
        READINESS_RECOVERY,
        system.definition.readiness?.recovery,
      ),
      firingHeatOptions: optionList(
        FIRING_HEAT_UNITS,
        system.definition.firingHeat?.per,
      ),
      overclockFiringHeatOptions: optionList(
        FIRING_HEAT_UNITS,
        system.definition.modes?.overclock?.overrides?.firingHeat?.per,
      ),
      sectorOptions: SECTORS.map((sector) => ({
        value: sector,
        label: sector.replace(/^./, (letter) => letter.toUpperCase()),
        selected: system.definition.sectors?.includes(sector),
      })),
    }, { inplace: false });
  }

  _attachPartListeners(partId, html, options) {
    super._attachPartListeners(partId, html, options);
    const root = html.matches("[data-component-form]")
      ? html
      : html.querySelector("[data-component-form]");
    const form = this.form;
    if (!root || !form) return;
    // Let the model report every invalid path together instead of the browser stopping at one field.
    form.noValidate = true;
    const controls = Array.from(
      root.querySelectorAll("input, select, textarea"),
    );
    if (this.#formDraft) {
      for (const [index, input] of controls.entries()) {
        const saved = this.#formDraft[index];
        if (!saved) continue;
        if (input.type === "checkbox") input.checked = saved.checked;
        else input.value = saved.value;
      }
    }
    root.querySelectorAll("[data-feature]").forEach((fieldset) => {
      const parent = field(form, fieldset.dataset.feature);
      if (!parent) return;
      const sync = () => {
        fieldset.disabled = !parent.checked;
        if (parent.checked) fieldset.removeAttribute("title");
        else fieldset.title = `Enable ${fieldset.dataset.featureLabel} first`;
      };
      parent.addEventListener("change", sync);
      sync();
    });
    root.addEventListener("input", () => {
      this.#formDraft = controls.map((input) => ({
        value: input.value,
        checked: input.checked,
      }));
    });
    root.querySelector("[name='system.componentClass']")?.addEventListener(
      "change",
      (event) => void this.#changeClass(form, root, event.currentTarget.value),
    );
    root.querySelector("[name='definition.topology']")?.addEventListener(
      "change",
      (event) =>
        void this.#changeShieldTopology(form, event.currentTarget.value),
    );
    root.querySelectorAll("[data-row-action]").forEach((button) => {
      button.addEventListener(
        "click",
        (event) => void this.#rowAction(event, form, button),
      );
    });
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    root.addEventListener("dragover", (event) => event.preventDefault(), true);
  }

  #assertEditable() {
    const denial = componentEditDenial(this.item ?? this.document);
    if (denial) throw new Error(denial);
  }

  async #changeClass(form, root, componentClass) {
    try {
      this.#assertEditable();
      const previousClass = root.dataset.componentClass;
      const draft = normalizeForm(
        form,
        previousClass,
        this.#draftSource(this.item ?? this.document),
      );
      const definition = defaultDefinition(componentClass);
      if (
        JSON.stringify(draft) !==
          sourceFingerprint(this.item ?? this.document) &&
        JSON.stringify(draft.system.definition) !== JSON.stringify(definition)
      ) {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Change component class?" },
          content: "<p>Changing class resets the whole profile. Continue?</p>",
          defaultYes: false,
          rejectClose: false,
        });
        if (!confirmed) {
          field(form, "system.componentClass").value = previousClass;
          this.#formDraft = Array.from(
            root.querySelectorAll("input, select, textarea"),
          )
            .map((input) => ({ value: input.value, checked: input.checked }));
          return;
        }
        this.#assertEditable();
      }
      draft.system.componentClass = componentClass;
      draft.system.driveRole = "";
      draft.system.definition = definition;
      this.#setDraft(draft);
      await this.render();
    } catch (error) {
      ui.notifications.error(error?.message ?? String(error));
      await this.render();
    }
  }

  async #changeShieldTopology(form, topology) {
    try {
      this.#assertEditable();
      const draft = normalizeForm(
        form,
        null,
        this.#draftSource(this.item ?? this.document),
      );
      draft.system.definition.topology = topology;
      draft.system.definition.sectors = topology === "bubble"
        ? ["bubble"]
        : [...SECTORS];
      this.#setDraft(draft);
      await this.render();
    } catch (error) {
      ui.notifications.error(error?.message ?? String(error));
      await this.render();
    }
  }

  async #rowAction(event, form, button) {
    event.preventDefault();
    try {
      this.#assertEditable();
      const draft = normalizeForm(
        form,
        null,
        this.#draftSource(this.item ?? this.document),
      );
      const action = button.dataset.rowAction;
      if (action === "add-tier") {
        const tier = tierDefault(draft.system.componentClass);
        if (tier) draft.system.definition.tiers.push(tier);
      } else if (action === "remove-tier") {
        draft.system.definition.tiers.splice(Number(button.dataset.index), 1);
      } else if (action === "add-barrage") {
        const barrage = draft.system.definition.traits.find((trait) =>
          trait.id === "barrage"
        );
        if (!barrage) {
          ui.notifications.warn("Enable the Barrage trait first");
          return;
        }
        barrage.profiles.push({
          rounds: 1,
          attackPenalty: 0,
          maxEffectiveHits: 1,
        });
      } else if (action === "remove-barrage") {
        const barrage = draft.system.definition.traits.find((trait) =>
          trait.id === "barrage"
        );
        barrage?.profiles.splice(Number(button.dataset.index), 1);
      }
      this.#setDraft(draft);
      const restoreFocus = button === document.activeElement;
      await this.render();
      if (restoreFocus) {
        const buttons = Array.from(
          this.form.querySelectorAll(`[data-row-action="${action}"]`),
        );
        const index = Math.min(
          Number(button.dataset.index ?? 0),
          buttons.length - 1,
        );
        const fallbackAction = action.replace("remove-", "add-");
        (buttons[index] ??
          this.form.querySelector(`[data-row-action="${fallbackAction}"]`))
          ?.focus();
      }
    } catch (error) {
      ui.notifications.error(error?.message ?? String(error));
    }
  }

  async #submit(form) {
    let source;
    try {
      this.#assertEditable();
      const item = this.item ?? this.document;
      if (this.#draftFingerprint !== sourceFingerprint(item)) {
        throw new Error(
          "This component changed after this edit was staged. Close and reopen the component sheet to reload it.",
        );
      }
      if (
        this.#draftRevision !== null &&
        this.#draftRevision !==
          item?.parent?.system?.shipCombat?.state?.revision
      ) {
        throw new Error(
          "Ship state changed after this edit was staged. Close and reopen the component sheet to reload it.",
        );
      }
      const update = normalizeForm(form, null, this.#draftSource(item));
      const persistedSource = typeof item?.toObject === "function"
        ? item.toObject(false)
        : item;
      source = {
        ...clone(persistedSource),
        name: update.name,
        img: update.img,
        system: clone(update.system),
      };
      const inputErrors = Array.from(
        form.querySelectorAll("input, select, textarea"),
      )
        .filter((input) =>
          input.willValidate &&
          (input.validity.badInput || input.validity.valueMissing)
        )
        .map((input) => {
          let path = input.name;
          if (input.dataset.tierField) {
            const index = Array.from(form.querySelectorAll("[data-tier-row]"))
              .indexOf(input.closest("[data-tier-row]"));
            path =
              `system.definition.tiers[${index}].${input.dataset.tierField}`;
          } else if (input.dataset.barrageField) {
            const index = Array.from(
              form.querySelectorAll("[data-barrage-row]"),
            ).indexOf(input.closest("[data-barrage-row]"));
            const traitIndex = source.system.definition.traits.findIndex((
              trait,
            ) => trait.id === "barrage");
            path =
              `system.definition.traits[${traitIndex}].profiles[${index}].${input.dataset.barrageField}`;
          }
          return { path, message: input.validationMessage, control: input };
        });
      validateProspectiveComponent(item, source, inputErrors);
      const actor = item.parent;
      const itemId = item.id ?? item._id;
      if (isInstalledComponent(item)) {
        await saveInstalledShipComponent(
          actor,
          itemId,
          source,
          this.#draftRevision,
        );
      } else {
        const updateData = {
          name: update.name,
          img: update.img,
          "system.schemaVersion": update.system.schemaVersion,
          "system.componentClass": update.system.componentClass,
          "system.size": update.system.size,
          "system.driveRole": update.system.driveRole,
          "system.definition": foundry.data.operators.ForcedReplacement.create(
            update.system.definition,
          ),
        };
        if (update.system.description !== undefined) {
          updateData["system.description"] = update.system.description;
        }
        if (update.system.price !== undefined) {
          updateData["system.price"] = update.system.price;
        }
        if (update.system.weight !== undefined) {
          updateData["system.weight"] = update.system.weight;
        }
        if (update.system.quantity !== undefined) {
          updateData["system.quantity"] = update.system.quantity;
        }
        if (update.system.rarity !== undefined) {
          updateData["system.rarity"] = update.system.rarity;
        }
        await item.update(updateData, { diff: false });
      }
      this.#clearDraft();
      this.#mode = ShipComponentSheet.MODES.PLAY;
      ui.notifications.info("Ship component saved.");
      await this.render();
    } catch (error) {
      showValidationSummary(form, error, source);
      ui.notifications.error(error?.message ?? String(error));
    }
  }

  async close(options = {}) {
    this.#clearDraft();
    return super.close(options);
  }

  async _onDrop() {
    return false;
  }
  async _onDropActiveEffect() {
    return false;
  }
  async _onDropActor() {
    return false;
  }
  async _onDropFolder() {
    return false;
  }
  async _onDropItem() {
    return false;
  }
}

export function registerShipComponentSheet() {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(
    Item,
    MODULE_ID,
    ShipComponentSheet,
    {
      types: [COMPONENT_ITEM_TYPE],
      makeDefault: true,
      label: "Ship Component",
    },
  );
}
