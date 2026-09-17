import { MODULE_ID, OPERATOR_TYPES } from "../constants.js";

export const CREW_FEATURE_NAME = "Ship Station Qualifications";
export const CREW_FEATURE_IMG = "icons/tools/navigation/compass-brass-vintage.svg";

export const DEFAULT_RATINGS = Object.freeze({
  piloting: 1,
  gunnery: 1,
  sensors: 1,
  engineering: 1,
});

export const DEFAULT_CAPABILITIES = Object.freeze({
  work: true,
  repairDrone: false,
  selfRepair: false,
});

function clampRating(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(1, Math.min(10, number)) : 1;
}

/**
 * Cleanly format ratings dictionary with 1-10 integer clamping.
 * @param {Record<string, number>} [ratings]
 * @returns {{ piloting: number, gunnery: number, sensors: number, engineering: number }}
 */
export function normalizeRatings(ratings = {}) {
  return {
    piloting: clampRating(ratings?.piloting ?? DEFAULT_RATINGS.piloting),
    gunnery: clampRating(ratings?.gunnery ?? DEFAULT_RATINGS.gunnery),
    sensors: clampRating(ratings?.sensors ?? DEFAULT_RATINGS.sensors),
    engineering: clampRating(ratings?.engineering ?? DEFAULT_RATINGS.engineering),
  };
}

/**
 * Generate an HTML badge snippet displaying character ratings inline in sheet descriptions.
 * @param {Record<string, number>} ratings
 * @param {string} [type="pc"]
 * @returns {string}
 */
export function formatCrewBadgeHtml(ratings, type = "pc") {
  const r = normalizeRatings(ratings);
  const typeLabel = (type ?? "pc").toUpperCase();
  return [
    `<div class="vira-crew-qualifications-badge" data-vira-crew-type="${escapeHtml(type)}">`,
    `  <p><strong>Ship Station Qualifications</strong> · <span class="vira-chip">${escapeHtml(typeLabel)}</span></p>`,
    `  <div class="vira-ratings-readout" style="display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.35rem; font-size: 0.85em;">`,
    `    <span><strong>Pilot:</strong> ${r.piloting}</span>`,
    `    <span><strong>Gunnery:</strong> ${r.gunnery}</span>`,
    `    <span><strong>Sensors:</strong> ${r.sensors}</span>`,
    `    <span><strong>Engineering:</strong> ${r.engineering}</span>`,
    `  </div>`,
    `</div>`,
  ].join("\n");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Find an existing crew qualification Feature item on the given Actor.
 * @param {object} actor
 * @returns {object|null}
 */
export function findCrewFeature(actor) {
  if (!actor?.items) return null;
  const items = Array.isArray(actor.items) ? actor.items : (actor.items.contents ?? Array.from(actor.items.values?.() ?? []));
  return items.find((item) => {
    if (item.type !== "feat") return false;
    const flagData = item.flags?.[MODULE_ID]?.crewRole;
    if (flagData) return true;
    return item.name === CREW_FEATURE_NAME;
  }) ?? null;
}

/**
 * Extract normalized crew qualification data from an Actor.
 * Checks for an embedded Feature item first, then actor flags, then fallback defaults.
 * @param {object} actor
 * @returns {{ ratings: { piloting: number, gunnery: number, sensors: number, engineering: number }, type: string, capabilities: { work: boolean, repairDrone: boolean, selfRepair: boolean }, item: object|null }}
 */
export function getActorCrewData(actor) {
  const item = findCrewFeature(actor);
  const defaultType = actor?.type === "character" ? "pc" : "npc";

  if (item) {
    const itemFlags = item.flags?.[MODULE_ID]?.crewRole ?? {};
    const ratings = normalizeRatings(itemFlags.ratings);
    const type = OPERATOR_TYPES.includes(itemFlags.type) ? itemFlags.type : defaultType;
    const capabilities = {
      work: itemFlags.capabilities?.work !== false,
      repairDrone: Boolean(itemFlags.capabilities?.repairDrone),
      selfRepair: Boolean(itemFlags.capabilities?.selfRepair),
    };
    return { ratings, type, capabilities, item };
  }

  const actorFlags = actor?.flags?.[MODULE_ID]?.crewRole ?? {};
  const ratings = normalizeRatings(actorFlags.ratings);
  const type = OPERATOR_TYPES.includes(actorFlags.type) ? actorFlags.type : defaultType;
  const capabilities = {
    work: actorFlags.capabilities?.work !== false,
    repairDrone: Boolean(actorFlags.capabilities?.repairDrone),
    selfRepair: Boolean(actorFlags.capabilities?.selfRepair),
  };
  return { ratings, type, capabilities, item: null };
}

/**
 * Determine the primary non-GM user ID owning this Actor, if any.
 * @param {object} actor
 * @returns {string|null}
 */
export function getPrimaryUserId(actor) {
  if (!actor?.ownership) return null;
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  for (const [userId, level] of Object.entries(actor.ownership)) {
    if (userId === "default" || level < ownerLevel) continue;
    const user = globalThis.game?.users?.get(userId);
    if (user && !user.isGM) return userId;
  }
  return null;
}

/**
 * Ensure an Actor has the crew qualifications Feature item embedded, creating it if absent.
 * @param {object} actor
 * @param {object} [options]
 * @returns {Promise<object>} The existing or created Item document
 */
export async function ensureActorCrewFeature(actor, { ratings = null, type = null, capabilities = null } = {}) {
  const existing = findCrewFeature(actor);
  const currentData = getActorCrewData(actor);
  const nextRatings = normalizeRatings(ratings ?? currentData.ratings);
  const nextType = type ?? currentData.type;
  const nextCapabilities = capabilities ?? currentData.capabilities;
  const descriptionHtml = formatCrewBadgeHtml(nextRatings, nextType);

  const payload = {
    isCrewRole: true,
    crewRole: {
      ratings: nextRatings,
      type: nextType,
      capabilities: nextCapabilities,
    },
  };

  if (existing) {
    await existing.update({
      [`flags.${MODULE_ID}`]: payload,
      "system.description.value": descriptionHtml,
    });
    return existing;
  }

  if (typeof actor?.createEmbeddedDocuments !== "function") {
    // Pure data context (unit tests / detached)
    return {
      name: CREW_FEATURE_NAME,
      type: "feat",
      img: CREW_FEATURE_IMG,
      flags: { [MODULE_ID]: payload },
      system: { description: { value: descriptionHtml } },
    };
  }

  const [created] = await actor.createEmbeddedDocuments("Item", [{
    name: CREW_FEATURE_NAME,
    type: "feat",
    img: CREW_FEATURE_IMG,
    system: {
      description: { value: descriptionHtml },
      type: { value: "feat" },
    },
    flags: {
      [MODULE_ID]: payload,
    },
  }]);

  return created;
}

/**
 * Construct an operator profile object from an Actor document.
 * @param {object} actor
 * @returns {object}
 */
export function buildOperatorProfileFromActor(actor) {
  const crewData = getActorCrewData(actor);
  const userId = getPrimaryUserId(actor);
  return {
    id: `actor-${actor.id}`,
    label: actor.name ?? "Crew Member",
    type: crewData.type,
    actorId: actor.id,
    userId: userId ?? null,
    ratings: crewData.ratings,
    img: actor.img ?? actor.prototypeToken?.texture?.src ?? null,
    capabilities: crewData.capabilities,
  };
}
