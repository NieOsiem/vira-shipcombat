import { describe, expect, test } from "bun:test";

import { sceneGridGeometry } from "../scripts/foundry/scene-geometry.js";

describe("ship-combat Distance Unit geometry", () => {
  test("maps one DU to one grid interval regardless of the scene distance label", () => {
    const fiveFootGrid = sceneGridGeometry({ grid: { size: 100, distance: 5 } }, {});
    const tenMileGrid = sceneGridGeometry({ grid: { size: 100, distance: 10 } }, {});

    expect(fiveFootGrid).toEqual({ gridSize: 100, unitsPerPixel: 0.01, pixelsPerUnit: 100 });
    expect(tenMileGrid).toEqual(fiveFootGrid);
  });

  test("uses the scene grid size before active-canvas fallbacks", () => {
    const scene = { grid: { size: 80, distance: 5 } };
    const canvas = { scene: {}, dimensions: { size: 120 }, grid: { size: 140 } };

    expect(sceneGridGeometry(scene, canvas)).toEqual({
      gridSize: 80,
      unitsPerPixel: 0.0125,
      pixelsPerUnit: 80,
    });
  });
});
