import { COMPONENT_ITEM_TYPE, MODULE_ID, SHIP_TYPE } from "../constants.js";
import { buildShipConsoleView, powerPriorities } from "./ship-view-model.js";
import { sceneGridGeometry } from "./scene-geometry.js";
import {
  getRefitDenial,
  installShipComponent,
  materializeActorConfig,
  removeShipComponent,
  resetShipToCanadensis,
  saveShipHull,
} from "./refit.js";

import { previewPowerRoute } from "../rules/power.js";
import { previewDefenseRoute } from "../rules/shields.js";
import { getDriveCapabilities, previewManeuver, projectCoast } from "../rules/movement.js";
import { previewAttack } from "../rules/combat.js";
import { getSensorStats, TRACK_STATUS } from "../rules/sensors.js";
import { submitShipOperation, rollbackShipOperation, getOperationLog } from "../state/action-queue.js";
import { setMovementPreview, clearMovementPreview } from "../canvas/overlays.js";

const TABS = [
  { id: "overview", label: "Overview" }, { id: "crew", label: "Crew" },
  { id: "helm", label: "Helm" }, { id: "power-defense", label: "Power" },
  { id: "sensors", label: "Sensors" }, { id: "weapons", label: "Weapons" },
  { id: "damage", label: "Damage" },
];
const MAINTENANCE_TABS = [{ id: "refit", label: "Refit" }, { id: "log-config", label: "Log / Config" }];
const GROUPS = {
  Overview: ["resolveFate"],
  Crew: ["setRoster", "spendResource", "takeControl", "contributeWork"],
  Helm: ["maneuver", "rotate", "armEvasion", "disarmEvasion"],
  "Power/Defense": ["routePower", "toggleWeapon", "routeDefense"],
  Sensors: ["ping", "acquire", "analyze", "deepScan", "firingSolution", "fade", "jam", "breakLock", "burnThrough"],
  Weapons: ["attack", "beginReload", "reload", "cancelReload"],
  Damage: ["repair", "recoveryWork", "hullRepair", "cooling", "vent"],
};
const HELP = {
  resolveFate: "GM fate resolution",
  setRoster: "{\"roster\":{\"command\":[],\"crew\":[]}}", spendResource: "{\"operatorId\":\"…\",\"operation\":{}}",
  takeControl: "{\"operatorId\":\"…\",\"control\":\"helm|power|defense\"}", contributeWork: "{\"operatorId\":\"…\",\"jobId\":\"…\",\"required\":1}",
  maneuver: "{\"operatorId\":\"…\",\"deltaV\":{\"forward\":0,\"lateral\":0},\"rotation\":0}", rotate: "{\"operatorId\":\"…\",\"rotation\":0}",
  armEvasion: "{\"operatorId\":\"…\"}", disarmEvasion: "{\"operatorId\":\"…\"}",
  routePower: "{\"operatorId\":\"…\",\"allocation\":{}}", toggleWeapon: "{\"operatorId\":\"…\",\"weaponId\":\"…\"}", routeDefense: "{\"operatorId\":\"…\",\"charge\":{},\"regenerationAllocation\":{}}",
  ping: "{\"operatorId\":\"…\",\"operatorSensors\":0}", acquire: "{\"operatorId\":\"…\",\"distance\":0}", analyze: "{\"operatorId\":\"…\",\"distance\":0}", deepScan: "{\"operatorId\":\"…\",\"distance\":0}", firingSolution: "{\"operatorId\":\"…\",\"distance\":0}", fade: "{\"operatorId\":\"…\"}", jam: "{\"operatorId\":\"…\",\"operatorSensors\":0}", breakLock: "{\"operatorId\":\"…\",\"operatorSensors\":0}", burnThrough: "{\"operatorId\":\"…\",\"operatorSensors\":0}",
  attack: "{\"operatorId\":\"…\",\"weaponId\":\"…\",\"barrage\":1}", beginReload: "{\"operatorId\":\"…\",\"weaponId\":\"…\"}", reload: "{\"operatorId\":\"…\",\"weaponId\":\"…\",\"amount\":1}", cancelReload: "{\"operatorId\":\"…\",\"weaponId\":\"…\"}",
  repair: "{\"operatorId\":\"…\",\"conditionId\":\"…\",\"rating\":\"engineering\"}", recoveryWork: "{\"operatorId\":\"…\",\"conditionId\":\"…\"}", hullRepair: "{\"operatorId\":\"…\",\"rating\":\"engineering\"}", cooling: "{\"operatorId\":\"…\"}", vent: "{\"operatorId\":\"…\"}",
};
const TARGETED = new Set(["acquire", "analyze", "deepScan", "firingSolution", "jam", "breakLock", "burnThrough", "attack"]);
const GM_ONLY = new Set(["resolveFate"]);
const drafts = new Map();
const selectedTabs = new Map();
const TARGET_OPERATIONS = new Set(["acquire", "analyze", "deepScan", "firingSolution", "jam", "breakLock", "burnThrough", "attack"]);

function numeric(value, fallback = 0) {
  if (value === "" || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function truthyFormValue(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function elementFormData(element) {
  const form = element.matches?.("form") ? element : element.closest?.("form");
  const values = form ? Object.fromEntries(new FormData(form).entries()) : {};
  const panel = form?.closest?.("[data-tab-panel]");
  const operator = panel?.querySelector("[data-page-operator]");
  if (operator) values.operatorId = operator.value;
  const aimedComponent = form?.elements?.namedItem("aimedComponentId");
  if (!form?.querySelector("[data-aim-enabled]")?.checked || aimedComponent?.dataset.targetUuid !== values.targetUuid) delete values.aimedComponentId;
  return { ...values, ...(element?.dataset ?? {}) };
}


function rosterPayload(data, config) {
  const roster = { command: [], crew: [] };
  for (const kind of ["command", "crew"]) {
    const capacity = Number(config?.[`${kind}Capacity`] ?? 0);
    for (let slot = 0; slot < capacity; slot += 1) {
      const operatorId = data[`${kind}-${slot}`];
      if (operatorId) roster[kind].push({ operatorId, slot });
    }
  }
  return roster;
}

function uiOperation(type, data, config, state) {
  const operatorId = data.operatorId || undefined;
  const payload = operatorId ? { operatorId } : {};
  switch (type) {
    case "setRoster":
      return { payload: { gmOverride: true, roster: rosterPayload(data, config) }, targetUuids: [] };
    case "takeControl":
      return { payload: { ...payload, control: data.control }, targetUuids: [] };
    case "maneuver":
      return {
        payload: {
          ...payload,
          deltaV: { forward: numeric(data.forward), lateral: numeric(data.lateral) },
          rotation: numeric(data.rotation),
        },
        targetUuids: [],
      };
    case "rotate":
      return { payload: { ...payload, rotation: numeric(data.rotation) }, targetUuids: [] };
    case "armEvasion":
    case "disarmEvasion":
    case "fade":
    case "cooling":
    case "vent":
    case "hullRepair":
      return { payload, targetUuids: [] };
    case "routePower":
      return {
        payload: {
          ...payload,
          allocation: Object.fromEntries(["engines", "shields", "sensors", "cooling", "weapons"]
            .map((system) => [system, numeric(data[system])])),
          powerPresetId: data.powerPresetId || null,
          ...powerPriorities(config, state, {
            sheddingPriority: formPriority(data, "sheddingPriority"),
            weaponPriority: formPriority(data, "weaponPriority"),
          }),
        },
        targetUuids: [],
      };
    case "routeDefense": {
      const sectors = config?.components?.shield?.topology === "bubble"
        ? [config.components.shield.sectors?.[0] ?? "bubble"]
        : config?.components?.shield?.sectors ?? ["fore", "port", "starboard", "aft"];
      return {
        payload: {
          ...payload,
          charge: Object.fromEntries(sectors.map((sector) => [sector, numeric(data[`charge-${sector}`])])),
          regenerationAllocation: regenerationWeights(config, state, sectors, data),
        },
        targetUuids: [],
      };
    }
    case "toggleWeapon":
      return {
        payload: {
          ...payload,
          weaponId: data.weaponId,
          status: data.weaponSetting === "off" ? "off" : "online",
          mode: data.weaponSetting === "overclock" ? "overclock" : "nominal",
        },
        targetUuids: [],
      };
    case "ping":
      return { payload, targetUuids: [] };
    case "acquire": {
      const result = { ...payload };
      if (data.dc !== "" && data.dc != null) result.dc = numeric(data.dc);
      return { payload: result, targetUuids: data.targetUuid ? [data.targetUuid] : [] };
    }
    case "analyze":
    case "deepScan":
    case "firingSolution":
    case "jam":
    case "breakLock":
    case "burnThrough":
      return { payload, targetUuids: data.targetUuid ? [data.targetUuid] : [] };
    case "attack":
      return {
        payload: {
          ...payload,
          weaponId: data.weaponId,
          barrageRounds: numeric(data.barrageRounds, 1),
          ...(data.aimedComponentId ? { aimedComponentId: data.aimedComponentId } : {}),
        },
        targetUuids: data.targetUuid ? [data.targetUuid] : [],
      };
    case "beginReload":
    case "reload":
    case "cancelReload":
      return { payload: { ...payload, weaponId: data.weaponId }, targetUuids: [] };
    case "repair":
      return {
        payload: {
          ...payload,
          conditionId: data.conditionId,
          rating: data.rating || "engineering",
          modifier: numeric(data.modifier),
        },
        targetUuids: [],
      };
    case "recoveryWork":
      return { payload: { ...payload, conditionId: data.conditionId }, targetUuids: [] };
    case "contributeWork":
      return {
        payload: { ...payload, jobId: data.jobId, required: numeric(data.required, 1) },
        targetUuids: [],
      };
    default:
      throw new Error(`No purpose-built UI payload exists for ${type}.`);
  }
}

function formPriority(data, prefix) {
  const keys = Object.keys(data).filter((key) => key.startsWith(`${prefix}-`))
    .sort((a, b) => numeric(a.split("-").at(-1)) - numeric(b.split("-").at(-1)));
  return keys.length ? keys.map((key) => data[key]) : undefined;
}

function regenerationWeights(config, state, sectors, data) {
  if (config.components.shield.topology === "bubble") return { [sectors[0]]: 100 };
  const budget = numeric(config.components.shield.tiers?.find((tier) => tier.power === state.power?.shields)?.regeneration);
  if (!budget) return { ...state.shields.regenerationAllocation };
  const units = sectors.map((sector) => Math.max(0, numeric(data[`regen-${sector}`])));
  const total = units.reduce((sum, value) => sum + value, 0);
  if (total !== budget) throw new Error(`Assign exactly ${budget} regeneration units.`);
  if (!total) throw new Error("Assign the regeneration budget before routing defenses.");
  const exact = units.map((value) => value * 100 / total);
  const weights = exact.map(Math.floor);
  const order = sectors.map((_, index) => index).sort((a, b) => (exact[b] - weights[b]) - (exact[a] - weights[a]) || a - b);
  for (let left = 100 - weights.reduce((sum, value) => sum + value, 0), index = 0; left > 0; left--, index++) weights[order[index % order.length]]++;
  return Object.fromEntries(sectors.map((sector, index) => [sector, weights[index]]));
}

function clone(value) { return foundry.utils.deepClone(value ?? {}); }
function escapeSecrets(value, isGM, key = "") {
  if (isGM) return value;
  if (/secret|hidden|gmOnly|defenses|systems/i.test(key)) return "Unknown";
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => escapeSecrets(entry, false, key));
  if (value.state === "undetected") return { targetUuid: value.targetUuid ?? "Unknown", state: "undetected" };
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, escapeSecrets(child, false, childKey)]));
}
function errorText(error) { return error?.message ?? String(error); }
function assignedUserIds(config, state) {
  const profiles = new Map((config?.operators ?? []).map((profile) => [profile.id, profile]));
  const ids = new Set();
  for (const kind of ["command", "crew"]) {
    for (const assignment of state?.roster?.[kind] ?? []) {
      const operatorId = typeof assignment === "string" ? assignment : assignment?.operatorId ?? assignment?.id;
      const userId = assignment?.userId ?? profiles.get(operatorId)?.userId;
      if (typeof userId === "string" && userId) ids.add(userId);
    }
  }
  return ids;
}

