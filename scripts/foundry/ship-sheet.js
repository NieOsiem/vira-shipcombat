import { COMPONENT_ITEM_TYPE, MODULE_ID, SHIP_TYPE } from "../constants.js";
import {
  buildShipConsoleView,
  helmCoastTrackGradientStyle,
  helmTrackGradientStyle,
  powerPriorities,
} from "./ship-view-model.js";
import { sceneGridGeometry } from "./scene-geometry.js";
import { SensorRadar } from "./sensor-radar.js";
import {
  getRefitDenial,
  installShipComponent,
  materializeActorConfig,
  removeShipComponent,
  resetShipToCanadensis,
  saveShipHull,
} from "./refit.js";
import {
  buildOperatorProfileFromActor,
  ensureActorCrewFeature,
} from "./crew.js";
import { openCrewRatingEditor } from "./crew-sheet.js";

import { previewPowerRoute } from "../rules/power.js";
import { previewDefenseRoute } from "../rules/shields.js";
import {
  armEvasion,
  getDriveCapabilities,
  previewManeuver,
  projectCoast,
} from "../rules/movement.js";
import { calculateStruckSector, previewAttack } from "../rules/combat.js";
import { getSensorStats, TRACK_STATUS } from "../rules/sensors.js";
import {
  assignedUserIds,
  rosterIdentityConflicts,
} from "../rules/operators.js";
import {
  getOperationLog,
  rollbackShipOperation,
  submitShipOperation,
} from "../state/action-queue.js";
import {
  clearMovementPreview,
  setMovementPreview,
} from "../canvas/overlays.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "crew", label: "Crew" },
  { id: "helm", label: "Helm" },
  { id: "power-defense", label: "Power" },
  { id: "sensors", label: "Sensors" },
  { id: "weapons", label: "Weapons" },
  { id: "damage", label: "Damage Control" },
];
const MAINTENANCE_TABS = [{ id: "refit", label: "Refit" }, {
  id: "log-config",
  label: "Log / Config",
}];
const GROUPS = {
  Overview: ["resolveFate"],
  Crew: ["setRoster", "spendResource", "takeControl", "releaseControl", "contributeWork"],
  Helm: ["maneuver", "rotate", "armEvasion", "disarmEvasion", "takeControl", "releaseControl"],
  "Power/Defense": ["routePower", "toggleWeapon", "routeDefense"],
  Sensors: [
    "ping",
    "acquire",
    "analyze",
    "deepScan",
    "firingSolution",
    "fade",
    "jam",
    "breakLock",
    "burnThrough",
  ],
  Weapons: ["attack", "beginReload", "reload", "cancelReload"],
  Damage: ["repair", "recoveryWork", "hullRepair", "cooling", "vent"],
};
const HELP = {
  resolveFate: "GM fate resolution",
  setRoster: '{"roster":{"command":[],"crew":[]}}',
  spendResource: '{"operatorId":"…","operation":{}}',
  takeControl: '{"operatorId":"…","control":"helm|power|defense"}',
  releaseControl: '{"operatorId":"…","control":"helm|power|defense"}',
  contributeWork: '{"operatorId":"…","jobId":"…","required":1}',
  maneuver:
    '{"operatorId":"…","deltaV":{"forward":0,"lateral":0},"rotation":0}',
  rotate: '{"operatorId":"…","rotation":0}',
  armEvasion: '{"operatorId":"…"}',
  disarmEvasion: '{"operatorId":"…"}',
  routePower: '{"operatorId":"…","allocation":{}}',
  toggleWeapon: '{"operatorId":"…","weaponId":"…"}',
  routeDefense: '{"operatorId":"…","allocation":{},"regenerationAllocation":{}}',
  ping: '{"operatorId":"…","operatorSensors":0}',
  acquire: '{"operatorId":"…","distance":0}',
  analyze: '{"operatorId":"…","distance":0}',
  deepScan: '{"operatorId":"…","distance":0}',
  firingSolution: '{"operatorId":"…","distance":0}',
  fade: '{"operatorId":"…"}',
  jam: '{"operatorId":"…","operatorSensors":0}',
  breakLock: '{"operatorId":"…","operatorSensors":0}',
  burnThrough: '{"operatorId":"…","operatorSensors":0}',
  attack: '{"operatorId":"…","weaponId":"…","barrage":1}',
  beginReload: '{"operatorId":"…","weaponId":"…"}',
  reload: '{"operatorId":"…","weaponId":"…","amount":1}',
  cancelReload: '{"operatorId":"…","weaponId":"…"}',
  repair: '{"operatorId":"…","conditionId":"…","rating":"engineering"}',
  recoveryWork: '{"operatorId":"…","conditionId":"…"}',
  hullRepair: '{"operatorId":"…","rating":"engineering"}',
  cooling: '{"operatorId":"…"}',
  vent: '{"operatorId":"…"}',
};
const SENSOR_HELP = Object.freeze({
  acquire: "Lock a live contact: makes it a targeted track you can shoot at",
  firingSolution: "Spend an action now to add +4 to one attack against this target later",
  breakLock: "Break a hostile targeted track locked onto your ship",
  ping: "Active sweep against every contact in range; leaves you easier to detect (−6 signature)",
  analyze: "Reveal this target's shields, armor, hull state and defensive protocols",
  deepScan: "Reveal this target's systems, weapons, arcs, heat and faults",
  jam: "Give this contact −4 on its checks against you until its next turn starts",
  burnThrough: "Contest and remove a jam this contact is projecting onto you",
  fade: "Try to slip passive detection and break tracks held on your ship",
});
const TARGETED = new Set([
  "acquire",
  "analyze",
  "deepScan",
  "firingSolution",
  "jam",
  "breakLock",
  "burnThrough",
  "attack",
]);
const GM_ONLY = new Set(["resolveFate"]);
const drafts = new Map();
const selectedTabs = new Map();
const radarScales = new Map();
const TARGET_OPERATIONS = new Set([
  "acquire",
  "analyze",
  "deepScan",
  "firingSolution",
  "jam",
  "breakLock",
  "burnThrough",
  "attack",
]);

function numeric(value, fallback = 0) {
  if (value === "" || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function truthyFormValue(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function elementFormData(element) {
  const form = element.matches?.("form")
    ? element
    : (element.closest?.("form[data-ui-operation]") ?? element.closest?.("form"));
  const values = form ? Object.fromEntries(new FormData(form).entries()) : {};
  const panel = element?.closest?.("[data-tab-panel]") ?? form?.closest?.("[data-tab-panel]");
  const operator = panel?.querySelector("[data-page-operator], select[name='operatorId']");
  if (!values.operatorId && operator?.value) values.operatorId = operator.value;
  const aimedComponent = form?.elements?.namedItem("aimedComponentId");
  if (
    !form?.querySelector("[data-aim-enabled]")?.checked ||
    aimedComponent?.dataset.targetUuid !== values.targetUuid
  ) delete values.aimedComponentId;
  return { ...values, ...(element?.dataset ?? {}) };
}

function rosterPayload(data, config, state) {
  const roster = clone(state?.roster ?? { command: [], crew: [] });
  roster.command = Array.isArray(roster.command) ? [...roster.command] : [];
  roster.crew = Array.isArray(roster.crew) ? [...roster.crew] : [];
  for (const kind of ["command", "crew"]) {
    const capacity = Number(config?.[`${kind}Capacity`] ?? 0);
    for (let slot = 0; slot < capacity; slot += 1) {
      const key = `${kind}-${slot}`;
      if (key in data) {
        const operatorId = data[key];
        roster[kind] = roster[kind].filter((entry) => {
          const entryOp = typeof entry === "string" ? entry : entry?.operatorId ?? entry?.id;
          return entry.slot !== slot && (!operatorId || entryOp !== operatorId);
        });
        if (operatorId) roster[kind].push({ operatorId, slot });
      }
    }
  }
  return roster;
}

function uiOperation(type, data, config, state) {
  const operatorId = data.operatorId || undefined;
  const payload = operatorId ? { operatorId } : {};
  if (game.user.isGM) payload.gmOverride = true;
  switch (type) {
    case "setRoster":
      return {
        payload: { gmOverride: true, roster: rosterPayload(data, config, state) },
        targetUuids: [],
      };
    case "takeControl":
    case "releaseControl":
      return {
        payload: { ...payload, control: data.control },
        targetUuids: [],
      };
    case "maneuver": {
      const forward = Number(numeric(data.forward).toFixed(2));
      const lateral = Number(numeric(data.lateral).toFixed(2));
      const rotation = Number(numeric(data.rotation).toFixed(1));
      const coast = Number(Math.max(0, numeric(data.coastDuration)).toFixed(2));
      if (coast > 0 && (forward !== 0 || lateral !== 0)) {
        throw new Error(
          "Coast requires zero main and lateral thrust; rotation is allowed.",
        );
      }
      return {
        payload: {
          ...payload,
          deltaV: { forward, lateral },
          rotation,
          ...(coast > 0 ? { duration: coast } : {}),
        },
        targetUuids: [],
      };
    }
    case "rotate":
      return {
        payload: { ...payload, rotation: Number(numeric(data.rotation).toFixed(1)) },
        targetUuids: [],
      };
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
          allocation: Object.fromEntries(
            ["engines", "shields", "sensors", "cooling", "weapons"]
              .map((system) => [system, numeric(data[system])]),
          ),
          ...powerPriorities(config, state, {
            sheddingPriority: formPriority(data, "sheddingPriority"),
            weaponPriority: formPriority(data, "weaponPriority"),
          }),
        },
        targetUuids: [],
      };
    case "routeDefense": {
      const bubble = config?.components?.shield?.topology === "bubble";
      const sectors = bubble
        ? [config.components.shield.sectors?.[0] ?? "bubble"]
        : config?.components?.shield?.sectors ??
          ["fore", "port", "starboard", "aft"];
      return {
        payload: {
          ...payload,
          allocation: Object.fromEntries(
            sectors.map((
              sector,
            ) => [sector, numeric(data[`allocation-${sector}`])]),
          ),
          regenerationAllocation: bubble ? { [sectors[0]]: 100 } : Object
            .fromEntries(
              sectors.map((
                sector,
              ) => [
                sector,
                numeric(
                  data[`regen-${sector}`],
                  state.shields?.regenerationAllocation?.[sector] ?? 0,
                ),
              ]),
            ),
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
      return {
        payload: result,
        targetUuids: data.targetUuid ? [data.targetUuid] : [],
      };
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
          ...(data.aimedComponentId
            ? { aimedComponentId: data.aimedComponentId }
            : {}),
        },
        targetUuids: data.targetUuid ? [data.targetUuid] : [],
      };
    case "beginReload":
    case "reload":
    case "cancelReload":
      return {
        payload: { ...payload, weaponId: data.weaponId },
        targetUuids: [],
      };
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
      return {
        payload: { ...payload, conditionId: data.conditionId },
        targetUuids: [],
      };
    case "contributeWork":
      return {
        payload: {
          ...payload,
          jobId: data.jobId,
          required: numeric(data.required, 1),
        },
        targetUuids: [],
      };
    default:
      throw new Error(`No purpose-built UI payload exists for ${type}.`);
  }
}

function formPriority(data, prefix) {
  const keys = Object.keys(data).filter((key) => key.startsWith(`${prefix}-`))
    .sort((a, b) =>
      numeric(a.split("-").at(-1)) - numeric(b.split("-").at(-1))
    );
  return keys.length ? keys.map((key) => data[key]) : undefined;
}

function clone(value) {
  return foundry.utils.deepClone(value ?? {});
}
function escapeSecrets(value, isGM, key = "") {
  if (isGM) return value;
  if (/secret|hidden|gmOnly|defenses|systems/i.test(key)) return "Unknown";
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => escapeSecrets(entry, false, key));
  }
  if (value.state === "undetected") {
    return { targetUuid: value.targetUuid ?? "Unknown", state: "undetected" };
  }
  return Object.fromEntries(
    Object.entries(value).map((
      [childKey, child],
    ) => [childKey, escapeSecrets(child, false, childKey)]),
  );
}
function errorText(error) {
  return error?.message ?? String(error);
}
function signed(value, digits = 2) {
  const number = Number(value ?? 0);
  const rounded = Number(number.toFixed(digits));
  const clean = Math.abs(rounded) < 1e-9 ? 0 : rounded;
  return `${clean >= 0 ? "+" : ""}${clean}`;
}

function rangeBandLabel(band) {
  if (band === "optimal") return "optimal";
  if (band === "beyondMaximum") return "beyond max";
  const quarter = /^extended(\d)$/.exec(String(band ?? ""));
  return quarter ? `extended ${quarter[1]}/4` : "unknown";
}

/** Range bands need translating; motion bands already read as ">2-4". */
function modifierDetail(band) {
  const text = String(band ?? "");
  return /^(extended\d|optimal|beyondMaximum)$/.test(text)
    ? rangeBandLabel(text)
    : text;
}

function actorToken(actor) {
  const synthetic = actor?.token?.document ?? actor?.token;
  if (synthetic && (actor?.isToken || synthetic.actor === actor)) {
    return synthetic;
  }

  const sceneId = canvas?.scene?.id;
  if (!sceneId || typeof actor?.getActiveTokens !== "function") return null;
  const matches = actor.getActiveTokens(true)
    .map((token) => token?.document ?? token)
    .filter((token) => (token?.parent?.id ?? token?.scene?.id) === sceneId);
  const unique = Array.from(
    new Map(matches.map((token) => [token.uuid, token])).values(),
  );
  return unique.length === 1 ? unique[0] : null;
}

function sourceUnavailableReason(actor) {
  const scene = globalThis.canvas?.scene;
  const names = collectionValues(actor?.getActiveTokens?.(true)).map((token) =>
    token?.document ?? token
  )
    .filter((token) => (token?.parent?.id ?? token?.scene?.id) === scene?.id)
    .map((token) => `${token.name ?? actor.name} (${token.id})`);
  if (names.length > 1) {
    return `Multiple linked tokens on Scene “${scene?.name ?? "Unnamed"}”: ${
      names.join(", ")
    }. Open a specific token's console to choose the source.`;
  }
  const baseId = actor?.isToken
    ? actor?.token?.actorId ?? actor?.token?.baseActor?.id ?? actor?.id
    : actor?.id;
  const placements = scene
    ? sceneTokenDocuments(scene).filter((token) =>
      (token?.actorId ?? token?.actor?.id) === baseId
    )
    : [];
  if (placements.length) {
    const placed = placements.map((token) =>
      `${token.name ?? actor.name} (${token.id})`
    );
    return `This ship is placed on Scene “${scene.name}” as an unlinked token copy: ${
      placed.join(", ")
    }. Open the console from that token on the canvas (double-click the ship token); this sidebar sheet edits the unplaced template.`;
  }
  return `No linked token on Scene “${
    scene?.name ?? "No active scene"
  }”. Place this ship on the active Scene to use operational controls.`;
}

