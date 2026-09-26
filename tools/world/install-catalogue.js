#!/usr/bin/env bun
/**
 * Build a pasteable installer for a world-only ship catalogue wave.
 *
 *   bun tools/world/install-catalogue.js                      # validate wave-1 and emit the script
 *   bun tools/world/install-catalogue.js --check              # validate only
 *   bun tools/world/install-catalogue.js --wave=wave-2        # another manifest
 *
 * The catalogue lives in `world-data/**` as ordinary modules. It is deliberately absent from
 * `scripts/data/reference-builds.js`, so the module treats these hulls as **custom hulls**: nothing
 * is shipped, and a fresh copy installs no components by itself. This tool validates the wave with
 * the engine's own `materializeShipConfig`, then writes a self-contained script
 * (`tools/world/generated/install-<wave>.js`) that the GM runs inside the Foundry client:
 *
 *   await __viraInstallWave1(false)   // dry run: lists everything it would create
 *   await __viraInstallWave1(true)    // apply (idempotent — safe to re-run)
 *
 * It creates: the component Items (into the "Ship Parts" folder), and one Actor template per hull
 * (into the "Ships" folder) whose default components are installed — blanks stay empty on purpose.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_REFERENCE_BUILD_ID, REFERENCE_BUILDS } from "../../scripts/data/reference-builds.js";
import { materializeShipConfig } from "../../scripts/model/equipment.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DOC_ID = /^[A-Za-z0-9]{16}$/;

const argumentValue = (flag) => {
  const prefix = `${flag}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
};

const WAVE = argumentValue("--wave") ?? "wave-1";
const CHECK_ONLY = process.argv.includes("--check");
const OUT = resolve(argumentValue("--out") ?? join(REPO, "tools/world/generated", `install-${WAVE}.js`));

const fail = (message) => {
  console.error(`install-catalogue: ${message}`);
  process.exit(1);
};

/** Collect every problem before failing, so one run reports them all. */
function validateWave(wave) {
  const problems = [];
  const hullIds = new Set(REFERENCE_BUILDS.map((build) => build.id));
  const sourceIds = new Map();

  for (const source of wave.componentSources ?? []) {
    if (!DOC_ID.test(String(source?._id ?? ""))) problems.push(`component id '${source?._id}' is not 16 alphanumeric characters`);
    if (sourceIds.has(source?._id)) problems.push(`component id '${source?._id}' is duplicated`);
    sourceIds.set(source?._id, source);
    if (!source?.system?.componentClass) problems.push(`component '${source?._id}' has no componentClass`);
  }

  for (const entry of wave.hulls ?? []) {
    const id = entry?.hull?.id;
    const label = entry?.hull?.label ?? id;
    if (!id) { problems.push("a hull entry has no id"); continue; }
    if (hullIds.has(id)) problems.push(`hull '${id}' collides with the bundled reference build registry`);
    hullIds.add(id);
    if (Number(entry.hull.schemaVersion) !== 2) problems.push(`hull '${id}' must carry schemaVersion 2`);
    if (!Array.isArray(entry.sources)) { problems.push(`hull '${id}' has no default component sources array`); continue; }

    const known = new Set([...sourceIds.keys(), ...entry.sources.map((source) => source?._id)]);
    for (const source of entry.sources) {
      if (!DOC_ID.test(String(source?._id ?? ""))) problems.push(`hull '${id}' installs '${source?._id}', whose id is not 16 alphanumeric characters`);
      if (!sourceIds.has(source?._id)) sourceIds.set(source._id, source);
    }
    for (const slot of entry.hull.slots ?? []) {
      if (slot.itemId && !known.has(slot.itemId)) problems.push(`hull '${id}' slot '${slot.id}' references '${slot.itemId}', which no component source provides`);
    }
    for (const hardpoint of entry.hull.hardpoints ?? []) {
      if (hardpoint.weaponId && !entry.sources.some((source) => source?._id === hardpoint.weaponId)) {
        problems.push(`hull '${id}' hardpoint '${hardpoint.id}' references '${hardpoint.weaponId}', which the hull does not install`);
      }
    }
    try {
      materializeShipConfig(entry.hull, entry.sources);
    } catch (error) {
      problems.push(`hull '${id}' (${label}) does not materialize: ${error.code ?? ""} ${error.message}`);
    }
  }
  return problems;
}

