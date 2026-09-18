import { describe, expect, test } from "bun:test";

import {
  autoScale,
  bearingRelDegrees,
  clampScale,
  designatorFor,
  designatorLabel,
  dialPercent,
  dialFromBearing,
  dialPoint,
  formatRange,
  projectContact,
  radarPercentStyle,
  relativeVector,
  ringValues,
  screenOffset,
} from "../scripts/foundry/radar-geometry.js";

const north = { x: 0, y: -10 };
const origin = { x: 0, y: 0 };

describe("radar dial orientation", () => {
  test("keeps FORE up for a ship facing north", () => {
    const contact = projectContact({
      position: { x: 0, y: -10 },
      origin,
      facingDeg: 0,
      scale: 20,
    });

    expect(contact.bearingRel).toBeCloseTo(0, 6);
    expect(contact.u).toBeCloseTo(0, 6);
    expect(contact.v).toBeCloseTo(-0.5, 6);
  });

  test("rotates the plane so the bow, not scene north, is up", () => {
    // Own ship faces east: a contact to the east is dead ahead, a contact to
    // the north is off the port beam.
    const ahead = projectContact({
      position: { x: 10, y: 0 },
      origin,
      facingDeg: 90,
      scale: 20,
    });
    const port = projectContact({
      position: { x: 0, y: -10 },
      origin,
      facingDeg: 90,
      scale: 20,
    });

    expect(ahead.bearingRel).toBeCloseTo(0, 6);
    expect(ahead.v).toBeCloseTo(-0.5, 6);
    expect(port.bearingRel).toBeCloseTo(-90, 6);
    expect(port.u).toBeCloseTo(-0.5, 6);
  });

  test("measures bearing clockwise from FORE into [-180, 180)", () => {
    expect(bearingRelDegrees(0, -1)).toBeCloseTo(0, 6);
    expect(bearingRelDegrees(1, 0)).toBeCloseTo(90, 6);
    expect(bearingRelDegrees(0, 1)).toBe(-180);
    expect(bearingRelDegrees(-1, 0)).toBeCloseTo(-90, 6);
  });

  test("rotates a delta without changing its length", () => {
    const offset = screenOffset(3, 4, 37);

    expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(5, 6);
  });
});

describe("radar dial scaling", () => {
  test("spaces contacts proportionally to distance instead of bunching them", () => {
    const near = projectContact({ position: { x: 0, y: -5 }, origin, scale: 50 });
    const far = projectContact({ position: { x: 0, y: -40 }, origin, scale: 50 });

    expect(near.v).toBeCloseTo(-0.1, 6);
    expect(far.v).toBeCloseTo(-0.8, 6);
  });

  test("hoists a contact beyond the displayed range onto its true bearing", () => {
    const contact = projectContact({ position: { x: 0, y: -400 }, origin, scale: 50 });

    expect(contact.hoisted).toBe(true);
    expect(contact.distance).toBeCloseTo(400, 6);
    expect(Math.hypot(contact.u, contact.v)).toBeCloseTo(1, 6);
    expect(contact.v).toBeCloseTo(-1, 6);
  });

  test("plots the same point from range and bearing as from a world position", () => {
    const position = { x: 12, y: -9 };
    const facingDeg = 63;
    const scale = 40;
    const projected = projectContact({ position, origin, facingDeg, scale });
    const polar = dialFromBearing(projected.distance, projected.bearingRel, scale);

    expect(polar.u).toBeCloseTo(projected.u, 9);
    expect(polar.v).toBeCloseTo(projected.v, 9);
    expect(polar.hoisted).toBe(false);
  });

  test("reports a contact that has no known position", () => {
    const contact = projectContact({ position: null, origin, scale: 50 });

    expect(contact.unknown).toBe(true);
    expect(contact.u).toBe(0);
    expect(contact.v).toBe(0);
  });

  test("auto-fits the furthest shown contact inside the rim", () => {
    expect(autoScale([3, 12, 7], { maximum: 150 })).toBeCloseTo(13.8, 6);
    expect(autoScale([3, 12, 7], { maximum: 10 })).toBe(10);
    expect(autoScale([1], { minimum: 5, maximum: 150 })).toBe(5);
    expect(autoScale([], { minimum: 5, maximum: 150 })).toBe(5);
    expect(autoScale([900], { minimum: 5, maximum: 150 })).toBe(150);
  });

  test("clamps a manual scale into the dial ladder", () => {
    expect(clampScale(1, { minimum: 5, maximum: 150 })).toBe(5);
    expect(clampScale(25, { minimum: 5, maximum: 150 })).toBe(25);
    expect(clampScale(400, { minimum: 5, maximum: 150 })).toBe(150);
  });

  test("labels rings on the displayed scale", () => {
    expect(ringValues(25)).toEqual([5, 10, 15, 20, 25]);
    expect(formatRange(7.5)).toBe("7.5");
    expect(formatRange(150)).toBe("150");
  });

  test("places DOM hit targets on the same dial point as the canvas", () => {
    const point = dialPoint(relativeVector({ position: north, origin }), 20);

    expect(dialPercent(point.u, point.v)).toEqual({ x: 50, y: 25 });
    expect(radarPercentStyle(point.u, point.v)).toBe("--contact-x:50.00%;--contact-y:25.00%");
  });
});

describe("contact designators", () => {
  test("keeps a contact's designator for the whole fight", () => {
    const uuid = "Scene.scene.Token.abcdef123456";

    expect(designatorFor(uuid)).toBe(designatorFor(uuid));
    expect(designatorLabel(designatorFor(uuid))).toBe(`CONTACT-${designatorFor(uuid)}`);
  });

  test("gives colliding contacts distinct designators", () => {
    const uuids = Array.from({ length: 24 }, (_, index) => `Scene.s.Token.${index}`);
    const used = [];
    const assigned = uuids.map((uuid) => {
      const designator = designatorFor(uuid, used);
      used.push(designator);
      return designator;
    });

    expect(new Set(assigned).size).toBe(uuids.length);
    expect(assigned.every(Boolean)).toBe(true);
  });

  test("does not depend on the order contacts arrive in", () => {
    const uuids = ["Scene.s.Token.aaa", "Scene.s.Token.bbb", "Scene.s.Token.ccc"];

    const assign = (order) => {
      const used = [];
      const result = new Map();
      for (const uuid of order) {
        const designator = designatorFor(uuid, used);
        used.push(designator);
        result.set(uuid, designator);
      }
      return result;
    };
    const forward = assign(uuids);
    const backward = assign([...uuids].reverse());

    expect(forward).toEqual(backward);
  });
});