function draftKey(source, type) {
  const uuid = typeof source === "string"
    ? source
    : actorToken(source)?.uuid ?? source?.uuid;
  return `${uuid ?? "unbound"}-${type}`;
}
function pretty(value) {
  return JSON.stringify(value, null, 2);
}
function parseObject(text, label = "JSON") {
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
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
  return (tiers ?? []).map((tier) => `${tier.power}:${tier[valueKey] ?? "—"}`)
    .join(" · ");
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
        {
          label: "Hull",
          value: `${state?.hull ?? "—"} / ${config?.maxHull ?? "—"}`,
        },
        {
          label: "Heat",
          value: `${state?.heat ?? "—"} / ${config?.heatCapacity ?? "—"}`,
        },
        {
          label: "Command / Crew",
          value: `${config?.commandCapacity ?? "—"} / ${
            config?.crewCapacity ?? "—"
          }`,
        },
        { label: "Fate policy", value: config?.fatePolicy ?? "—" },
      ],
    },
    {
      label: "Movement and defense",
      entries: [
        {
          label: "Main / Reverse thrust",
          value: `${capability.forward} / ${capability.retro}`,
        },
        {
          label: "Port / Starboard thrust",
          value: `${capability.port} / ${capability.starboard}`,
        },
        { label: "Rotation", value: `${capability.rotation}°` },
        { label: "Safe Velocity", value: config?.safeVelocity ?? "—" },
        {
          label: "Evasion",
          value: `${
            Math.round(
              numeric(config?.evasionReserve) *
                (numeric(config?.evasionReserve) <= 1 ? 100 : 1),
            )
          }% reserve · +${config?.evasionAcBonus ?? "—"} AC`,
        },
        {
          label: "Armor",
          value: `Fore ${armor.fore ?? "—"} · Port ${
            armor.port ?? "—"
          } · Starboard ${armor.starboard ?? "—"} · Aft ${armor.aft ?? "—"}`,
        },
      ],
    },
    {
      label: "Power, shields, and sensors",
      entries: [
        {
          label: "Reactor",
          value: installedSummary(
            reactor,
            (entry) =>
              `${entry.nominalOutput ?? "—"} nominal · ${
                entry.redlineOutput ?? "—"
              } redline · ${entry.overclockHeat ?? "—"} Heat`,
          ),
        },
        {
          label: "Available power",
          value: `${power.unused} free · ${power.ceilings.maximum} capacity`,
        },
        {
          label: "Shields",
          value: installedSummary(
            shield,
            (entry) =>
              `${entry.topology ?? "—"} · ${
                entry.totalBudget ?? "—"
              } budget · ${entry.sectorCap ?? "—"} cap · ${
                entry.rechargeDelay ?? "—"
              } delay`,
          ),
        },
        {
          label: "Shield regeneration (Power:value)",
          value: shield
            ? tierSummary(shield.tiers, "regeneration") || "No tiers"
            : "Not installed",
        },
        {
          label: "Passive sensors",
          value: sensor
            ? `${sensorBase.passiveRange ?? "—"} range · ${
              sensorBase.passiveStrength ?? "—"
            } strength`
            : "Not installed",
        },
        {
          label: "Active sensors",
          value: sensor
            ? `${sensorBase.activeRange ?? "—"} range · ${
              sensorBase.activeModifier ?? "—"
            } modifier · ${sensorBase.ewModifier ?? "—"} EW`
            : "Not installed",
        },
        {
          label: "Cooling (Power:value)",
          value: cooling
            ? tierSummary(cooling.tiers, "cooling") || "No tiers"
            : "Not installed",
        },
        {
          label: "Emergency vent",
          value: cooling
            ? `${cooling.ventAmount ?? "—"} Heat · ${
              cooling.ventCooldown ?? "—"
            } Start cooldown`
            : "Not installed",
        },
        {
          label: "Current regeneration",
          value:
            shield?.tiers?.find((tier) => tier.power === state?.power?.shields)
              ?.regeneration ?? 0,
        },
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
    .filter((condition) =>
      condition?.componentId === itemId || condition?.targetId === itemId
    );
  const severityRank = {
    destroyed: 5,
    critical: 4,
    major: 3,
    minor: 2,
    unknown: 1,
  };
  const condition =
    conditions.sort((left, right) =>
      (severityRank[right?.severity] ?? 0) - (severityRank[left?.severity] ?? 0)
    )[0];
  if (condition?.severity === "destroyed") return "Destroyed";
  if (condition?.severity) return `${titleCase(condition.severity)} damage`;
  if (weapon.status) return titleCase(weapon.status);
  return "Installed · nominal";
}

function refitMountView(actor, state, mount, kind) {
  const hardpoint = kind === "hardpoint";
  const itemId = hardpoint ? mount.weaponId : mount.itemId;
  const item = itemId
    ? actor.items?.get?.(itemId) ??
      collectionValues(actor.items).find((entry) => entry?.id === itemId)
    : null;
  const installed = Boolean(item);
  const role = hardpoint
    ? "Weapon hardpoint"
    : mount.class === "drive"
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
    dropLabel: `Drop exact ${hardpoint ? mount.category : mount.class} · ${
      hardpoint ? mount.mountSize : mount.size
    }`,
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
  if (typeof collection?.values === "function") {
    return Array.from(collection.values());
  }
  return collection?.[Symbol.iterator] ? Array.from(collection) : [];
}

function sceneTokenDocuments(scene) {
  const documents = collectionValues(scene?.tokens);
  if (documents.length > 0) {
    return documents.map((entry) => entry?.document ?? entry);
  }
  return collectionValues(globalThis.canvas?.tokens?.placeables).map((entry) =>
    entry?.document ?? entry
  );
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
  return Number(
    wall?.move ?? wall?.document?.move ?? wall?._source?.move ?? 1,
  ) !== none;
}

function sightWall(wall) {
  if (doorIsOpen(wall)) return false;
  const none = globalThis.CONST?.WALL_SENSE_TYPES?.NONE ?? 0;
  return Number(
    wall?.sight ?? wall?.document?.sight ?? wall?._source?.sight ?? 1,
  ) !== none;
}

function cross(first, second, third) {
  return ((second.x - first.x) * (third.y - first.y)) -
    ((second.y - first.y) * (third.x - first.x));
}

function pointOnSegment(point, start, end, epsilon = 1e-9) {
  return Math.abs(cross(start, end, point)) <= epsilon &&
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);
  const epsilon = 1e-9;
  if (
    ((firstSideStart > epsilon && firstSideEnd < -epsilon) ||
      (firstSideStart < -epsilon && firstSideEnd > epsilon)) &&
    ((secondSideStart > epsilon && secondSideEnd < -epsilon) ||
      (secondSideStart < -epsilon && secondSideEnd > epsilon))
  ) {
    return true;
  }
  return (Math.abs(firstSideStart) <= epsilon &&
    pointOnSegment(secondStart, firstStart, firstEnd, epsilon)) ||
    (Math.abs(firstSideEnd) <= epsilon &&
      pointOnSegment(secondEnd, firstStart, firstEnd, epsilon)) ||
    (Math.abs(secondSideStart) <= epsilon &&
      pointOnSegment(firstStart, secondStart, secondEnd, epsilon)) ||
    (Math.abs(secondSideEnd) <= epsilon &&
      pointOnSegment(firstEnd, secondStart, secondEnd, epsilon));
}

function trackForTarget(state, targetUuid) {
  return Object.values(state?.tracks ?? {}).find((track) =>
    String(track?.targetUuid) === String(targetUuid)
  );
}

function namedAimedComponents(contact, components = []) {
  const remembered = contact.remembered?.identifiedSubsystems ?? [];
  const knownIds = new Set(
    remembered.map((component) =>
      String(component?.id ?? component?.componentId ?? component)
    ),
  );
  const revealed = contact.systemsRevealed === true;
  const candidates = [
    ...remembered,
    ...collectionValues(contact.systems?.installedWeapons),
    ...collectionValues(contact.systems?.weapons),
    ...components.filter((component) =>
      revealed || knownIds.has(String(component.id))
    ),
  ];
  const options = new Map();
  for (const component of candidates) {
    const id = component?.id ?? component?.componentId;
    const label = component?.label ?? component?.name;
    if (
      id == null || typeof id === "object" || typeof label !== "string" ||
      !label.trim() || label.trim() === String(id)
    ) continue;
    options.set(String(id), {
      ...component,
      id: String(id),
      label: label.trim(),
    });
  }
  return Array.from(options.values()).sort((left, right) =>
    left.label.localeCompare(right.label)
  );
}

function liveTrack(state, targetUuid) {
  const track = trackForTarget(state, targetUuid);
  return track?.state === TRACK_STATUS.CONTACT ||
    track?.state === TRACK_STATUS.TARGETED;
}

function weaponLineOfSight(sourceToken, targetToken, geometry) {
  const start = tokenCenter(sourceToken, geometry);
  const end = tokenCenter(targetToken, geometry);
  return !collectionValues(geometry.scene?.walls).some((wall) => {
    if (!sightWall(wall)) return false;
    const coordinates = wallCoordinates(wall);
    if (!coordinates) return false;
    const a = {
      x: coordinates[0] * geometry.unitsPerPixel,
      y: coordinates[1] * geometry.unitsPerPixel,
    };
    const b = {
      x: coordinates[2] * geometry.unitsPerPixel,
      y: coordinates[3] * geometry.unitsPerPixel,
    };
    return segmentsIntersect(start, end, a, b);
  });
}

async function movementObstacles(
  sourceToken,
  geometry,
  observerState,
  isGM = globalThis.game?.user?.isGM === true,
) {
  const obstacles = [];
  for (const token of sceneTokenDocuments(geometry.scene)) {
    if (
      !token || token.uuid === sourceToken.uuid || token.id === sourceToken.id
    ) continue;
    const actor = token.actor;
    const shipCombat = actor?.system?.shipCombat;
    if (
      actor?.type !== SHIP_TYPE || !shipCombat?.config || !shipCombat?.state
    ) continue;
    if (
      !isGM &&
      (token.hidden === true ||
        (!actor.isOwner && !liveTrack(observerState, token.uuid)))
    ) continue;
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
      a: {
        x: coordinates[0] * geometry.unitsPerPixel,
        y: coordinates[1] * geometry.unitsPerPixel,
      },
      b: {
        x: coordinates[2] * geometry.unitsPerPixel,
        y: coordinates[3] * geometry.unitsPerPixel,
      },
    });
  }
  return obstacles;
}

function targetedCoastProjections(state, geometry) {
  const tokens = new Map(
    sceneTokenDocuments(geometry.scene).map((
      token,
    ) => [String(token.uuid), token]),
  );
  const projections = [];
  for (const track of Object.values(state?.tracks ?? {})) {
    if (track?.state !== TRACK_STATUS.TARGETED) continue;
    const token = tokens.get(String(track.targetUuid));
    const targetState = token?.actor?.system?.shipCombat?.state;
    if (!token || !targetState) continue;
    if (!globalThis.game?.user?.isGM && token.hidden === true) continue;
    const duration = targetState.phase === "active"
      ? Math.max(0, 1 - Number(targetState.timeline ?? 0))
      : 1;
    const projection = projectCoast({
      position: tokenCenter(token, geometry),
      velocity: clone(targetState.velocity ?? { x: 0, y: 0 }),
      facing: Number(token.rotation ?? 0),
      duration,
      collisionRadius: tokenRadius(token, geometry),
    });
    const label = globalThis.game?.user?.isGM
      ? token.name ?? token.actor?.name
      : track.remembered?.label ?? track.remembered?.identity?.label;
    projections.push({
      targetUuid: token.uuid,
      label: label ?? "Tracked contact",
      path: projection.path,
    });
  }
  return projections;
}
function canvasPoint(point, pixelsPerUnit) {
  if (
    !point || !Number.isFinite(Number(point.x)) ||
    !Number.isFinite(Number(point.y))
  ) return point;
  return {
    ...point,
    x: Number(point.x) * pixelsPerUnit,
    y: Number(point.y) * pixelsPerUnit,
  };
}

