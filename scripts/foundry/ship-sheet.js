import { MODULE_ID, SHIP_TYPE } from "../constants.js";
import { validateShipConfig } from "../model/validation.js";
import { CANADENSIS_CONFIG } from "../data/canadensis.js";
import { nativeVehicleFieldValues } from "../model/native-vehicle.js";

import { previewPowerRoute } from "../rules/power.js";
import { previewDefenseRoute } from "../rules/shields.js";
import { previewManeuver } from "../rules/movement.js";
import { previewAttack } from "../rules/combat.js";
import { submitShipOperation, rollbackShipOperation, getOperationLog } from "../state/action-queue.js";
import { setMovementPreview, clearMovementPreview } from "../canvas/overlays.js";

const TABS = ["Overview", "Crew", "Helm", "Power/Defense", "Sensors", "Weapons", "Damage", "Log/Config"];
const GROUPS = {
  Overview: ["enterCombat", "startPhase", "coast", "endPhase", "leaveCombat", "refreshResources", "resolveFate"],
  Crew: ["setRoster", "spendResource", "takeControl", "contributeWork"],
  Helm: ["maneuver", "rotate", "armEvasion", "disarmEvasion", "reposition"],
  "Power/Defense": ["routePower", "toggleWeapon", "routeDefense"],
  Sensors: ["ping", "acquire", "analyze", "deepScan", "firingSolution", "fade", "jam", "breakLock", "burnThrough"],
  Weapons: ["attack", "beginReload", "reload", "cancelReload"],
  Damage: ["repair", "recoveryWork", "hullRepair", "cooling", "vent"],
};
const HELP = {
  enterCombat: "GM: {\"turnKey\":\"combat.turn\",\"gmOverride\":true}", startPhase: "GM: {\"turnKey\":\"combat.turn\",\"gmOverride\":true}",
  coast: "End Active movement", endPhase: "GM phase resolution", leaveCombat: "GM: {\"gmOverride\":true}", resolveFate: "GM fate resolution",
  setRoster: "{\"roster\":{\"command\":[],\"crew\":[]}}", refreshResources: "{}", spendResource: "{\"operatorId\":\"…\",\"operation\":{}}",
  takeControl: "{\"operatorId\":\"…\",\"control\":\"helm|power|defense\"}", contributeWork: "{\"operatorId\":\"…\",\"jobId\":\"…\",\"required\":1}",
  maneuver: "{\"operatorId\":\"…\",\"deltaV\":{\"forward\":0,\"lateral\":0},\"rotation\":0}", rotate: "{\"operatorId\":\"…\",\"rotation\":0}",
  armEvasion: "{\"operatorId\":\"…\",\"evasionReserve\":1}", disarmEvasion: "{\"operatorId\":\"…\"}", reposition: "GM: {\"position\":{\"x\":0,\"y\":0},\"facing\":0,\"resetVelocity\":false,\"gmOverride\":true}",
  routePower: "{\"operatorId\":\"…\",\"allocation\":{}}", toggleWeapon: "{\"operatorId\":\"…\",\"weaponId\":\"…\"}", routeDefense: "{\"operatorId\":\"…\",\"charge\":{},\"regenerationAllocation\":{}}",
  ping: "{\"operatorId\":\"…\",\"operatorSensors\":0}", acquire: "{\"operatorId\":\"…\",\"distance\":0}", analyze: "{\"operatorId\":\"…\",\"distance\":0}", deepScan: "{\"operatorId\":\"…\",\"distance\":0}", firingSolution: "{\"operatorId\":\"…\",\"distance\":0}", fade: "{\"operatorId\":\"…\"}", jam: "{\"operatorId\":\"…\",\"operatorSensors\":0}", breakLock: "{\"operatorId\":\"…\",\"operatorSensors\":0}", burnThrough: "{\"operatorId\":\"…\",\"operatorSensors\":0}",
  attack: "{\"operatorId\":\"…\",\"weaponId\":\"…\",\"barrage\":1}", beginReload: "{\"operatorId\":\"…\",\"weaponId\":\"…\"}", reload: "{\"operatorId\":\"…\",\"weaponId\":\"…\",\"amount\":1}", cancelReload: "{\"operatorId\":\"…\",\"weaponId\":\"…\"}",
  repair: "{\"operatorId\":\"…\",\"conditionId\":\"…\",\"rating\":\"engineering\"}", recoveryWork: "{\"operatorId\":\"…\",\"conditionId\":\"…\"}", hullRepair: "{\"operatorId\":\"…\",\"rating\":\"engineering\"}", cooling: "{\"operatorId\":\"…\"}", vent: "{\"operatorId\":\"…\"}",
};
const TARGETED = new Set(["acquire", "analyze", "deepScan", "firingSolution", "fade", "jam", "breakLock", "burnThrough", "attack"]);
const GM_ONLY = new Set(["enterCombat", "startPhase", "endPhase", "leaveCombat", "reposition", "resolveFate"]);
const drafts = new Map();

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
function validationTokenWidth(actor) {
  const width = Number(actorToken(actor)?.width ?? actor?.prototypeToken?.width ?? actor?._source?.prototypeToken?.width ?? 1);
  return Number.isFinite(width) && width > 0 ? width : 1;
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

function configurationSummary(config, state) {
  const drive = config?.components?.drive ?? {};
  const shield = config?.components?.shield ?? {};
  const sensor = config?.components?.sensor ?? {};
  const reactor = config?.components?.reactor ?? {};
  const cooling = config?.components?.cooling ?? {};
  const armor = config?.armor ?? {};
  const base = drive.base ?? {};
  const sensorBase = sensor.base ?? {};
  return [
    {
      label: "Identity and limits",
      entries: [
        { label: "Class", value: config?.label ?? "—" },
        { label: "Size", value: config?.size ?? "—" },
        { label: "Initiative", value: config?.initiative ?? "—" },
        { label: "AC", value: config?.ac ?? "—" },
        { label: "Base Signature", value: config?.baseSignature ?? "—" },
        { label: "Hull", value: `${state?.hull ?? "—"} / ${config?.maxHull ?? "—"}` },
        { label: "Heat", value: `${state?.heat ?? "—"} / ${config?.heatCapacity ?? "—"}` },
        { label: "Command / Crew", value: `${config?.commandCapacity ?? "—"} / ${config?.crewCapacity ?? "—"}` },
        { label: "Fate policy", value: config?.fatePolicy ?? "—" },
      ],
    },
    {
      label: "Movement and defense",
      entries: [
        { label: "Drive base", value: `F ${base.forward ?? "—"} · R ${base.retro ?? "—"} · P ${base.port ?? "—"} · S ${base.starboard ?? "—"} · Rot ${base.rotation ?? "—"}°` },
        { label: "Drive tiers (Power:multiplier)", value: tierSummary(drive.tiers, "multiplier") || "—" },
        { label: "Safe Velocity", value: config?.safeVelocity ?? "—" },
        { label: "Evasion", value: `${config?.evasionReserve ?? "—"}% reserve · +${config?.evasionAcBonus ?? "—"} AC` },
        { label: "Armor", value: `Fore ${armor.fore ?? "—"} · Port ${armor.port ?? "—"} · Starboard ${armor.starboard ?? "—"} · Aft ${armor.aft ?? "—"}` },
      ],
    },
    {
      label: "Power, shields, and sensors",
      entries: [
        { label: "Reactor", value: `${reactor.nominalOutput ?? "—"} nominal · ${reactor.redlineOutput ?? "—"} redline · ${reactor.overclockHeat ?? "—"} Heat` },
        { label: "Shields", value: `${shield.topology ?? "—"} · ${shield.totalBudget ?? "—"} budget · ${shield.sectorCap ?? "—"} cap · ${shield.rechargeDelay ?? "—"} delay` },
        { label: "Shield regeneration (Power:value)", value: tierSummary(shield.tiers, "regeneration") || "—" },
        { label: "Passive sensors", value: `${sensorBase.passiveRange ?? "—"} range · ${sensorBase.passiveStrength ?? "—"} strength` },
        { label: "Active sensors", value: `${sensorBase.activeRange ?? "—"} range · ${sensorBase.activeModifier ?? "—"} modifier · ${sensorBase.ewModifier ?? "—"} EW` },
        { label: "Cooling (Power:value)", value: tierSummary(cooling.tiers, "cooling") || "—" },
        { label: "Emergency vent", value: `${cooling.ventAmount ?? "—"} Heat · ${cooling.ventCooldown ?? "—"} Start cooldown` },
      ],
    },
  ];
}


function sceneGeometry(token) {
  const scene = globalThis.canvas?.scene ?? token?.parent;
  const gridSize = Number(globalThis.canvas?.dimensions?.size ?? scene?.grid?.size ?? globalThis.canvas?.grid?.size ?? 100) || 100;
  const gridDistance = Number(globalThis.canvas?.dimensions?.distance ?? scene?.grid?.distance ?? 1) || 1;
  return { scene, gridSize, gridDistance, unitsPerPixel: gridDistance / gridSize, pixelsPerUnit: gridSize / gridDistance };
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

function tokenRadius(token, geometry) {
  return (Number(token?.width ?? 0) * geometry.gridDistance) / 2;
}

function driveCapabilities(config, state) {
  const drive = config?.components?.drive ?? {};
  const power = Number(state?.power?.engines ?? 0);
  const tier = Array.from(drive.tiers ?? [])
    .filter((entry) => Number(entry?.power) <= power)
    .sort((left, right) => Number(left.power) - Number(right.power))
    .at(-1);
  const multiplier = Number(tier?.multiplier ?? 0);
  const base = drive.base ?? {};
  return {
    forward: Number(base.forward ?? 0) * multiplier,
    retro: Number(base.retro ?? 0) * multiplier,
    port: Number(base.port ?? 0) * multiplier,
    starboard: Number(base.starboard ?? 0) * multiplier,
    rotation: Number(base.rotation ?? 0) * multiplier,
  };
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

function movementObstacles(sourceToken, geometry) {
  const obstacles = [];
  for (const token of sceneTokenDocuments(geometry.scene)) {
    if (!token || token.uuid === sourceToken.uuid || token.id === sourceToken.id) continue;
    const actor = token.actor;
    const shipCombat = actor?.system?.shipCombat;
    if (actor?.type !== SHIP_TYPE || !shipCombat?.config || !shipCombat?.state) continue;
    obstacles.push({
      id: token.uuid ?? token.id,
      position: tokenCenter(token, geometry),
      velocity: clone(shipCombat.state.velocity ?? { x: 0, y: 0 }),
      facing: Number(token.rotation ?? 0),
      radius: tokenRadius(token, geometry),
      size: shipCombat.config.size ?? "medium",
      maxHull: shipCombat.config.maxHull,
      armor: 0,
    });
  }
  for (const wall of collectionValues(geometry.scene?.walls)) {
    const document = wall?.document ?? wall;
    const coordinates = document?.c ?? wall?.c;
    if (!Array.isArray(coordinates) || coordinates.length < 4) continue;
    obstacles.push({
      id: document.uuid ?? document.id ?? wall.id,
      type: "wall",
      a: { x: Number(coordinates[0]) * geometry.unitsPerPixel, y: Number(coordinates[1]) * geometry.unitsPerPixel },
      b: { x: Number(coordinates[2]) * geometry.unitsPerPixel, y: Number(coordinates[3]) * geometry.unitsPerPixel },
    });
  }
  return obstacles;
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
  return converted;
}

function movementPreviewInput(payload, token, config, state) {
  const geometry = sceneGeometry(token);
  const radius = tokenRadius(token, geometry);
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
      obstacles: movementObstacles(token, geometry),
    },
    geometry,
  };
}

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

class ShipConsole extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = { classes: [MODULE_ID, "ship-console"], position: { width: 860, height: 720 }, window: { resizable: true }, actions: {} };
  static PARTS = { console: { template: `modules/${MODULE_ID}/templates/ship-console.hbs` } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor ?? this.document;
    const token = actorToken(actor);
    const data = actor.system?.shipCombat ?? {};
    const state = clone(data.state);
    const isGM = game.user.isGM;
    const canOperate = Boolean(token && (isGM || actor.isOwner));
    const unavailableReason = !token ? "Open a placed token to operate this ship." : !canOperate ? "You do not own this token actor." : "";
    const actions = Object.fromEntries(TABS.map((tab) => [tab, (GROUPS[tab] ?? []).map((type) => {
      const gmDenied = GM_ONLY.has(type) && !isGM;
      return { type, help: HELP[type] ?? "{}", targeted: TARGETED.has(type), disabled: !canOperate || gmDenied, reason: unavailableReason || (gmDenied ? "Active GM only." : "") };
    })]));
    let log = [];
    if (isGM && token) { try { log = await getOperationLog() ?? []; } catch (error) { log = [{ error: errorText(error) }]; } }
    return foundry.utils.mergeObject(context, {
      actor, token, tabs: TABS.map((label, index) => ({ label, id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), active: index === 0 })),
      actions, isGM, canOperate, unavailableReason, revision: Number(state.revision ?? 0), phase: state.phase ?? "—", turnKey: state.turnKey ?? "—",
      specGroups: configurationSummary(data.config ?? {}, state),
      stateJson: pretty(escapeSecrets(state, isGM)), configJson: pretty(data.config ?? {}), log: Array.isArray(log) ? log.map((entry) => ({ id: entry.id ?? entry.requestId ?? "", json: pretty(entry), rollback: Boolean(entry.id ?? entry.requestId) })) : [],
    }, { inplace: false });
  }

  async close(options = {}) {
    const token = actorToken(this.actor);
    if (token) clearMovementPreview(token.uuid);
    return super.close(options);
  }

  _attachPartListeners(partId, html, options) {
    super._attachPartListeners(partId, html, options);
    html.querySelectorAll("[data-tab-button]").forEach((button) => button.addEventListener("click", () => this.#selectTab(html, button.dataset.tabButton)));
    html.querySelectorAll("form[data-operation]").forEach((form) => {
      const type = form.dataset.operation; const key = draftKey(this.actor, type); const saved = drafts.get(key);
      if (saved) { form.elements.payload.value = saved.payload; if (form.elements.targets) form.elements.targets.value = saved.targets; }
      form.addEventListener("input", () => { drafts.set(key, { payload: form.elements.payload.value, targets: form.elements.targets?.value ?? "" }); this.#preview(form); });
      form.addEventListener("submit", (event) => this.#submit(event, form));
      this.#preview(form);
    });
    html.querySelector("form[data-config]")?.addEventListener("submit", (event) => this.#saveConfig(event));
    html.querySelector("[data-canadensis]")?.addEventListener("click", () => this.#resetCanadensis());
    html.querySelectorAll("[data-rollback]").forEach((button) => button.addEventListener("click", () => this.#rollback(button.dataset.rollback)));
    html.querySelector("[data-native-vehicle-sheet]")?.addEventListener("click", () => {
      try { openNativeVehicleSheet(this.actor); } catch (error) { ui.notifications.error(errorText(error)); }
    });
  }

  #selectTab(html, id) {
    html.querySelectorAll("[data-tab-button]").forEach((el) => el.setAttribute("aria-selected", String(el.dataset.tabButton === id)));
    html.querySelectorAll("[data-tab-panel]").forEach((el) => { el.hidden = el.dataset.tabPanel !== id; });
  }

  async #preview(form) {
    const output = form.querySelector("[data-preview]"); if (!output) return;
    try {
      const payload = parseObject(form.elements.payload.value); const type = form.dataset.operation; const actor = this.actor; const config = actor.system.shipCombat.config; const state = clone(actor.system.shipCombat.state);
      let result = payload;
      if (type === "routePower") result = previewPowerRoute(config, state, payload);
      else if (type === "routeDefense") result = previewDefenseRoute(config, state, payload);
      else if (type === "maneuver" || type === "rotate") {
        const token = actorToken(actor);
        if (!token) throw new Error("Open a placed token to preview ship movement.");
        const assembled = movementPreviewInput(payload, token, config, state);
        result = previewManeuver(assembled.input);
        setMovementPreview(token.uuid, canvasMovementPreview(result, assembled.geometry));
      }
      else if (type === "attack") {
        const targetUuid = (form.elements.targets?.value ?? "").split(/[\s,]+/).find(Boolean);
        if (!targetUuid) throw new Error("Enter a target Token UUID to preview an attack.");
        const target = await fromUuid(targetUuid); const targetActor = target?.actor;
        if (!targetActor) throw new Error("The target UUID must identify a placed Token.");
        result = previewAttack({ attackerConfig: config, attackerState: state, targetConfig: targetActor.system.shipCombat.config, targetState: clone(targetActor.system.shipCombat.state), declaration: { ...payload, targetUuid } });
      }
      output.textContent = pretty(result); output.dataset.error = "false";
    } catch (error) { output.textContent = `Preview unavailable: ${errorText(error)}`; output.dataset.error = "true"; }
  }

  async #submit(event, form) {
    event.preventDefault();
    const token = actorToken(this.actor); if (!token) return ui.notifications.warn("Open a placed token to operate this ship.");
    try {
      const payload = parseObject(form.elements.payload.value); const targetUuids = (form.elements.targets?.value ?? "").split(/[\s,]+/).filter(Boolean);
      const revisions = { [token.uuid]: Number(this.actor.system.shipCombat.state?.revision ?? 0) };
      for (const uuid of targetUuids) { const document = await fromUuid(uuid); revisions[uuid] = Number(document?.actor?.system?.shipCombat?.state?.revision ?? document?.system?.shipCombat?.state?.revision ?? 0); }
      const request = { id: foundry.utils.randomID(), type: form.dataset.operation, sourceUuid: token.uuid, targetUuids, expectedRevisions: revisions, payload };
      const response = await submitShipOperation(request); if (!response?.ok) throw new Error(response?.error?.message ?? response?.error ?? `${form.dataset.operation} was rejected.`);
      drafts.delete(draftKey(token.uuid, form.dataset.operation)); clearMovementPreview(token.uuid); ui.notifications.info(`${form.dataset.operation} committed.`); await this.render();
    } catch (error) { ui.notifications.error(errorText(error)); }
  }

  async #saveConfig(event) {
    event.preventDefault(); if (!game.user.isGM) return ui.notifications.error("Active GM only.");
    try { const config = parseObject(event.currentTarget.elements.config.value, "Configuration"); const validation = validateShipConfig(config, { tokenWidth: validationTokenWidth(this.actor) }); if (!validation.valid) throw new Error(validation.errors.map((e) => e.message ?? `${e.path}: ${e.code}`).join("\n")); await this.actor.update({ "system.shipCombat.config": foundry.data.operators.ForcedReplacement.create(config), ...nativeVehicleFieldValues(config, this.actor.system.shipCombat.state) }, { diff: false }); ui.notifications.info("Ship configuration saved; combat state was not changed."); await this.render(); } catch (error) { ui.notifications.error(errorText(error)); }
  }

  async #resetCanadensis() {
    if (!game.user.isGM) return;
    if (!globalThis.confirm("Replace this ship's configuration with the exact Canadensis configuration? Combat state will not be changed.")) return;
    const config = clone(CANADENSIS_CONFIG); const validation = validateShipConfig(config, { tokenWidth: validationTokenWidth(this.actor) });
    if (!validation.valid) return ui.notifications.error("Bundled Canadensis configuration is invalid.");
    await this.actor.update({ "system.shipCombat.config": foundry.data.operators.ForcedReplacement.create(config), ...nativeVehicleFieldValues(config, this.actor.system.shipCombat.state) }, { diff: false }); ui.notifications.info("Canadensis configuration restored; combat state was not changed."); await this.render();
  }

  async #rollback(id) {
    if (!game.user.isGM || !globalThis.confirm(`Roll back the whole operation ${id}?`)) return;
    try { const response = await rollbackShipOperation(id); if (!response?.ok) throw new Error(response?.error?.message ?? response?.error ?? "Rollback was rejected."); ui.notifications.info("Whole operation rolled back."); await this.render(); } catch (error) { ui.notifications.error(errorText(error)); }
  }
}

export function registerShipSheet() {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, ShipConsole, { types: [SHIP_TYPE], makeDefault: true, label: "Vira Ship Console" });
}

export { ShipConsole, movementPreviewInput, canvasMovementPreview };
