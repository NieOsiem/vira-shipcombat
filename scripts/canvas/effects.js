import { SHIP_TYPE } from "../constants.js";
import { materializeActorConfig } from "../foundry/refit.js";
import { sceneGridGeometry } from "../foundry/scene-geometry.js";

const MODULE_ID = "vira-shipcombat";

/**
 * Projectile travel speed in scene-pixels per millisecond, indexed by projectileClass.
 * Kept consistent as requested by user.
 */
const PROJECTILE_SPEEDS = Object.freeze({
  instant: 6.0,
  fast: 2.0,
  medium: 1.2,
  slow: 0.7,
  veryslow: 0.4,
});

const MIN_TRAVEL_MS = 90;
const MAX_TRAVEL_MS = 3000;
const MISS_OVERSHOOT = 250;
const IMPACT_MS = 450;
const BARRAGE_STAGGER_MS = 75;
const BEAM_DURATION_MS = 280;

// Active visual effect collections
const activeProjectiles = [];
const activeBeams = [];
const activeMuzzleFlashes = [];
const activeImpacts = [];
const activeShieldPulses = [];
const activeParticles = [];

let effectContainer = null;
let effectGraphics = null;
let tickerRef = null;

function gridSize() {
  return sceneGridGeometry(globalThis.canvas?.scene).gridSize;
}

function useModernGraphics(g) {
  return typeof g?.stroke === "function";
}

/**
 * Parse a hex color string, guaranteeing a bright visible fallback.
 * Pure black (#000000) falls back to prevent invisible projectiles in space.
 */
function parseColor(hex, fallback) {
  if (typeof hex !== "string") return fallback;
  const clean = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(clean)) {
    const val = parseInt(clean.slice(1), 16);
    return val === 0 ? fallback : val;
  }
  if (/^#[0-9a-f]{3}$/i.test(clean)) {
    const r = clean[1], g = clean[2], b = clean[3];
    const val = parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
    return val === 0 ? fallback : val;
  }
  return fallback;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function tokenCenter(token) {
  if (!token) return null;
  const x = Number(token.x ?? 0) + Number(token.w ?? 0) / 2;
  const y = Number(token.y ?? 0) + Number(token.h ?? token.w ?? 0) / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function missPoint(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: to.x + MISS_OVERSHOOT, y: to.y };
  const ux = dx / dist;
  const uy = dy / dist;
  // Angular offset so the miss visibly whizzes past
  const angle = (Math.random() - 0.5) * 0.22;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: to.x + (ux * cos - uy * sin) * MISS_OVERSHOOT,
    y: to.y + (ux * sin + uy * cos) * MISS_OVERSHOOT,
  };
}

function travelDuration(from, to, projectileClass) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const key = String(projectileClass ?? "medium").toLowerCase().replace(/[^a-z]/g, "");
  const speed = PROJECTILE_SPEEDS[key] ?? PROJECTILE_SPEEDS.medium;
  return Math.max(MIN_TRAVEL_MS, Math.min(MAX_TRAVEL_MS, dist / speed));
}

function resolveWeaponConfig(sourceUuid, weaponId) {
  try {
    const token = globalThis.fromUuidSync?.(sourceUuid);
    const actor = token?.actor ?? token;
    if (!actor || actor.type !== SHIP_TYPE) return null;
    const config = materializeActorConfig(actor);
    const weapons = config?.components?.weapons;
    if (!Array.isArray(weapons)) return null;
    return weapons.find((w) => w.id === weaponId) ?? null;
  } catch {
    return null;
  }
}