function canvasMovementPreview(preview, geometry) {
  const converted = clone(preview);
  converted.path = Array.isArray(converted.path)
    ? converted.path.map((entry) => ({
      ...entry,
      position: canvasPoint(entry.position, geometry.pixelsPerUnit),
    }))
    : converted.path;
  for (const key of ["position", "poweredEnd", "coastEnd"]) {
    if (key === "position") {
      converted.position = canvasPoint(
        converted.position,
        geometry.pixelsPerUnit,
      );
    } else if (converted[key]) {
      converted[key] = {
        ...converted[key],
        position: canvasPoint(converted[key].position, geometry.pixelsPerUnit),
      };
    }
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
    position: { width: 735, height: 840 },
    window: { resizable: true },
    actions: {},
  };

  static PARTS = {
    console: { template: `modules/${MODULE_ID}/templates/ship-console.hbs` },
  };
  #hullDraft = null;
  #aimedComponents = new Map();
  #aimContexts = new WeakMap();
  #view = null;
  #config = null;
  #root = null;
  #epoch = 0;
  #previewSerial = new WeakMap();
  #hooks = [];
  #sensorFocus = "";
  #radar = null;
  #operators = new Map();
  #uiDrafts = new Map();
  #details = new Map();
  #movementInput = null;
  #canAct = false;
  #pending = new Set();
  #weaponIntents = new Map();
  #shots = new Map();
  #panelWeapon = "";
  #peekWeapon = "";
  #tokenRefresh = null;
  #dragItem = null;
  #dragListeners = null;

  get title() {
    const state = this.actor?.system?.shipCombat?.state;
    const phase = state?.phase ?? "outsideCombat";
    if (phase === "outsideCombat") return "Outside Combat";
    const combat = globalThis.game?.combat;
    const round = Number.isSafeInteger(combat?.round) ? combat.round : "?";
    const token = actorToken(this.actor);
    const active = token && (
      combat?.combatant?.tokenId === token.id ||
      combat?.combatant?.token?.uuid === token.uuid
    );
    return `Combat · Round ${round} · ${active ? "Active" : "Waiting"}`;
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
    if (this.#hullDraft) this.#refreshHullDraft();
    const config = await materializeActorConfig(actor);
    const isGM = game.user.isGM;
    const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
    const canInspect = isGM || actor.testUserPermission(game.user, observer);
    const assigned = assignedUserIds(config, state).has(game.user.id);
    const canOperate = Boolean(token && (isGM || (canInspect && assigned)));
    const unavailableReason = !token
      ? sourceUnavailableReason(actor)
      : !canInspect
      ? "Observer permission is required."
      : !isGM && !assigned
      ? "No ship operator is assigned to your user."
      : "";
    const actReason = canOperate
      ? state.phase === "active" ? "" : "Active Phase required."
      : unavailableReason || "Operational access required.";
    const rosterConflicts = rosterIdentityConflicts(config, state?.roster)
      .map((conflict) => ({
        tokens: conflict.tokens.join(" · "),
        slots: conflict.operators.map(({ slot, index, operatorId }) => {
          const label = (config.operators ?? []).find((entry) =>
            entry.id === operatorId
          )?.label ?? operatorId;
          return `${slot === "command" ? "Command" : "Crew"} ${index} — ${label}`;
        }).join("; "),
      }));

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
            const components =
              (await materializeActorConfig(document.actor)).components ?? {};
            targetComponents.set(
              uuid,
              [
                components.reactor,
                components.shield,
                components.sensor,
                components.cooling,
                ...Object.values(components.drives ?? {}),
                ...(components.weapons ?? []),
              ].filter(Boolean),
            );
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
      radarScale: radarScales.get(actor.uuid) ?? null,
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
    const rawActions = Object.keys(GROUPS).flatMap((tab) =>
      (GROUPS[tab] ?? []).map((type) => {
        const gmDenied = GM_ONLY.has(type) && !isGM;
        return {
          type,
          group: tab,
          help: HELP[type] ?? "{}",
          targeted: TARGETED.has(type),
          disabled: !canOperate || gmDenied,
          reason: unavailableReason || (gmDenied ? "Active GM only." : ""),
        };
      })
    );

    let log = [];
    if (isGM && token) {
      try {
        log = await getOperationLog() ?? [];
      } catch (error) {
        log = [{ error: errorText(error) }];
      }
    }
    const visibleLog = Array.isArray(log)
      ? log.slice(-30).reverse().map((entry) => ({
        id: entry.id ?? entry.requestId ?? "",
        type: entry.request?.type ?? entry.type ?? entry.kind ?? "operation",
        timestamp: entry.timestamp ?? "",
        ok: entry.response?.ok !== false && entry.kind !== "rejected",
        json: pretty(entry),
        rollback: entry.kind === "operation" &&
          Boolean(entry.id ?? entry.requestId),
      }))
      : [];
    const refitDenial = getRefitDenial(actor);
    const refitSlots = (hullConfig.slots ?? []).map((slot) =>
      refitMountView(actor, state, slot, "slot")
    );
    const refitHardpoints = (hullConfig.hardpoints ?? []).map((hardpoint) =>
      refitMountView(actor, state, hardpoint, "hardpoint")
    );
    const referencedItemIds = new Set([
      ...(hullConfig.slots ?? []).map((slot) => slot.itemId),
      ...(hullConfig.hardpoints ?? []).map((hardpoint) => hardpoint.weaponId),
    ]);
    const refitUnreferencedItems = collectionValues(actor.items)
      .filter((item) =>
        item.type === COMPONENT_ITEM_TYPE && !referencedItemIds.has(item.id)
      )
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
      maintenanceTabs: MAINTENANCE_TABS.map((tab) => ({
        ...tab,
        active: tab.id === activeTab,
      })),
      isGM,
      canOperate,
      unavailableReason,
      actReason,
      rosterConflicts,
      canRefit: !refitDenial,
      refitDenial,
      refitSlots,
      refitHardpoints,
      refitUnreferencedItems,
      canAdmin: Boolean(isGM && canOperate),
      canAct: Boolean(canOperate && state.phase === "active"),
      canAttack: Boolean(canOperate && state.phase === "active"),
      activePhase: state.phase === "active",
      tabState: Object.fromEntries(
        tabIds.map((id) => [id, { active: id === activeTab }]),
      ),
      view,
      rawActions,
      revision: Number(state.revision ?? 0),
      phase: state.phase ?? "—",
      turnKey: state.turnKey ?? "—",
      specGroups: configurationSummary(config, state, view),
      stateJson: pretty(escapeSecrets(state, isGM)),
      configJson: this.#hullDraft?.json ?? pretty(hullConfig),
      configRevision: this.#hullDraft?.revision ?? state.revision,
      hullDraftStale: this.#hullDraft?.stale ?? false,
      log: visibleLog,
    }, { inplace: false });
  }

  async close(options = {}) {
    this.#radar?.destroy();
    this.#radar = null;
    this.#hullDraft = null;
    this.#epoch++;
    this.#root = null;
    if (this.#tokenRefresh) {
      clearTimeout(this.#tokenRefresh);
      this.#tokenRefresh = null;
    }
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
          const data = globalThis.TextEditor?.getDragEventData?.(event) ??
            JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
          const ItemClass = globalThis.Item?.implementation ??
            globalThis.CONFIG?.Item?.documentClass;
          if (data.type === "Item") {
            this.#dragItem = Promise.resolve(ItemClass?.fromDropData?.(data))
              .catch(() => null);
          }
        } catch (_error) {
          /* Unrelated browser drags have no Foundry Item payload. */
        }
      };
      const end = () => {
        this.#dragItem = null;
        this.#root?.querySelectorAll("[data-refit-drop]").forEach((drop) => {
          drop.dataset.dragActive = "false";
          drop.classList.remove("is-dragover");
        });
      };
      this.#dragListeners = { start, end };
      document.addEventListener("dragstart", start);
      document.addEventListener("dragend", end);
      document.addEventListener("drop", end);
    }
    if (!this.#hooks.length) {
      this.#hooks.push([
        "targetToken",
        Hooks.on("targetToken", (user) => {
          if (user?.id === game.user.id && this.#root) {
            this.#refreshTargets(this.#root);
          }
        }),
      ]);
      this.#hooks.push([
        "viraShipCombatConsoleRefresh",
        Hooks.on("viraShipCombatConsoleRefresh", () => {
          this.#epoch++;
          this.#movementInput = null;
          const token = actorToken(this.actor);
          if (token) clearMovementPreview(token.uuid);
          if (this.rendered) void this.render();
        }),
      ]);
      for (const event of ["createWall", "updateWall", "deleteWall"]) {
        this.#hooks.push([
          event,
          Hooks.on(event, () => {
            const panel = this.#root?.querySelector(
              "[data-tab-panel='weapons']",
            );
            if (panel && !panel.hidden) {
              panel.querySelectorAll("form[data-live-preview='attack']")
                .forEach((form) => void this.#previewUi(form));
            }
          }),
        ]);
      }
      for (const event of ["updateToken", "createToken", "deleteToken"]) {
        this.#hooks.push([
          event,
          Hooks.on(event, (token, changes) =>
            this.#queueGeometryRefresh(event, changes)),
        ]);
      }
    }
    this.#attachNavigation(html);
    html.querySelectorAll("select[data-default]").forEach((select) => {
      const preferred = select.dataset.default;
      if (
        preferred &&
        Array.from(select.options).some((option) => option.value === preferred)
      ) select.value = preferred;
    });
    this.#restoreControls(html);
    this.#applyWeaponIntents(html);
    this.#renderFirePanel(html);
    this.#attachHelm(html);
    this.#attachPower(html);
    this.#attachDefense(html);
    html.querySelectorAll("[data-sensor-focus]").forEach((button) =>
      button.addEventListener("click", () => {
        const uuid = button.dataset.sensorFocus;
        this.#sensorFocus = uuid;
        this.#refreshSensors(html);
        if (uuid && globalThis.canvas?.scene) {
          const targetToken = sceneTokenDocuments(canvas.scene).find((t) => t.uuid === uuid);
          const placeable = targetToken?.object ?? canvas?.tokens?.get?.(targetToken?.id);
          if (placeable) {
            placeable.setTarget(true, { releaseOthers: true });
          }
        }
      })
    );
    this.#refreshSensors(html);
    const stage = html.querySelector("[data-radar-stage]");
    this.#radar?.destroy();
    this.#radar = null;
    if (stage) {
      this.#radar = new SensorRadar(stage);
      this.#radar.onScaleChange = (value) => {
        const uuid = this.actor?.uuid;
        if (!uuid) return;
        if (value == null) radarScales.delete(uuid);
        else radarScales.set(uuid, value);
      };
      this.#radar.attach();
      this.#radar.setView(this.#view);
    }
    html.querySelectorAll("form[data-ui-operation='attack']").forEach(
      (form) => {
        const weaponId = form.dataset.weaponId;
        const envelope = () => {
          this.#previewWeaponEnvelope(form);
          this.#peekWeapon = weaponId;
          this.#renderFirePanel();
        };
        const clearEnvelope = (event) => {
          if (event.type === "focusout" && form.contains(event.relatedTarget)) {
            return;
          }
          const token = actorToken(this.actor);
          if (token) clearMovementPreview(token.uuid);
          this.#peekWeapon = "";
          this.#renderFirePanel();
        };
        form.addEventListener("pointerenter", envelope);
        form.addEventListener("focusin", envelope);
        form.addEventListener("pointerleave", clearEnvelope);
        form.addEventListener("focusout", clearEnvelope);
        // Clicking anywhere on the card pins it as the panel's subject.
        form.addEventListener("pointerdown", () => {
          this.#panelWeapon = weaponId;
          this.#renderFirePanel();
        });
        form.querySelector("[data-aim-enabled]")?.addEventListener(
          "change",
          () => {
            this.#refreshAimed(form);
            form.dispatchEvent(new Event("input", { bubbles: true }));
          },
        );
        this.#syncBarrage(form);
        form.querySelector("[data-barrage-enabled]")?.addEventListener(
          "change",
          (event) => this.#toggleBarrage(form, event.currentTarget.checked),
        );
        form.querySelectorAll("[data-weapon-setting]").forEach((segment) => {
          segment.addEventListener("click", (event) => {
            event.stopPropagation();
            void this.#submitWeaponSetting(event, segment);
          });
        });
      },
    );
    this.#refreshTargets(html);
    html.querySelectorAll("form[data-ui-operation]").forEach((form) => {
      form.addEventListener("submit", (event) => this.#submitUi(event, form));
    });
    html.querySelectorAll("button[data-ui-operation]").forEach((button) => {
      button.addEventListener(
        "click",
        (event) => this.#submitUi(event, button),
      );
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
        drafts.set(key, {
          payload: form.elements.payload.value,
          targets: form.elements.targets?.value ?? "",
        });
        void this.#previewRaw(form);
      });
      form.addEventListener("submit", (event) => this.#submitRaw(event, form));
    });
    const configForm = html.querySelector("form[data-config]");
    const hullEditor = configForm?.closest("details");
    hullEditor?.addEventListener("toggle", () => {
      if (hullEditor.open) this.#refreshHullDraft(configForm);
    });
    if (hullEditor?.open) this.#refreshHullDraft(configForm);
    configForm?.addEventListener("input", () => {
      const json = configForm.elements.config.value;
      if (!this.#hullDraft) this.#refreshHullDraft();
      this.#hullDraft.json = json;
      this.#hullDraft.dirty = json !== this.#hullDraft.base;
      this.#refreshHullDraft(configForm);
    });
    html.querySelector("[data-hull-reload]")?.addEventListener("click", () => {
      this.#refreshHullDraft(configForm, true);
      configForm.elements.config.focus();
    });
    configForm?.addEventListener("submit", (event) => this.#saveConfig(event));
    html.querySelector("[data-canadensis]")?.addEventListener(
      "click",
      () => this.#resetCanadensis(),
    );
    html.querySelectorAll("[data-refit-drop]").forEach((drop) => {
      drop.addEventListener(
        "dragover",
        (event) => void this.#dragComponent(event, drop),
      );
      drop.addEventListener("dragleave", (event) => {
        if (!drop.contains(event.relatedTarget)) {
          drop.classList.remove("is-dragover");
          drop.dataset.dragActive = "false";
        }
      });
      drop.addEventListener(
        "drop",
        (event) => void this.#dropComponent(event, drop),
        true,
      );
    });
    html.querySelectorAll("[data-roster-slot]").forEach((slotEl) => {
      slotEl.addEventListener(
        "dragover",
        (event) => void this.#dragRoster(event, slotEl),
      );
      slotEl.addEventListener("dragleave", (event) => {
        if (!slotEl.contains(event.relatedTarget)) {
          slotEl.classList.remove("is-dragover");
        }
      });
      slotEl.addEventListener(
        "drop",
        (event) => void this.#dropRoster(event, slotEl),
        true,
      );
    });
    html.querySelectorAll("[data-roster-remove]").forEach((button) => {
      button.addEventListener(
        "click",
        () => void this.#unassignRosterSlot(button.dataset.rosterRemove),
      );
    });
    html.querySelectorAll("[data-roster-edit]").forEach((button) => {
      button.addEventListener(
        "click",
        () => void this.#editRosterActor(button.dataset.rosterEdit),
      );
    });
    html.querySelectorAll("[data-roster-actor]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const actorId = element.dataset.rosterActor;
        const actor = globalThis.game?.actors?.get(actorId);
        actor?.sheet?.render(true);
      });
    });
    html.querySelectorAll("[data-refit-item]").forEach((button) => {
      button.addEventListener(
        "click",
        () => this.#openComponent(button.dataset.refitItem),
      );
    });
    html.querySelectorAll("[data-refit-remove]").forEach((button) => {
      button.addEventListener(
        "click",
        () => void this.#removeComponent(button.dataset.refitRemove, button),
      );
    });
    html.querySelectorAll("[data-refit-browse]").forEach((button) => {
      button.addEventListener(
        "click",
        () => void this.#browseComponents(button.dataset.refitBrowse, button),
      );
    });
    html.querySelectorAll("[data-rollback]").forEach((button) => {
      button.addEventListener(
        "click",
        () => this.#rollback(button.dataset.rollback),
      );
    });
    html.querySelector("[data-native-vehicle-sheet]")?.addEventListener(
      "click",
      () => {
        try {
          openNativeVehicleSheet(this.actor);
        } catch (error) {
          ui.notifications.error(errorText(error));
        }
      },
    );
  }

  #refreshHullDraft(form = null, reload = false) {
    const data = this.actor.system.shipCombat;
    const current = pretty(data.config);
    if (reload || !this.#hullDraft?.dirty) {
      this.#hullDraft = {
        json: current,
        base: current,
        revision: data.state.revision,
        dirty: false,
        stale: false,
      };
    } else {
      this.#hullDraft.stale = current !== this.#hullDraft.base;
      if (!this.#hullDraft.stale) {
        this.#hullDraft.revision = data.state.revision;
      }
    }
    if (form) {
      if (form.elements.config.value !== this.#hullDraft.json) {
        form.elements.config.value = this.#hullDraft.json;
      }
      form.dataset.revision = String(this.#hullDraft.revision);
      const banner = form.closest("details")?.querySelector(
        "[data-hull-stale]",
      );
      if (banner) banner.hidden = !this.#hullDraft.stale;
    }
  }

  #attachNavigation(html) {
    const prefix = this.id;
    const ids = new Map();
    html.querySelectorAll("[id]").forEach((element) => {
      const previous = element.id;
      const next = previous.startsWith(`${prefix}-`)
        ? previous
        : `${prefix}-${previous}`;
      ids.set(previous, next);
      element.id = next;
    });
    html.querySelectorAll("[aria-controls], [aria-labelledby]").forEach(
      (element) => {
        for (const attribute of ["aria-controls", "aria-labelledby"]) {
          if (element.hasAttribute(attribute)) {
            element.setAttribute(
              attribute,
              element.getAttribute(attribute).split(/\s+/).map((id) =>
                ids.get(id) ?? id
              ).join(" "),
            );
          }
        }
      },
    );
    html.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      const heading = panel.querySelector(".ship-panel-heading h2");
      panel.tabIndex = -1;
      if (heading) {
        heading.id = `${prefix}-heading-${panel.dataset.tabPanel}`;
        panel.setAttribute("aria-labelledby", heading.id);
      }
    });
    const tabs = Array.from(html.querySelectorAll("[role='tab']"));
    const selected =
      tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ??
        tabs[0];
    tabs.forEach((tab) => {
      tab.tabIndex = tab === selected ? 0 : -1;
      tab.addEventListener("keydown", (event) => {
        const index = tabs.indexOf(tab);
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
          ? tabs.length - 1
          : event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : -1;
        if (next < 0) return;
        event.preventDefault();
        this.#selectTab(html, tabs[next].dataset.tabButton);
        tabs[next].focus();
      });
    });
    html.querySelectorAll("[data-tab-button]").forEach((button) => {
      button.addEventListener(
        "click",
        () => this.#selectTab(html, button.dataset.tabButton),
      );
    });
    const menu = html.querySelector(".ship-maintenance-menu");
    menu?.addEventListener("toggle", () => {
      if (!menu.open && menu.contains(document.activeElement)) {
        html.querySelector("[data-tab-panel]:not([hidden])")?.focus();
      }
    });
    menu?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      html.querySelector("[data-tab-panel]:not([hidden])")?.focus();
    });
  }

  #selectTab(html, id) {
    selectedTabs.set(this.actor.uuid, id);
    html.querySelectorAll("[data-tab-button]").forEach((element) => {
      const active = element.dataset.tabButton === id;
      if (element.getAttribute("role") === "tab") {
        element.setAttribute("aria-selected", String(active));
        element.tabIndex = active || (!TABS.some((tab) =>
            tab.id === id
          ) && element.dataset.tabButton === TABS[0].id)
          ? 0
          : -1;
      } else element.setAttribute("aria-pressed", String(active));
    });
    html.querySelectorAll("[data-tab-panel]").forEach((element) => {
      element.hidden = element.dataset.tabPanel !== id;
    });
    html.querySelectorAll("details").forEach((details) => {
      if (details.querySelector("[data-tab-button]") && details.open) {
        details.open = false;
        html.querySelector(`[data-tab-panel='${id}']`)?.focus();
      }
    });
    this.#epoch++;
    const token = actorToken(this.actor);
    if (token) clearMovementPreview(token.uuid);
    html.querySelectorAll(`[data-tab-panel='${id}'] form[data-live-preview]`)
      .forEach((form) => void this.#previewUi(form));
  }

  #restoreControls(html) {
    const revision = this.actor.system.shipCombat.state.revision;
    html.querySelectorAll("[data-page-operator], select[name='operatorId']")
      .forEach((select) => {
        const key = select.dataset.pageOperator ??
          select.closest("[data-tab-panel]")?.dataset.tabPanel;
        const saved = this.#operators.get(key);
        select.querySelectorAll("option").forEach((option) => {
          if (
            this.#view.operators.find((operator) =>
              operator.id === option.value
            )?.inactive
          ) option.disabled = true;
        });
        if (
          saved &&
          Array.from(select.options).some((option) =>
            option.value === saved && !option.disabled
          )
        ) select.value = saved;
        select.addEventListener("change", () => {
          this.#operators.set(key, select.value);
          select.closest("[data-tab-panel]")?.querySelectorAll(
            "form[data-live-preview]",
          ).forEach((form) => void this.#previewUi(form));
        });
      });
    html.querySelectorAll("form[data-ui-operation]").forEach((form) => {
      const key = `${form.dataset.uiOperation}:${
        form.elements.namedItem("weaponId")?.value ?? ""
      }`;
      const saved = this.#uiDrafts.get(key);
      if (saved) {
        for (const [name, value] of Object.entries(saved.values)) {
          if (
            name === "targetUuid" || name === "weaponSetting" ||
            name === "operatorId" || name === "aimedComponentId"
          ) continue;
          const input = form.elements.namedItem(name);
          if (
            input &&
            (!input.options ||
              Array.from(input.options).some((option) =>
                option.value === value
              ))
          ) input.value = value;
        }
      }
      form.addEventListener(
        "input",
        () =>
          this.#uiDrafts.set(key, {
            revision,
            values: Object.fromEntries(new FormData(form).entries()),
            aim: form.querySelector("[data-aim-enabled]")?.checked,
          }),
      );
    });
    html.querySelectorAll("details").forEach((details, index) => {
      if (details.querySelector("[data-tab-button]")) return;
      const key = `${
        details.closest("[data-tab-panel]")?.dataset.tabPanel
      }:${index}`;
      if (this.#details.has(key)) details.open = this.#details.get(key);
      details.addEventListener(
        "toggle",
        () => this.#details.set(key, details.open),
      );
    });
    const state = this.actor.system.shipCombat.state;
    const hide = (operation, hidden) =>
      html.querySelectorAll(`button[data-ui-operation='${operation}']`).forEach(
        (button) => {
          button.hidden = hidden;
        },
      );
    hide("cooling", !this.#config.components?.cooling || state.heat <= 0);
    hide(
      "vent",
      !this.#config.components?.cooling || state.heat <= 0 ||
        state.ventCooldown > 0,
    );
    hide("hullRepair", state.hull >= this.#config.maxHull);
    html.querySelectorAll("form[data-ui-operation='attack']").forEach(
      (form) => {
        const weapon = this.#view.weapons.find((entry) =>
          entry.id === form.elements.namedItem("weaponId")?.value
        );
        const reload = form.querySelector("[data-ui-operation='beginReload']");
        if (reload) {
          reload.hidden = !weapon?.manualReload ||
            weapon.readiness >= weapon.capacity || weapon.reloadWork != null;
        }
        const contribute = form.querySelector("[data-ui-operation='reload']");
        const operatorSelect = form.closest("[data-tab-panel]")?.querySelector(
          "[data-page-operator]",
        );
        const refreshReloadCost = () => {
          if (contribute) {
            contribute.textContent = `Contribute reload Work (${
              operator?.kind === "command" ? "3 Actions" : "1 Order"
            })`;
          }
        };
        operatorSelect?.addEventListener("change", refreshReloadCost);
        refreshReloadCost();
      },
    );
  }

  #attachHelm(html) {
    const state = this.actor.system.shipCombat.state;
    const capabilities = getDriveCapabilities(this.#config, state);
    const limits = {
      forward: [-capabilities.retro, capabilities.forward],
      lateral: [-capabilities.port, capabilities.starboard],
      rotation: [-capabilities.rotation, capabilities.rotation],
    };
    const form = html.querySelector("form[data-ui-operation='maneuver']");
    if (!form) return;
    const denial = state.phase !== "active"
      ? "Active Phase required."
      : "Operational access required.";
    for (const [name, [min, max]] of Object.entries(limits)) {
      const input = form.elements.namedItem(name);
      if (!input) continue;
      input.min = String(min);
      input.max = String(max);
      input.step = name === "rotation" ? "1" : "0.05";
      const draft = this.#uiDrafts.get("maneuver:");
      if (draft) {
        input.value = String(numeric(draft.values[name]));
      }
      input.disabled = max - min <= 0 || !this.#canAct;
      input.title = !this.#canAct
        ? denial
        : max - min <= 0
        ? "No operational thruster capability"
        : "Full capability range; insufficient remaining budget rejects the maneuver.";
      const zeroPos = `${max > min ? -min / (max - min) * 100 : 50}%`;
      input.style.setProperty("--zero-position", zeroPos);
      input.closest(".ship-helm-slider-track")?.style.setProperty("--zero-position", zeroPos);
      input.closest(".ship-helm-axis")?.style.setProperty("--zero-position", zeroPos);
      const digits = name === "rotation" ? 1 : 2;
      const refresh = () => {
        const value = Number(numeric(input.value).toFixed(digits));
        if (value !== 0 && (name === "forward" || name === "lateral")) {
          const coastInput = form.elements.namedItem("coastDuration");
          if (coastInput && Number(coastInput.value) !== 0) {
            coastInput.value = "0";
            form.querySelectorAll("[data-slider-value='coastDuration']").forEach(
              (o) => { o.textContent = "0.00 time (0%)"; },
            );
          }
        }
        input.setAttribute(
          "aria-valuetext",
          `${signed(value, digits)}${name === "rotation" ? " degrees" : " thrust"}`,
        );
        form.querySelectorAll(`[data-slider-value='${name}']`).forEach(
          (output) => {
            output.textContent = `${signed(value, digits)}${
              name === "rotation" ? "°" : ""
            }`;
          },
        );
      };
      input.addEventListener("input", refresh);
      refresh();
    }
    const coast = form.querySelector("input[name='coastDuration']");
    if (coast) {
      const remainingTimeline = Math.max(
        0,
        1 - numeric(state.timeline) - numeric(state.evasion?.reserved),
      );
      coast.max = String(remainingTimeline);
      coast.disabled = !this.#canAct || remainingTimeline <= 0;
      coast.title = !this.#canAct
        ? denial
        : remainingTimeline <= 0
        ? "No timeline remaining to coast"
        : "Uses unreserved timeline; zero main and lateral thrust required.";
      const refreshCoast = () => {
        const val = Number(numeric(coast.value).toFixed(2));
        if (val > 0) {
          const fwd = form.elements.namedItem("forward");
          const lat = form.elements.namedItem("lateral");
          if (fwd && Number(fwd.value) !== 0) {
            fwd.value = "0";
            form.querySelectorAll("[data-slider-value='forward']").forEach(
              (o) => { o.textContent = "+0"; },
            );
          }
          if (lat && Number(lat.value) !== 0) {
            lat.value = "0";
            form.querySelectorAll("[data-slider-value='lateral']").forEach(
              (o) => { o.textContent = "+0"; },
            );
          }
        }
        coast.setAttribute("aria-valuetext", `${val.toFixed(2)} turn fraction`);
        form.querySelectorAll("[data-slider-value='coastDuration']").forEach(
          (output) => {
            output.textContent = `${val.toFixed(2)} time (${Math.round(val * 100)}%)`;
          },
        );
      };
      coast.addEventListener("input", refreshCoast);
      refreshCoast();
    }

    form.querySelector("[data-coast-remaining]")?.addEventListener("click", (event) => {
      event.preventDefault();
      const remaining = Number(coast?.max ?? 0);
      if (remaining <= 0) {
        ui.notifications.warn("No timeline remaining to coast.");
        return;
      }
      const forwardInput = form.elements.namedItem("forward");
      const lateralInput = form.elements.namedItem("lateral");
      if (forwardInput) forwardInput.value = "0";
      if (lateralInput) lateralInput.value = "0";
      coast.value = String(remaining);
      void this.#submitUi(event, form, "maneuver");
    });

    form.querySelector("[data-helm-reset]")?.addEventListener("click", (event) => {
      event.preventDefault();
      for (const name of ["forward", "lateral", "rotation"]) {
        const input = form.elements.namedItem(name);
        if (input) {
          input.value = "0";
          input.dispatchEvent(new Event("input", { bubbles: false }));
          form.querySelectorAll(`[data-slider-value='${name}']`).forEach(
            (o) => { o.textContent = name === "rotation" ? "0°" : "+0"; },
          );
        }
      }
      const coastInput = form.elements.namedItem("coastDuration");
      if (coastInput) {
        coastInput.value = "0";
        form.querySelectorAll("[data-slider-value='coastDuration']").forEach(
          (o) => { o.textContent = "0.00 time (0%)"; },
        );
      }
      void this.#previewUi(form);
    });

    const operator = html.querySelector("[data-tab-panel='helm'] select[data-page-operator='helm'], [data-tab-panel='helm'] select[name='operatorId']") ??
      form.elements.namedItem("operatorId");
    const hiddenOperator = form.elements.namedItem("operatorId");
    const holder = typeof state.controls?.helm === "string"
      ? state.controls.helm
      : state.controls?.helm?.operatorId;
    const holderLabel =
      this.#config.operators?.find((entry) => entry.id === holder)?.label ??
        holder ?? "Unheld";
    const refreshControl = () => {
      if (hiddenOperator && hiddenOperator !== operator && operator?.value) {
        hiddenOperator.value = operator.value;
      }
      const held = Boolean(holder && holder === operator?.value);
      const take = html.querySelector("[data-tab-panel='helm'] [data-ui-operation='takeControl'][data-control='helm']");
      if (take) {
        take.disabled = held || !this.#canAct;
        take.title = !this.#canAct ? denial : `Current holder: ${holderLabel}`;
        if (operator?.value) take.dataset.operatorId = operator.value;
      }
      const release = html.querySelector("[data-tab-panel='helm'] [data-ui-operation='releaseControl'][data-control='helm']");
      if (release) {
        release.disabled = !holder || !this.#canAct;
        release.title = !this.#canAct
          ? denial
          : !holder
          ? "No helm operator to release."
          : "Release helm control.";
      }
      let reason = "";
      try {
        const reserve = numeric(this.#config.evasionReserve);
        armEvasion(clone(state), {
          phase: state.phase,
          hasHelm: held,
          enginesPower: numeric(state.power?.engines),
          hardwareOperational:
            Math.max(capabilities.forward, capabilities.retro) > 0 &&
            capabilities.rotation > 0 &&
            Math.max(capabilities.port, capabilities.starboard) > 0,
          maneuverCapability: Math.max(
            capabilities.forward,
            capabilities.retro,
            capabilities.port,
            capabilities.starboard,
          ),
          evasionReserve: reserve > 1 ? reserve / 100 : reserve,
        });
        if (!this.#canAct) reason = denial;
      } catch (error) {
        reason = errorText(error);
      }
      const arm = form.querySelector("[data-ui-operation='armEvasion']");
      if (arm) {
        arm.hidden = Boolean(state.evasion?.armed || reason);
        arm.disabled = !this.#canAct;
        arm.title = !this.#canAct ? denial : "Reserve timeline to evade.";
      }
      const disarm = form.querySelector("[data-ui-operation='disarmEvasion']");
      if (disarm) {
        disarm.hidden = !state.evasion?.armed;
        disarm.disabled = !held || !this.#canAct;
        disarm.title = !this.#canAct
          ? denial
          : "Reserved timeline is not refunded.";
      }
      const feedback = form.querySelector("[data-evasion-reason]");
      if (feedback) {
        feedback.textContent = state.evasion?.armed
          ? "Disarming does not refund reserved timeline."
          : reason;
      }
    };
    operator?.addEventListener("change", () => {
      refreshControl();
      void this.#previewUi(form);
    });
    refreshControl();
  }

  #attachPower(html) {
    const form = html.querySelector("form[data-ui-operation='routePower']");
    if (!form) return;
    const state = this.actor.system.shipCombat.state;
    const denial = state.phase !== "active"
      ? "Active Phase required."
      : "Operational access required.";
    const operator = html.querySelector("[data-page-operator='power']");
    const refreshControls = () => {
      for (const control of ["power", "defense"]) {
        const take = html.querySelector(
          `[data-tab-panel='power-defense'] [data-control='${control}']`,
        );
        if (!take) continue;
        const holder = typeof state.controls?.[control] === "string"
          ? state.controls[control]
          : state.controls?.[control]?.operatorId;
        const label = this.#config.operators?.find((entry) =>
          entry.id === holder
        )?.label ?? holder ?? "Unheld";
        const held = Boolean(holder && holder === operator?.value);
        take.textContent = held
          ? "Held — commit below"
          : `Take ${control} · ${label} (costs 1 Action/Order)`;
        take.disabled = held || !this.#canAct;
        take.title = !this.#canAct ? denial : `Current holder: ${label}`;
      }
    };
    operator?.addEventListener("change", refreshControls);
    refreshControls();
    for (const prefix of ["sheddingPriority", "weaponPriority"]) {
      const selects = Array.from(
        form.querySelectorAll(`select[name^='${prefix}-']`),
      );
      for (const select of selects) {
        select.dataset.previous = select.value;
        select.disabled = !this.#canAct;
        select.title = !this.#canAct
          ? denial
          : "Swaps with the previous occupant of this priority.";
        const swap = () => {
          const previous = select.dataset.previous;
          const other = selects.find((entry) =>
            entry !== select && entry.value === select.value
          );
          if (other) other.value = previous;
          for (const entry of selects) entry.dataset.previous = entry.value;
        };
        select.addEventListener("input", swap);
        select.addEventListener("change", () => {
          swap();
          form.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
    }
    const refresh = () => {
      const focused = document.activeElement;
      const focusSystem = focused?.closest?.("[data-power-blocks]")?.dataset
        .powerBlocks;
      const focusIndex = focused?.dataset.powerIndex;

      // Update Reactor Reserve Stack
      const reactorStack = form.querySelector("[data-reactor-stack]");
      if (reactorStack) {
        const reactorMax = this.#view.power.reactor?.maximum ?? 14;
        const reactorRedline = this.#view.power.reactor?.redline ?? 2;
        const totalCommitted = this.#view.power.systems.reduce((sum, s) => {
          return sum + numeric(form.elements.namedItem(s.id)?.value);
        }, 0);
        const freePower = Math.max(0, reactorMax - totalCommitted);
        reactorStack.setAttribute("aria-valuenow", String(freePower));
        reactorStack.replaceChildren();
        for (let idx = 1; idx <= reactorMax; idx++) {
          const isRedline = idx <= reactorRedline;
          const isAvailable = idx <= freePower;
          const slab = document.createElement("div");
          slab.className = `ship-ftl-slab ship-ftl-slab--reactor ${isRedline ? "is-redline" : "is-nominal"} ${isAvailable ? "is-available" : "is-spent"}`;
          slab.title = isRedline
            ? `Overdrive reserve: ${idx <= Math.min(freePower, reactorRedline) ? "Available" : "Spent"}`
            : `Nominal reserve: ${isAvailable ? "Available" : "Spent"}`;
          reactorStack.append(slab);
        }
        const reactorIndicator = form.querySelector(".ship-ftl-reactor-indicator");
        if (reactorIndicator) {
          reactorIndicator.title = `Reactor: ${totalCommitted} / ${reactorMax} Power (${freePower} Available)`;
        }
      }

      for (const system of this.#view.power.systems) {
        const container = Array.from(
          form.querySelectorAll("[data-power-blocks]"),
        ).find((node) => node.dataset.powerBlocks === system.id);
        if (!container) continue;
        const input = form.elements.namedItem(system.id);
        const current = numeric(input.value);
        const values = [
          ...new Set(system.options.map((option) => option.value)),
        ].sort((left, right) => left - right);
        const maximum = Math.max(0, ...values);
        const overclockTiers = new Set(system.overclockTiers ?? []);
        const reservedWeapons = system.id === "weapons"
          ? (this.#view.power.weaponReserved ?? 0)
          : 0;

        container.replaceChildren();
        for (let index = 1; index <= maximum; index++) {
          const filled = index <= current;
          const isOverclock = overclockTiers.has(index);
          const isReserved = system.id === "weapons" && index <= reservedWeapons;
          const button = document.createElement("button");
          button.type = "button";
          button.className = `ship-ftl-slab ${filled ? "is-filled" : "is-empty"}${isOverclock ? " is-overclock" : ""}${isReserved ? " is-reserved" : ""}`;
          button.dataset.powerIndex = String(index);
          button.setAttribute("aria-pressed", String(filled));
          button.setAttribute(
            "aria-label",
            `${system.label} power point ${index}`,
          );
          button.disabled = !this.#canAct;
          button.title = !this.#canAct
            ? denial
            : `${system.label} ${index} Power${
              isOverclock ? " (Overclock)" : ""
            }${isReserved ? " (Weapon Reserved)" : ""}`;

          // Direct slab click
          button.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!this.#canAct) return;
            let target;
            if (system.id === "weapons") {
              target = Math.max(reservedWeapons, index);
            } else if (values.includes(index)) {
              target = index;
            } else {
              target = values.find((v) => v >= index) ?? values.at(-1);
            }
            input.value = String(target);
            form.dispatchEvent(new Event("input", { bubbles: true }));
          });
          container.append(button);
        }

        // Setup Icon button stepper
        const iconBtn = form.querySelector(`[data-power-icon="${system.id}"]`);
        if (iconBtn && !iconBtn.dataset.attached) {
          iconBtn.dataset.attached = "true";
          // Left click: +1 tier
          iconBtn.addEventListener("click", () => {
            if (!this.#canAct) return;
            const cur = numeric(input.value);
            const next = values.find((v) => v > cur);
            if (next !== undefined) {
              input.value = String(next);
              form.dispatchEvent(new Event("input", { bubbles: true }));
            }
          });
          // Right click: -1 tier
          iconBtn.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            if (!this.#canAct) return;
            const cur = numeric(input.value);
            const prev = values.filter((v) => v < cur).at(-1);
            if (prev !== undefined) {
              if (system.id === "weapons" && prev < reservedWeapons) {
                return;
              }
              input.value = String(prev);
              form.dispatchEvent(new Event("input", { bubbles: true }));
            }
          });
        }
        if (iconBtn) {
          iconBtn.disabled = !this.#canAct;
          const cur = numeric(input.value);
          const next = values.find((v) => v > cur);
          const prev = values.filter((v) => v < cur).at(-1);
          iconBtn.title = !this.#canAct
            ? denial
            : `${system.label}: ${cur} Power\nLeft-click: +1 (${
              next ?? "max"
            })\nRight-click: −1 (${prev ?? "min"})`;
        }
      }
      if (focusSystem && focusIndex) {
        form.querySelector(
          `[data-power-blocks='${focusSystem}'] [data-power-index='${focusIndex}']`,
        )?.focus();
      }
    };
    form.addEventListener("input", refresh);
    refresh();
  }

  #attachDefense(html) {
    const form = html.querySelector("form[data-ui-operation='routeDefense']");
    if (!form || !this.#view.shields.sectors.length) return;
    const shields = this.#view.shields;
    const state = this.actor.system.shipCombat.state;
    const denial = state.phase !== "active"
      ? "Active Phase required."
      : "Operational access required.";
    const pool = shields.regenPipsTotal ?? 20;
    const draft = this.#uiDrafts.get("routeDefense:");
    const inputs = new Map();
    for (const sector of shields.sectors) {
      const allocation = form.elements.namedItem(`allocation-${sector.id}`);
      const regen = form.elements.namedItem(`regen-${sector.id}`);
      if (!allocation || !regen) return;
      const seededAllocation = draft
        ? numeric(draft.values[allocation.name], sector.allocation)
        : sector.allocation;
      const seededWeight = draft
        ? numeric(draft.values[regen.name], sector.weight)
        : sector.weight;
      allocation.value = String(
        Math.max(0, Math.min(seededAllocation, sector.capacity)),
      );
      regen.value = String(Math.max(0, Math.min(seededWeight, 100)));
      inputs.set(sector.id, { allocation, regen });
    }
    const submit = form.querySelector("button[type='submit']");
    const hint = form.querySelector("[data-shield-transfer-hint]");
    const stagedAllocation = (sector) =>
      Math.max(
        0,
        Math.min(
          numeric(inputs.get(sector.id).allocation.value),
          sector.capacity,
        ),
      );
    const stagedWeight = (sector) =>
      Math.max(0, Math.min(numeric(inputs.get(sector.id).regen.value), 100));
    let unassignedRegen = 0;
    form.querySelectorAll("[data-distribute]").forEach((button) => {
      button.disabled = !this.#canAct || !shields.directional;
      button.title = !this.#canAct
        ? denial
        : !shields.directional
        ? button.dataset.distribute === "regen"
          ? "Bubble shields regenerate as one pool."
          : "Bubble shields have no directional allocation."
        : button.dataset.distribute === "regen"
        ? "Stage an even regeneration split; commit below."
        : "Stage an even allocation; commit below.";
    });
    const refresh = () => {
      const write = (selector, text) => {
        form.querySelectorAll(selector).forEach((output) => {
          output.textContent = text;
        });
      };
      const active = document.activeElement;
      const pipStrip = active?.closest?.("[data-shield-regen-pips]");
      const pipSector = pipStrip?.dataset.shieldRegenPips;
      const pipIndex = pipStrip ? active.dataset.shieldPipIndex : null;

      let allocationTotal = 0;
      let weightTotal = 0;
      for (const sector of shields.sectors) {
        allocationTotal += stagedAllocation(sector);
        weightTotal += stagedWeight(sector);
      }
      const unassigned = Math.max(0, shields.budget - allocationTotal);
      unassignedRegen = Math.max(0, pool - weightTotal / 5);
      write("[data-shield-total-budget]", String(shields.budget));
      write("[data-shield-unassigned]", String(unassigned));
      write("[data-shield-unassigned-regen]", String(unassignedRegen));
      if (hint) {
        hint.textContent = "";
      }
      if (submit) {
        submit.disabled = !this.#canAct;
        submit.title = !this.#canAct
          ? denial
          : "Commit the staged shield allocation.";
      }

      let totalHp = 0;
      for (const sector of shields.sectors) {
        const allocation = stagedAllocation(sector);
        const weight = stagedWeight(sector);
        const pips = Math.round(weight / 5);
        const hp = Math.min(sector.hp, allocation);
        totalHp += hp;
        write(`[data-shield-hp='${sector.id}']`, String(hp));
        write(`[data-shield-alloc-value='${sector.id}']`, String(allocation));
        write(`[data-shield-max='${sector.id}']`, String(sector.capacity));
        write(`[data-regen-value='${sector.id}']`, `${weight}%`);
        write(
          `[data-regen-rate='${sector.id}']`,
          `${((shields.regeneration * weight) / 100).toFixed(1)} / round`,
        );
        const rowValue = form.querySelector(
          `[data-shield-row-value='${sector.id}']`,
        );
        if (rowValue) {
          rowValue.textContent = `${allocation} / ${sector.capacity}`;
        }
        const status = form.querySelector(
          `[data-shield-status='${sector.id}']`,
        );
        if (status) {
          status.textContent = sector.statusLabel ?? "";
          status.hidden = !sector.statusLabel;
        }
        const bar = form.querySelector(`[data-shield-bar='${sector.id}']`);
        if (bar) {
          const hpPercent = sector.capacity ? hp / sector.capacity * 100 : 0;
          const allocPercent = sector.capacity
            ? allocation / sector.capacity * 100
            : 0;
          bar.dataset.hp = String(hp);
          bar.dataset.alloc = String(allocation);
          bar.dataset.max = String(sector.capacity);
          bar.style.setProperty("--hp-percent", `${hpPercent}%`);
          bar.style.setProperty("--alloc-percent", `${allocPercent}%`);
          bar.setAttribute(
            "aria-label",
            `${sector.label} shield ${hp} HP · ${allocation} allocated of ${sector.capacity}`,
          );
          bar.replaceChildren();
          for (let index = 1; index <= sector.capacity; index++) {
            const cell = document.createElement("span");
            cell.className = `ship-shield-cell ${
              index <= hp
                ? "is-hp"
                : index <= allocation
                ? "is-alloc"
                : "is-empty"
            }`;
            cell.setAttribute("aria-hidden", "true");
            bar.append(cell);
          }
        }
        const strip = form.querySelector(
          `[data-shield-regen-pips='${sector.id}']`,
        );
        if (strip) {
          const reachable = pips + unassignedRegen;
          strip.replaceChildren();
          for (let index = 1; index <= pool; index++) {
            const pip = document.createElement("button");
            pip.type = "button";
            pip.className = `ship-shield-pip ${
              index <= pips ? "is-filled" : "is-empty"
            }`;
            pip.dataset.shieldPipIndex = String(index);
            pip.setAttribute("aria-pressed", String(index <= pips));
            pip.setAttribute(
              "aria-label",
              `${sector.label} regeneration pip ${index} of ${pool}`,
            );
            pip.disabled = !this.#canAct ||
              !shields.directional ||
              index > reachable;
            pip.title = !this.#canAct
              ? denial
              : !shields.directional
              ? "Bubble shields regenerate as one pool."
              : !shields.regeneration
              ? "0 regeneration at current tier; policy persists."
              : index > reachable
              ? `Redistribute: ${unassignedRegen} of ${pool} regen pips unassigned.`
              : `${sector.label} regeneration ${index * 5}%`;
            pip.addEventListener("click", () => {
              if (pip.disabled || !this.#canAct) return;
              if (index > pips && index - pips > unassignedRegen) return;
              inputs.get(sector.id).regen.value = String(index * 5);
              form.dispatchEvent(new Event("input", { bubbles: true }));
            });
            strip.append(pip);
          }
        }
      }
      write("[data-shield-total-hp]", String(totalHp));

      form.querySelectorAll("[data-shield-alloc]").forEach((button) => {
        const sector = shields.sectors.find((entry) =>
          entry.id === button.dataset.shieldAlloc
        );
        if (!sector) return;
        const value = stagedAllocation(sector);
        const adding = numeric(button.dataset.delta) > 0;
        const reason = !this.#canAct
          ? denial
          : !shields.directional
          ? "Bubble shields have no directional allocation."
          : adding
          ? sector.collapse
            ? "Collapsed sector cannot receive allocation."
            : !sector.canReceive || value >= sector.capacity
            ? "Sector capacity reached."
            : unassigned <= 0
            ? "Redistribute: remove from another sector first"
            : ""
          : value <= 0
          ? "No allocation to remove."
          : "";
        button.disabled = Boolean(reason);
        button.title = reason ||
          (adding
            ? "Add one allocation point."
            : "Remove one allocation point.");
      });
      form.querySelectorAll("[data-shield-regen]").forEach((button) => {
        const sector = shields.sectors.find((entry) =>
          entry.id === button.dataset.shieldRegen
        );
        if (!sector) return;
        const weight = stagedWeight(sector);
        const adding = numeric(button.dataset.delta) > 0;
        const reason = !this.#canAct
          ? denial
          : !shields.directional
          ? "Bubble shields regenerate as one pool."
          : adding
          ? weight >= 100
            ? "Regeneration policy is already fully assigned."
            : unassignedRegen <= 0
            ? "Redistribute: remove pips from another sector first"
            : ""
          : weight <= 0
          ? "No regeneration pips to remove."
          : "";
        button.disabled = Boolean(reason);
        button.title = reason ||
          (!shields.regeneration
            ? "0 regeneration at current tier; policy persists."
            : adding
            ? "Add one regeneration pip."
            : "Remove one regeneration pip.");
      });

      if (pipSector && pipIndex) {
        form.querySelector(
          `[data-shield-regen-pips='${pipSector}'] [data-shield-pip-index='${pipIndex}']`,
        )?.focus();
      }
    };

    form.querySelectorAll("[data-shield-alloc]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.disabled || !this.#canAct) return;
        const sector = shields.sectors.find((entry) =>
          entry.id === button.dataset.shieldAlloc
        );
        if (!sector) return;
        const input = inputs.get(sector.id).allocation;
        const current = stagedAllocation(sector);
        const next = Math.max(
          0,
          Math.min(current + numeric(button.dataset.delta), sector.capacity),
        );
        if (next === current) return;
        if (next > current) {
          const others = shields.sectors.reduce(
            (sum, entry) =>
              sum + (entry.id === sector.id ? 0 : stagedAllocation(entry)),
            0,
          );
          if (others + next > shields.budget) return;
        }
        input.value = String(next);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    form.querySelectorAll("[data-shield-regen]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.disabled || !this.#canAct) return;
        const sector = shields.sectors.find((entry) =>
          entry.id === button.dataset.shieldRegen
        );
        if (!sector) return;
        const input = inputs.get(sector.id).regen;
        const current = stagedWeight(sector);
        const next = Math.max(
          0,
          Math.min(current + numeric(button.dataset.delta) * 5, 100),
        );
        if (next === current) return;
        if (next > current && (next - current) / 5 > unassignedRegen) return;
        input.value = String(next);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    form.addEventListener("input", refresh);
    refresh();
  }

  #refreshSensors(html) {
    const online = this.#view.sensor.online === true;
    const contacts = new Map(
      this.#view.contacts.map((entry) => [entry.targetUuid, entry]),
    );
    const contact = contacts.get(this.#sensorFocus);
    if (!contact) this.#sensorFocus = "";
    html.querySelectorAll("[data-sensor-focus]").forEach((button) => {
      const selected = button.dataset.sensorFocus === this.#sensorFocus;
      button.setAttribute("aria-pressed", String(selected));
      button.dataset.selected = String(selected);
      button.title = contacts.get(button.dataset.sensorFocus)?.label ?? "";
    });
    const panel = html.querySelector("[data-sensor-focus-panel]");
    if (panel) this.#renderSensorReadout(panel, contact);
    const form = html.querySelector("[data-sensor-form]");
    if (!form) return;
    const target = form.elements.namedItem("targetUuid");
    if (target) target.value = this.#sensorFocus;
    const reasonFor = (type) => {
      if (!this.#canAct) return "Inactive phase or not your station";
      if (!online) return "Sensors offline";
      if (type === "fade") return "";
      if (type === "ping") return "";
      if (!contact) return "Select a contact";
      if (type === "acquire" || type === "breakLock" || type === "jam") {
        return contact.live ? "" : "Contact is not live";
      }
      if (["analyze", "deepScan", "firingSolution"].includes(type)) {
        return contact.targeted ? "" : "Requires a targeted contact";
      }
      if (type === "burnThrough") {
        return contact.jams?.some((jam) =>
          jam.sourceUuid === contact.targetUuid
        )
          ? ""
          : "This contact is not jamming you";
      }
      return "";
    };
    form.querySelectorAll("button[data-ui-operation]").forEach((button) => {
      const type = button.dataset.uiOperation;
      const reason = reasonFor(type);
      button.disabled = Boolean(reason);
      button.dataset.reason = reason;
      button.title = reason || SENSOR_HELP[type] || "";
    });
  }

  #renderSensorReadout(panel, contact) {
    if (!contact) {
      const empty = document.createElement("p");
      empty.className = "ship-empty";
      empty.textContent = "Select a radar contact to inspect it.";
      panel.replaceChildren(empty);
      return;
    }
    const name = document.createElement("strong");
    name.className = "ship-radar-readout-name";
    name.textContent = contact.designatorLabel;
    const parts = [name];
    if (contact.label !== contact.designatorLabel) {
      const sub = document.createElement("span");
      sub.className = "ship-radar-readout-sub";
      sub.textContent = contact.label;
      parts.push(sub);
    }
    const chip = document.createElement("span");
    chip.className = "ship-radar-state-chip";
    chip.dataset.tone = contact.targeted
      ? "targeted"
      : contact.stale
      ? "stale"
      : "contact";
    chip.textContent = contact.stateLabel;
    parts.push(chip);
    const grid = document.createElement("dl");
    grid.className = "ship-radar-readout-grid";
    const rows = [
      [
        "RANGE",
        `${contact.distanceLabel}${contact.hoisted ? " · HOISTED" : ""}`,
      ],
      ["BEARING", `${contact.bearingLabel} REL`],
      ["COURSE", contact.heading == null ? "—" : `${contact.heading}°`],
      [
        "VELOCITY",
        contact.velocity
          ? `${contact.velocity.speed} · ${contact.velocity.bearing}°`
          : "—",
      ],
      ["AC", contact.effectiveAc ?? "—"],
      [
        "STATE",
        contact.stale ? "Last known" : contact.live ? "Live" : "Undetected",
      ],
    ];
    for (const [term, value] of rows) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      grid.append(row);
    }
    parts.push(grid);
    if (contact.targeted) {
      const flags = document.createElement("p");
      flags.className = "ship-radar-readout-flags";
      flags.textContent = [
        `DEFENSES ${contact.defensesRevealed ? "✓" : "✕"}`,
        `SYSTEMS ${contact.systemsRevealed ? "✓" : "✕"}`,
        `SOLUTION ${contact.firingSolution ? "✓" : "✕"}`,
      ].join(" · ");
      parts.push(flags);
    }
    for (const note of [contact.jamLabel, ...contact.expiryLabels]) {
      if (!note) continue;
      const line = document.createElement("p");
      line.className = "ship-radar-readout-note";
      line.textContent = note;
      parts.push(line);
    }
    for (
      const [label, value] of [["Defenses", contact.defenses], [
        "Systems",
        contact.systems,
      ]]
    ) {
      if (!value) continue;
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = label;
      const content = document.createElement("pre");
      content.textContent = pretty(value);
      details.append(summary, content);
      parts.push(details);
    }
    panel.replaceChildren(...parts);
  }

  #previewWeaponEnvelope(form) {
    if (form.closest("[data-tab-panel]")?.hidden) return;
    const token = actorToken(this.actor);
    const weapon = this.#view.weapons.find((entry) =>
      entry.id === form.elements.namedItem("weaponId")?.value
    );
    if (!token || !weapon) return;
    const geometry = sceneGeometry(token);
    const origin = tokenCenter(token, geometry);
    setMovementPreview(token.uuid, {
      firingArc: {
        origin: {
          x: origin.x * geometry.pixelsPerUnit,
          y: origin.y * geometry.pixelsPerUnit,
        },
        rotation: Number(token.rotation ?? 0) + weapon.orientation,
        arcDegrees: weapon.arc,
        optimalRange: weapon.optimalRange * geometry.pixelsPerUnit,
        maximumRange: weapon.maximumRange * geometry.pixelsPerUnit,
      },
    });
  }

  #refreshAimed(form, targetChanged = false) {
    const slot = form.querySelector("[data-aim-slot]");
    const enabled = form.querySelector("[data-aim-enabled]");
    if (!slot || !enabled) return;
    const target = form.elements.namedItem("targetUuid")?.value;
    const contact = this.#view.targetedContacts.find((entry) =>
      entry.targetUuid === target
    );
    if (targetChanged) this.#aimContexts.delete(form);
    const context = this.#aimContexts.get(form);
    const candidates = this.#aimedComponents.get(target) ?? [];
    const components = context?.targetUuid === target
      ? candidates.filter((component) => {
        const installed = context.components.find((entry) =>
          entry.id === component.id
        );
        const pool = context.config.criticalPools?.[context.sector] ?? [];
        return installed &&
          (!Array.isArray(installed.regions) ||
            installed.regions.includes(context.sector)) &&
          pool.some((entry) =>
            (entry.targetId ?? entry.componentId) === component.id &&
            (entry.kind ?? "fault") !== "hazard" &&
            (entry.channelId ?? entry.conditionId)
          ) &&
          !Object.values(context.state.conditions ?? {}).some((entry) =>
            (entry.componentId ?? entry.targetId) === component.id &&
            String(entry.severity).toLowerCase() === "destroyed"
          );
      })
      : [];
    const missing = [];
    if (!contact) missing.push("A Targeted sensor track is required.");
    if (!contact?.firingSolution) missing.push("No ready Firing Solution.");
    if (!contact?.systemsRevealed && !candidates.length) {
      missing.push("Target not Deep Scanned; no remembered components.");
    }
    if (!missing.length && !components.length) {
      missing.push(
        context?.targetUuid === target
          ? "No eligible remembered, non-destroyed components in the struck region."
          : "Checking struck-region component eligibility.",
      );
    }
    const reason = missing.join(" ");
    const selected = !targetChanged
      ? form.elements.namedItem("aimedComponentId")?.value
      : "";
    slot.replaceChildren();
    enabled.disabled = Boolean(reason);
    enabled.title = reason ||
      "Aim at a known component in the struck region; consumes the ready Firing Solution.";
    enabled.closest("label")?.setAttribute("title", enabled.title);
    const guidance = form.querySelector("[data-aim-guidance]");
    if (guidance) {
      guidance.textContent = reason ||
        "Aimed shot: −4 attack; consumes Firing Solution.";
    }
    if (
      targetChanged || (reason && context?.targetUuid === target) ||
      !contact?.firingSolution
    ) enabled.checked = false;
    if (!enabled.checked || reason) return;
    const select = document.createElement("select");
    select.name = "aimedComponentId";
    select.dataset.targetUuid = target;
    select.setAttribute("aria-label", "Aim at revealed component");
    for (const component of components) {
      const option = document.createElement("option");
      option.value = component.id;
      option.textContent = component.label;
      select.append(option);
    }
    if (components.some((component) => component.id === selected)) {
      select.value = selected;
    }
    slot.append(select);
  }

  #foundryTargets() {
    return collectionValues(game.user?.targets).map((token) =>
      token.document ?? token
    );
  }

  #refreshTargets(html) {
    const targets = this.#foundryTargets();
    const uuid = targets.length === 1 ? targets[0].uuid : "";
    const contact = this.#view.contacts.find((entry) =>
      entry.targetUuid === uuid
    );
    const lamp = html.querySelector("[data-target-lamp]");
    if (lamp) {
      lamp.dataset.state = targets.length === 1
        ? "one"
        : targets.length
        ? "multiple"
        : "none";
      // The state dot is drawn by the lamp's ::before; the text stays word-only.
      lamp.textContent = targets.length === 1
        ? `ONE TARGET — ${contact?.label ?? "Unidentified contact"}`
        : targets.length
        ? `${targets.length} TARGETS — select one`
        : "NO TARGET";
    }
    html.querySelectorAll("[data-sensor-focus]").forEach((button) => {
      button.dataset.foundryTargeted = String(
        targets.some((target) => target.uuid === button.dataset.sensorFocus),
      );
    });
    if (uuid && uuid !== this.#sensorFocus) {
      this.#sensorFocus = uuid;
      this.#refreshSensors(html);
    }
    html.querySelectorAll("form[data-ui-operation='attack']").forEach(
      (form) => {
        const input = form.elements.namedItem("targetUuid");
        const changed = Boolean(input.dataset.initialized) &&
          input.value !== uuid;
        input.value = uuid;
        if (!input.dataset.initialized) {
          const draft = this.#uiDrafts.get(
            `attack:${form.elements.namedItem("weaponId").value}`,
          );
          if (draft?.values.targetUuid === uuid && draft.aim) {
            const enabled = form.querySelector("[data-aim-enabled]");
            if (enabled) enabled.checked = true;
            this.#refreshAimed(form);
            const aimed = form.elements.namedItem("aimedComponentId");
            if (
              aimed &&
              Array.from(aimed.options).some((option) =>
                option.value === draft.values.aimedComponentId
              )
            ) aimed.value = draft.values.aimedComponentId;
          }
          input.dataset.initialized = "true";
        }
        this.#refreshAimed(form, changed);
        this.#weaponValidity(
          form,
          null,
          targets.length === 1
            ? "Checking shot"
            : "Select exactly one Foundry target",
        );
        void this.#previewUi(form);
      },
    );
  }

  #weaponValidity(form, legal, message) {
    if (legal === true && !this.#canAct) {
      message = this.actor.system.shipCombat.state.phase !== "active"
        ? "Valid shot — Fire blocked until Active Phase"
        : "Valid shot — operator permission required.";
    }
    form.dataset.shot = legal === null
      ? "pending"
      : legal
      ? this.#canAct ? "valid" : "ready"
      : "blocked";
    const indicator = form.querySelector("[data-weapon-validity]");
    if (indicator) {
      indicator.dataset.state = legal === null
        ? "pending"
        : legal
        ? "valid"
        : "invalid";
      indicator.textContent = legal === null ? "…" : legal ? "●" : "▲";
      indicator.title = message;
      indicator.setAttribute("aria-label", message);
    }
    const fire = form.querySelector("button[type='submit']");
    if (fire) {
      fire.disabled = legal !== true || !this.#canAct;
      fire.title = fire.disabled
        ? message || "Not a valid shot."
        : "Fire this weapon at the selected target.";
    }
  }

  #activeWeaponId() {
    const weapons = this.#view?.weapons ?? [];
    if (this.#peekWeapon) return this.#peekWeapon;
    if (this.#panelWeapon) return this.#panelWeapon;
    return (weapons.find((weapon) => !weapon.off) ?? weapons[0])?.id ?? "";
  }

  /** Cache one weapon's last preview so hover, focus and the panel share it. */
  #storeShot(form, entry) {
    const weaponId = form.dataset.weaponId ??
      form.elements.namedItem("weaponId")?.value;
    if (!weaponId) return;
    this.#shots.set(weaponId, {
      revision: this.actor.system.shipCombat.state.revision,
      targetUuid: form.elements.namedItem("targetUuid")?.value ?? "",
      ...entry,
    });
    this.#renderFirePanel();
    this.#applyShotMarkers();
  }

  #shotFor(weaponId) {
    const shot = this.#shots.get(weaponId);
    if (!shot) return null;
    return shot.revision === this.actor.system.shipCombat.state.revision
      ? shot
      : null;
  }

  /** Plot the selected target on every dial: bearing, distance, and why it misses. */
  #applyShotMarkers(root = this.#root) {
    if (!root) return;
    root.querySelectorAll("form[data-ui-operation='attack']").forEach((form) => {
      const dial = form.querySelector("[data-dial]");
      const marker = dial?.querySelector("[data-dial-marker]");
      if (!dial || !marker) return;
      const shot = this.#shotFor(form.dataset.weaponId);
      const preview = shot?.result?.public;
      if (!preview || !Number.isFinite(preview.relativeBearing)) {
        marker.hidden = true;
        delete marker.dataset.out;
        delete marker.dataset.far;
        return;
      }
      const maximum = Number(dial.dataset.dialMax);
      const distance = Number(preview.distance);
      const ratio = maximum > 0 && Number.isFinite(distance)
        ? Math.min(1, Math.max(0, distance / maximum))
        : 1;
      const radians = preview.relativeBearing * Math.PI / 180;
      marker.style.setProperty("--marker-x", (Math.sin(radians) * ratio).toFixed(3));
      marker.style.setProperty("--marker-y", (-Math.cos(radians) * ratio).toFixed(3));
      marker.hidden = false;
      marker.dataset.out = String(
        preview.arcValid !== true || preview.lineOfSightValid === false,
      );
      marker.dataset.far = String(preview.rangeValid !== true);
    });
  }

  #renderFirePanel(root = this.#root) {
    const body = root?.querySelector("[data-fire-body]");
    if (!body) return;
    const weaponId = this.#activeWeaponId();
    const weapon = (this.#view?.weapons ?? []).find((entry) =>
      entry.id === weaponId
    );
    const nodes = [];
    const line = (label, value, className = "ship-fire-line") => {
      const row = document.createElement("p");
      row.className = className;
      const name = document.createElement("span");
      name.textContent = label;
      const amount = document.createElement("strong");
      amount.textContent = value;
      row.append(name, amount);
      return row;
    };
    if (!weapon) {
      const empty = document.createElement("p");
      empty.className = "ship-muted";
      empty.textContent = "No weapons installed.";
      body.replaceChildren(empty);
      return;
    }
    // Name gets its own line: gun names outgrow the column long before the
    // panel runs out of vertical room.
    const subject = document.createElement("p");
    subject.className = "ship-fire-subject";
    subject.textContent = weapon.label;
    const state = document.createElement("p");
    state.className = "ship-fire-state";
    state.textContent = `${weapon.stateLabel} · ${weapon.hardpoint} · ${
      weapon.reservation
    } Power`;
    nodes.push(subject, state);
    if (weapon.booting && weapon.bootLabel) {
      const boot = document.createElement("p");
      boot.className = "ship-fire-state ship-fire-state--boot";
      boot.textContent = weapon.bootLabel;
      nodes.push(boot);
    }

    const shot = this.#shotFor(weaponId);
    if (!shot) {
      const waiting = document.createElement("p");
      waiting.className = "ship-fire-muted";
      waiting.textContent = "Checking shot…";
      nodes.push(waiting);
      body.replaceChildren(...nodes);
      return;
    }
    if (shot.error) {
      nodes.push(this.#violationNode(shot.error));
      body.replaceChildren(...nodes);
      return;
    }
    const preview = shot.result.public ?? {};
    const groups = Array.isArray(preview.modifiers) ? preview.modifiers : [];
    for (const group of groups) {
      const items = Array.isArray(group.items) ? group.items : [];
      const total = items.every((item) => Number.isFinite(item.value))
        ? items.reduce((sum, item) => sum + item.value, 0)
        : null;
      const value = Number.isFinite(total) ? signed(total, 0) : "—";
      const block = document.createElement("div");
      block.className = "ship-fire-group";
      const [only] = items;
      // A single undetailed term is more useful named than grouped, so the
      // panel never shows a bare "+4" without saying what produced it.
      if (only && !only.detail) {
        block.append(line(only.label, signed(only.value, 0)));
      } else {
        block.append(line(group.label, value));
        for (const item of items) {
          const detail = item.detail ? ` · ${modifierDetail(item.detail)}` : "";
          block.append(
            line(
              `${item.label}${detail}`,
              signed(item.value, 0),
              "ship-fire-line ship-fire-item",
            ),
          );
        }
      }
      nodes.push(block);
    }
    const total = preview.knownModifierTotal;
    const threshold = Number.isFinite(preview.finalAc) &&
      Number.isFinite(total)
      ? preview.finalAc - total
      : null;
    const totalRow = document.createElement("p");
    totalRow.className = "ship-fire-total";
    totalRow.dataset.legal = String(Boolean(shot.result.legal));
    const totalLabel = document.createElement("span");
    totalLabel.textContent = shot.result.legal ? "To hit" : "Blocked";
    const totalValue = document.createElement("strong");
    totalValue.textContent = `${
      Number.isFinite(total) ? signed(total, 0) : "—"
    } vs AC ${
      Number.isFinite(preview.finalAc) ? preview.finalAc : "unknown"
    }${threshold == null ? "" : ` · d20 ${Math.max(2, Math.min(20, threshold))}+`}`;
    totalRow.append(totalLabel, totalValue);
    nodes.push(totalRow);

    const geometry = document.createElement("p");
    geometry.className = "ship-fire-geometry";
    const flag = (label, ok) => {
      const span = document.createElement("span");
      span.dataset.ok = ok === true ? "true" : ok === false ? "false" : "neutral";
      span.textContent = label;
      return span;
    };
    geometry.append(
      flag("Arc", preview.arcValid),
      flag(`Band ${rangeBandLabel(preview.range?.band)}`, preview.rangeValid),
      flag("LOS", preview.lineOfSightValid === undefined ? null : preview.lineOfSightValid),
      flag(`Strikes ${preview.struckSector ?? "—"}`, null),
    );
    nodes.push(geometry);

    const costs = document.createElement("div");
    costs.className = "ship-fire-costs";
    const ammo = preview.costs?.readiness;
    if (ammo) {
      costs.append(line("Ammo", `${ammo.before} → ${ammo.after}`));
    }
    const heat = preview.costs?.firingHeat;
    if (heat) costs.append(line("Heat", `${heat.before} → ${heat.after}`));
    if (preview.costs?.firingSolution?.consumed) {
      costs.append(line("Firing solution", "consumed"));
    }
    const action = preview.costs?.operation;
    if (action) {
      const operator = (this.#view.operators ?? []).find((entry) =>
        entry.id === action.operatorId
      );
      costs.append(
        line(
          operator?.label ?? "Action",
          `${action.before} → ${action.after} ${action.pool ?? ""}`.trim(),
        ),
      );
    }
    if (preview.damageProfile) {
      costs.append(
        line(
          "Damage",
          `${preview.damageProfile.shield} shield · ${preview.damageProfile.hull} hull${
            preview.damageProfile.heat ? ` · ${preview.damageProfile.heat} heat` : ""
          } · AP ${preview.armorPiercing}`,
        ),
      );
    }
    nodes.push(costs);

    for (const violation of shot.result.violations ?? []) {
      nodes.push(this.#violationNode(violation.message));
    }
    if (!this.#canAct) {
      const blocked = this.actor.system.shipCombat.state.phase !== "active"
        ? "Fire blocked until the Active Phase."
        : "Fire blocked: operator permission required.";
      nodes.push(this.#violationNode(blocked));
    }
    body.replaceChildren(...nodes);
  }

  #violationNode(message) {
    const row = document.createElement("p");
    row.className = "ship-fire-violation";
    const text = document.createElement("span");
    text.textContent = message;
    row.append(text);
    return row;
  }

  #syncBarrage(form) {
    const toggle = form.querySelector("[data-barrage-enabled]");
    if (!toggle) return;
    toggle.checked = Number(
      form.elements.namedItem("barrageRounds")?.value ?? 1,
    ) > 1;
  }

  #toggleBarrage(form, engaged) {
    const rounds = form.elements.namedItem("barrageRounds");
    if (!rounds) return;
    if (!engaged) {
      rounds.value = "1";
    } else if (Number(rounds.value) <= 1) {
      const weapon = this.#view.weapons.find((entry) =>
        entry.id === form.dataset.weaponId
      );
      const feasible = (weapon?.barrageProfiles ?? []).find((profile) =>
        profile.rounds > 1 && profile.feasible
      ) ?? (weapon?.barrageProfiles ?? []).find((profile) => profile.rounds > 1);
      rounds.value = String(feasible?.rounds ?? 1);
    }
    form.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async #submitWeaponSetting(event, segment) {
    const form = segment.closest("form[data-ui-operation='attack']");
    const weaponId = form?.dataset.weaponId;
    if (!weaponId) return;
    if (segment.dataset.current === "true") return;
    if (segment.dataset.reachable !== "true") {
      ui.notifications.warn(
        segment.title || "That power state is not available.",
      );
      return;
    }
    const setting = segment.dataset.weaponSetting;
    this.#weaponIntents.set(weaponId, setting);
    this.#applyWeaponIntents();
    try {
      await this.#submitUi(event, segment, "toggleWeapon");
    } finally {
      this.#weaponIntents.delete(weaponId);
      this.#applyWeaponIntents();
    }
  }

  #applyWeaponIntents(root = this.#root) {
    if (!root) return;
    root.querySelectorAll("form[data-ui-operation='attack']").forEach((form) => {
      const intent = this.#weaponIntents.get(form.dataset.weaponId);
      form.querySelectorAll("[data-weapon-setting]").forEach((segment) => {
        const pending = intent === segment.dataset.weaponSetting &&
          segment.dataset.current !== "true";
        if (pending) segment.dataset.intent = "true";
        else delete segment.dataset.intent;
      });
    });
  }

  #queueGeometryRefresh(event, changes) {
    const moved = event !== "updateToken" ||
      ["x", "y", "rotation", "elevation", "width", "height", "hidden"].some(
        (key) => changes && key in changes,
      );
    if (!moved || this.#tokenRefresh) return;
    this.#tokenRefresh = setTimeout(() => {
      this.#tokenRefresh = null;
      const panel = this.#root?.querySelector("[data-tab-panel='weapons']");
      if (!panel || panel.hidden) return;
      panel.querySelectorAll("form[data-live-preview='attack']")
        .forEach((form) => void this.#previewUi(form));
    }, 120);
  }

  async #dragComponent(event, drop) {
    event.preventDefault();
    if (getRefitDenial(this.actor)) return;
    drop.dataset.dragActive = "true";
    try {
      let item;
      if (this.#dragItem) item = await this.#dragItem;
      else {
        const data = globalThis.TextEditor?.getDragEventData?.(event) ??
          JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
        if (data.type !== "Item") return;
        const ItemClass = globalThis.Item?.implementation ??
          globalThis.CONFIG?.Item?.documentClass;
        item = await ItemClass?.fromDropData?.(data);
      }
      const compatible = !this.#componentMismatch(drop.dataset.mountId, item);
      if (drop.dataset.dragActive === "true") {
        drop.classList.toggle("is-dragover", compatible);
      }
    } catch (_error) {
      drop.classList.remove("is-dragover");
    }
  }

  #openComponent(itemId) {
    try {
      const item = this.actor.items?.get?.(itemId) ??
        collectionValues(this.actor.items).find((entry) =>
          entry?.id === itemId
        );
      if (!item) throw new Error("The component Item is no longer available.");
      const sheet = item.sheet;
      if (!sheet) throw new Error("The component Item sheet is unavailable.");
      if (sheet.rendered) sheet.bringToFront();
      else sheet.render({ force: true });
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  #componentMismatch(mountId, item) {
    const hull = this.actor.system.shipCombat.config;
    const slot = hull.slots?.find((entry) => entry.id === mountId);
    const hardpoint = hull.hardpoints?.find((entry) => entry.id === mountId);
    if (!slot && !hardpoint) return "Mount no longer exists";
    if (item?.type !== COMPONENT_ITEM_TYPE) return "Not a ship component";
    const system = item.system ?? {};
    const requiredClass = slot?.class ?? "weapon";
    const requiredSize = slot?.size ?? hardpoint.mountSize;
    const reasons = [];
    if (system.componentClass !== requiredClass) {
      reasons.push(`Requires ${requiredClass} class`);
    }
    if (system.size !== requiredSize) {
      reasons.push(`Requires ${requiredSize} size`);
    }
    if (slot?.class === "drive") {
      const role = ["portLateral", "starboardLateral"].includes(slot.driveRole)
        ? "lateral"
        : slot.driveRole;
      if (system.driveRole !== role) {
        reasons.push(`Requires ${role} drive role`);
      }
    }
    if (
      hardpoint &&
      (hardpoint.category !== "hardpoint" ||
        system.definition?.category !== hardpoint.category)
    ) reasons.push("Requires matching hardpoint category");
    return reasons.join("; ");
  }

  async #refitError(error) {
    if (error?.code === "REFIT_CLEANUP_FAILED") {
      ui.notifications.warn(errorText(error));
      await this.render();
    } else ui.notifications.error(errorText(error));
  }

  async #installComponent(mountId, sourceItem) {
    const installed = await installShipComponent(
      this.actor,
      mountId,
      sourceItem,
    );
    if (!installed) return;
    ui.notifications.info(`${sourceItem.name ?? "Component"} installed.`);
    await this.render();
  }

  async #browseComponents(mountId, button) {
    button.disabled = true;
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      const hull = this.actor.system.shipCombat.config;
      const referenced = new Set([
        ...(hull.slots ?? []).map((mount) => mount.itemId),
        ...(hull.hardpoints ?? []).map((mount) => mount.weaponId),
      ]);
      const candidates = collectionValues(this.actor.items).filter((item) =>
        item.type === COMPONENT_ITEM_TYPE && !referenced.has(item.id)
      ).map((item) => ({ item, origin: "Unreferenced ship Item" }));
      const pack = game.packs.get(`${MODULE_ID}.ship-components`);
      let packWarning = "";
      if (pack) {
        try {
          for (const item of await pack.getDocuments()) {
            if (item.type === COMPONENT_ITEM_TYPE) {
              candidates.push({ item, origin: "Ship Components compendium" });
            }
          }
        } catch (error) {
          packWarning = `Compendium unavailable: ${errorText(error)}`;
        }
      } else packWarning = "Ship Components compendium is unavailable.";
      const content = document.createElement("div");
      const help = document.createElement("p");
      help.textContent =
        "Compatible components match this mount's class, exact size, and drive role. Installation creates a fresh embedded copy; source Items are retained.";
      content.append(help);
      if (packWarning) {
        const warning = document.createElement("p");
        warning.textContent = packWarning;
        warning.setAttribute("role", "status");
        content.append(warning);
      }
      const label = document.createElement("label");
      label.textContent = "Compatible components";
      const select = document.createElement("select");
      select.name = "component";
      select.required = true;
      const mismatches = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Incompatible components and reasons";
      mismatches.append(summary);
      const list = document.createElement("ul");
      candidates.forEach(({ item, origin }, index) => {
        const reason = this.#componentMismatch(mountId, item);
        if (reason) {
          const row = document.createElement("li");
          row.textContent = `${item.name} (${origin}): ${reason}`;
          list.append(row);
        } else {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = `${item.name} · ${origin}`;
          select.append(option);
        }
      });
      if (select.options.length) {
        label.append(select);
        content.append(label);
      } else {
        const empty = document.createElement("p");
        empty.textContent = "No compatible components found for this mount.";
        content.append(empty);
      }
      if (list.childElementCount) {
        mismatches.append(list);
        content.append(mismatches);
      }
      const buttons = [{ action: "cancel", label: "Cancel" }];
      if (select.options.length) {
        buttons.unshift({
          action: "install",
          label: "Install component",
          default: true,
          callback: (_event, _button, dialog) =>
            dialog.element.querySelector("select[name='component']").value,
        });
      }
      const selection = await foundry.applications.api.DialogV2.wait({
        window: { title: "Browse components" },
        content: content.outerHTML,
        buttons,
        rejectClose: false,
      });
      if (
        selection === null || selection === undefined || selection === "cancel"
      ) return;
      const candidate = candidates[Number(selection)];
      if (candidate) await this.#installComponent(mountId, candidate.item);
    } catch (error) {
      await this.#refitError(error);
    } finally {
      if (button.isConnected) {
        button.disabled = Boolean(getRefitDenial(this.actor));
      }
    }
  }

  async #dropComponent(event, drop) {
    event.preventDefault();
    event.stopImmediatePropagation();
    drop.classList.remove("is-dragover");
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      const data = globalThis.TextEditor?.getDragEventData?.(event) ??
        JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
      if (data?.type !== "Item") {
        throw new Error("Drop a ship component Item on this mount.");
      }
      const ItemClass = globalThis.Item?.implementation ??
        globalThis.CONFIG?.Item?.documentClass;
      const sourceItem = await ItemClass?.fromDropData?.(data);
      if (!sourceItem) {
        throw new Error("The dropped Item could not be resolved.");
      }
      await this.#installComponent(drop.dataset.mountId, sourceItem);
    } catch (error) {
      await this.#refitError(error);
    }
  }

  async #removeComponent(mountId, button) {
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      button.disabled = true;
      const removed = await removeShipComponent(this.actor, mountId);
      if (removed) {
        ui.notifications.info(
          `${removed.name ?? "Component"} removed; the mount is now degraded.`,
        );
      }
      await this.render();
    } catch (error) {
      await this.#refitError(error);
      if (button.isConnected) {
        button.disabled = Boolean(getRefitDenial(this.actor));
      }
    }
  }

  #dragRoster(event, slot) {
    event.preventDefault();
    slot.classList.add("is-dragover");
  }

  async #dropRoster(event, slot) {
    event.preventDefault();
    event.stopImmediatePropagation();
    slot.classList.remove("is-dragover");
    try {
      if (!globalThis.game?.user?.isGM && !this.#canAct) {
        throw new Error("Only the active GM or authorized operator can modify station assignments.");
      }
      const data = globalThis.TextEditor?.getDragEventData?.(event) ??
        JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
      if (data?.type !== "Actor") {
        throw new Error("Drop a PC or NPC Actor on this station slot.");
      }
      const ActorClass = globalThis.Actor?.implementation ?? globalThis.CONFIG?.Actor?.documentClass;
      const droppedActor = await ActorClass?.fromDropData?.(data);
      if (!droppedActor) {
        throw new Error("The dropped Actor could not be resolved.");
      }
      if (droppedActor.type === SHIP_TYPE) {
        throw new Error("A ship cannot be assigned to a station slot.");
      }

      const kind = slot.dataset.kind;
      const slotIndex = Number(slot.dataset.slot);
      await this.#assignActorToSlot(droppedActor, kind, slotIndex);
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #assignActorToSlot(droppedActor, kind, slotIndex) {
    await ensureActorCrewFeature(droppedActor);
    const profile = buildOperatorProfileFromActor(droppedActor);

    const ship = this.actor;
    const config = ship.system?.shipCombat?.config ?? {};
    const state = ship.system?.shipCombat?.state ?? {};

    // 1. Update operators array on the ship actor
    const operators = Array.isArray(config.operators) ? [...config.operators] : [];
    const existingIndex = operators.findIndex((o) => o.id === profile.id || (profile.actorId && o.actorId === profile.actorId));
    if (existingIndex >= 0) {
      operators[existingIndex] = { ...operators[existingIndex], ...profile };
    } else {
      operators.push(profile);
    }
    await ship.update({ "system.shipCombat.config.operators": operators });

    // 2. Prepare next roster with duplicate slot and actor removal
    const currentRoster = clone(state.roster ?? { command: [], crew: [] });
    currentRoster.command = Array.isArray(currentRoster.command) ? [...currentRoster.command] : [];
    currentRoster.crew = Array.isArray(currentRoster.crew) ? [...currentRoster.crew] : [];

    const isTarget = (entry, k, idx) => {
      const opId = typeof entry === "string" ? entry : entry?.operatorId ?? entry?.id;
      const slot = typeof entry === "object" && entry?.slot != null ? entry.slot : idx;
      if (k === kind && slot === slotIndex) return true;
      if (opId === profile.id) return true;
      const entryProfile = operators.find((o) => o.id === opId);
      if (profile.actorId && (entry?.actorId === profile.actorId || entryProfile?.actorId === profile.actorId)) {
        return true;
      }
      return false;
    };

    currentRoster.command = currentRoster.command.filter((entry, idx) => !isTarget(entry, "command", idx));
    currentRoster.crew = currentRoster.crew.filter((entry, idx) => !isTarget(entry, "crew", idx));
    currentRoster[kind].push({ operatorId: profile.id, slot: slotIndex });

    // 3. Commit roster via operation or direct write
    const token = actorToken(ship);
    if (token) {
      await this.#commitOperation(
        "setRoster",
        { gmOverride: true, roster: currentRoster },
        [],
        state.revision,
      );
    } else {
      await ship.update({ "system.shipCombat.state.roster": currentRoster });
    }

    ui.notifications.info(`Assigned ${profile.label} to ${kind === "command" ? "Command" : "Crew"} ${slotIndex + 1}.`);
    await this.render();
  }

  async #unassignRosterSlot(key) {
    try {
      const [kind, slotStr] = key.split("-");
      const slotIndex = Number(slotStr);
      const ship = this.actor;
      const state = ship.system?.shipCombat?.state ?? {};
      const currentRoster = clone(state.roster ?? { command: [], crew: [] });
      currentRoster[kind] = (currentRoster[kind] ?? []).filter((entry, idx) => {
        const slot = typeof entry === "object" && entry?.slot != null ? entry.slot : idx;
        return slot !== slotIndex;
      });

      const token = actorToken(ship);
      if (token) {
        await this.#commitOperation(
          "setRoster",
          { gmOverride: true, roster: currentRoster },
          [],
          state.revision,
        );
      } else {
        await ship.update({ "system.shipCombat.state.roster": currentRoster });
      }

      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #editRosterActor(actorId) {
    if (!actorId) return;
    const actor = globalThis.game?.actors?.get(actorId);
    if (actor) {
      await openCrewRatingEditor(actor);
    }
  }

  #distribute(button) {
    const form = button.closest("form");
    if (!form || !this.#canAct || button.disabled) return;
    const prefix = button.dataset.distribute;
    const inputs = Array.from(
      form.querySelectorAll(`input[name^="${prefix}-"]`),
    );
    if (!inputs.length) return;
    const step = prefix === "regen" ? 5 : 1;
    const caps = inputs.map((input) => {
      if (prefix === "regen") return Infinity;
      const sector = this.#view.shields.sectors.find((entry) =>
        `allocation-${entry.id}` === input.name
      );
      return sector?.canReceive ? sector.capacity : numeric(input.value);
    });
    const pool = this.#view.shields.regenPipsTotal ?? 20;
    const total = prefix === "regen" ? pool : this.#view.shields.budget;
    const values = inputs.map(() => 0);
    let remaining = total;
    let cursor = 0;
    while (
      remaining > 0 &&
      inputs.some((input, index) => values[index] < caps[index])
    ) {
      const index = cursor % inputs.length;
      if (values[index] < caps[index]) {
        values[index] += 1;
        remaining -= 1;
      }
      cursor += 1;
    }
    inputs.forEach((input, index) => {
      input.value = String(values[index] * step);
    });
    form.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async #previewUi(form) {
    const type = form.dataset.livePreview;
    const output = form.querySelector("[data-preview]");
    // Attack cards own no output line: their detail renders in the shared panel.
    if (!output && type !== "attack") return;
    const actor = this.actor;
    const state = clone(actor.system.shipCombat.state);
    const epoch = this.#epoch;
    const serial = (this.#previewSerial.get(form) ?? 0) + 1;
    this.#previewSerial.set(form, serial);
    const current = () =>
      this.#epoch === epoch && this.#previewSerial.get(form) === serial &&
      this.#root?.contains(form) &&
      this.actor.system.shipCombat.state.revision === state.revision;
    if (type === "attack") this.#weaponValidity(form, null, "Checking shot");
    try {
      const config = this.#config;
      const data = elementFormData(form);
      const operation = uiOperation(type, data, config, state);
      if (type === "maneuver" || type === "rotate") {
        const token = actorToken(actor);
        if (!token) {
          throw new Error(
            "Place this ship on the active Scene to preview movement.",
          );
        }
        this.#movementInput ??= movementPreviewInput({}, token, config, state);
        const assembled = await this.#movementInput;
        if (!current() || form.closest("[data-tab-panel]")?.hidden) return;
        const result = {
          ...previewManeuver({ ...assembled.input, ...operation.payload }),
          targetedCoasts: assembled.targetedCoasts,
        };
        setMovementPreview(
          token.uuid,
          canvasMovementPreview(result, assembled.geometry),
        );
        const speed = Math.hypot(
          Number(result.finalVelocity?.x ?? 0),
          Number(result.finalVelocity?.y ?? 0),
        );
        const warning = result.warnings?.[0]?.code
          ? ` · ${result.warnings[0].code.replaceAll("_", " ")}`
          : "";
        const timelineRemaining = Math.max(
          0,
          result.timelineRemaining - numeric(state.evasion?.reserved),
        );
        const budgetText = ` · Remaining timeline ${
          timelineRemaining.toFixed(2)
        } · Rotation ${result.rotationRemaining.toFixed(1)}°`;
        const timelineMeter = form.querySelector("[data-timeline-projected]");
        if (timelineMeter) {
          timelineMeter.value = 1 - timelineRemaining;
          timelineMeter.title = `Projected remaining timeline ${
            timelineRemaining.toFixed(2)
          }`;
        }
        const rotationMeter = form.querySelector("[data-rotation-projected]");
        if (rotationMeter) {
          rotationMeter.value = Math.max(
            0,
            getDriveCapabilities(config, state).rotation -
              result.rotationRemaining,
          );
          rotationMeter.title = `Projected remaining rotation ${
            result.rotationRemaining.toFixed(1)
          }°`;
        }

        const timelineSpent = numeric(state.timeline) + numeric(state.evasion?.reserved);
        const currentTimelineUsed = Math.max(0, result.timelineUsed - numeric(state.timeline));
        const translationSpentPct = Math.round(timelineSpent * 100);
        const translationCurrentPct = Math.round(currentTimelineUsed * 100);
        const translationLeftPct = Math.max(0, 100 - translationSpentPct - translationCurrentPct);

        const rotCapacity = getDriveCapabilities(config, state).rotation;
        const rotSpent = numeric(state.rotationSpent);
        const currentRotUsed = Math.max(0, rotCapacity - rotSpent - result.rotationRemaining);
        const rotSpentPct = rotCapacity > 0 ? Math.round((rotSpent / rotCapacity) * 100) : 0;
        const rotCurrentPct = rotCapacity > 0 ? Math.round((currentRotUsed / rotCapacity) * 100) : 0;
        const rotLeftPct = Math.max(0, 100 - rotSpentPct - rotCurrentPct);

        form.querySelectorAll('[data-budget="translation"]').forEach((el) => {
          const spent = el.querySelector(".ship-budget-spent");
          const curr = el.querySelector(".ship-budget-current");
          const left = el.querySelector(".ship-budget-left");
          if (spent) spent.textContent = `${translationSpentPct}% spent`;
          if (curr) curr.textContent = `${translationCurrentPct}% current`;
          if (left) left.textContent = `${translationLeftPct}% left`;
        });

        form.querySelectorAll('[data-budget="rotation"]').forEach((el) => {
          const spent = el.querySelector(".ship-budget-spent");
          const curr = el.querySelector(".ship-budget-current");
          const left = el.querySelector(".ship-budget-left");
          if (spent) spent.textContent = `${rotSpentPct}% spent`;
          if (curr) curr.textContent = `${rotCurrentPct}% current`;
          if (left) left.textContent = `${rotLeftPct}% left`;
        });

        const fwdTrack = form.querySelector('[data-helm-track="forward"]');
        if (fwdTrack) {
          const fwdZ = parseFloat(fwdTrack.style.getPropertyValue("--zero-position")) || 50;
          const style = `--zero-position: ${fwdZ}%; ${helmTrackGradientStyle(fwdZ, timelineSpent, currentTimelineUsed)}`;
          fwdTrack.style.cssText = style;
          const input = fwdTrack.querySelector("input");
          if (input) input.style.cssText = style;
        }
        const latTrack = form.querySelector('[data-helm-track="lateral"]');
        if (latTrack) {
          const latZ = parseFloat(latTrack.style.getPropertyValue("--zero-position")) || 50;
          const style = `--zero-position: ${latZ}%; ${helmTrackGradientStyle(latZ, timelineSpent, currentTimelineUsed)}`;
          latTrack.style.cssText = style;
          const input = latTrack.querySelector("input");
          if (input) input.style.cssText = style;
        }
        const rotTrack = form.querySelector('[data-helm-track="rotation"]');
        if (rotTrack) {
          const style = `--zero-position: 50%; ${helmTrackGradientStyle(50, rotCapacity > 0 ? rotSpent / rotCapacity : 0, rotCapacity > 0 ? currentRotUsed / rotCapacity : 0)}`;
          rotTrack.style.cssText = style;
          const input = rotTrack.querySelector("input");
          if (input) input.style.cssText = style;
        }
        const coastTrack = form.querySelector('[data-helm-track="coast"]');
        if (coastTrack) {
          const style = helmCoastTrackGradientStyle(timelineSpent, currentTimelineUsed);
          coastTrack.style.cssText = style;
          const input = coastTrack.querySelector("input");
          if (input) input.style.cssText = style;
        }

        const vectorImg = form.querySelector("[data-vector-image]");
        if (vectorImg && result.finalFacing !== undefined) {
          const match = vectorImg.style.transform?.match(/rotate\((-?[\d.]+)deg\)/);
          const currentDeg = match ? parseFloat(match[1]) : (assembled.input?.facing ?? state.facing ?? 0);
          const targetFacing = ((Math.round(result.finalFacing) % 360) + 360) % 360;
          const delta = ((targetFacing - currentDeg) % 360 + 540) % 360 - 180;
          const nextDeg = currentDeg + delta;
          vectorImg.style.transform = `rotate(${Math.round(nextDeg)}deg)`;
        }
        const vectorSpeed = form.querySelector("[data-vector-speed]");
        if (vectorSpeed) vectorSpeed.textContent = speed.toFixed(2);
        const vectorHeading = form.querySelector("[data-vector-heading]");
        if (vectorHeading && result.finalFacing !== undefined) {
          const normFacing = ((Math.round(result.finalFacing) % 360) + 360) % 360;
          vectorHeading.textContent = `${String(normFacing).padStart(3, "0")}°`;
        }
        const vectorAngVel = form.querySelector("[data-vector-angvel]");
        if (vectorAngVel) {
          vectorAngVel.textContent = `${signed(Number(operation.payload.rotation ?? 0), 1)}°`;
        }

        if (operation.payload.duration > 0) {
          const displacement = Math.hypot(
            result.poweredEnd.position.x - assembled.input.position.x,
            result.poweredEnd.position.y - assembled.input.position.y,
          );
          const coastTime = Number(result.poweredEnd?.time ?? 0).toFixed(2);
          output.textContent =
            `Coast ${coastTime} turn fraction · Projected displacement ${
              displacement.toFixed(2)
            } scene units · ${signed(operation.payload.rotation, 1)}° · Speed ${
              speed.toFixed(2)
            } / safe ${config.safeVelocity}${warning}${budgetText}`;
        } else {
          output.textContent = `Projected ${
            signed(operation.payload.deltaV?.forward ?? 0, 2)
          } forward · ${
            signed(operation.payload.deltaV?.lateral ?? 0, 2)
          } starboard · ${signed(operation.payload.rotation, 1)}° · Speed ${
            speed.toFixed(2)
          } / safe ${config.safeVelocity}${warning}${budgetText}`;
        }
      } else if (type === "routePower") {
        const allocation = operation.payload.allocation;
        const stagedState = {
          ...state,
          power: { ...state.power, ...allocation },
        };
        const sensor = getSensorStats(config, stagedState);
        const regeneration = config.components?.shield?.tiers?.find((tier) =>
          tier.power === allocation.shields
        )?.regeneration ?? 0;
        const drives = getDriveCapabilities(config, stagedState);
        const cooling = config.components?.cooling?.tiers?.find((tier) =>
          tier.power === allocation.cooling
        )?.cooling ?? 0;
        const reservation = this.#view.power.weaponReserved
          ? `${this.#view.power.weaponReserved} reserved (${this.#view.power.reservingWeapons} wpn)`
          : "No draw";
        const summaries = {
          engines: `${drives.forward} thrust`,
          shields: `${regeneration} regen`,
          sensors: sensor.online ? `${sensor.activeRange} active` : "Offline",
          weapons: reservation,
          cooling: `${cooling} cooling`,
        };
        form.querySelectorAll("[data-power-effect]").forEach((output) => {
          output.textContent = summaries[output.dataset.powerEffect];
        });
        if (allocation.weapons < this.#view.power.weaponReserved) {
          throw new Error(`${reservation} — depower them on the Weapons tab`);
        }
        const result = previewPowerRoute(config, state, operation.payload);
        const gridDraw = form.querySelector("[data-power-grid='draw']");
        const gridFree = form.querySelector("[data-power-grid='free']");
        const gridEmit = form.querySelector("[data-power-grid='emission']");
        const gridHeat = form.querySelector("[data-power-grid='heat']");
        if (gridDraw) gridDraw.textContent = `${result.committed} / ${result.ceilings.maximum} Power`;
        if (gridFree) gridFree.textContent = `${result.unused} available`;
        if (gridEmit) {
          gridEmit.textContent = result.redlining ? "REDLINE" : result.emission.band;
          gridEmit.classList.toggle("ship-danger", Boolean(result.redlining));
        }
        if (gridHeat) {
          gridHeat.textContent = `${result.heatAdded} Heat on commit`;
          gridHeat.classList.toggle("ship-warning", result.heatAdded > 0);
        }
        output.textContent = "";
        output.dataset.error = "false";
      } else if (type === "routeDefense") {
        // The HUD already shows allocation, HP and regeneration; keep the line
        // free for errors.
        previewDefenseRoute(config, state, operation.payload);
        output.textContent = "";
      } else if (type === "attack") {
        const targetUuid = operation.targetUuids[0];
        if (!this.#foundryTargets().length) {
          throw new Error("No Foundry target selected.");
        }
        if (this.#foundryTargets().length !== 1 || !targetUuid) {
          throw new Error("Select exactly one Foundry target.");
        }
        if (
          !this.#view.targetedContacts.some((contact) =>
            contact.targetUuid === targetUuid
          )
        ) throw new Error("A Targeted sensor track is required.");
        const target = await fromUuid(targetUuid);
        const targetActor = target?.actor;
        if (!targetActor) {
          throw new Error("The selected contact is no longer present.");
        }
        const sourceToken = actorToken(actor);
        const targetToken = target?.document ?? target;
        if (!sourceToken) throw new Error(sourceUnavailableReason(actor));
        const geometry = sceneGeometry(sourceToken);
        const targetState = clone(targetActor.system.shipCombat.state);
        const targetConfig = await materializeActorConfig(targetActor);
        if (!current()) return;
        const components = targetConfig.components ?? {};
        this.#aimContexts.set(form, {
          targetUuid,
          config: targetConfig,
          state: targetState,
          components: [
            components.reactor,
            components.shield,
            components.sensor,
            components.cooling,
            ...Object.values(components.drives ?? {}),
            ...(components.weapons ?? []),
          ].filter(Boolean),
          sector: calculateStruckSector({
            attackerPosition: tokenCenter(sourceToken, geometry),
            targetPosition: tokenCenter(targetToken, geometry),
            targetFacing: Number(targetToken.rotation ?? 0),
          }),
        });
        this.#refreshAimed(form);
        const aimedComponentId = elementFormData(form).aimedComponentId;
        delete operation.payload.aimedComponentId;
        if (aimedComponentId) {
          operation.payload.aimedComponentId = aimedComponentId;
        }
        const operator = config.operators?.find((entry) =>
          entry.id === operation.payload.operatorId
        );
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
        this.#storeShot(form, { result });
        const codes = new Set(result.violations.map((entry) => entry.code));
        const blocker = codes.has("WEAPON_OFFLINE")
          ? "Weapon offline/booting."
          : codes.has("TARGET_OUT_OF_ARC") || codes.has("TARGET_OUT_OF_RANGE")
          ? "Out of arc/range."
          : codes.has("TARGET_NOT_TARGETED")
          ? "A Targeted sensor track is required."
          : result.violations[0]?.message ?? "Valid shot";
        this.#weaponValidity(form, result.legal, blocker);
      }
      if (type !== "attack") {
        const submit = form.querySelector("button[type='submit']");
        if (submit) submit.disabled = !this.#canAct;
        output.dataset.error = "false";
      }
    } catch (error) {
      if (!current()) return;
      if (type === "attack") {
        this.#storeShot(form, { error: errorText(error) });
        this.#weaponValidity(form, false, errorText(error));
      }
      if (type !== "attack") {
        const submit = form.querySelector("button[type='submit']");
        if (submit) submit.disabled = true;
        output.textContent = errorText(error);
        output.dataset.error = "true";
      }
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
    const current = () =>
      this.#epoch === epoch && this.#previewSerial.get(form) === serial &&
      this.#root?.contains(form);
    try {
      const payload = parseObject(form.elements.payload.value);
      const type = form.dataset.rawOperation;
      const actor = this.actor;
      const config = await materializeActorConfig(actor);
      const state = clone(actor.system.shipCombat.state);
      let result = payload;
      if (type === "routePower") {
        result = previewPowerRoute(config, state, payload);
      } else if (type === "routeDefense") {
        result = previewDefenseRoute(config, state, payload);
      } else if (type === "maneuver" || type === "rotate") {
        const token = actorToken(actor);
        if (!token) {
          throw new Error(
            "Place this ship on the active Scene to preview movement.",
          );
        }
        const assembled = await movementPreviewInput(
          payload,
          token,
          config,
          state,
        );
        if (!current()) return;
        result = {
          ...previewManeuver(assembled.input),
          targetedCoasts: assembled.targetedCoasts,
        };
        setMovementPreview(
          token.uuid,
          canvasMovementPreview(result, assembled.geometry),
        );
      } else if (type === "attack") {
        const targetUuid = (form.elements.targets?.value ?? "").split(/[\s,]+/)
          .find(Boolean);
        if (!targetUuid) {
          throw new Error("Enter a target Token UUID to preview an attack.");
        }
        const target = await fromUuid(targetUuid);
        const targetActor = target?.actor;
        if (!targetActor) {
          throw new Error("The target UUID must identify a placed Token.");
        }
        const sourceToken = actorToken(actor);
        const targetToken = target?.document ?? target;
        if (!sourceToken) {
          throw new Error(
            "Place this ship on the active scene to preview an attack.",
          );
        }
        const geometry = sceneGeometry(sourceToken);
        const targetState = clone(targetActor.system.shipCombat.state);
        const targetConfig = await materializeActorConfig(targetActor);
        const operator = config.operators?.find((entry) =>
          entry.id === payload.operatorId
        );
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
    const pendingKey = type === "toggleWeapon"
      ? `${type}:${data.weaponId}`
      : type;
    if (this.#pending.has(pendingKey)) return;
    this.#pending.add(pendingKey);
    try {
      if (type === "attack") {
        const targets = this.#foundryTargets();
        if (targets.length !== 1) {
          throw new Error("Select exactly one Foundry target before firing.");
        }
        if (data.targetUuid !== targets[0].uuid) delete data.aimedComponentId;
        data.targetUuid = targets[0].uuid;
        if (
          !this.#view.targetedContacts.some((contact) =>
            contact.targetUuid === data.targetUuid
          )
        ) throw new Error("A Targeted sensor track is required.");
      }
      const config = await materializeActorConfig(this.actor);
      const operation = uiOperation(type, data, config, state);
      if (type === "routePower") {
        previewPowerRoute(config, state, operation.payload);
      }
      if (type === "routeDefense") {
        previewDefenseRoute(config, state, operation.payload);
      }
      if (TARGET_OPERATIONS.has(type) && operation.targetUuids.length !== 1) {
        throw new Error("Select one valid contact.");
      }
      element.disabled = true;
      await this.#commitOperation(
        type,
        operation.payload,
        operation.targetUuids,
        state.revision,
      );
    } catch (error) {
      ui.notifications.error(errorText(error));
      if (type === "toggleWeapon") {
        element.value = this.#view.weapons.find((weapon) =>
          weapon.id === data.weaponId
        )?.setting ?? "off";
      }
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
      const targetUuids = (form.elements.targets?.value ?? "").split(/[\s,]+/)
        .filter(Boolean);
      await this.#commitOperation(type, payload, targetUuids);
      drafts.delete(
        draftKey(
          actorToken(this.actor)?.uuid ?? this.actor.uuid,
          `raw-${type}`,
        ),
      );
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #commitOperation(
    type,
    payload,
    targetUuids,
    sourceRevision = this.actor.system.shipCombat.state?.revision,
  ) {
    const token = actorToken(this.actor);
    if (!token) {
      throw new Error("Place this ship on the active Scene to operate it.");
    }
    const revisions = { [token.uuid]: Number(sourceRevision ?? 0) };
    for (const uuid of targetUuids) {
      const document = await fromUuid(uuid);
      const revision = document?.actor?.system?.shipCombat?.state?.revision ??
        document?.system?.shipCombat?.state?.revision;
      if (!Number.isInteger(revision)) {
        throw new Error("The selected target is unavailable.");
      }
      revisions[uuid] = revision;
    }
    if (
      type === "attack" &&
      (this.#foundryTargets().length !== 1 ||
        this.#foundryTargets()[0].uuid !== targetUuids[0])
    ) {
      throw new Error(
        "Foundry targeting changed; select exactly one target and fire again.",
      );
    }
    const request = {
      id: foundry.utils.randomID(),
      type,
      sourceUuid: token.uuid,
      targetUuids,
      expectedRevisions: revisions,
      payload,
    };
    const response = await submitShipOperation(request);
    if (!response?.ok) {
      throw new Error(
        response?.error?.message ?? response?.error ?? `${type} was rejected.`,
      );
    }
    this.#uiDrafts.delete(`${type}:${payload.weaponId ?? ""}`);
    this.#epoch++;
    this.#movementInput = null;
    clearMovementPreview(token.uuid);
    ui.notifications.info(
      `${type.replace(/([a-z])([A-Z])/g, "$1 $2")} committed.`,
    );
    await this.render();
  }

  async #saveConfig(event) {
    event.preventDefault();
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      this.#refreshHullDraft(event.currentTarget);
      if (this.#hullDraft.stale) {
        throw new Error(
          "Hull changed since you started editing. Reload the current hull before saving.",
        );
      }
      const hullConfig = parseObject(
        event.currentTarget.elements.config.value,
        "Hull configuration",
      );
      await saveShipHull(
        this.actor,
        hullConfig,
        Number(event.currentTarget.dataset.revision),
      );
      this.#hullDraft = null;
      ui.notifications.info(
        "Hull configuration saved and installed components rematerialized.",
      );
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }

  async #resetCanadensis() {
    try {
      const denial = getRefitDenial(this.actor);
      if (denial) throw new Error(denial);
      if (
        !await foundry.applications.api.DialogV2.confirm({
          window: { title: "Reset to Canadensis?" },
          content:
            "<p>Replace the hull configuration, installed component copies, and crew definitions with the Canadensis defaults? Only still-compatible roster assignments are retained.</p><p>Component-local state (including shields, readiness, sensor tracks, and recovery work) is replaced. Hull damage, heat, velocity, and ship-wide hazards are retained; this is not a full combat reset.</p>",
          defaultYes: false,
          rejectClose: false,
        })
      ) return;
      await resetShipToCanadensis(this.actor);
      this.#hullDraft = null;
      ui.notifications.info(
        "Canadensis hull and fresh component copies restored.",
      );
      await this.render();
    } catch (error) {
      if (error?.code === "REFIT_CLEANUP_FAILED") this.#hullDraft = null;
      await this.#refitError(error);
    }
  }

  async #rollback(id) {
    if (
      !game.user.isGM ||
      !globalThis.confirm(`Roll back the whole operation ${id}?`)
    ) return;
    try {
      const response = await rollbackShipOperation(id);
      if (!response?.ok) {
        throw new Error(
          response?.error?.message ?? response?.error ??
            "Rollback was rejected.",
        );
      }
      ui.notifications.info("Whole operation rolled back.");
      await this.render();
    } catch (error) {
      ui.notifications.error(errorText(error));
    }
  }
}

export function registerShipSheet() {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(
    Actor,
    MODULE_ID,
    ShipConsole,
    { types: [SHIP_TYPE], makeDefault: true, label: "Vira Ship Console" },
  );
}

export { canvasMovementPreview, movementPreviewInput, ShipConsole };
