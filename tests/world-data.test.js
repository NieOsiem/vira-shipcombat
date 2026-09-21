import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REFERENCE_BUILDS } from "../scripts/data/reference-builds.js";
import { CANADENSIS_COMPONENT_SOURCES } from "../scripts/data/canadensis-components.js";
import { PEREGRINUS_COMPONENT_SOURCES } from "../scripts/data/peregrinus-components.js";
import { materializeShipConfig } from "../scripts/model/equipment.js";

/**
 * The world-only catalogue lives in `world-data/**` and is never shipped, but a malformed entry can
 * only fail at install time, on a live world — exactly how a 17-character document id slipped
 * through once. These checks run the same materialization the module runs, so a broken hull is
 * caught here instead of mid-session.
 *
 * The suite stays green while the catalogue is being authored: a wave that cannot even be imported
 * is warned about and skipped, and `bun tools/world/install-catalogue.js --check` remains the loud
 * gate before anything is installed.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WAVE_FILES = ["wave-1", "wave-2"];

const DOC_ID = /^[A-Za-z0-9]{16}$/;
// A hull id is a data slug (like `canadensis-training-corvette`), not a Foundry document id: it is
// used as a flag value and a label, never as an `_id`. Components below DO carry document ids.
const HULL_ID = /^[a-z0-9][a-z0-9-]*$/;

async function loadWave(name) {
  const path = join(REPO, "world-data/waves", `${name}.js`);
  if (!existsSync(path)) return { wave: null, missing: true };
  try {
    const module = await import(pathToFileURL(path).href);
    const isWave = (value) => Boolean(value) && typeof value === "object" && Array.isArray(value.hulls) && Array.isArray(value.componentSources);
    return { wave: [module.default, ...Object.values(module)].find(isWave) ?? null };
  } catch (error) {
    console.warn(`world-data: ${name} could not be imported (${error.message}) — catalogue checks skipped`);
    return { wave: null, missing: true };
  }
}

describe("world-only ship catalogue", () => {
  for (const name of WAVE_FILES) {
    test(`${name} hulls are installable, unique and schema-current`, async () => {
      const { wave, missing } = await loadWave(name);
      if (missing) return; // nothing authored yet — install-catalogue.js --check is the loud gate

      const bundledComponentIds = new Set(
        [...CANADENSIS_COMPONENT_SOURCES, ...PEREGRINUS_COMPONENT_SOURCES].map((source) => source._id),
      );
      const bundledHullIds = new Set(REFERENCE_BUILDS.map((build) => build.id));
      const seen = new Set();

      for (const source of wave.componentSources ?? []) {
        expect(String(source._id)).toMatch(DOC_ID);
        expect(seen.has(source._id)).toBe(false);
        expect(bundledComponentIds.has(source._id)).toBe(false);
        seen.add(source._id);
      }

      const hullIds = new Set();
      for (const entry of wave.hulls ?? []) {
        const hull = entry.hull;
        expect(String(hull.id)).toMatch(HULL_ID);
        expect(hullIds.has(hull.id)).toBe(false);
        hullIds.add(hull.id);
        // A catalogue hull must stay a custom hull: shipped nowhere, installs nothing by itself.
        expect(bundledHullIds.has(hull.id)).toBe(false);
        expect(hull.schemaVersion).toBe(2);

        // Every installed id is one the hull itself supplies, and the engine accepts the pair.
        for (const source of entry.sources ?? []) expect(String(source._id)).toMatch(DOC_ID);
        expect(() => materializeShipConfig(hull, entry.sources ?? [])).not.toThrow();
      }
    });
  }
});
