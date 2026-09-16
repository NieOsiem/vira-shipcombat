function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Return the canvas conversion for ship-combat Distance Units. One DU is one grid interval. */
export function sceneGridGeometry(scene, canvas = globalThis.canvas) {
  const gridSize = positiveNumber(scene?.grid?.size)
    ?? positiveNumber(scene?.dimensions?.size)
    ?? positiveNumber(canvas?.scene === scene ? canvas?.dimensions?.size : null)
    ?? positiveNumber(canvas?.grid?.size)
    ?? 100;
  return { gridSize, unitsPerPixel: 1 / gridSize, pixelsPerUnit: gridSize };
}