function signed(value) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${number}`;
}

function attackPreviewText(result) {
  const preview = result.public ?? {};
  const categories = preview.categories ?? {};
  const motion = preview.relativeMotion ?? {};
  const validity = [
    `Arc ${preview.arcValid ? "OK" : "blocked"}`,
    `Range ${preview.rangeValid ? "OK" : "blocked"}`,
    `LOS ${preview.lineOfSightValid ? "OK" : "blocked"}`,
  ].join(" · ");
  const modifiers = [
    `Gunnery ${signed(categories.gunnery)}`,
    `Weapon ${signed(categories.weapon)}`,
    `Range ${signed(categories.range)}`,
    `Motion ${signed(categories.relativeMotion)}`,
    `Sensors ${signed(categories.sensors)}`,
    `Special ${signed(categories.special)}`,
  ].join(" · ");
  const motionDetail = `Motion T ${Number(motion.transverseSpeed ?? 0).toFixed(2)} · R ${Number(motion.radialSpeed ?? 0).toFixed(2)} · raw ${Number(motion.rawMotion ?? 0).toFixed(2)} · projectile ×${Number(motion.projectileMultiplier ?? 1).toFixed(2)} · effective ${Number(motion.effectiveMotion ?? 0).toFixed(2)} (${motion.band ?? "—"})`;
  const violations = result.violations?.length
    ? ` · ${result.violations.map((entry) => entry.message).join(" · ")}`
    : "";
  return `${result.legal ? "LEGAL SHOT" : "ILLEGAL SHOT"} · AC ${preview.finalAc ?? "—"} · Total ${signed(preview.knownModifierTotal)} · ${modifiers} · ${validity} · Range band ${preview.range?.band ?? "—"} at ${Number(preview.range?.distance ?? 0).toFixed(1)} · Strikes ${preview.struckSector ?? "—"} · ${motionDetail}${violations}`;
}

function actorToken(actor) {
  const synthetic = actor?.token?.document ?? actor?.token;
  if (synthetic && (actor?.isToken || synthetic.actor === actor)) return synthetic;

  const sceneId = canvas?.scene?.id;
  if (!sceneId || typeof actor?.getActiveTokens !== "function") return null;
  const matches = actor.getActiveTokens(true)
    .map((token) => token?.document ?? token)
    .filter((token) => (token?.parent?.id ?? token?.scene?.id) === sceneId);
  const unique = Array.from(new Map(matches.map((token) => [token.uuid, token])).values());
  return unique.length === 1 ? unique[0] : null;
}

function draftKey(source, type) {
  const uuid = typeof source === "string" ? source : actorToken(source)?.uuid ?? source?.uuid;
  return `${uuid ?? "unbound"}-${type}`;
}
function pretty(value) { return JSON.stringify(value, null, 2); }
function parseObject(text, label = "JSON") {
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}
function openNativeVehicleSheet(actor) {
  const SheetClass = globalThis.dnd5e?.applications?.actor?.VehicleActorSheet;
  if (!SheetClass) throw new Error("The D&D5e vehicle sheet is unavailable.");
  const candidate = new SheetClass({ document: actor });
  const existing = foundry.applications.instances.get(candidate.id);
  if (existing?.rendered) existing.bringToFront();
  else (existing ?? candidate).render({ force: true });
}
function tierSummary(tiers, valueKey) {
  return (tiers ?? []).map((tier) => `${tier.power}:${tier[valueKey] ?? "—"}`).join(" · ");
}


function installedSummary(component, value) {
  return component ? value(component) : "Not installed";
}

function configurationSummary(config, state, view) {
  const components = config?.components ?? {};
  const shield = components.shield;
  const sensor = components.sensor;
  const reactor = components.reactor;
  const cooling = components.cooling;
  const armor = config?.armor ?? {};
  const sensorBase = sensor?.base ?? {};
  const power = view.power;
  const capability = getDriveCapabilities(config, state);
  return [
    {
      label: "Identity and limits",
      entries: [
        { label: "Class", value: config?.label ?? "—" },
        { label: "Size", value: config?.size ?? "—" },
        { label: "Initiative", value: config?.initiative ?? "—" },
        { label: "AC", value: config?.ac ?? "—" },
        { label: "Signature", value: view.status.signature.value },
        { label: "Hull", value: `${state?.hull ?? "—"} / ${config?.maxHull ?? "—"}` },
        { label: "Heat", value: `${state?.heat ?? "—"} / ${config?.heatCapacity ?? "—"}` },
        { label: "Command / Crew", value: `${config?.commandCapacity ?? "—"} / ${config?.crewCapacity ?? "—"}` },
        { label: "Fate policy", value: config?.fatePolicy ?? "—" },
      ],
    },
    {
      label: "Movement and defense",
      entries: [
        { label: "Main / Reverse thrust", value: `${capability.forward} / ${capability.retro}` },
        { label: "Port / Starboard thrust", value: `${capability.port} / ${capability.starboard}` },
        { label: "Rotation", value: `${capability.rotation}°` },
        { label: "Safe Velocity", value: config?.safeVelocity ?? "—" },
        { label: "Evasion", value: `${Math.round(numeric(config?.evasionReserve) * (numeric(config?.evasionReserve) <= 1 ? 100 : 1))}% reserve · +${config?.evasionAcBonus ?? "—"} AC` },
        { label: "Armor", value: `Fore ${armor.fore ?? "—"} · Port ${armor.port ?? "—"} · Starboard ${armor.starboard ?? "—"} · Aft ${armor.aft ?? "—"}` },
      ],
    },
    {
      label: "Power, shields, and sensors",
      entries: [
        { label: "Reactor", value: installedSummary(reactor, (entry) => `${entry.nominalOutput ?? "—"} nominal · ${entry.redlineOutput ?? "—"} redline · ${entry.overclockHeat ?? "—"} Heat`) },
        { label: "Available power", value: `${power.unused} free · ${power.ceilings.maximum} capacity` },
        { label: "Shields", value: installedSummary(shield, (entry) => `${entry.topology ?? "—"} · ${entry.totalBudget ?? "—"} budget · ${entry.sectorCap ?? "—"} cap · ${entry.rechargeDelay ?? "—"} delay`) },
        { label: "Shield regeneration (Power:value)", value: shield ? tierSummary(shield.tiers, "regeneration") || "No tiers" : "Not installed" },
        { label: "Passive sensors", value: sensor ? `${sensorBase.passiveRange ?? "—"} range · ${sensorBase.passiveStrength ?? "—"} strength` : "Not installed" },
        { label: "Active sensors", value: sensor ? `${sensorBase.activeRange ?? "—"} range · ${sensorBase.activeModifier ?? "—"} modifier · ${sensorBase.ewModifier ?? "—"} EW` : "Not installed" },
        { label: "Cooling (Power:value)", value: cooling ? tierSummary(cooling.tiers, "cooling") || "No tiers" : "Not installed" },
        { label: "Emergency vent", value: cooling ? `${cooling.ventAmount ?? "—"} Heat · ${cooling.ventCooldown ?? "—"} Start cooldown` : "Not installed" },
        { label: "Current regeneration", value: shield?.tiers?.find((tier) => tier.power === state?.power?.shields)?.regeneration ?? 0 },
      ],
    },
  ];
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function refitStatus(itemId, state) {
  if (!itemId) return "Empty · systems degraded";
  const weapon = state?.weapons?.[itemId] ?? {};
  const conditions = Object.values(state?.conditions ?? {})
    .filter((condition) => condition?.componentId === itemId || condition?.targetId === itemId);
  const severityRank = { destroyed: 5, critical: 4, major: 3, minor: 2, unknown: 1 };
  const condition = conditions.sort((left, right) =>
    (severityRank[right?.severity] ?? 0) - (severityRank[left?.severity] ?? 0))[0];
  if (condition?.severity === "destroyed") return "Destroyed";
  if (condition?.severity) return `${titleCase(condition.severity)} damage`;
  if (weapon.status) return titleCase(weapon.status);
  return "Installed · nominal";
}

function refitMountView(actor, state, mount, kind) {
  const hardpoint = kind === "hardpoint";
  const itemId = hardpoint ? mount.weaponId : mount.itemId;
  const item = itemId ? actor.items?.get?.(itemId) ?? collectionValues(actor.items).find((entry) => entry?.id === itemId) : null;
  const installed = Boolean(item);
  const role = hardpoint ? "Weapon hardpoint" : mount.class === "drive"
    ? `${titleCase(mount.driveRole)} drive`
    : titleCase(mount.class);
  return {
    id: mount.id,
    label: mount.label ?? mount.id,
    kind,
    role,
    size: hardpoint ? mount.mountSize : mount.size,
    regions: (mount.regions ?? []).map(titleCase).join(" · ") || "None",
    orientation: `${Number(mount.orientation ?? 0)}°`,
    traverse: hardpoint ? titleCase(mount.traverse ?? "fixed") : "",
    itemId: installed ? itemId : "",
    itemName: installed ? item.name ?? itemId : "Empty mount",
    itemImg: installed ? item.img : "",
    installed,
    status: refitStatus(installed ? itemId : null, state),
    dropLabel: `Drop exact ${hardpoint ? mount.category : mount.class} · ${hardpoint ? mount.mountSize : mount.size}`,
  };
}


function sceneGeometry(token) {
  const scene = globalThis.canvas?.scene ?? token?.parent;
  return { scene, ...sceneGridGeometry(scene) };
}

function tokenCenter(token, geometry) {
  const x = Number(token?.x ?? 0);
  const y = Number(token?.y ?? 0);
  const width = Number(token?.width ?? 0);
  const height = Number(token?.height ?? width);
  return {
    x: (x + ((width * geometry.gridSize) / 2)) * geometry.unitsPerPixel,
    y: (y + ((height * geometry.gridSize) / 2)) * geometry.unitsPerPixel,
  };
}

function tokenRadius(token) {
  return Number(token?.width ?? 0) / 2;
}

function driveCapabilities(config, state) {
  return getDriveCapabilities(config, state);
}

function collectionValues(collection) {
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (typeof collection?.values === "function") return Array.from(collection.values());
  return collection?.[Symbol.iterator] ? Array.from(collection) : [];
}

function sceneTokenDocuments(scene) {
  const documents = collectionValues(scene?.tokens);
  if (documents.length > 0) return documents.map((entry) => entry?.document ?? entry);
  return collectionValues(globalThis.canvas?.tokens?.placeables).map((entry) => entry?.document ?? entry);
}
function doorIsOpen(wall) {
  const open = globalThis.CONST?.WALL_DOOR_STATES?.OPEN ?? 1;
  return Number(wall?.ds ?? wall?.document?.ds ?? wall?._source?.ds) === open;
}

function wallCoordinates(wall) {
  const coordinates = wall?.c ?? wall?.document?.c ?? wall?._source?.c;
  if (!Array.isArray(coordinates) || coordinates.length < 4) return null;
  const values = coordinates.slice(0, 4).map(Number);
  return values.every(Number.isFinite) ? values : null;
}

function movementWall(wall) {
  if (doorIsOpen(wall)) return false;
  const none = globalThis.CONST?.WALL_MOVEMENT_TYPES?.NONE ?? 0;
  return Number(wall?.move ?? wall?.document?.move ?? wall?._source?.move ?? 1) !== none;
}

function sightWall(wall) {
  if (doorIsOpen(wall)) return false;
  const none = globalThis.CONST?.WALL_SENSE_TYPES?.NONE ?? 0;
  return Number(wall?.sight ?? wall?.document?.sight ?? wall?._source?.sight ?? 1) !== none;
}

function cross(first, second, third) {
  return ((second.x - first.x) * (third.y - first.y))
    - ((second.y - first.y) * (third.x - first.x));
}

function pointOnSegment(point, start, end, epsilon = 1e-9) {
  return Math.abs(cross(start, end, point)) <= epsilon
    && point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);
  const epsilon = 1e-9;
  if (((firstSideStart > epsilon && firstSideEnd < -epsilon) || (firstSideStart < -epsilon && firstSideEnd > epsilon))
    && ((secondSideStart > epsilon && secondSideEnd < -epsilon) || (secondSideStart < -epsilon && secondSideEnd > epsilon))) {
    return true;
  }
  return (Math.abs(firstSideStart) <= epsilon && pointOnSegment(secondStart, firstStart, firstEnd, epsilon))
    || (Math.abs(firstSideEnd) <= epsilon && pointOnSegment(secondEnd, firstStart, firstEnd, epsilon))
    || (Math.abs(secondSideStart) <= epsilon && pointOnSegment(firstStart, secondStart, secondEnd, epsilon))
    || (Math.abs(secondSideEnd) <= epsilon && pointOnSegment(firstEnd, secondStart, secondEnd, epsilon));
}

function trackForTarget(state, targetUuid) {
  return Object.values(state?.tracks ?? {}).find((track) => String(track?.targetUuid) === String(targetUuid));
}

function namedAimedComponents(contact, components = []) {
  const remembered = contact.remembered?.identifiedSubsystems ?? [];
  const knownIds = new Set(remembered.map((component) => String(component?.id ?? component?.componentId ?? component)));
  const revealed = contact.systemsRevealed === true;
  const candidates = [
    ...remembered,
    ...collectionValues(contact.systems?.installedWeapons),
    ...collectionValues(contact.systems?.weapons),
    ...components.filter((component) => revealed || knownIds.has(String(component.id))),
  ];
  const options = new Map();
  for (const component of candidates) {
    const id = component?.id ?? component?.componentId;
    const label = component?.label ?? component?.name;
    if (id == null || typeof id === "object" || typeof label !== "string" || !label.trim() || label.trim() === String(id)) continue;
    options.set(String(id), { id: String(id), label: label.trim() });
  }
  return Array.from(options.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function liveTrack(state, targetUuid) {
  const track = trackForTarget(state, targetUuid);
  return track?.state === TRACK_STATUS.CONTACT || track?.state === TRACK_STATUS.TARGETED;
}

function weaponLineOfSight(sourceToken, targetToken, geometry) {
  const start = tokenCenter(sourceToken, geometry);
  const end = tokenCenter(targetToken, geometry);
  return !collectionValues(geometry.scene?.walls).some((wall) => {
    if (!sightWall(wall)) return false;
    const coordinates = wallCoordinates(wall);
    if (!coordinates) return false;
    const a = { x: coordinates[0] * geometry.unitsPerPixel, y: coordinates[1] * geometry.unitsPerPixel };
    const b = { x: coordinates[2] * geometry.unitsPerPixel, y: coordinates[3] * geometry.unitsPerPixel };
    return segmentsIntersect(start, end, a, b);
  });
}


async function movementObstacles(sourceToken, geometry, observerState, isGM = globalThis.game?.user?.isGM === true) {
  const obstacles = [];
  for (const token of sceneTokenDocuments(geometry.scene)) {
    if (!token || token.uuid === sourceToken.uuid || token.id === sourceToken.id) continue;
    const actor = token.actor;
    const shipCombat = actor?.system?.shipCombat;
    if (actor?.type !== SHIP_TYPE || !shipCombat?.config || !shipCombat?.state) continue;
    if (!isGM && (token.hidden === true || (!actor.isOwner && !liveTrack(observerState, token.uuid)))) continue;
    const config = await materializeActorConfig(actor);
    obstacles.push({
      id: token.uuid ?? token.id,
      position: tokenCenter(token, geometry),
      velocity: clone(shipCombat.state.velocity ?? { x: 0, y: 0 }),
      facing: Number(token.rotation ?? 0),
      radius: tokenRadius(token, geometry),
      size: config.size ?? "medium",
      maxHull: config.maxHull,
      armor: 0,
    });
  }
  for (const wall of collectionValues(geometry.scene?.walls)) {
    if (!movementWall(wall)) continue;
    const document = wall?.document ?? wall;
    const coordinates = wallCoordinates(wall);
    if (!coordinates) continue;
    obstacles.push({
      id: document.uuid ?? document.id ?? wall.id,
      type: "wall",
      a: { x: coordinates[0] * geometry.unitsPerPixel, y: coordinates[1] * geometry.unitsPerPixel },
      b: { x: coordinates[2] * geometry.unitsPerPixel, y: coordinates[3] * geometry.unitsPerPixel },
    });
  }
  return obstacles;
}

function targetedCoastProjections(state, geometry) {
  const tokens = new Map(sceneTokenDocuments(geometry.scene).map((token) => [String(token.uuid), token]));
  const projections = [];
  for (const track of Object.values(state?.tracks ?? {})) {
    if (track?.state !== TRACK_STATUS.TARGETED) continue;
    const token = tokens.get(String(track.targetUuid));
    const targetState = token?.actor?.system?.shipCombat?.state;
    if (!token || !targetState) continue;
    if (!globalThis.game?.user?.isGM && token.hidden === true) continue;
    const duration = targetState.phase === "active" ? Math.max(0, 1 - Number(targetState.timeline ?? 0)) : 1;
    const projection = projectCoast({
      position: tokenCenter(token, geometry),
      velocity: clone(targetState.velocity ?? { x: 0, y: 0 }),
      facing: Number(token.rotation ?? 0),
      duration,
      collisionRadius: tokenRadius(token, geometry),
    });
    const label = globalThis.game?.user?.isGM ? token.name ?? token.actor?.name : track.remembered?.label ?? track.remembered?.identity?.label;
    projections.push({ targetUuid: token.uuid, label: label ?? "Tracked contact", path: projection.path });
  }
  return projections;
}
function canvasPoint(point, pixelsPerUnit) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return point;
  return { ...point, x: Number(point.x) * pixelsPerUnit, y: Number(point.y) * pixelsPerUnit };
}


function canvasMovementPreview(preview, geometry) {
  const converted = clone(preview);
  converted.path = Array.isArray(converted.path)
    ? converted.path.map((entry) => ({ ...entry, position: canvasPoint(entry.position, geometry.pixelsPerUnit) }))
    : converted.path;
  for (const key of ["position", "poweredEnd", "coastEnd"]) {
    if (key === "position") converted.position = canvasPoint(converted.position, geometry.pixelsPerUnit);
    else if (converted[key]) converted[key] = { ...converted[key], position: canvasPoint(converted[key].position, geometry.pixelsPerUnit) };
  }
  converted.collisions = Array.isArray(converted.collisions)
    ? converted.collisions.map((entry) => ({
      ...entry,
      point: canvasPoint(entry.point, geometry.pixelsPerUnit),
      position: canvasPoint(entry.position, geometry.pixelsPerUnit),
      contactPoint: canvasPoint(entry.contactPoint, geometry.pixelsPerUnit),
    }))
    : converted.collisions;
  converted.warnings = Array.isArray(converted.warnings)
    ? converted.warnings.map((entry) => ({
      ...entry,
      point: canvasPoint(entry.point, geometry.pixelsPerUnit),
      position: canvasPoint(entry.position, geometry.pixelsPerUnit),
    }))
    : converted.warnings;
  converted.targetedCoasts = Array.isArray(converted.targetedCoasts)
    ? converted.targetedCoasts.map((projection) => ({
        ...projection,
        path: projection.path?.map((entry) => ({
          ...entry,
          position: canvasPoint(entry.position, geometry.pixelsPerUnit),
        })),
      }))
    : [];
  return converted;
}

async function movementPreviewInput(payload, token, config, state) {
  const geometry = sceneGeometry(token);
  const radius = tokenRadius(token);
  return {
    input: {
      ...payload,
      id: token.uuid,
      position: tokenCenter(token, geometry),
      facing: Number(token.rotation ?? 0),
      velocity: clone(state.velocity ?? { x: 0, y: 0 }),
      timelineUsed: Number(state.timeline ?? 0),
      rotationSpent: Number(state.rotationSpent ?? 0),
      evasionReserved: Number(state.evasion?.reserved ?? 0),
      state,
      capabilities: driveCapabilities(config, state),
      collisionRadius: radius,
      safeVelocity: Number(config.safeVelocity),
      ship: {
        id: token.uuid,
        size: config.size ?? "medium",
        radius,
        maxHull: config.maxHull,
        armor: 0,
      },
      obstacles: await movementObstacles(token, geometry, state),
    },
    geometry,
    targetedCoasts: targetedCoastProjections(state, geometry),
  };
}

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

class ShipConsole extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "ship-console"],
    position: { width: 480, height: 680 },
    window: { resizable: true },
    actions: {},
  };

  static PARTS = { console: { template: `modules/${MODULE_ID}/templates/ship-console.hbs` } };
  #hullDraft = null;
  #aimedComponents = new Map();
  #view = null;
  #config = null;
  #root = null;
  #epoch = 0;
  #previewSerial = new WeakMap();
  #hooks = [];
  #sensorFocus = "";
  #operators = new Map();
  #uiDrafts = new Map();
  #details = new Map();
  #movementInput = null;
  #canAct = false;
  #pending = new Set();
  #dragItem = null;
  #dragListeners = null;

  get title() {
    return `${this.actor?.name ?? this.document?.name ?? "Ship"} · Ship Console`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.#epoch++;
    this.#movementInput = null;
    const previousToken = actorToken(this.actor);
    if (previousToken) clearMovementPreview(previousToken.uuid);
    const actor = this.actor ?? this.document;
    const token = actorToken(actor);
    const data = actor.system?.shipCombat ?? {};
    const hullConfig = clone(data.config);
    const state = clone(data.state);
    this.#hullDraft ??= { json: pretty(hullConfig), revision: state.revision };
    const config = await materializeActorConfig(actor);
    const isGM = game.user.isGM;
    const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
    const canInspect = isGM || actor.testUserPermission(game.user, observer);
    const assigned = assignedUserIds(config, state).has(game.user.id);
    const canOperate = Boolean(token && (isGM || (canInspect && assigned)));
    const unavailableReason = !token
      ? "Place this ship on the active Scene to use operational controls."
      : !canInspect ? "Observer permission is required."
        : !isGM && !assigned ? "No ship operator is assigned to your user." : "";

    const targetLabels = {};
    const targetComponents = new Map();
    if (isGM) {
      for (const track of Object.values(state.tracks ?? {})) {
        const uuid = track?.targetUuid;
        if (!uuid) continue;
        try {
          const document = await fromUuid(uuid);
          targetLabels[uuid] = document?.name ?? document?.actor?.name;
          if (track.state === TRACK_STATUS.TARGETED && document?.actor) {
            const components = (await materializeActorConfig(document.actor)).components ?? {};
            targetComponents.set(uuid, [
              components.reactor, components.shield, components.sensor, components.cooling,
              ...Object.values(components.drives ?? {}), ...(components.weapons ?? []),
            ].filter(Boolean));
          }
        } catch (_error) {
          // A stale contact remains usable as last-known telemetry without its deleted Document.
        }
      }
    }

    const view = buildShipConsoleView(config, state, {
      token,
      targetLabels,
      operatorUserId: isGM ? null : game.user.id,
    });
    this.#aimedComponents = new Map(view.targetedContacts.map((contact) => [
      contact.targetUuid,
      namedAimedComponents(contact, targetComponents.get(contact.targetUuid)),
    ]));
    this.#view = view;
    this.#config = config;
    const tabIds = [...TABS, ...MAINTENANCE_TABS].map((tab) => tab.id);
    this.#canAct = canOperate && state.phase === "active";
    const preferredTab = selectedTabs.get(actor.uuid);
    const activeTab = tabIds.includes(preferredTab) ? preferredTab : tabIds[0];
    const rawActions = Object.keys(GROUPS).flatMap((tab) => (GROUPS[tab] ?? []).map((type) => {
      const gmDenied = GM_ONLY.has(type) && !isGM;
      return {
        type,
        group: tab,
        help: HELP[type] ?? "{}",
        targeted: TARGETED.has(type),
        disabled: !canOperate || gmDenied,
        reason: unavailableReason || (gmDenied ? "Active GM only." : ""),
      };
    }));

    let log = [];
    if (isGM && token) {
      try {
        log = await getOperationLog() ?? [];
      } catch (error) {
        log = [{ error: errorText(error) }];
      }
    }
    const visibleLog = Array.isArray(log) ? log.slice(-30).reverse().map((entry) => ({
      id: entry.id ?? entry.requestId ?? "",
      type: entry.request?.type ?? entry.type ?? entry.kind ?? "operation",
      timestamp: entry.timestamp ?? "",
      ok: entry.response?.ok !== false && entry.kind !== "rejected",
      json: pretty(entry),
      rollback: entry.kind === "operation" && Boolean(entry.id ?? entry.requestId),
    })) : [];
    const refitDenial = getRefitDenial(actor);
    const refitSlots = (hullConfig.slots ?? []).map((slot) => refitMountView(actor, state, slot, "slot"));
    const refitHardpoints = (hullConfig.hardpoints ?? []).map((hardpoint) => refitMountView(actor, state, hardpoint, "hardpoint"));
    const referencedItemIds = new Set([
      ...(hullConfig.slots ?? []).map((slot) => slot.itemId),
      ...(hullConfig.hardpoints ?? []).map((hardpoint) => hardpoint.weaponId),
    ]);
    const refitUnreferencedItems = collectionValues(actor.items)
      .filter((item) => item.type === COMPONENT_ITEM_TYPE && !referencedItemIds.has(item.id))
      .map((item) => ({
        id: item.id,
        name: item.name,
        componentClass: titleCase(item.system?.componentClass),
        size: item.system?.size ?? "Unknown",
      }));

    return foundry.utils.mergeObject(context, {
      actor,
      token,
      tabs: TABS.map((tab) => ({ ...tab, active: tab.id === activeTab })),
      maintenanceTabs: MAINTENANCE_TABS.map((tab) => ({ ...tab, active: tab.id === activeTab })),
      isGM,
      canOperate,
      unavailableReason,
      canRefit: !refitDenial,
      refitDenial,
      refitSlots,
      refitHardpoints,
      refitUnreferencedItems,
      canAdmin: Boolean(isGM && canOperate),
      canAct: Boolean(canOperate && state.phase === "active"),
      canAttack: Boolean(canOperate && state.phase === "active"),
      activePhase: state.phase === "active",
      tabState: Object.fromEntries(tabIds.map((id) => [id, { active: id === activeTab }])),
      view,
      rawActions,
      revision: Number(state.revision ?? 0),
      phase: state.phase ?? "—",
      turnKey: state.turnKey ?? "—",
      specGroups: configurationSummary(config, state, view),
      stateJson: pretty(escapeSecrets(state, isGM)),
      configJson: this.#hullDraft.json,
      configRevision: this.#hullDraft.revision,
      log: visibleLog,
    }, { inplace: false });
  }

  async close(options = {}) {
    this.#hullDraft = null;
    this.#epoch++;
    this.#root = null;
    for (const [event, id] of this.#hooks) Hooks.off(event, id);
    this.#hooks = [];
    if (this.#dragListeners) {
      document.removeEventListener("dragstart", this.#dragListeners.start);
      document.removeEventListener("dragend", this.#dragListeners.end);
      document.removeEventListener("drop", this.#dragListeners.end);
      this.#dragListeners = null;
      this.#dragItem = null;
    }
    const token = actorToken(this.actor);
    if (token) clearMovementPreview(token.uuid);
    return super.close(options);
  }

  _attachPartListeners(partId, html, options) {
    super._attachPartListeners(partId, html, options);
    this.#root = html;
    if (!this.#dragListeners) {
      const start = (event) => {
        this.#dragItem = null;
        try {
          const data = globalThis.TextEditor?.getDragEventData?.(event) ?? JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
          const ItemClass = globalThis.Item?.implementation ?? globalThis.CONFIG?.Item?.documentClass;
          if (data.type === "Item") this.#dragItem = Promise.resolve(ItemClass?.fromDropData?.(data)).catch(() => null);
        } catch (_error) { /* Unrelated browser drags have no Foundry Item payload. */ }
      };
      const end = () => {
        this.#dragItem = null;
        this.#root?.querySelectorAll("[data-refit-drop]").forEach((drop) => { drop.dataset.dragActive = "false"; drop.classList.remove("is-dragover"); });
      };
      this.#dragListeners = { start, end };
      document.addEventListener("dragstart", start);
      document.addEventListener("dragend", end);
      document.addEventListener("drop", end);
    }
    if (!this.#hooks.length) {
      this.#hooks.push(["targetToken", Hooks.on("targetToken", (user) => {
        if (user?.id === game.user.id && this.#root) this.#refreshTargets(this.#root);
      })]);
      this.#hooks.push(["viraShipCombatConsoleRefresh", Hooks.on("viraShipCombatConsoleRefresh", () => {
        this.#epoch++;
        this.#movementInput = null;
        const token = actorToken(this.actor);
        if (token) clearMovementPreview(token.uuid);
        if (this.rendered) void this.render();
      })]);
    }
    html.querySelectorAll("[data-tab-button]").forEach((button) => {
      button.addEventListener("click", () => this.#selectTab(html, button.dataset.tabButton));
    });
    html.querySelectorAll("select[data-default]").forEach((select) => {
      const preferred = select.dataset.default;
      if (preferred && Array.from(select.options).some((option) => option.value === preferred)) select.value = preferred;
    });
    this.#restoreControls(html);
    this.#attachHelm(html);
    this.#attachPower(html);
    this.#attachDefense(html);
    html.querySelectorAll("[data-sensor-focus]").forEach((button) => button.addEventListener("click", () => {
      this.#sensorFocus = button.dataset.sensorFocus;
      this.#refreshSensors(html);
    }));
    this.#refreshSensors(html);
    html.querySelectorAll("form[data-ui-operation='attack']").forEach((form) => {
      form.querySelector("[data-aim-enabled]")?.addEventListener("change", () => {
        this.#refreshAimed(form);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const setting = form.elements.namedItem("weaponSetting");
      setting?.addEventListener("change", (event) => {
        event.stopPropagation();
        void this.#submitUi(event, setting, "toggleWeapon");
      });
    });
    this.#refreshTargets(html);
    html.querySelectorAll("form[data-ui-operation]").forEach((form) => {
      form.addEventListener("submit", (event) => this.#submitUi(event, form));
    });
    html.querySelectorAll("button[data-ui-operation]").forEach((button) => {
      button.addEventListener("click", (event) => this.#submitUi(event, button));
    });
    html.querySelectorAll("form[data-live-preview]").forEach((form) => {
      const refresh = () => void this.#previewUi(form);
      form.addEventListener("input", refresh);
      form.addEventListener("change", refresh);
      refresh();
    });
    html.querySelectorAll("[data-distribute]").forEach((button) => {
      button.addEventListener("click", () => this.#distribute(button));
    });
    html.querySelectorAll("form[data-raw-operation]").forEach((form) => {
      const type = form.dataset.rawOperation;
      const key = draftKey(this.actor, `raw-${type}`);
      const saved = drafts.get(key);
      if (saved) {
        form.elements.payload.value = saved.payload;
        if (form.elements.targets) form.elements.targets.value = saved.targets;
      }
      form.addEventListener("input", () => {
        drafts.set(key, { payload: form.elements.payload.value, targets: form.elements.targets?.value ?? "" });
        void this.#previewRaw(form);
      });
      form.addEventListener("submit", (event) => this.#submitRaw(event, form));
    });
    const configForm = html.querySelector("form[data-config]");
    configForm?.addEventListener("input", () => {
      this.#hullDraft = {
        json: configForm.elements.config.value,
        revision: Number(configForm.dataset.revision),
      };
    });
    configForm?.addEventListener("submit", (event) => this.#saveConfig(event));
    html.querySelector("[data-canadensis]")?.addEventListener("click", () => this.#resetCanadensis());
    html.querySelectorAll("[data-refit-drop]").forEach((drop) => {
      drop.addEventListener("dragover", (event) => void this.#dragComponent(event, drop));
      drop.addEventListener("dragleave", (event) => {
        if (!drop.contains(event.relatedTarget)) { drop.classList.remove("is-dragover"); drop.dataset.dragActive = "false"; }
      });
      drop.addEventListener("drop", (event) => void this.#dropComponent(event, drop), true);
    });
    html.querySelectorAll("[data-refit-item]").forEach((button) => {
      button.addEventListener("click", () => this.#openComponent(button.dataset.refitItem));
    });
    html.querySelectorAll("[data-refit-remove]").forEach((button) => {
      button.addEventListener("click", () => void this.#removeComponent(button.dataset.refitRemove, button));
    });
    html.querySelectorAll("[data-rollback]").forEach((button) => {
      button.addEventListener("click", () => this.#rollback(button.dataset.rollback));
    });
    html.querySelector("[data-native-vehicle-sheet]")?.addEventListener("click", () => {
      try {
        openNativeVehicleSheet(this.actor);
      } catch (error) {
        ui.notifications.error(errorText(error));
      }
    });
  }

  #selectTab(html, id) {
    selectedTabs.set(this.actor.uuid, id);
    html.querySelectorAll("[data-tab-button]").forEach((element) => {
      element.setAttribute("aria-selected", String(element.dataset.tabButton === id));
    });
    html.querySelectorAll("[data-tab-panel]").forEach((element) => {
      element.hidden = element.dataset.tabPanel !== id;
    });
    html.querySelectorAll("details").forEach((details) => {
      if (details.querySelector("[data-tab-button]")) details.open = false;
    });
    this.#epoch++;
    const token = actorToken(this.actor);
    if (token) clearMovementPreview(token.uuid);
    html.querySelectorAll(`[data-tab-panel='${id}'] form[data-live-preview]`).forEach((form) => void this.#previewUi(form));
  }

  #restoreControls(html) {
    const revision = this.actor.system.shipCombat.state.revision;
    html.querySelectorAll("[data-page-operator], select[name='operatorId']").forEach((select) => {
      const key = select.dataset.pageOperator ?? select.closest("[data-tab-panel]")?.dataset.tabPanel;
      const saved = this.#operators.get(key);
      select.querySelectorAll("option").forEach((option) => { if (this.#view.operators.find((operator) => operator.id === option.value)?.inactive) option.disabled = true; });
      if (saved && Array.from(select.options).some((option) => option.value === saved && !option.disabled)) select.value = saved;
      select.addEventListener("change", () => {
        this.#operators.set(key, select.value);
        select.closest("[data-tab-panel]")?.querySelectorAll("form[data-live-preview]").forEach((form) => void this.#previewUi(form));
      });
    });
    html.querySelectorAll("form[data-ui-operation]").forEach((form) => {
      const key = `${form.dataset.uiOperation}:${form.elements.namedItem("weaponId")?.value ?? ""}`;
      const saved = this.#uiDrafts.get(key);
      const durable = form.dataset.uiOperation === "attack";
      if (saved && (saved.revision === revision || durable)) {
        for (const [name, value] of Object.entries(saved.values)) {
          if (name === "targetUuid" || name === "weaponSetting" || name === "operatorId" || name === "aimedComponentId") continue;
          const input = form.elements.namedItem(name);
          if (input && (!input.options || Array.from(input.options).some((option) => option.value === value))) input.value = value;
        }
      }
      form.addEventListener("input", () => this.#uiDrafts.set(key, { revision, values: Object.fromEntries(new FormData(form).entries()), aim: form.querySelector("[data-aim-enabled]")?.checked }));
    });
    html.querySelectorAll("details").forEach((details, index) => {
      if (details.querySelector("[data-tab-button]")) return;
      const key = `${details.closest("[data-tab-panel]")?.dataset.tabPanel}:${index}`;
      if (this.#details.has(key)) details.open = this.#details.get(key);
      details.addEventListener("toggle", () => this.#details.set(key, details.open));
    });
    const state = this.actor.system.shipCombat.state;
    const hide = (operation, hidden) => html.querySelectorAll(`button[data-ui-operation='${operation}']`).forEach((button) => { button.hidden = hidden; });
    hide("armEvasion", state.evasion?.armed || !this.#config.components?.drives?.main || state.power?.engines <= 0);
    hide("disarmEvasion", !state.evasion?.armed);
    hide("cooling", !this.#config.components?.cooling || state.heat <= 0);
    hide("vent", !this.#config.components?.cooling || state.heat <= 0 || state.ventCooldown > 0);
    hide("hullRepair", state.hull >= this.#config.maxHull);
    html.querySelectorAll("form[data-ui-operation='attack']").forEach((form) => {
      const weapon = this.#view.weapons.find((entry) => entry.id === form.elements.namedItem("weaponId")?.value);
      const reload = form.querySelector("[data-ui-operation='beginReload']");
      if (reload) reload.hidden = !weapon?.online || weapon.readiness >= weapon.capacity;
      const overclock = form.elements.namedItem("weaponSetting")?.querySelector("option[value='overclock']");
      if (overclock) overclock.disabled = !weapon?.online;
    });
  }

  #attachHelm(html) {
    const state = this.actor.system.shipCombat.state;
    const capabilities = getDriveCapabilities(this.#config, state);
    const time = Math.max(0, 1 - numeric(state.timeline) - numeric(state.evasion?.reserved));
    const rotation = Math.max(0, capabilities.rotation - numeric(state.rotationSpent));
    const limits = { forward: [-capabilities.retro * time, capabilities.forward * time], lateral: [-capabilities.port * time, capabilities.starboard * time], rotation: [-rotation, rotation] };
    const form = html.querySelector("form[data-ui-operation='maneuver']");
    if (!form) return;
    for (const [name, [min, max]] of Object.entries(limits)) {
      const input = form.elements.namedItem(name);
      if (!input) continue;
      // Symmetric native ranges put the zero detent in the physical center.
      const extent = Math.max(Math.abs(min), max);
      const step = name === "rotation" ? 1 : 0.1;
      const roundedExtent = Math.ceil(extent / step) * step;
      input.min = String(-roundedExtent); input.max = String(roundedExtent); input.step = String(step);
      const draft = this.#uiDrafts.get("maneuver:");
      if (draft?.revision === state.revision) input.value = String(numeric(draft.values[name]));
      input.disabled = extent <= 0 || !this.#canAct;
      input.style.setProperty("--zero-position", "50%");
      input.setAttribute("aria-label", name === "forward" ? "Retro / forward thrust" : name === "lateral" ? "Port / starboard thrust" : "Rotation degrees");
      const refresh = () => {
        let value = Math.max(Math.ceil(min / numeric(input.step)) * numeric(input.step), Math.min(Math.floor(max / numeric(input.step)) * numeric(input.step), numeric(input.value)));
        if (Math.abs(value) < numeric(input.step) / 2) value = 0;
        input.value = String(value);
        input.setAttribute("aria-valuetext", `${signed(value)}${name === "rotation" ? " degrees" : " thrust"}`);
        form.querySelectorAll(`[data-slider-value='${name}']`).forEach((output) => { output.textContent = `${signed(value)}${name === "rotation" ? "°" : ""}`; });
      };
      input.addEventListener("input", refresh);
      refresh();
    }
  }

  #attachPower(html) {
    const form = html.querySelector("form[data-ui-operation='routePower']");
    if (!form) return;
    const refresh = () => {
      for (const system of this.#view.power.systems) {
        const container = Array.from(form.querySelectorAll("[data-power-blocks]")).find((node) => node.dataset.powerBlocks === system.id);
        if (!container) continue;
        const input = form.elements.namedItem(system.id);
        const current = numeric(input.value);
        const maximum = Math.max(0, ...system.options.map((option) => option.value));
        container.replaceChildren();
        for (let index = 1; index <= maximum; index++) {
          const filled = index <= current;
          const next = current + (filled ? -1 : 1);
          const button = document.createElement("button");
          button.type = "button"; button.textContent = filled ? "■" : "□";
          button.setAttribute("aria-pressed", String(filled));
          button.setAttribute("aria-label", `${filled ? "Remove" : "Add"} one ${system.label} power`);
          button.disabled = !this.#canAct || !system.options.some((option) => option.value === next);
          button.addEventListener("click", () => {
            input.value = String(next);
            const preset = form.elements.namedItem("powerPresetId"); if (preset) preset.value = "";
            form.dispatchEvent(new Event("input", { bubbles: true }));
          });
          container.append(button);
        }
      }
      form.querySelectorAll("[data-power-preset]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.powerPreset === form.elements.namedItem("powerPresetId")?.value)));
    };
    form.addEventListener("input", refresh);
    form.querySelectorAll("button[data-power-preset]").forEach((button) => button.addEventListener("click", () => {
      const allocation = JSON.parse(button.dataset.allocation ?? "{}");
      for (const [system, value] of Object.entries(allocation)) { const input = form.elements.namedItem(system); if (input) input.value = String(value); }
      const preset = form.elements.namedItem("powerPresetId"); if (preset) preset.value = button.dataset.powerPreset;
      form.dispatchEvent(new Event("input", { bubbles: true }));
    }));
    refresh();
  }

  #attachDefense(html) {
    const form = html.querySelector("form[data-ui-operation='routeDefense']");
    if (!form || !this.#view.shields.sectors.length) return;
    const shields = this.#view.shields;
    const inputs = shields.sectors.map((sector) => form.elements.namedItem(`regen-${sector.id}`));
    const refresh = () => {
      let total = 0;
      for (const sector of shields.sectors) {
        const input = form.elements.namedItem(`charge-${sector.id}`);
        total += numeric(input.value);
        const sectorNode = input.closest("[data-sector]");
        sectorNode?.querySelector(".ship-meter")?.style.setProperty("--meter-value", `${sector.capacity ? numeric(input.value) / sector.capacity * 100 : 0}%`);
        form.querySelectorAll(`[data-shield-charge-value='${sector.id}']`).forEach((output) => { output.textContent = input.value; });
      }
      const unassigned = shields.total - total;
      form.querySelectorAll("[data-shield-unassigned]").forEach((output) => { output.textContent = String(unassigned); });
      form.querySelectorAll("[data-shield-charge]").forEach((button) => {
        const sector = shields.sectors.find((entry) => entry.id === button.dataset.shieldCharge);
        const value = numeric(form.elements.namedItem(`charge-${sector.id}`).value);
        button.disabled = !this.#canAct || (numeric(button.dataset.delta) > 0 ? unassigned <= 0 || !sector.canReceive || value >= sector.capacity : value <= 0);
      });
      const sum = inputs.reduce((value, input) => value + numeric(input.value), 0);
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index];
        const limit = Math.max(0, shields.regeneration - sum + numeric(input.value));
        input.style.setProperty("--regen-limit", `${shields.regeneration ? limit / shields.regeneration * 100 : 0}%`);
        form.querySelectorAll(`[data-regen-value='${shields.sectors[index].id}']`).forEach((output) => { output.textContent = `${input.value} / ${shields.regeneration}`; });
      }
    };
    inputs.forEach((input, index) => {
      input.min = "0"; input.max = String(shields.regeneration); input.step = "1";
      const draft = this.#uiDrafts.get("routeDefense:");
      input.value = String(draft?.revision === this.actor.system.shipCombat.state.revision ? numeric(draft.values[input.name], shields.sectors[index].regeneration) : shields.sectors[index].regeneration);
      input.disabled = !shields.regeneration || !shields.directional;
      input.addEventListener("input", () => {
        let excess = inputs.reduce((sum, entry) => sum + numeric(entry.value), 0) - shields.regeneration;
        const others = inputs.filter((entry) => entry !== input);
        while (excess > 0 && others.some((entry) => numeric(entry.value) > 0)) {
          for (const other of others) if (excess > 0 && numeric(other.value) > 0) { other.value = String(numeric(other.value) - 1); excess--; }
        }
        let free = shields.regeneration - inputs.reduce((sum, entry) => sum + numeric(entry.value), 0);
        while (free > 0 && others.length) {
          for (const other of others) if (free > 0) { other.value = String(numeric(other.value) + 1); free--; }
        }
      });
    });
    form.querySelectorAll("[data-shield-charge]").forEach((button) => button.addEventListener("click", () => {
      const input = form.elements.namedItem(`charge-${button.dataset.shieldCharge}`);
      input.value = String(numeric(input.value) + numeric(button.dataset.delta));
      form.dispatchEvent(new Event("input", { bubbles: true }));
    }));
    form.addEventListener("input", refresh);
    refresh();
  }

  #refreshSensors(html) {
    const contact = this.#view.contacts.find((entry) => entry.targetUuid === this.#sensorFocus);
    if (!contact) this.#sensorFocus = "";
    html.querySelectorAll("[data-sensor-focus]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.sensorFocus === this.#sensorFocus)));
    const panel = html.querySelector("[data-sensor-focus-panel]");
    if (panel) {
      panel.replaceChildren();
      const title = document.createElement("strong"); title.textContent = contact?.label ?? "Select a radar contact"; panel.append(title);
      if (contact) {
        const telemetry = document.createElement("p"); telemetry.textContent = `${contact.stateLabel} · Bearing ${contact.bearing}${contact.jammed ? " · Jammed" : ""}${contact.stale ? " · Stale" : ""}`; panel.append(telemetry);
        for (const [label, value] of [["Defenses", contact.defenses], ["Systems", contact.systems]]) {
          if (!value) continue;
          const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = label;
          const content = document.createElement("pre"); content.textContent = pretty(value); details.append(summary, content); panel.append(details);
        }
      }
    }
    const form = html.querySelector("[data-tab-panel='sensors'] form");
    if (!form) return;
    const target = form.elements.namedItem("targetUuid"); if (target) target.value = this.#sensorFocus;
    form.querySelectorAll("button[data-ui-operation]").forEach((button) => {
      const type = button.dataset.uiOperation;
      if (type === "burnThrough") {
        button.hidden = !this.#view.sensor.online || !contact?.jams?.some((jam) => jam.sourceUuid === contact.targetUuid);
        return;
      }
      const allowed = type === "fade" || (this.#view.sensor.online && (type === "ping" || (type === "burnThrough" ? contact?.jammed : ["analyze", "deepScan", "firingSolution"].includes(type) ? contact?.targeted : contact?.live)));
      button.hidden = !allowed;
    });
  }

  #refreshAimed(form, targetChanged = false) {
    const slot = form.querySelector("[data-aim-slot]");
    const enabled = form.querySelector("[data-aim-enabled]");
    if (!slot || !enabled) return;
    const target = form.elements.namedItem("targetUuid")?.value;
    const components = this.#aimedComponents.get(target) ?? [];
    const selected = !targetChanged ? form.elements.namedItem("aimedComponentId")?.value : "";
    slot.replaceChildren();
    enabled.disabled = !components.length;
    if (targetChanged || !components.length) enabled.checked = false;
    if (!enabled.checked) return;
    const select = document.createElement("select"); select.name = "aimedComponentId"; select.dataset.targetUuid = target;
    select.setAttribute("aria-label", "Aim at revealed component");
    for (const component of components) { const option = document.createElement("option"); option.value = component.id; option.textContent = component.label; select.append(option); }
    if (components.some((component) => component.id === selected)) select.value = selected;
    slot.append(select);
  }

  #foundryTargets() {
    return collectionValues(game.user?.targets).map((token) => token.document ?? token);
  }

  #refreshTargets(html) {
    const targets = this.#foundryTargets();
    const uuid = targets.length === 1 ? targets[0].uuid : "";
    const contact = this.#view.contacts.find((entry) => entry.targetUuid === uuid);
    const lamp = html.querySelector("[data-target-lamp]");
    if (lamp) {
      lamp.dataset.state = targets.length === 1 ? "one" : targets.length ? "multiple" : "none";
      lamp.textContent = targets.length === 1 ? `● ONE TARGET — ${contact?.label ?? "Unidentified contact"}` : targets.length ? `◆ ${targets.length} TARGETS — select one` : "○ NO TARGET";
    }
    html.querySelectorAll("[data-sensor-focus]").forEach((button) => { button.dataset.foundryTargeted = String(targets.some((target) => target.uuid === button.dataset.sensorFocus)); });
    html.querySelectorAll("form[data-ui-operation='attack']").forEach((form) => {
      const input = form.elements.namedItem("targetUuid");
      const changed = Boolean(input.dataset.initialized) && input.value !== uuid;
      input.value = uuid;
      if (!input.dataset.initialized) {
        const draft = this.#uiDrafts.get(`attack:${form.elements.namedItem("weaponId").value}`);
        if (draft?.values.targetUuid === uuid && draft.aim) {
          const enabled = form.querySelector("[data-aim-enabled]"); if (enabled) enabled.checked = true;
          this.#refreshAimed(form);
          const aimed = form.elements.namedItem("aimedComponentId");
          if (aimed && Array.from(aimed.options).some((option) => option.value === draft.values.aimedComponentId)) aimed.value = draft.values.aimedComponentId;
        }
        input.dataset.initialized = "true";
      }
      this.#refreshAimed(form, changed);
      this.#weaponValidity(form, null, targets.length === 1 ? "Checking shot" : "Select exactly one Foundry target");
      void this.#previewUi(form);
    });
  }

  #weaponValidity(form, legal, message) {
    const indicator = form.querySelector("[data-weapon-validity]");
    if (indicator) { indicator.dataset.state = legal === null ? "pending" : legal ? "valid" : "invalid"; indicator.textContent = legal === null ? "…" : legal ? "●" : "▲"; indicator.title = message; indicator.setAttribute("aria-label", message); }
    const fire = form.querySelector("button[type='submit']");
    if (fire) fire.disabled = legal !== true || !this.#canAct;
  }

  async #dragComponent(event, drop) {
    event.preventDefault();
    if (getRefitDenial(this.actor)) return;
    drop.dataset.dragActive = "true";
    try {
      let item;
      if (this.#dragItem) item = await this.#dragItem;
      else {
        const data = globalThis.TextEditor?.getDragEventData?.(event) ?? JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
        if (data.type !== "Item") return;
        const ItemClass = globalThis.Item?.implementation ?? globalThis.CONFIG?.Item?.documentClass;
        item = await ItemClass?.fromDropData?.(data);
      }
      const hull = this.actor.system.shipCombat.config;
      const slot = hull.slots?.find((entry) => entry.id === drop.dataset.mountId);
      const hardpoint = hull.hardpoints?.find((entry) => entry.id === drop.dataset.mountId);
      const system = item?.system;
      const role = ["portLateral", "starboardLateral"].includes(slot?.driveRole) ? "lateral" : slot?.driveRole;
      const compatible = item?.type === COMPONENT_ITEM_TYPE && (slot
        ? system.componentClass === slot.class && system.size === slot.size && (slot.class !== "drive" || system.driveRole === role)
        : hardpoint && system.componentClass === "weapon" && system.size === hardpoint.mountSize && hardpoint.category === "hardpoint" && system.definition.category === hardpoint.category);
      if (drop.dataset.dragActive === "true") drop.classList.toggle("is-dragover", Boolean(compatible));
    } catch (_error) { drop.classList.remove("is-dragover"); }
  }

  #openComponent(itemId) {
    try {
      const item = this.actor.items?.get?.(itemId) ?? collectionValues(this.actor.items).find((entry) => entry?.id === itemId);
      if (!item) throw new Error("The component Item is no longer available.");
      const sheet = item.sheet;
      if (!sheet) throw new Error("The component Item sheet is unavailable.");
      if (sheet.rendered) sheet.bringToFront();
      else sheet.render({ force: true });
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #dropComponent(event, drop) {
    event.preventDefault();
    event.stopImmediatePropagation();
    drop.classList.remove("is-dragover");
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      const data = globalThis.TextEditor?.getDragEventData?.(event)
        ?? JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
      if (data?.type !== "Item") throw new Error("Drop a ship component Item on this mount.");
      const ItemClass = globalThis.Item?.implementation ?? globalThis.CONFIG?.Item?.documentClass;
      const sourceItem = await ItemClass?.fromDropData?.(data);
      if (!sourceItem) throw new Error("The dropped Item could not be resolved.");
      await installShipComponent(this.actor, drop.dataset.mountId, sourceItem);
      ui.notifications.info(`${sourceItem.name ?? "Component"} installed.`);
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #removeComponent(mountId, button) {
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      button.disabled = true;
      const removed = await removeShipComponent(this.actor, mountId);
      if (removed) ui.notifications.info(`${removed.name ?? "Component"} removed; the mount is now degraded.`);
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
      button.disabled = false;
    }
  }

  #distribute(button) {
    const form = button.closest("form");
    if (!form) return;
    const prefix = button.dataset.distribute;
    const inputs = Array.from(form.querySelectorAll(`input[name^="${prefix}-"]`));
    if (!inputs.length) return;
    const caps = inputs.map((input) => {
      if (prefix !== "charge") return numeric(input.max, Infinity);
      const sector = this.#view.shields.sectors.find((entry) => `charge-${entry.id}` === input.name);
      return sector?.canReceive ? sector.capacity : sector?.charge ?? 0;
    });
    const total = prefix === "regen"
      ? this.#view.shields.regeneration
      : this.#view.shields.total;
    const values = inputs.map(() => 0);
    let remaining = total;
    let cursor = 0;
    while (remaining > 0 && inputs.some((input, index) => values[index] < caps[index])) {
      const index = cursor % inputs.length;
      if (values[index] < caps[index]) {
        values[index] += 1;
        remaining -= 1;
      }
      cursor += 1;
    }
    inputs.forEach((input, index) => { input.value = String(values[index]); });
    form.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async #previewUi(form) {
    const output = form.querySelector("[data-preview]");
    if (!output) return;
    const actor = this.actor;
    const state = clone(actor.system.shipCombat.state);
    const type = form.dataset.livePreview;
    const epoch = this.#epoch;
    const serial = (this.#previewSerial.get(form) ?? 0) + 1;
    this.#previewSerial.set(form, serial);
    const current = () => this.#epoch === epoch && this.#previewSerial.get(form) === serial && this.#root?.contains(form)
      && this.actor.system.shipCombat.state.revision === state.revision;
    if (type === "attack") this.#weaponValidity(form, null, "Checking shot");
    try {
      const config = this.#config;
      const data = elementFormData(form);
      const operation = uiOperation(type, data, config, state);
      if (type === "maneuver" || type === "rotate") {
        const token = actorToken(actor);
        if (!token) throw new Error("Place this ship on the active Scene to preview movement.");
        this.#movementInput ??= movementPreviewInput({}, token, config, state);
        const assembled = await this.#movementInput;
        if (!current() || form.closest("[data-tab-panel]")?.hidden) return;
        const result = {
          ...previewManeuver({ ...assembled.input, ...operation.payload }),
          targetedCoasts: assembled.targetedCoasts,
        };
        setMovementPreview(token.uuid, canvasMovementPreview(result, assembled.geometry));
        const speed = Math.hypot(Number(result.finalVelocity?.x ?? 0), Number(result.finalVelocity?.y ?? 0));
        const warning = result.warnings?.[0]?.code ? ` · ${result.warnings[0].code.replaceAll("_", " ")}` : "";
        output.textContent = `Projected ${signed(operation.payload.deltaV.forward)} forward · ${signed(operation.payload.deltaV.lateral)} starboard · ${signed(operation.payload.rotation)}° · Speed ${speed.toFixed(1)} / safe ${config.safeVelocity}${warning}`;
      } else if (type === "routePower") {
        const result = previewPowerRoute(config, state, operation.payload);
        const stagedState = { ...state, power: { ...state.power, ...result.allocation } };
        const sensor = getSensorStats(config, stagedState);
        const regeneration = config.components?.shield?.tiers?.find((tier) => tier.power === result.allocation.shields)?.regeneration ?? 0;
        const drives = getDriveCapabilities(config, stagedState);
        const cooling = config.components?.cooling?.tiers?.find((tier) => tier.power === result.allocation.cooling)?.cooling ?? 0;
        const summaries = { engines: `${drives.forward} thrust`, shields: `${regeneration} regen`, sensors: sensor.online ? `${sensor.activeRange} active` : "Offline", weapons: `${result.weaponReserved} reserved`, cooling: `${cooling} cooling` };
        form.querySelectorAll("[data-power-effect]").forEach((output) => { output.textContent = summaries[output.dataset.powerEffect]; });
        output.textContent = `${result.committed} / ${result.ceilings.maximum} Power · ${result.unused} available · ${result.redlining ? "REDLINE" : result.emission.band} · ${result.heatAdded} Heat on commit`;
      } else if (type === "routeDefense") {
        const result = previewDefenseRoute(config, state, operation.payload);
        output.textContent = `${result.totalCharge} shield charge conserved · regeneration ${Object.entries(result.regenerationAllocation).map(([sector, value]) => `${sector} ${value}%`).join(" · ")}`;
      } else if (type === "attack") {
        const targetUuid = operation.targetUuids[0];
        if (this.#foundryTargets().length !== 1 || !targetUuid) throw new Error("Select exactly one Foundry target.");
        if (!this.#view.targetedContacts.some((contact) => contact.targetUuid === targetUuid)) throw new Error("A Targeted sensor track is required.");
        const target = await fromUuid(targetUuid);
        const targetActor = target?.actor;
        if (!targetActor) throw new Error("The selected contact is no longer present.");
        const sourceToken = actorToken(actor);
        const targetToken = target?.document ?? target;
        if (!sourceToken) throw new Error("Place this ship on the active scene to preview an attack.");
        const geometry = sceneGeometry(sourceToken);
        const targetState = clone(targetActor.system.shipCombat.state);
        const targetConfig = await materializeActorConfig(targetActor);
        if (!current()) return;
        const operator = config.operators?.find((entry) => entry.id === operation.payload.operatorId);
        const result = previewAttack({
          attackerConfig: config,
          attackerState: state,
          targetConfig,
          targetState,
          declaration: {
            ...operation.payload,
            targetUuid,
            attackerPosition: tokenCenter(sourceToken, geometry),
            targetPosition: tokenCenter(targetToken, geometry),
            attackerVelocity: clone(state.velocity),
            targetVelocity: clone(targetState.velocity),
            attackerFacing: Number(sourceToken.rotation ?? 0),
            targetFacing: Number(targetToken.rotation ?? 0),
            lineOfSight: weaponLineOfSight(sourceToken, targetToken, geometry),
            gunneryModifier: Number(operator?.ratings?.gunnery ?? 0),
          },
        });
        output.textContent = attackPreviewText(result);
        this.#weaponValidity(form, result.legal, result.legal ? "Valid shot" : result.violations.map((entry) => entry.message).join(" · "));
      }
      if (type !== "attack") { const submit = form.querySelector("button[type='submit']"); if (submit) submit.disabled = !this.#canAct; }
      output.dataset.error = "false";
    } catch (error) {
      if (!current()) return;
      if (type === "attack") this.#weaponValidity(form, false, errorText(error));
      if (type !== "attack") { const submit = form.querySelector("button[type='submit']"); if (submit) submit.disabled = true; }
      output.textContent = errorText(error);
      output.dataset.error = "true";
      if (type === "maneuver" || type === "rotate") {
        const token = actorToken(actor);
        if (token) clearMovementPreview(token.uuid);
      }
    }
  }

  async #previewRaw(form) {
    const output = form.querySelector("[data-preview]");
    if (!output) return;
    const epoch = this.#epoch;
    const serial = (this.#previewSerial.get(form) ?? 0) + 1;
    this.#previewSerial.set(form, serial);
    const current = () => this.#epoch === epoch && this.#previewSerial.get(form) === serial && this.#root?.contains(form);
    try {
      const payload = parseObject(form.elements.payload.value);
      const type = form.dataset.rawOperation;
      const actor = this.actor;
      const config = await materializeActorConfig(actor);
      const state = clone(actor.system.shipCombat.state);
      let result = payload;
      if (type === "routePower") result = previewPowerRoute(config, state, payload);
      else if (type === "routeDefense") result = previewDefenseRoute(config, state, payload);
      else if (type === "maneuver" || type === "rotate") {
        const token = actorToken(actor);
        if (!token) throw new Error("Place this ship on the active Scene to preview movement.");
        const assembled = await movementPreviewInput(payload, token, config, state);
        if (!current()) return;
        result = {
          ...previewManeuver(assembled.input),
          targetedCoasts: assembled.targetedCoasts,
        };
        setMovementPreview(token.uuid, canvasMovementPreview(result, assembled.geometry));
      } else if (type === "attack") {
        const targetUuid = (form.elements.targets?.value ?? "").split(/[\s,]+/).find(Boolean);
        if (!targetUuid) throw new Error("Enter a target Token UUID to preview an attack.");
        const target = await fromUuid(targetUuid);
        const targetActor = target?.actor;
        if (!targetActor) throw new Error("The target UUID must identify a placed Token.");
        const sourceToken = actorToken(actor);
        const targetToken = target?.document ?? target;
        if (!sourceToken) throw new Error("Place this ship on the active scene to preview an attack.");
        const geometry = sceneGeometry(sourceToken);
        const targetState = clone(targetActor.system.shipCombat.state);
        const targetConfig = await materializeActorConfig(targetActor);
        const operator = config.operators?.find((entry) => entry.id === payload.operatorId);
        result = previewAttack({
          attackerConfig: config,
          attackerState: state,
          targetConfig,
          targetState,
          declaration: {
            ...payload,
            targetUuid,
            attackerPosition: tokenCenter(sourceToken, geometry),
            targetPosition: tokenCenter(targetToken, geometry),
            attackerVelocity: clone(state.velocity),
            targetVelocity: clone(targetState.velocity),
            attackerFacing: Number(sourceToken.rotation ?? 0),
            targetFacing: Number(targetToken.rotation ?? 0),
            lineOfSight: weaponLineOfSight(sourceToken, targetToken, geometry),
            gunneryModifier: Number(operator?.ratings?.gunnery ?? 0),
          },
        });
      }
      if (!current()) return;
      output.textContent = pretty(result);
      output.dataset.error = "false";
    } catch (error) {
      if (!current()) return;
      output.textContent = `Preview unavailable: ${errorText(error)}`;
      output.dataset.error = "true";
    }
  }

  async #submitUi(event, element, operationType = null) {
    event.preventDefault();
    const type = operationType ?? element.dataset.uiOperation;
    const data = elementFormData(element);
    const state = clone(this.actor.system.shipCombat.state);
    const pendingKey = type === "toggleWeapon" ? `${type}:${data.weaponId}` : type;
    if (this.#pending.has(pendingKey)) return;
    this.#pending.add(pendingKey);
    try {
      if (type === "attack") {
        const targets = this.#foundryTargets();
        if (targets.length !== 1) throw new Error("Select exactly one Foundry target before firing.");
        if (data.targetUuid !== targets[0].uuid) delete data.aimedComponentId;
        data.targetUuid = targets[0].uuid;
        if (!this.#view.targetedContacts.some((contact) => contact.targetUuid === data.targetUuid)) throw new Error("A Targeted sensor track is required.");
      }
      const config = await materializeActorConfig(this.actor);
      const operation = uiOperation(type, data, config, state);
      if (type === "routePower") previewPowerRoute(config, state, operation.payload);
      if (type === "routeDefense") previewDefenseRoute(config, state, operation.payload);
      if (TARGET_OPERATIONS.has(type) && operation.targetUuids.length !== 1) {
        throw new Error("Select one valid contact.");
      }
      element.disabled = true;
      this.#uiDrafts.delete(`${type}:${data.weaponId ?? ""}`);
      await this.#commitOperation(type, operation.payload, operation.targetUuids, state.revision);
    } catch (error) {
      ui.notifications.error(errorText(error));
      if (type === "toggleWeapon") element.value = this.#view.weapons.find((weapon) => weapon.id === data.weaponId)?.setting ?? "off";
    } finally {
      this.#pending.delete(pendingKey);
      if (element.isConnected) element.disabled = false;
    }
  }

  async #submitRaw(event, form) {
    event.preventDefault();
    try {
      const type = form.dataset.rawOperation;
      const payload = parseObject(form.elements.payload.value);
      const targetUuids = (form.elements.targets?.value ?? "").split(/[\s,]+/).filter(Boolean);
      await this.#commitOperation(type, payload, targetUuids);
      drafts.delete(draftKey(actorToken(this.actor)?.uuid ?? this.actor.uuid, `raw-${type}`));
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #commitOperation(type, payload, targetUuids, sourceRevision = this.actor.system.shipCombat.state?.revision) {
    const token = actorToken(this.actor);
    if (!token) throw new Error("Place this ship on the active Scene to operate it.");
    const revisions = { [token.uuid]: Number(sourceRevision ?? 0) };
    for (const uuid of targetUuids) {
      const document = await fromUuid(uuid);
      const revision = document?.actor?.system?.shipCombat?.state?.revision ?? document?.system?.shipCombat?.state?.revision;
      if (!Number.isInteger(revision)) throw new Error("The selected target is unavailable.");
      revisions[uuid] = revision;
    }
    if (type === "attack" && (this.#foundryTargets().length !== 1 || this.#foundryTargets()[0].uuid !== targetUuids[0])) throw new Error("Foundry targeting changed; select exactly one target and fire again.");
    const request = {
      id: foundry.utils.randomID(),
      type,
      sourceUuid: token.uuid,
      targetUuids,
      expectedRevisions: revisions,
      payload,
    };
    const response = await submitShipOperation(request);
    if (!response?.ok) throw new Error(response?.error?.message ?? response?.error ?? `${type} was rejected.`);
    this.#epoch++;
    this.#movementInput = null;
    clearMovementPreview(token.uuid);
    ui.notifications.info(`${type.replace(/([a-z])([A-Z])/g, "$1 $2")} committed.`);
    await this.render();
  }

  async #saveConfig(event) {
    event.preventDefault();
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      const hullConfig = parseObject(event.currentTarget.elements.config.value, "Hull configuration");
      await saveShipHull(this.actor, hullConfig, Number(event.currentTarget.dataset.revision));
      this.#hullDraft = null;
      ui.notifications.info("Hull configuration saved and installed components rematerialized.");
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #resetCanadensis() {
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      if (!globalThis.confirm("Replace this hull and its installed component copies with the Canadensis configuration?")) return;
      await resetShipToCanadensis(this.actor);
      this.#hullDraft = null;
      ui.notifications.info("Canadensis hull and fresh component copies restored.");
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #rollback(id) {
    if (!game.user.isGM || !globalThis.confirm(`Roll back the whole operation ${id}?`)) return;
    try {
      const response = await rollbackShipOperation(id);
      if (!response?.ok) throw new Error(response?.error?.message ?? response?.error ?? "Rollback was rejected.");
      ui.notifications.info("Whole operation rolled back.");
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }
}

export function registerShipSheet() {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, ShipConsole, { types: [SHIP_TYPE], makeDefault: true, label: "Vira Ship Console" });
}

export { ShipConsole, movementPreviewInput, canvasMovementPreview };