const manifestPath = join(REPO, "world-data/waves", `${WAVE}.js`);
const isWave = (value) => Boolean(value) && typeof value === "object" && Array.isArray(value.hulls) && Array.isArray(value.componentSources);
let manifest;
try {
  const module = await import(pathToFileURL(manifestPath).href);
  manifest = [module.default, ...Object.values(module)].find(isWave) ?? null;
} catch (error) {
  fail(`cannot import ${manifestPath}: ${error.message}`);
}
if (!manifest) fail(`${manifestPath} must export the wave as its default export`);

const problems = validateWave(manifest);
if (problems.length) {
  console.error(`install-catalogue: ${problems.length} problem(s) in ${WAVE}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const componentCount = new Set((manifest.componentSources ?? []).map((source) => source._id)).size;
const ready = (manifest.hulls ?? []).filter((entry) => entry.role !== "blank").length;
const blanks = (manifest.hulls ?? []).length - ready;
console.log(
  `install-catalogue: ${WAVE} valid — ${manifest.hulls.length} hulls (${ready} ready, ${blanks} blank), ` +
  `${componentCount} component sources, all hulls materialize; default build stays '${DEFAULT_REFERENCE_BUILD_ID}'`,
);

if (CHECK_ONLY) process.exit(0);

// The wave carries two kinds of source: **designs** (what a shop lists, one per distinct part) and
// **installation copies** (one per hull that mounts the part, each with its own id so a mounted
// unit's readiness, faults and magazine never alias another ship's). Only designs become world
// Items; copies exist on the hull templates and are created fresh by a refit.
const installedIds = new Set((manifest.hulls ?? []).flatMap((entry) => (entry.sources ?? []).map((source) => source._id)));
const designByShape = new Map();
const designSources = [];
for (const source of manifest.componentSources ?? []) {
  const shape = `${source.system.componentClass}|${source.name}|${JSON.stringify(source.system.definition)}`;
  const current = designByShape.get(shape);
  if (!current) {
    designByShape.set(shape, source);
    designSources.push(source);
    continue;
  }
  // Prefer the member no hull installs: that is the blueprint the copies were made from.
  if (installedIds.has(current._id) && !installedIds.has(source._id)) {
    designByShape.set(shape, source);
    designSources[designSources.indexOf(current)] = source;
  }
}
const installationCopyIds = (manifest.componentSources ?? [])
  .filter((source) => !designSources.includes(source))
  .map((source) => source._id);

/** Wave ids become global names: `wave-2` -> `__viraInstallWave2` / `__viraRepairWave2`. */
const WAVE_SAFE = String(manifest.id ?? WAVE).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join("");
const INSTALL_GLOBAL = `__viraInstall${WAVE_SAFE}`;
const REPAIR_GLOBAL = `__viraRepair${WAVE_SAFE}`;

const payload = {
  wave: manifest.id ?? WAVE,
  label: manifest.label ?? WAVE,
  generatedFor: "world-only ship catalogue (custom hulls: not shipped, install nothing by default)",
  componentSources: designSources,
  installationCopyIds,
  hulls: manifest.hulls.map((entry) => ({
    role: entry.role ?? "ready",
    intent: entry.intent ?? "",
    config: entry.hull,
    sources: entry.sources,
    // `createInitialState` reads the *materialized* configuration (components attached), which is
    // how the module seeds shield pools and power; the actor still stores the authored `config`.
    materializedConfig: materializeShipConfig(entry.hull, entry.sources),
  })),
};

const script = `// Generated by tools/world/install-catalogue.js — do not edit by hand.
// ${payload.label}
//
// Run inside the Foundry client (GM), then:
//   await __viraInstallWave1(false)   // dry run
//   await __viraInstallWave1(true)    // apply (idempotent)
globalThis.${INSTALL_GLOBAL} = async function (apply) {
  const PAYLOAD = ${JSON.stringify(payload)};
  const MODULE_ID = "vira-shipcombat";
  const FLAGS = { [\`\${MODULE_ID}InternalUpdate\`]: true, [\`\${MODULE_ID}Initialization\`]: true };
  const report = { mode: apply ? "APPLY" : "DRY RUN", wave: PAYLOAD.wave, components: { created: 0, existing: 0 }, hulls: [], folders: [] };
  const api = game.modules.get(MODULE_ID)?.api;
  if (!api?.createInitialState) throw new Error("vira-shipcombat API unavailable — is the module active?");

  const ensureFolder = async (name, type) => {
    const found = game.folders.find((folder) => folder.type === type && folder.name === name);
    if (found) return found;
    report.folders.push(\`create \${type} folder "\${name}"\`);
    return apply ? Folder.create({ name, type }) : null;
  };
  const partFolder = await ensureFolder("Ship Parts", "Item");
  const shipFolder = await ensureFolder("Ships", "Actor");

  for (const source of PAYLOAD.componentSources) {
    if (game.items.get(source._id)) { report.components.existing += 1; continue; }
    report.components.created += 1;
    if (apply) {
      // A document's folder is data, not a create option.
      const data = partFolder ? { ...source, folder: partFolder.id } : source;
      const created = await Item.create(data, { keepId: true });
      if (!created) throw new Error(\`failed to create component \${source._id} (\${source.name})\`);
    }
  }

  for (const entry of PAYLOAD.hulls) {
    const id = entry.config.id;
    const row = { id, label: entry.config.label, role: entry.role, intent: entry.intent, action: "create", installed: entry.sources.length };
    const existing = game.actors.find((actor) => actor.getFlag(MODULE_ID, "catalogue")?.hullId === id);
    if (existing) { row.action = "exists"; report.hulls.push(row); continue; }
    // The dry run proves the payload against the live module API: a hull the client cannot build a
    // fresh state for would fail here rather than halfway through a create.
    try {
      const probe = api.createInitialState(entry.materializedConfig ?? entry.config);
      const shields = probe?.shields ?? {};
      const pools = Object.keys(shields.hp ?? {}).length;
      row.stateOk = pools > 0 || (entry.sources ?? []).every((source) => source.system.componentClass !== "shield");
      row.shieldPools = pools;
    } catch (error) {
      row.stateOk = false;
      row.stateError = error.message;
    }
    report.hulls.push(row);
    if (!apply) continue;
    const state = api.createInitialState(entry.materializedConfig ?? entry.config);
    const actor = await Actor.create({
      name: entry.config.label,
      type: "vira-shipcombat.ship",
      folder: shipFolder?.id,
      flags: { [MODULE_ID]: { catalogue: { wave: PAYLOAD.wave, hullId: id, role: entry.role } } },
      system: { shipCombat: { schemaVersion: 2, config: entry.config, state } },
    });
    if (!actor) throw new Error(\`failed to create hull template \${id}\`);
    for (const source of entry.sources) {
      const installed = await actor.createEmbeddedDocuments("Item", [source], { keepId: true, ...FLAGS });
      if (!installed?.length) throw new Error(\`failed to install \${source._id} on \${id}\`);
    }
    const ship = actor.system.shipCombat;
    const shieldPools = Object.keys(ship.state.shields?.hp ?? {}).length;
    if (entry.sources.some((source) => source.system.componentClass === "shield") && shieldPools === 0) {
      throw new Error(\`\${id}: the seeded state has no shield pool — the hull would fail to render\`);
    }
    if (entry.role === "ready") {
      // "Ready to go" means guns hot: point every installed weapon at the power the hull reserved.
      const updates = {};
      for (const item of actor.items) {
        if (item.system?.componentClass !== "weapon") continue;
        const weapon = ship.state.weapons?.[item.id];
        if (!weapon) continue;
        updates[\`system.shipCombat.state.weapons.\${item.id}.status\`] = "online";
        updates[\`system.shipCombat.state.weapons.\${item.id}.mode\`] = "nominal";
      }
      if (Object.keys(updates).length) await actor.update(updates);
    }
  }
  return report;
};

// Repair / update mode for content that already exists in the world.
//   await __viraRepairWave1(false)   // dry run — lists every change
//   await __viraRepairWave1(true)    // apply
// It (a) fills a shield block that shipped empty on a catalogue hull, (b) files every catalogue
// component into the "Ship Parts" folder, and (c) syncs an existing component's definition to the
// wave's copy. It never rewrites a hull config on a live ship and never touches non-catalogue
// documents.
globalThis.${REPAIR_GLOBAL} = async function (apply) {
  const PAYLOAD = ${JSON.stringify(payload)};
  const MODULE_ID = "vira-shipcombat";
  const report = { mode: apply ? "APPLY" : "DRY RUN", shields: [], folders: [], definitions: [], retired: [] };
  const api = game.modules.get(MODULE_ID)?.api;
  if (!api?.createInitialState) throw new Error("vira-shipcombat API unavailable — is the module active?");
  const partFolder = game.folders.find((folder) => folder.type === "Item" && folder.name === "Ship Parts") ?? null;
  const sourceIds = new Set(PAYLOAD.componentSources.map((source) => source._id));

  for (const entry of PAYLOAD.hulls) {
    const actor = game.actors.find((candidate) => candidate.getFlag(MODULE_ID, "catalogue")?.hullId === entry.config.id);
    if (!actor) continue;
    const state = actor.system?.shipCombat?.state ?? {};
    const ship = actor.system?.shipCombat ?? {};
    const config = ship.config ?? entry.config;
    const fresh = api.createInitialState(entry.materializedConfig ?? config);
    const pristine =
      Object.keys(state.tracks ?? {}).length === 0 &&
      Object.keys(state.conditions ?? {}).length === 0 &&
      Number(state.timeline ?? 0) === 0 &&
      Number(state.rotationSpent ?? 0) === 0 &&
      Number(state.pivotSpent ?? 0) === 0 &&
      Number(state.heat ?? 0) === 0 &&
      (state.hull == null || Number(state.hull) === Number(config.maxHull));
    if (pristine) {
      // Nothing has happened to this template yet: adopt the freshly seeded state wholesale —
      // unless it already matches, so re-running the repair stays a true no-op.
      if (JSON.stringify(state) === JSON.stringify(fresh)) continue;
      report.shields.push({ actor: actor.name, action: "reseed state", pools: Object.keys(fresh?.shields?.hp ?? {}).length });
      if (apply) await actor.update({ "system.shipCombat.state": structuredClone(fresh) });
      continue;
    }
    const hasShield = (entry.sources ?? []).some((source) => source.system.componentClass === "shield");
    const pools = Object.keys(state?.shields?.hp ?? {}).length;
    const powerZero = Object.values(state.power ?? {}).every((value) => Number(value ?? 0) === 0 || typeof value === "boolean");
    if (hasShield && pools === 0) {
      report.shields.push({ actor: actor.name, action: "fill shields", pools: Object.keys(fresh?.shields?.hp ?? {}).length });
      if (apply) await actor.update({ "system.shipCombat.state.shields": structuredClone(fresh.shields) });
    }
    if (powerZero && Object.values(fresh.power ?? {}).some((value) => Number(value ?? 0) > 0)) {
      report.shields.push({ actor: actor.name, action: "restore power commit" });
      if (apply) await actor.update({ "system.shipCombat.state.power": structuredClone(fresh.power) });
    }
  }

  // Retire installation copies that were published as shop items: the hulls carry their own, and a
  // refit makes a fresh copy from the design.
  for (const id of PAYLOAD.installationCopyIds ?? []) {
    const item = game.items.get(id);
    if (!item) continue;
    report.retired.push({ item: item.name, id, action: "retire shop copy" });
    if (apply) await item.delete();
  }

  for (const source of PAYLOAD.componentSources) {
    const item = game.items.get(source._id);
    if (!item) { report.definitions.push({ id: source._id, action: "missing" }); continue; }
    if (partFolder && item.folder?.id !== partFolder.id) {
      report.folders.push({ item: item.name, id: item.id, action: "move to Ship Parts" });
      if (apply) await item.update({ folder: partFolder.id });
    }
    const current = JSON.stringify(item.system?.definition ?? null);
    const wanted = JSON.stringify(source.system?.definition ?? null);
    const nameMismatch = item.name !== source.name;
    if (current !== wanted || nameMismatch) {
      report.definitions.push({ item: item.name, id: item.id, action: nameMismatch ? ("sync definition & rename to " + source.name) : "sync definition" });
      if (apply) await item.update({ name: source.name, "system.definition": structuredClone(source.system.definition) });
    }
  }
  // A mounted component keeps its own copy: a tweak to a design must reach the ships too.
  const byId = new Map(PAYLOAD.componentSources.map((source) => [source._id, source]));
  for (const entry of PAYLOAD.hulls) {
    const actor = game.actors.find((candidate) => candidate.getFlag(MODULE_ID, "catalogue")?.hullId === entry.config.id);
    if (!actor) continue;
    for (const source of entry.sources ?? []) {
      const item = actor.items.get(source._id);
      if (!item) continue;
      const current = JSON.stringify(item.system?.definition ?? null);
      const wanted = JSON.stringify(source.system?.definition ?? null);
      const nameMismatch = item.name !== source.name;
      if (current === wanted && !nameMismatch) continue;
      report.definitions.push({ actor: actor.name, item: item.name, id: item.id, action: nameMismatch ? ("sync mounted copy & rename to " + source.name) : "sync mounted copy" });
      if (apply) await item.update({ name: source.name, "system.definition": structuredClone(source.system.definition) }, { [\`\${MODULE_ID}InternalUpdate\`]: true, [\`\${MODULE_ID}Initialization\`]: true });
    }
    void byId;
  }

  return report;
};
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, script);
console.log(`install-catalogue: wrote ${OUT}`);
console.log(`next: run it in the GM client — await ${INSTALL_GLOBAL}(false) then (true)`);
console.log(`repair/update an existing install with: await ${REPAIR_GLOBAL}(false) then (true)`);
