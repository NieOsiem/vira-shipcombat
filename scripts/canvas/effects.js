import { SHIP_TYPE } from "../constants.js";
import { materializeActorConfig } from "../foundry/refit.js";
import { sceneGridGeometry } from "../foundry/scene-geometry.js";

const MODULE_ID = "vira-shipcombat";

/**
 * Projectile travel speed in scene-pixels per millisecond, indexed by projectileClass.
 * Tweak by eye after live testing.
 */
const PROJECTILE_SPEEDS = Object.freeze({
  instant: 6.0,
  fast: 2.0,
  medium: 1.2,
  slow: 0.7,
  veryslow: 0.4,
});

const MIN_TRAVEL_MS = 80;
const MAX_TRAVEL_MS = 3000;
const MISS_OVERSHOOT = 120;
const FLASH_MS = 150;
const IMPACT_MS = 250;
const BARRAGE_STAGGER_MS = 70;

const activeEffects = [];
let effectContainer = null;
let effectGraphics = null;
let tickerRef = null;

function gridSize() {
  return sceneGridGeometry(globalThis.canvas?.scene).gridSize;
}

function useModernGraphics(g) {
  return typeof g?.stroke === "function";
}

function parseColor(hex, fallback) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  return parseInt(hex.slice(1), 16);
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
  const angle = (Math.random() - 0.5) * 0.15;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: to.x + (ux * cos - uy * sin) * MISS_OVERSHOOT,
    y: to.y + (ux * sin + uy * cos) * MISS_OVERSHOOT,
  };
}

function travelDuration(from, to, projectileClass) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const key = String(projectileClass ?? "medium").toLowerCase().replace(
    /[^a-z]/g,
    "",
  );
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

function resolveTokenPosition(uuid) {
  try {
    const doc = globalThis.fromUuidSync?.(uuid);
    const token = doc?.object ?? doc?._object;
    return tokenCenter(token);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

function drawLine(g, from, to, { color, width, alpha }) {
  if (useModernGraphics(g)) {
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke({ color, width, alpha, cap: "round" });
  } else {
    g.lineStyle(width, color, alpha);
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
  }
}

function drawFilledCircle(g, point, radius, color, alpha) {
  if (useModernGraphics(g)) {
    g.circle(point.x, point.y, radius);
    g.fill({ color, alpha });
  } else {
    g.beginFill(color, alpha);
    g.drawCircle(point.x, point.y, radius);
    g.endFill();
  }
}

// ---------------------------------------------------------------------------
// Visual style renderers — each draws one frame of a projectile in flight
// ---------------------------------------------------------------------------

const STYLE_RENDERERS = {
  bullet(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.06));
    drawLine(g, tail, head, { color: glow, width: 4 * s, alpha: 0.4 });
    drawLine(g, tail, head, { color: core, width: 2 * s, alpha: 0.9 });
    drawFilledCircle(g, head, 2 * s, core, 0.8);
  },

  laser(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, Math.min(1, t * 1.5));
    const trailFrom = lerpPoint(from, to, Math.max(0, t - 0.3));
    const alpha = t < 0.8 ? 0.9 : Math.max(0, 1 - (t - 0.8) * 5);
    drawLine(g, trailFrom, head, { color: glow, width: 6 * s, alpha: alpha * 0.35 });
    drawLine(g, trailFrom, head, { color: core, width: 2.5 * s, alpha });
  },

  blaster(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.1));
    drawLine(g, tail, head, { color: glow, width: 5 * s, alpha: 0.5 });
    drawLine(g, tail, head, { color: core, width: 3 * s, alpha: 0.9 });
    drawFilledCircle(g, head, 3 * s, core, 0.7);
  },

  orb(g, from, to, t, core, glow, s) {
    const pos = lerpPoint(from, to, t);
    const pulse = 1 + Math.sin(t * Math.PI * 6) * 0.15;
    const r = 5 * s * pulse;
    drawFilledCircle(g, pos, r * 1.6, glow, 0.2);
    drawFilledCircle(g, pos, r, glow, 0.4);
    drawFilledCircle(g, pos, r * 0.5, core, 0.9);
  },

  railgun(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.15));
    drawLine(g, tail, head, { color: glow, width: 7 * s, alpha: 0.25 });
    drawLine(g, tail, head, { color: core, width: 1.5 * s, alpha: 1 });
    drawFilledCircle(g, head, 2 * s, core, 1);
  },

  energy(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.12));
    const alpha = t < 0.7 ? 0.85 : Math.max(0, 1 - (t - 0.7) * 3.3);
    drawLine(g, tail, head, { color: glow, width: 5 * s, alpha: alpha * 0.4 });
    drawLine(g, tail, head, { color: core, width: 2.5 * s, alpha });
  },

  plasma(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, t);
    const tail = lerpPoint(from, to, Math.max(0, t - 0.08));
    const pulse = 1 + Math.sin(t * Math.PI * 8) * 0.2;
    const r = 4 * s * pulse;
    drawLine(g, tail, head, { color: glow, width: r * 2, alpha: 0.3 });
    drawFilledCircle(g, head, r, glow, 0.5);
    drawFilledCircle(g, head, r * 0.4, core, 0.9);
  },

  lance(g, from, to, t, core, glow, s) {
    const head = lerpPoint(from, to, Math.min(1, t * 2));
    const trailFrom = lerpPoint(from, to, Math.max(0, t - 0.15));
    const alpha = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) * 2.5);
    drawLine(g, trailFrom, head, { color: glow, width: 3 * s, alpha: alpha * 0.3 });
    drawLine(g, trailFrom, head, { color: core, width: 1 * s, alpha });
  },

  flak(g, from, to, t, core, glow, s) {
    const count = 5;
    const spread = 0.08;
    for (let i = 0; i < count; i++) {
      const angle = ((i / (count - 1)) - 0.5) * spread;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const target = {
        x: from.x + dx * cos - dy * sin,
        y: from.y + dx * sin + dy * cos,
      };
      const head = lerpPoint(from, target, t);
      const tail = lerpPoint(from, target, Math.max(0, t - 0.05));
      drawLine(g, tail, head, { color: glow, width: 2 * s, alpha: 0.4 });
      drawFilledCircle(g, head, 1.5 * s, core, 0.8);
    }
  },
};

