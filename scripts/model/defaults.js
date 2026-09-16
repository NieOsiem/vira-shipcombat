import { SCHEMA_VERSION, SECTORS } from "../constants.js";
import { CANADENSIS_CONFIG } from "../data/canadensis.js";

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function fillMissing(defaults, supplied) {
  if (supplied === undefined) return clone(defaults);
  if (Array.isArray(defaults) || !defaults || typeof defaults !== "object") {
    return clone(supplied);
  }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    return clone(supplied);
  }

  const result = clone(supplied);
  for (const [key, defaultValue] of Object.entries(defaults)) {
    result[key] = fillMissing(defaultValue, supplied[key]);
  }
  return result;
}

function shieldSectors(config) {
  const shield = config?.components?.shield;
  if (shield?.topology === "bubble") return ["bubble"];
  const configured = Array.isArray(shield?.sectors) ? shield.sectors : SECTORS;
  return [...configured];
}

function distribute(total, keys, cap = Infinity) {
  const values = Object.fromEntries(keys.map((key) => [key, 0]));
  let remaining = Math.max(0, Math.trunc(total ?? 0));
  let cursor = 0;
  while (remaining > 0 && keys.length > 0) {
    const key = keys[cursor % keys.length];
    if (values[key] < cap) {
      values[key] += 1;
      remaining -= 1;
    } else if (keys.every((candidate) => values[candidate] >= cap)) {
      break;
    }
    cursor += 1;
  }
  return values;
}

function initialPower(config) {
  const allocations = config?.powerPresets?.[0]?.allocations ?? {};
  const power = {
    engines: allocations.engines ?? 0,
    shields: allocations.shields ?? 0,
    sensors: allocations.sensors ?? 0,
    cooling: allocations.cooling ?? 0,
    weapons: allocations.weapons ?? 0,
  };
  const committed = power.engines + power.shields + power.sensors + power.cooling + power.weapons;
  power.redlining = committed > (config?.components?.reactor?.nominalOutput ?? Infinity);
  return power;
}

function initialWeapons(config, weaponsPower) {
  const weapons = config?.components?.weapons ?? [];
  const byId = new Map(weapons.map((weapon) => [weapon.id, weapon]));
  const priority = [
    ...(config?.weaponPriority ?? []),
    ...weapons.map((weapon) => weapon.id).filter((id) => !(config?.weaponPriority ?? []).includes(id)).sort(),
  ];
  const online = new Set();
  let reserved = 0;

  for (const id of priority) {
    const weapon = byId.get(id);
    if (!weapon) continue;
    const rating = weapon.powerRating ?? 0;
    if (reserved + rating <= weaponsPower) {
      online.add(id);
      reserved += rating;
    }
  }

  return Object.fromEntries(weapons.map((weapon) => [
    weapon.id,
    {
      status: online.has(weapon.id) ? "online" : "off",
      mode: "nominal",
      bootCounter: 0,
      readiness: weapon.readiness?.capacity ?? 0,
      reloadProgress: 0,
      reloadWork: null,
    },
  ]));
}

function initialRoster(config) {
  const roster = { command: [], crew: [], lockedTurnKey: null };
  for (const operator of config?.operators ?? []) {
    const assignment = operator.defaultAssignment;
    if (!assignment || !Array.isArray(roster[assignment.kind])) continue;
    roster[assignment.kind].push({ operatorId: operator.id, slot: assignment.slot });
  }
  roster.command.sort((a, b) => a.slot - b.slot);
  roster.crew.sort((a, b) => a.slot - b.slot);
  return roster;
}

/** @returns {object} A fresh mutable V1 state for config. */
export function createInitialState(config) {
  if (!config || typeof config !== "object") {
    throw new TypeError("createInitialState requires a ship configuration object");
  }

  const sectors = shieldSectors(config);
  const shield = config.components?.shield ?? {};
  const charge = distribute(shield.totalBudget, sectors, shield.sectorCap);
  const regenerationAllocation = distribute(100, sectors, 100);
  const collapse = Object.fromEntries(sectors.map((sector) => [sector, 0]));
  const power = initialPower(config);

  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    phase: "start",
    turnKey: null,
    hull: config.maxHull ?? 0,
    heat: 0,
    power,
    shields: { charge, regenerationAllocation, collapse },
    weapons: initialWeapons(config, power.weapons),
    roster: initialRoster(config),
    resources: { actions: {}, orders: {} },
    controls: { helm: null, power: null, defense: null },
    work: {},
    tracks: {},
    velocity: { x: 0, y: 0 },
    timeline: 0,
    rotationSpent: 0,
    evasion: { armed: false, reserved: 0 },
    ventCooldown: 0,
    effects: [],
    conditions: {},
    repairAttemptUsed: false,
    pendingFate: null,
    history: [],
  };
}

/** @returns {{schemaVersion:number, config:object, state:object}} Fresh reference ship data. */
export function createDefaultShipData() {
  const config = clone(CANADENSIS_CONFIG);
  return {
    schemaVersion: SCHEMA_VERSION,
    config,
    state: createInitialState(config),
  };
}

/** @returns {object} A new V1 ship-data object with missing fields filled. */
export function normalizeShipData(data) {
  const supplied = data && typeof data === "object" ? data : {};
  const config = clone(supplied.config ?? CANADENSIS_CONFIG);
  const defaults = {
    schemaVersion: SCHEMA_VERSION,
    config,
    state: createInitialState(config),
  };
  const normalized = fillMissing(defaults, supplied);
  normalized.schemaVersion = SCHEMA_VERSION;
  normalized.config = config;
  normalized.state.schemaVersion = SCHEMA_VERSION;
  return normalized;
}