function resolveTokenInfo(uuid) {
  try {
    const doc = globalThis.fromUuidSync?.(uuid);
    const token = doc?.object ?? doc?._object;
    if (!token) return null;
    const center = tokenCenter(token);
    if (!center) return null;
    const w = Number(token.w ?? 0);
    const h = Number(token.h ?? token.w ?? 0);
    const radius = Math.max(16, (Math.hypot(w, h) / 2) * 0.7);
    return { token, center, w, h, radius, rotation: Number(token.document?.rotation ?? 0) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Universal PIXI Drawing Primitives
// ---------------------------------------------------------------------------

function drawLine(g, from, to, { color, width, alpha, cap = "round" }) {
  if (width <= 0 || alpha <= 0) return;
  if (useModernGraphics(g)) {
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke({ color, width, alpha, cap });
  } else {
    g.lineStyle(width, color, alpha);
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
  }
}

function drawFilledCircle(g, point, radius, color, alpha) {
  if (radius <= 0 || alpha <= 0) return;
  if (useModernGraphics(g)) {
    g.circle(point.x, point.y, radius);
    g.fill({ color, alpha });
  } else {
    g.beginFill(color, alpha);
    g.drawCircle(point.x, point.y, radius);
    g.endFill();
  }
}

function drawCircleRing(g, point, radius, width, color, alpha) {
  if (radius <= 0 || width <= 0 || alpha <= 0) return;
  if (useModernGraphics(g)) {
    g.circle(point.x, point.y, radius);
    g.stroke({ color, width, alpha });
  } else {
    g.lineStyle(width, color, alpha);
    g.drawCircle(point.x, point.y, radius);
  }
}

function drawStar(g, center, innerR, outerR, points, color, alpha) {
  if (outerR <= 0 || alpha <= 0) return;
  const step = Math.PI / points;
  const pts = [];
  for (let i = 0; i < 2 * points; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = i * step - Math.PI / 2;
    pts.push(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r);
  }
  if (useModernGraphics(g)) {
    g.poly(pts);
    g.fill({ color, alpha });
  } else {
    g.beginFill(color, alpha);
    g.drawPolygon(pts);
    g.endFill();
  }
}

function strokeArc(g, center, radius, start, end, { color, width, alpha }) {
  if (radius <= 0 || width <= 0 || alpha <= 0) return;
  const startPoint = {
    x: center.x + Math.cos(start) * radius,
    y: center.y + Math.sin(start) * radius,
  };
  if (useModernGraphics(g)) {
    g.moveTo(startPoint.x, startPoint.y);
    g.arc(center.x, center.y, radius, start, end);
    g.stroke({ color, width, alpha, cap: "butt" });
  } else {
    g.lineStyle(width, color, alpha);
    g.moveTo(startPoint.x, startPoint.y);
    g.arc(center.x, center.y, radius, start, end);
  }
}

// ---------------------------------------------------------------------------
// Particle System (Sparks, Debris, Embers, Smoke)
// ---------------------------------------------------------------------------

function spawnParticle({ x, y, vx, vy, size, color, alpha = 1, decay = 0.025, drag = 0.96, shape = "circle" }) {
  if (activeParticles.length > 350) activeParticles.shift();
  activeParticles.push({ x, y, prevX: x, prevY: y, vx, vy, size, color, alpha, decay, drag, shape });
}

function updateAndDrawParticles(g, scale) {
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.prevX = p.x;
    p.prevY = p.y;
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= p.drag;
    p.vy *= p.drag;
    p.alpha -= p.decay;

    if (p.alpha <= 0) {
      activeParticles.splice(i, 1);
      continue;
    }

    if (p.shape === "spark") {
      // High-speed spark streak from prev position
      drawLine(g, { x: p.prevX, y: p.prevY }, { x: p.x, y: p.y }, {
        color: p.color,
        width: p.size * scale,
        alpha: p.alpha,
      });
    } else {
      drawFilledCircle(g, p, p.size * scale, p.color, p.alpha);
    }
  }
}

// ---------------------------------------------------------------------------
// Muzzle Flash System
// ---------------------------------------------------------------------------

function spawnMuzzleFlash(pos, dir, coreColor, glowColor, style, scale) {
  activeMuzzleFlashes.push({
    x: pos.x,
    y: pos.y,
    nx: dir.x,
    ny: dir.y,
    coreColor,
    glowColor,
    style,
    start: performance.now(),
    duration: 130,
    scale,
  });

  // Spawn 5-8 directional sparks from muzzle
  const count = 6;
  const baseAngle = Math.atan2(dir.y, dir.x);
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + (Math.random() - 0.5) * 0.9;
    const speed = (3 + Math.random() * 7) * scale;
    spawnParticle({
      x: pos.x,
      y: pos.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: (1.5 + Math.random() * 2) * scale,
      color: Math.random() > 0.4 ? coreColor : 0xffffff,
      alpha: 0.9,
      decay: 0.05 + Math.random() * 0.03,
      drag: 0.92,
      shape: "spark",
    });
  }
}

function updateAndDrawMuzzleFlashes(g, now) {
  for (let i = activeMuzzleFlashes.length - 1; i >= 0; i--) {
    const f = activeMuzzleFlashes[i];
    const elapsed = now - f.start;
    if (elapsed >= f.duration) {
      activeMuzzleFlashes.splice(i, 1);
      continue;
    }

    const p = elapsed / f.duration;
    const alpha = (1 - p);
    const s = f.scale;

    // Expanding flash ring
    const ringRadius = (8 + p * 20) * s;
    drawCircleRing(g, f, ringRadius, (4 - p * 3) * s, f.glowColor, alpha * 0.7);

    // 4-Point lens flare starburst
    const starR = (16 + p * 12) * s;
    drawStar(g, f, 3 * s, starR, 4, 0xffffff, alpha * 0.9);
    drawStar(g, f, 5 * s, starR * 1.5, 4, f.coreColor, alpha * 0.5);

    // Bright nucleus
    drawFilledCircle(g, f, (7 - p * 4) * s, f.coreColor, alpha);
    drawFilledCircle(g, f, (4 - p * 3) * s, 0xffffff, alpha);
  }
}

// ---------------------------------------------------------------------------
// Visual Style Renderers — Multi-Layered, Punchy, Over-The-Top Projectiles
// ---------------------------------------------------------------------------

const STYLE_RENDERERS = {
  /** Heavy Kinetic Round — Chunky illuminated slug, blinding nose, wake sparks. */
  bullet(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.15));

    // Outer atmospheric glow
    drawLine(g, tail, head, { color: glow, width: 18 * s, alpha: 0.35 });
    // Core body
    drawLine(g, tail, head, { color: core, width: 8 * s, alpha: 0.95 });
    // White-hot spine
    drawLine(g, tail, head, { color: 0xffffff, width: 2.5 * s, alpha: 0.9 });

    // Round glowing penetrator nose
    drawFilledCircle(g, head, 12 * s, glow, 0.3);
    drawFilledCircle(g, head, 7 * s, core, 0.9);
    drawFilledCircle(g, head, 4 * s, 0xffffff, 1.0);

    // Trailing smoke / spark motes
    if (Math.random() < 0.6) {
      spawnParticle({
        x: tail.x + (Math.random() - 0.5) * 6 * s,
        y: tail.y + (Math.random() - 0.5) * 6 * s,
        vx: (Math.random() - 0.5) * 1.5 * s,
        vy: (Math.random() - 0.5) * 1.5 * s,
        size: (1.5 + Math.random() * 2) * s,
        color: Math.random() > 0.4 ? glow : core,
        alpha: 0.7,
        decay: 0.045,
        drag: 0.95,
      });
    }
  },

  /** Continuous Searing Beam — Layered plasma lance, pulsing width, boiling target point. */
  laser(g, from, to, t, core, glow, s) {
    // Laser is rendered via activeBeams, this handles projectile fallback
    drawLine(g, from, to, { color: glow, width: 28 * s, alpha: 0.3 });
    drawLine(g, from, to, { color: core, width: 12 * s, alpha: 0.8 });
    drawLine(g, from, to, { color: 0xffffff, width: 3.5 * s, alpha: 1.0 });
  },

  /** Plasma Bolt — Teardrop plasma capsule with saturated glow and tail embers. */
  blaster(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.18));

    // Outer plasma corona
    drawLine(g, tail, head, { color: glow, width: 22 * s, alpha: 0.35 });
    // Saturated mantle
    drawLine(g, tail, head, { color: core, width: 10 * s, alpha: 0.9 });
    // Incandescent center
    drawLine(g, tail, head, { color: 0xffffff, width: 3.5 * s, alpha: 1.0 });

    // Rounded glowing head
    drawFilledCircle(g, head, 14 * s, glow, 0.35);
    drawFilledCircle(g, head, 8 * s, core, 0.9);
    drawFilledCircle(g, head, 4.5 * s, 0xffffff, 1.0);

    // Trailing plasma ember
    if (Math.random() < 0.5) {
      spawnParticle({
        x: tail.x + (Math.random() - 0.5) * 4 * s,
        y: tail.y + (Math.random() - 0.5) * 4 * s,
        vx: (Math.random() - 0.5) * 1.2 * s,
        vy: (Math.random() - 0.5) * 1.2 * s,
        size: (2 + Math.random() * 2) * s,
        color: core,
        alpha: 0.8,
        decay: 0.05,
        drag: 0.94,
      });
    }
  },

  /** Antimatter Orb — Pulsing multi-sphere with spinning orbital energy rings. */
  orb(g, from, to, t, core, glow, s) {
    const pos = lerpPoint(from, to, t);
    const now = performance.now();
    const pulse = 1 + Math.sin(now * 0.015) * 0.2;
    const r = 16 * s * pulse;

    // Outer nebula aura
    drawFilledCircle(g, pos, r * 2.2, glow, 0.15);
    drawFilledCircle(g, pos, r * 1.4, glow, 0.4);
    // Core energy ball
    drawFilledCircle(g, pos, r * 0.9, core, 0.75);
    // Brilliant nucleus
    drawFilledCircle(g, pos, r * 0.4, 0xffffff, 1.0);

    // Rotating orbital energy rings
    const rot = now * 0.008;
    for (let orbit = 0; orbit < 2; orbit++) {
      const a = rot + orbit * Math.PI * 0.5;
      const rx = Math.cos(a) * r * 1.5;
      const ry = Math.sin(a) * r * 0.6;
      drawCircleRing(g, { x: pos.x + rx, y: pos.y + ry }, 4 * s, 2 * s, 0xffffff, 0.8);
      drawCircleRing(g, pos, r * 1.3, (1.5 * s), glow, 0.4);
    }

    // Trailing mini-orb motes
    if (Math.random() < 0.4) {
      spawnParticle({
        x: pos.x + (Math.random() - 0.5) * 8 * s,
        y: pos.y + (Math.random() - 0.5) * 8 * s,
        vx: (Math.random() - 0.5) * 2 * s,
        vy: (Math.random() - 0.5) * 2 * s,
        size: (2.5 + Math.random() * 2.5) * s,
        color: glow,
        alpha: 0.7,
        decay: 0.04,
        drag: 0.93,
      });
    }
  },

  /** Hypersonic Railgun — Needle-thin searing core, expanding Mach rings, lightning arcs. */
  railgun(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tailLong = lerpPoint(from, to, Math.max(0, t - 0.35));
    const tailMid = lerpPoint(from, to, Math.max(0, t - 0.18));

    // Ionization wake
    drawLine(g, tailLong, head, { color: glow, width: 24 * s, alpha: 0.25 });
    drawLine(g, tailMid, head, { color: core, width: 10 * s, alpha: 0.85 });
    // Razor-sharp white filament
    drawLine(g, tailLong, head, { color: 0xffffff, width: 2.5 * s, alpha: 1.0 });

    // Needle-sharp tip with lens flare
    drawFilledCircle(g, head, 6 * s, 0xffffff, 1.0);
    drawStar(g, head, 3 * s, 20 * s, 4, 0xffffff, 0.9);
    drawStar(g, head, 5 * s, 28 * s, 4, glow, 0.45);

    // Expanding Mach induction rings along the trail
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const ringT = t - (i * 0.07);
      if (ringT > 0 && ringT < 1) {
        const ringPos = lerpPoint(from, to, ringT);
        const ringRadius = (6 + (t - ringT) * 120) * s;
        const ringAlpha = Math.max(0, (1 - (t - ringT) * 3.5)) * 0.6;
        drawCircleRing(g, ringPos, ringRadius, 2 * s, glow, ringAlpha);
      }
    }

    // Jagged electric branches off the trail
    if (Math.random() < 0.7) {
      const branchT = Math.max(0, t - Math.random() * 0.2);
      const bOrigin = lerpPoint(from, to, branchT);
      const perpAngle = Math.atan2(to.y - from.y, to.x - from.x) + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      const bLen = (12 + Math.random() * 18) * s;
      const bTarget = {
        x: bOrigin.x + Math.cos(perpAngle) * bLen + (Math.random() - 0.5) * 8 * s,
        y: bOrigin.y + Math.sin(perpAngle) * bLen + (Math.random() - 0.5) * 8 * s,
      };
      drawLine(g, bOrigin, bTarget, { color: 0xffffff, width: 1.5 * s, alpha: 0.85 });
    }
  },

  /** Oscillating Energy Stream — Twin intertwining helical ribbons around central beam. */
  energy(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.22));

    // Central glowing spine
    drawLine(g, tail, head, { color: glow, width: 16 * s, alpha: 0.35 });
    drawLine(g, tail, head, { color: core, width: 7 * s, alpha: 0.9 });
    drawLine(g, tail, head, { color: 0xffffff, width: 2 * s, alpha: 1.0 });

    // Twin oscillating sine-wave ribbons
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const perpX = -Math.sin(angle);
    const perpY = Math.cos(angle);
    const segCount = 8;
    const ribPts1 = [];
    const ribPts2 = [];

    for (let i = 0; i <= segCount; i++) {
      const segT = lerp(Math.max(0, t - 0.22), t, i / segCount);
      const basePt = lerpPoint(from, to, segT);
      const wave = Math.sin(segT * 35 + performance.now() * 0.02) * (11 * s);
      ribPts1.push({ x: basePt.x + perpX * wave, y: basePt.y + perpY * wave });
      ribPts2.push({ x: basePt.x - perpX * wave, y: basePt.y - perpY * wave });
    }

    for (let i = 1; i < ribPts1.length; i++) {
      drawLine(g, ribPts1[i - 1], ribPts1[i], { color: glow, width: 3 * s, alpha: 0.8 });
      drawLine(g, ribPts2[i - 1], ribPts2[i], { color: 0xffffff, width: 2 * s, alpha: 0.85 });
    }

    drawFilledCircle(g, head, 8 * s, core, 0.85);
    drawFilledCircle(g, head, 4 * s, 0xffffff, 1.0);
  },

  /** Thermonuclear Plasma Bolt — Wobbly boiling fireball with molten droplet wake. */
  plasma(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.16));
    const now = performance.now();

    // Multi-frequency organic radius wobble
    const wobble = Math.sin(now * 0.03) * 2 + Math.cos(now * 0.019) * 1.5;
    const r = (14 + wobble) * s;

    // Fiery mantle
    drawLine(g, tail, head, { color: glow, width: r * 2.4, alpha: 0.35 });
    drawLine(g, tail, head, { color: core, width: r * 1.4, alpha: 0.8 });
    drawFilledCircle(g, head, r * 1.6, glow, 0.35);
    drawFilledCircle(g, head, r * 1.0, core, 0.85);
    drawFilledCircle(g, head, r * 0.45, 0xffffff, 0.95);

    // Molten droplets spilling into vacuum
    if (Math.random() < 0.65) {
      spawnParticle({
        x: tail.x + (Math.random() - 0.5) * 8 * s,
        y: tail.y + (Math.random() - 0.5) * 8 * s,
        vx: (Math.random() - 0.5) * 2.5 * s,
        vy: (Math.random() - 0.5) * 2.5 * s,
        size: (2.5 + Math.random() * 3) * s,
        color: Math.random() > 0.5 ? glow : core,
        alpha: 0.85,
        decay: 0.04,
        drag: 0.92,
      });
    }
  },

  /** Heavy Titan Lance — Cataclysmic cutting beam, blinding starburst, heat shockwaves. */
  lance(g, from, to, t, core, glow, s) {
    // Lance is rendered via activeBeams, this handles projectile fallback
    drawLine(g, from, to, { color: glow, width: 44 * s, alpha: 0.35 });
    drawLine(g, from, to, { color: core, width: 18 * s, alpha: 0.85 });
    drawLine(g, from, to, { color: 0xffffff, width: 5 * s, alpha: 1.0 });
  },

  /** Canister Shrapnel Barrage — Grouped salvo of distinct tracers with smoke. */
  flak(g, from, to, t, core, glow, s) {
    const count = 8;
    const spread = 0.22;
    for (let i = 0; i < count; i++) {
      const angle = ((i / (count - 1)) - 0.5) * spread;
      const speedJitter = 1 + (((i * 17) % 7) - 3) * 0.04;
      const adjT = Math.min(1, t * speedJitter);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const target = {
        x: from.x + dx * cos - dy * sin,
        y: from.y + dx * sin + dy * cos,
      };

      const head = lerpPoint(from, target, adjT);
      const tail = lerpPoint(from, target, Math.max(0, adjT - 0.1));

      drawLine(g, tail, head, { color: glow, width: 9 * s, alpha: 0.45 });
      drawLine(g, tail, head, { color: core, width: 4 * s, alpha: 0.95 });
      drawFilledCircle(g, head, 4.5 * s, core, 0.9);
      drawFilledCircle(g, head, 2.5 * s, 0xffffff, 1.0);

      // Micro smoke motes
      if (Math.random() < 0.2) {
        spawnParticle({
          x: tail.x,
          y: tail.y,
          vx: (Math.random() - 0.5) * 1 * s,
          vy: (Math.random() - 0.5) * 1 * s,
          size: 1.5 * s,
          color: glow,
          alpha: 0.5,
          decay: 0.06,
          drag: 0.92,
        });
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Continuous Beam Weapons (Laser & Lance)
// ---------------------------------------------------------------------------

function spawnBeam(from, to, weapon, hit, critical, barrageIndex) {
  const coreColor = parseColor(weapon?.coreColor, 0xffffff);
  const glowColor = parseColor(weapon?.glowColor, 0x44ff88);
  const style = weapon?.visualStyle === "lance" ? "lance" : "laser";
  const duration = style === "lance" ? 340 : BEAM_DURATION_MS;
  const delay = (barrageIndex ?? 0) * (BARRAGE_STAGGER_MS * 1.5);
  const impactPoint = hit ? to : missPoint(from, to);

  activeBeams.push({
    from,
    to: impactPoint,
    coreColor,
    glowColor,
    style,
    hit,
    critical,
    start: performance.now() + delay,
    duration,
    muzzleFlashed: false,
    impactTriggered: false,
  });
}

function updateAndDrawBeams(g, now, scale) {
  for (let i = activeBeams.length - 1; i >= 0; i--) {
    const b = activeBeams[i];
    const elapsed = now - b.start;
    if (elapsed < 0) continue;

    if (!b.muzzleFlashed) {
      b.muzzleFlashed = true;
      const dx = b.to.x - b.from.x;
      const dy = b.to.y - b.from.y;
      const dist = Math.hypot(dx, dy);
      spawnMuzzleFlash(b.from, { x: dx / dist, y: dy / dist }, b.coreColor, b.glowColor, b.style, scale);
    }

    if (elapsed >= b.duration) {
      activeBeams.splice(i, 1);
      continue;
    }

    const p = elapsed / b.duration;
    // Fade out towards end
    const alpha = p < 0.65 ? 1 : (1 - (p - 0.65) / 0.35);
    const isLance = b.style === "lance";

    if (isLance) {
      // Massive titan lance beam
      drawLine(g, b.from, b.to, { color: b.glowColor, width: 54 * scale, alpha: alpha * 0.3 });
      drawLine(g, b.from, b.to, { color: b.glowColor, width: 30 * scale, alpha: alpha * 0.6 });
      drawLine(g, b.from, b.to, { color: b.coreColor, width: 14 * scale, alpha: alpha * 0.95 });
      drawLine(g, b.from, b.to, { color: 0xffffff, width: 4.5 * scale, alpha: alpha * 1.0 });

      // Lens flare stars at both ends
      drawStar(g, b.from, 5 * scale, 34 * scale, 8, 0xffffff, alpha);
      drawStar(g, b.from, 8 * scale, 50 * scale, 8, b.glowColor, alpha * 0.5);
      if (b.hit) {
        drawStar(g, b.to, 6 * scale, 42 * scale, 8, 0xffffff, alpha);
        drawStar(g, b.to, 10 * scale, 65 * scale, 8, b.glowColor, alpha * 0.6);
      }
    } else {
      // Coherent pulse laser beam with heat modulation
      const jitter = Math.sin(now * 0.04) * (2 * scale);
      drawLine(g, b.from, b.to, { color: b.glowColor, width: (30 * scale) + jitter, alpha: alpha * 0.28 });
      drawLine(g, b.from, b.to, { color: b.glowColor, width: (16 * scale) + jitter, alpha: alpha * 0.55 });
      drawLine(g, b.from, b.to, { color: b.coreColor, width: 8 * scale, alpha: alpha * 0.95 });
      drawLine(g, b.from, b.to, { color: 0xffffff, width: 2.8 * scale, alpha: alpha * 1.0 });

      // Lens flare star at muzzle
      drawStar(g, b.from, 3 * scale, 22 * scale, 4, 0xffffff, alpha * 0.9);
      drawStar(g, b.from, 5 * scale, 32 * scale, 4, b.glowColor, alpha * 0.5);
    }

    // Boiling sparks at target impact point during beam strike
    if (b.hit) {
      if (!b.impactTriggered) {
        b.impactTriggered = true;
        triggerImpact(b.to, b.coreColor, b.glowColor, b.hit, b.critical, scale);
      }
      // Continuous boiling embers
      const sparkAngle = Math.random() * Math.PI * 2;
      const sparkSpeed = (2 + Math.random() * 6) * scale;
      spawnParticle({
        x: b.to.x + (Math.random() - 0.5) * 8 * scale,
        y: b.to.y + (Math.random() - 0.5) * 8 * scale,
        vx: Math.cos(sparkAngle) * sparkSpeed,
        vy: Math.sin(sparkAngle) * sparkSpeed,
        size: (2 + Math.random() * 2) * scale,
        color: Math.random() > 0.4 ? b.coreColor : 0xffffff,
        alpha: 0.9,
        decay: 0.05,
        drag: 0.92,
        shape: "spark",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Projectile Spawner
// ---------------------------------------------------------------------------

function spawnProjectile(from, to, weapon, hit, critical, barrageIndex) {
  const style = weapon?.visualStyle ?? "bullet";

  // Laser and Lance are sustained continuous beams
  if (style === "laser" || style === "lance") {
    spawnBeam(from, to, weapon, hit, critical, barrageIndex);
    return;
  }

  const coreColor = parseColor(weapon?.coreColor, 0xffffff);
  const glowColor = parseColor(weapon?.glowColor, 0xffaa00);
  const renderer = STYLE_RENDERERS[style] ?? STYLE_RENDERERS.bullet;
  const impactPoint = hit ? to : missPoint(from, to);
  const duration = travelDuration(from, impactPoint, weapon?.projectileClass);
  const delay = (barrageIndex ?? 0) * BARRAGE_STAGGER_MS;

  activeProjectiles.push({
    start: performance.now() + delay,
    duration,
    from,
    to: impactPoint,
    renderer,
    coreColor,
    glowColor,
    style,
    hit,
    critical,
    muzzleFlashed: false,
  });
}

// ---------------------------------------------------------------------------
// Impact & Explosion Effects
// ---------------------------------------------------------------------------

function triggerImpact(point, coreColor, glowColor, hit, critical, scale) {
  activeImpacts.push({
    point,
    coreColor,
    glowColor,
    critical,
    start: performance.now(),
    duration: IMPACT_MS,
    scale,
  });

  // High-velocity explosion sparks
  const sparkCount = critical ? 32 : 18;
  for (let i = 0; i < sparkCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (critical ? (4 + Math.random() * 12) : (2.5 + Math.random() * 8)) * scale;
    spawnParticle({
      x: point.x + (Math.random() - 0.5) * 6 * scale,
      y: point.y + (Math.random() - 0.5) * 6 * scale,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: (critical ? (2 + Math.random() * 3) : (1.5 + Math.random() * 2)) * scale,
      color: Math.random() > 0.4 ? coreColor : (Math.random() > 0.5 ? glowColor : 0xffffff),
      alpha: 1.0,
      decay: 0.025 + Math.random() * 0.025,
      drag: 0.94,
      shape: "spark",
    });
  }
}

function updateAndDrawImpacts(g, now) {
  for (let i = activeImpacts.length - 1; i >= 0; i--) {
    const imp = activeImpacts[i];
    const elapsed = now - imp.start;
    if (elapsed >= imp.duration) {
      activeImpacts.splice(i, 1);
      continue;
    }

    const p = elapsed / imp.duration;
    const alpha = Math.max(0, 1 - p * 1.15);
    const s = imp.scale;
    const crit = imp.critical;
    const sizeMul = crit ? 2.2 : 1.0;

    // Expanding Primary Shockwave Ring
    const ringR = (12 + p * 55) * s * sizeMul;
    const ringW = Math.max(1, (5 - p * 4) * s * (crit ? 1.6 : 1.0));
    drawCircleRing(g, imp.point, ringR, ringW, imp.coreColor, alpha * 0.85);

    // Outer Secondary Shockwave
    if (crit) {
      const outerRingR = (8 + p * 75) * s;
      drawCircleRing(g, imp.point, outerRingR, 2 * s, 0xffffff, alpha * 0.6);
    }

    // Expanding Fireball / Plasma Burst
    const burstR = (10 + p * 28) * s * sizeMul;
    drawFilledCircle(g, imp.point, burstR * 1.5, imp.glowColor, alpha * 0.3);
    drawFilledCircle(g, imp.point, burstR * 1.0, imp.coreColor, alpha * 0.75);
    drawFilledCircle(g, imp.point, burstR * 0.45, 0xffffff, alpha * 0.95);

    // Critical Starburst Flare
    if (crit) {
      const starR = (25 + p * 30) * s;
      drawStar(g, imp.point, 5 * s, starR, 8, 0xffffff, alpha);
      drawStar(g, imp.point, 8 * s, starR * 1.4, 8, imp.glowColor, alpha * 0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Shield Sector Ripple & Arc Pulse
// ---------------------------------------------------------------------------

function pulseShieldSector(targetUuid, sector, coreColor, glowColor) {
  try {
    const info = resolveTokenInfo(targetUuid);
    if (!info) return;
    const { center, token, radius } = info;

    const sectorAngles = {
      fore: { start: -Math.PI / 4, end: Math.PI / 4 },
      starboard: { start: Math.PI / 4, end: (3 * Math.PI) / 4 },
      aft: { start: (3 * Math.PI) / 4, end: (5 * Math.PI) / 4 },
      port: { start: -(3 * Math.PI) / 4, end: -Math.PI / 4 },
    };
    const angles = sectorAngles[sector];
    if (!angles) return;

    const facing = Number(token.document?.rotation ?? 0) * (Math.PI / 180);
    const startAngle = angles.start + facing - Math.PI / 2;
    const endAngle = angles.end + facing - Math.PI / 2;
    const shieldR = radius + 10;

    activeShieldPulses.push({
      start: performance.now(),
      duration: IMPACT_MS * 1.6,
      center,
      radius: shieldR,
      startAngle,
      endAngle,
      coreColor: coreColor ?? 0x91c7c4,
      glowColor: glowColor ?? 0x44ddff,
    });

    // Shield surface sparks skittering along the arc
    const midAngle = (startAngle + endAngle) / 2;
    const scale = Math.max(0.5, gridSize() / 50);
    for (let i = 0; i < 14; i++) {
      const sAngle = startAngle + Math.random() * (endAngle - startAngle);
      const arcPt = {
        x: center.x + Math.cos(sAngle) * shieldR,
        y: center.y + Math.sin(sAngle) * shieldR,
      };
      const speed = (2 + Math.random() * 5) * scale;
      const sparkDir = sAngle + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      spawnParticle({
        x: arcPt.x,
        y: arcPt.y,
        vx: Math.cos(sparkDir) * speed + Math.cos(sAngle) * (1.5 * scale),
        vy: Math.sin(sparkDir) * speed + Math.sin(sAngle) * (1.5 * scale),
        size: (1.5 + Math.random() * 2) * scale,
        color: Math.random() > 0.3 ? 0x91c7c4 : 0xffffff,
        alpha: 0.95,
        decay: 0.035,
        drag: 0.93,
        shape: "spark",
      });
    }

    ensureTicker();
  } catch {
    // Token may have been removed
  }
}

function updateAndDrawShieldPulses(g, now, scale) {
  for (let i = activeShieldPulses.length - 1; i >= 0; i--) {
    const sp = activeShieldPulses[i];
    const elapsed = now - sp.start;
    if (elapsed >= sp.duration) {
      activeShieldPulses.splice(i, 1);
      continue;
    }

    const p = elapsed / sp.duration;
    const alpha = (1 - p);
    const { center, radius, startAngle, endAngle, coreColor, glowColor } = sp;

    // Layer 1: Wide Outer Shield Glow Barrier
    strokeArc(g, center, radius, startAngle, endAngle, {
      color: glowColor,
      width: (18 + p * 8) * scale,
      alpha: alpha * 0.45,
    });

    // Layer 2: Main Shield Barrier Arc
    strokeArc(g, center, radius, startAngle, endAngle, {
      color: coreColor,
      width: (8 + p * 3) * scale,
      alpha: alpha * 0.95,
    });

    // Layer 3: Blinding White Deflection Filament
    strokeArc(g, center, radius, startAngle, endAngle, {
      color: 0xffffff,
      width: 3 * scale,
      alpha: alpha * 1.0,
    });

    // Layer 4: Shield Ripple Ring expanding from center of arc
    const midA = (startAngle + endAngle) / 2;
    const hitApex = {
      x: center.x + Math.cos(midA) * radius,
      y: center.y + Math.sin(midA) * radius,
    };
    const rippleR = p * 45 * scale;
    drawCircleRing(g, hitApex, rippleR, 2 * scale, 0xffffff, alpha * 0.6);
  }
}

// ---------------------------------------------------------------------------
// Main Animation Loop (Single Ticker)
// ---------------------------------------------------------------------------

function tick() {
  if (!effectGraphics || effectGraphics.destroyed) return;
  effectGraphics.clear();

  const now = performance.now();
  const scale = Math.max(0.5, gridSize() / 50);

  // 1. Muzzle flashes
  updateAndDrawMuzzleFlashes(effectGraphics, now);

  // 2. Active in-flight projectiles
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const proj = activeProjectiles[i];
    const elapsed = now - proj.start;
    if (elapsed < 0) continue; // Barrage delay

    // Trigger muzzle flash on first frame of flight
    if (!proj.muzzleFlashed) {
      proj.muzzleFlashed = true;
      const dx = proj.to.x - proj.from.x;
      const dy = proj.to.y - proj.from.y;
      const dist = Math.hypot(dx, dy);
      const dir = dist > 0 ? { x: dx / dist, y: dy / dist } : { x: 0, y: -1 };
      spawnMuzzleFlash(proj.from, dir, proj.coreColor, proj.glowColor, proj.style, scale);
    }

    const progress = Math.min(1, elapsed / proj.duration);

    // Draw styled projectile
    proj.renderer(
      effectGraphics,
      proj.from,
      proj.to,
      progress,
      proj.coreColor,
      proj.glowColor,
      scale,
    );

    // Arrival / Impact
    if (progress >= 1) {
      if (proj.hit) {
        triggerImpact(proj.to, proj.coreColor, proj.glowColor, proj.hit, proj.critical, scale);
      } else {
        // Miss: tiny dissipating puff as it vanishes into space
        spawnParticle({
          x: proj.to.x,
          y: proj.to.y,
          vx: (Math.random() - 0.5) * 2 * scale,
          vy: (Math.random() - 0.5) * 2 * scale,
          size: 2 * scale,
          color: proj.coreColor,
          alpha: 0.5,
          decay: 0.05,
          drag: 0.9,
        });
      }
      activeProjectiles.splice(i, 1);
    }
  }

  // 3. Continuous Beams (Laser / Lance)
  updateAndDrawBeams(effectGraphics, now, scale);

  // 4. Impacts & Explosions
  updateAndDrawImpacts(effectGraphics, now);

  // 5. Shield sector pulses & ripples
  updateAndDrawShieldPulses(effectGraphics, now, scale);

  // 6. Particle system (sparks, smoke, debris, embers)
  updateAndDrawParticles(effectGraphics, scale);

  // Stop ticker when all visual effects have resolved
  if (
    activeProjectiles.length === 0 &&
    activeBeams.length === 0 &&
    activeMuzzleFlashes.length === 0 &&
    activeImpacts.length === 0 &&
    activeShieldPulses.length === 0 &&
    activeParticles.length === 0
  ) {
    removeTicker();
  }
}

function ensureTicker() {
  const ticker = globalThis.canvas?.app?.ticker;
  if (!ticker || tickerRef === ticker) return;
  if (tickerRef) tickerRef.remove(tick);
  tickerRef = ticker;
  tickerRef.add(tick);
}

function removeTicker() {
  if (tickerRef) tickerRef.remove(tick);
  tickerRef = null;
  if (effectGraphics && !effectGraphics.destroyed) effectGraphics.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Play attack visual effects for a committed attack operation.
 * Called from the viraShipCombatOperationCommitted hook on all clients.
 *
 * @param {object} fullResult - The committed result (publicEvents, gmEvents, etc.)
 * @param {object} request    - The original operation request
 */
export function playAttackEffects(fullResult, request) {
  if (request?.type !== "attack") return;
  if (!effectContainer || !effectGraphics) return;
  if (!globalThis.canvas?.ready) return;

  const sourceUuid = request.sourceUuid;
  const targetUuid = request.targetUuids?.[0];
  if (!sourceUuid || !targetUuid) return;

  const shooterInfo = resolveTokenInfo(sourceUuid);
  const targetInfo = resolveTokenInfo(targetUuid);
  const fromCenter = shooterInfo?.center ?? resolveTokenPosition(sourceUuid);
  const toCenter = targetInfo?.center ?? resolveTokenPosition(targetUuid);
  if (!fromCenter || !toCenter) return;

  const weaponId = request.payload?.weaponId;
  const weapon = resolveWeaponConfig(sourceUuid, weaponId);

  const attackEvent = (fullResult?.publicEvents ?? []).find((e) => e.type === "attack");
  const detail = attackEvent?.detail ?? {};
  const roll = detail.roll ?? {};
  const hit = roll.hit === true;
  const critical = roll.critical === true;
  const sector = detail.damage?.sector;
  const barrageRounds = Math.max(1, Number(request.payload?.barrageRounds ?? 1));

  // Compute direction and lateral normals
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const dist = Math.hypot(dx, dy);
  const ux = dist > 0 ? dx / dist : 0;
  const uy = dist > 0 ? dy / dist : -1;
  const lx = -uy;
  const ly = ux;

  const scale = Math.max(0.5, gridSize() / 50);
  const shooterRadius = shooterInfo?.radius ?? (30 * scale);
  const muzzleBase = {
    x: fromCenter.x + ux * shooterRadius,
    y: fromCenter.y + uy * shooterRadius,
  };

  const count = Math.min(barrageRounds, 12);

  for (let i = 0; i < count; i++) {
    // Alternating lateral gun barrel offsets for salvos
    const lateral = count > 1
      ? ((i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2)) * Math.min(18 * scale, shooterRadius * 0.35)
      : 0;

    const roundFrom = {
      x: muzzleBase.x + lx * lateral,
      y: muzzleBase.y + ly * lateral,
    };

    // Slight target convergence/dispersion
    const roundTo = {
      x: toCenter.x + lx * (lateral * 0.25),
      y: toCenter.y + ly * (lateral * 0.25),
    };

    spawnProjectile(roundFrom, roundTo, weapon, hit, critical, i);
  }

  // Shield sector pulse and ripple on hit
  if (hit && sector) {
    const isBeam = weapon?.visualStyle === "laser" || weapon?.visualStyle === "lance";
    const delay = isBeam
      ? 100
      : travelDuration(muzzleBase, toCenter, weapon?.projectileClass) + (count - 1) * BARRAGE_STAGGER_MS;

    setTimeout(() => {
      pulseShieldSector(
        targetUuid,
        sector,
        parseColor(weapon?.coreColor, 0x91c7c4),
        parseColor(weapon?.glowColor, 0x44ddff),
      );
    }, delay);
  }

  ensureTicker();
}

/**
 * Create the effects PIXI container. Called during canvas integration setup.
 */
export function createEffectsContainer() {
  destroyEffectsContainer();
  if (!globalThis.canvas?.stage || !globalThis.PIXI) return;
  effectContainer = new PIXI.Container();
  effectContainer.name = `${MODULE_ID}.effects`;
  effectContainer.eventMode = "none";
  effectContainer.interactiveChildren = false;
  effectContainer.sortableChildren = false;
  effectContainer.zIndex = 15000;
  effectGraphics = new PIXI.Graphics();
  effectGraphics.eventMode = "none";
  effectContainer.addChild(effectGraphics);
  canvas.stage.addChild(effectContainer);
}

/**
 * Tear down the effects container. Called on canvasTearDown.
 */
export function destroyEffectsContainer() {
  removeTicker();
  activeProjectiles.length = 0;
  activeBeams.length = 0;
  activeMuzzleFlashes.length = 0;
  activeImpacts.length = 0;
  activeShieldPulses.length = 0;
  activeParticles.length = 0;

  if (effectContainer && !effectContainer.destroyed) {
    effectContainer.parent?.removeChild(effectContainer);
    effectContainer.destroy({ children: true });
  }
  effectContainer = null;
  effectGraphics = null;
}

export { PROJECTILE_SPEEDS };