// ---------------------------------------------------------------------------
// Effect lifecycle
// ---------------------------------------------------------------------------

function spawnProjectile(from, to, weapon, hit, critical, barrageIndex) {
  const coreColor = parseColor(weapon?.coreColor, 0xffffff);
  const glowColor = parseColor(weapon?.glowColor, 0xffaa00);
  const style = weapon?.visualStyle ?? "bullet";
  const renderer = STYLE_RENDERERS[style] ?? STYLE_RENDERERS.bullet;
  const impactPoint = hit ? to : missPoint(from, to);
  const duration = travelDuration(from, impactPoint, weapon?.projectileClass);
  const delay = (barrageIndex ?? 0) * BARRAGE_STAGGER_MS;

  activeEffects.push({
    start: performance.now() + delay,
    phase: "travel",
    duration,
    from,
    to: impactPoint,
    renderer,
    coreColor,
    glowColor,
    hit,
    critical,
  });
}

function renderImpact(g, point, coreColor, glowColor, progress, scale, crit) {
  const alpha = 1 - progress;
  const sizeMul = crit ? 2 : 1;
  const r = (4 + progress * 12) * scale * sizeMul;
  drawFilledCircle(g, point, r * 1.5, glowColor, alpha * 0.25);
  drawFilledCircle(g, point, r, coreColor, alpha * 0.6);
  if (crit) {
    drawFilledCircle(g, point, r * 0.4, 0xffffff, alpha * 0.9);
  }
}

function tickShieldPulse(g, effect, elapsed, scale) {
  const progress = Math.min(1, elapsed / effect.duration);
  const alpha = (1 - progress) * 0.6;
  const width = (3 + progress * 4) * scale;
  const { center, radius, startAngle, endAngle, color } = effect;
  if (useModernGraphics(g)) {
    g.moveTo(
      center.x + Math.cos(startAngle) * radius,
      center.y + Math.sin(startAngle) * radius,
    );
    g.arc(center.x, center.y, radius, startAngle, endAngle);
    g.stroke({ color, width, alpha, cap: "butt" });
  } else {
    g.lineStyle(width, color, alpha);
    g.moveTo(
      center.x + Math.cos(startAngle) * radius,
      center.y + Math.sin(startAngle) * radius,
    );
    g.arc(center.x, center.y, radius, startAngle, endAngle);
  }
  return progress >= 1;
}

function tick() {
  if (!effectGraphics || effectGraphics.destroyed) return;
  effectGraphics.clear();

  const now = performance.now();
  const scale = Math.max(0.5, gridSize() / 100);

  for (let i = activeEffects.length - 1; i >= 0; i--) {
    const effect = activeEffects[i];
    const elapsed = now - effect.start;
    if (elapsed < 0) continue;

    let done = false;
    switch (effect.phase) {
      case "travel": {
        const progress = Math.min(1, elapsed / effect.duration);
        effect.renderer(
          effectGraphics, effect.from, effect.to, progress,
          effect.coreColor, effect.glowColor, scale,
        );
        if (progress >= 1) {
          if (effect.hit) {
            effect.phase = "impact";
            effect.start = now;
          } else {
            done = true;
          }
        }
        break;
      }
      case "impact": {
        const progress = Math.min(1, elapsed / IMPACT_MS);
        renderImpact(
          effectGraphics, effect.to,
          effect.coreColor, effect.glowColor,
          progress, scale, effect.critical,
        );
        if (progress >= 1) done = true;
        break;
      }
      case "shieldPulse":
        done = tickShieldPulse(effectGraphics, effect, elapsed, scale);
        break;
      default:
        done = true;
    }
    if (done) activeEffects.splice(i, 1);
  }

  if (activeEffects.length === 0) removeTicker();
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

function pulseShieldSector(targetUuid, sector, coreColor) {
  try {
    const doc = globalThis.fromUuidSync?.(targetUuid);
    const token = doc?.object ?? doc?._object;
    if (!token) return;
    const center = tokenCenter(token);
    if (!center) return;

    const sectorAngles = {
      fore: { start: -Math.PI / 4, end: Math.PI / 4 },
      starboard: { start: Math.PI / 4, end: (3 * Math.PI) / 4 },
      aft: { start: (3 * Math.PI) / 4, end: (5 * Math.PI) / 4 },
      port: { start: -(3 * Math.PI) / 4, end: -Math.PI / 4 },
    };
    const angles = sectorAngles[sector];
    if (!angles || !effectGraphics || effectGraphics.destroyed) return;

    const facing = Number(token.document?.rotation ?? 0) * (Math.PI / 180);
    const w = Number(token.w ?? 0);
    const h = Number(token.h ?? token.w ?? 0);
    const radius = Math.hypot(w, h) / 2 + 8;

    activeEffects.push({
      start: performance.now(),
      phase: "shieldPulse",
      duration: IMPACT_MS * 1.5,
      center,
      radius,
      startAngle: angles.start + facing - Math.PI / 2,
      endAngle: angles.end + facing - Math.PI / 2,
      color: coreColor,
    });
    ensureTicker();
  } catch {
    // Token may have been removed
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function playAttackEffects(fullResult, request) {
  if (request?.type !== "attack") return;
  if (!effectContainer || !effectGraphics) return;
  if (!globalThis.canvas?.ready) return;

  const sourceUuid = request.sourceUuid;
  const targetUuid = request.targetUuids?.[0];
  if (!sourceUuid || !targetUuid) return;

  const from = resolveTokenPosition(sourceUuid);
  const to = resolveTokenPosition(targetUuid);
  if (!from || !to) return;

  const weaponId = request.payload?.weaponId;
  const weapon = resolveWeaponConfig(sourceUuid, weaponId);

  const attackEvent = (fullResult?.publicEvents ?? []).find(
    (e) => e.type === "attack",
  );
  const detail = attackEvent?.detail ?? {};
  const roll = detail.roll ?? {};
  const hit = roll.hit === true;
  const critical = roll.critical === true;
  const sector = detail.damage?.sector;
  const barrageRounds = request.payload?.barrageRounds ?? 1;

  const count = Math.min(barrageRounds, 10);
  for (let i = 0; i < count; i++) {
    spawnProjectile(from, to, weapon, hit, critical, i);
  }

  if (hit && sector) {
    const delay = travelDuration(from, to, weapon?.projectileClass) +
      (count - 1) * BARRAGE_STAGGER_MS;
    setTimeout(() => {
      pulseShieldSector(
        targetUuid,
        sector,
        parseColor(weapon?.coreColor, 0x91c7c4),
      );
    }, delay);
  }

  ensureTicker();
}

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

export function destroyEffectsContainer() {
  removeTicker();
  activeEffects.length = 0;
  if (effectContainer && !effectContainer.destroyed) {
    effectContainer.parent?.removeChild(effectContainer);
    effectContainer.destroy({ children: true });
  }
  effectContainer = null;
  effectGraphics = null;
}

export { PROJECTILE_SPEEDS };
