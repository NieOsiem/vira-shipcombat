import { MODULE_ID, SHIP_TYPE } from "../constants.js";
import { FAULT_CHANNELS, HAZARD_CHANNELS } from "../rules/conditions.js";

const CHAT_ALIAS = "Vira Ship Combat";

const CONDITION_KIND_LABELS = Object.freeze({
  critical: "Critical",
  viciousCritical: "Vicious critical",
  aimed: "Aimed shot",
  aimedCritical: "Aimed critical",
  aimedViciousCritical: "Aimed vicious critical",
  noneEligible: "Critical",
});

function escape(value) {
  return foundry.utils.escapeHTML(value ?? "");
}

function fateSummary(fate) {
  if (fate?.outcome === "destroyed") return "The ship is destroyed.";
  if (fate?.outcome === "disabled") return "The ship is disabled.";
  if (fate?.status === "pending") return "Hull depleted. The ship's fate awaits resolution.";
  return "";
}

/**
 * `conditionKey` composes faults as `<component>:<channel>[:<sector>]` and
 * hazards as `<channel>[:<region>]`. Public payloads carry no labels, so the
 * affected target is read back out of the key alone.
 */
function conditionTarget(key) {
  const segments = String(key ?? "").split(":");
  const faultIndex = segments.findIndex((segment) =>
    FAULT_CHANNELS.includes(segment)
  );
  if (faultIndex > 0) {
    const location = segments[faultIndex + 1];
    const component = segments.slice(0, faultIndex).join(":");
    return {
      hazard: false,
      label: `${component} ${segments[faultIndex]}${
        location ? ` (${location})` : ""
      }`,
    };
  }
  const hazardIndex = segments.findIndex((segment) =>
    HAZARD_CHANNELS.includes(segment)
  );
  if (hazardIndex >= 0) {
    const region = segments[hazardIndex + 1];
    return {
      hazard: true,
      label: `${segments[hazardIndex]}${region ? ` (${region})` : ""}`,
    };
  }
  return { hazard: false, label: segments.join(" ") };
}

/** Names the Fault or Hazard an attack applied, from public damage data only. */
function conditionSummary(condition) {
  if (!condition || typeof condition !== "object") return "";
  const headline = CONDITION_KIND_LABELS[condition.kind] ?? "Subsystem damage";
  const applications = (
    Array.isArray(condition.applications) ? condition.applications : []
  ).filter((application) => Number(application?.applied) > 0);
  if (!applications.length) return `${headline}: no subsystem fault applied.`;
  const targets = applications.map((application) =>
    conditionTarget(application.key ?? condition.conditionId)
  );
  const noun = targets.every((target) => target.hazard) ? "hazard" : "fault";
  const entries = applications.map((application, index) =>
    `${targets[index].label} — ${application.before} → ${application.after}`
  );
  return `${headline} ${noun}: ${entries.join("; ")}.`;
}

function attackSummary(detail) {
  if (Array.isArray(detail.attacks)) {
    return detail.attacks.map(({ detail: attack }, index) => `Attack ${index + 1}: ${attackSummary(attack)}`).join(" ");
  }
  const roll = detail.roll;
  if (!roll) return "Attack resolved.";
  const parts = [roll.hit ? (roll.critical ? "Critical hit!" : "Hit!") : "Miss."];
  parts.push(`Roll ${roll.natural}; total ${roll.total}.`);
  if (roll.hit) parts.push(`${roll.effectiveHits} effective hit${roll.effectiveHits === 1 ? "" : "s"}.`);
  const damage = detail.damage;
  if (damage?.sector) parts.push(`Impact sector: ${damage.sector}.`);
  if (damage?.totals) parts.push(`Hull damage: ${damage.totals.hullDamage}; heat damage: ${damage.totals.heatDamage}.`);
  const condition = conditionSummary(damage?.conditionEvent);
  if (condition) parts.push(condition);
  if (detail.drawback?.type === "jam") {
    parts.push("⚠️ Misfire! Weapon jammed (weapon malfunction).");
  }
  if (detail.drawback?.backfire) {
    parts.push(`🔥 Backfire! Fire hazard ignited in ${detail.drawback.sector ?? "weapon"} sector!`);
  }
  const fate = fateSummary(damage?.fate);
  if (fate) parts.push(fate);
  return parts.join(" ");
}

const ATTACK_VISIBILITY_KEY = "attackCardVisibility";
const ATTACK_CATEGORY_LABELS = Object.freeze({
  gunnery: "Gunnery",
  weapon: "Weapon",
  range: "Range",
  relativeMotion: "Motion",
  sensors: "Sensors",
  special: "Special",
});
const CROSSHAIR_ICON = `<svg class="vsa-target-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path stroke="currentColor" stroke-width="2" d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/></svg>`;

function attackVisibilitySetting() {
  try {
    return game.settings?.get(MODULE_ID, ATTACK_VISIBILITY_KEY) ?? "shared";
  } catch {
    return "shared";
  }
}

function shipActorFromUuid(uuid) {
  const document = globalThis.fromUuidSync?.(uuid);
  const actor = document?.actor ?? document;
  return actor?.type === SHIP_TYPE ? actor : null;
}

/** The attack card is player-visible when some non-GM user holds at least OBSERVER on the attacker ship. */
function attackerIsPlayerFacing(sourceUuid) {
  const actor = shipActorFromUuid(sourceUuid);
  if (!actor || typeof actor.testUserPermission !== "function") return false;
  const observer = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 20;
  return (game.users ?? []).some(
    (user) => !user.isGM && actor.testUserPermission(user, observer),
  );
}

/** Public attack cards speak as the firing ship, mirroring MidiQOL's actor-owned cards. */
function attackerSpeaker(sourceUuid) {
  const actor = shipActorFromUuid(sourceUuid);
  if (actor) {
    return foundry.documents.ChatMessage.implementation.getSpeaker({
      actor,
      alias: actor.name,
    });
  }
  return speakerData();
}

function collisionSummary(detail) {
  return (detail.collisions ?? []).map((collision) => {
    const sourceDamage = collision.sourceDamage ?? collision.damage;
    const parts = ["Collision!"];
    if (sourceDamage?.damage) parts.push(`Ship hull damage: ${sourceDamage.damage.hullDamageTaken}.`);
    if (collision.targetDamage?.damage) parts.push(`Other ship hull damage: ${collision.targetDamage.damage.hullDamageTaken}.`);
    return parts.join(" ");
  }).join(" ");
}


function attackTags(detail) {
  const tags = [];
  if (detail.roll?.critical) tags.push("Critical");
  if (Number(detail.commitment?.barrage?.rounds) > 1) {
    tags.push(`Barrage ×${detail.commitment.barrage.rounds}`);
  }
  if (detail.commitment?.aimedComponentId) tags.push("Aimed");
  return tags.map((tag) => `<span class="vsa-tag">${escape(tag)}</span>`).join("");
}


function modifierBoxes(categories) {
  return Object.entries(categories ?? {})
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) !== 0)
    .map(([key, value]) => {
      const numeric = Number(value);
      const label = ATTACK_CATEGORY_LABELS[key] ?? key;
      return `<div class="vsa-box"><span class="vsa-box-label">${escape(label)}</span><span class="vsa-box-value">${numeric > 0 ? "+" : "−"}${Math.abs(numeric)}</span></div>`;
    })
    .join("");
}

function documentLabel(uuid) {
  const document = globalThis.fromUuidSync?.(uuid);
  return document?.name ?? document?.actor?.name ?? null;
}

function weaponImage(sourceUuid, weaponId) {
  if (!weaponId) return null;
  const document = globalThis.fromUuidSync?.(sourceUuid);
  const img = document?.actor?.items?.get?.(weaponId)?.img;
  // Foundry's generic placeholder art reads worse than no icon at all.
  if (typeof img !== "string" || !img || /(^|\/)icons\/svg\//.test(img)) return null;
  // Chat content resolves relative sources against the page URL, not the Foundry root.
  if (!/^(?:[a-z]+:|\/)/i.test(img)) return `/${img}`;
  return img;
}

function statBox(label, value, cls = "") {
  return `<div class="vsa-box ${cls}"><span class="vsa-box-label">${escape(label)}</span><span class="vsa-box-value">${escape(value)}</span></div>`;
}

/** Concept-style structured card; only ever rendered from the GM-channel attack detail. */
function renderAttackCard(event) {
  const detail = event.detail ?? {};
  const roll = detail.roll ?? {};
  const commitment = detail.commitment ?? {};
  const profile = commitment.profile ?? {};
  const damage = detail.damage ?? {};
  const weapon = detail.weaponLabel ?? commitment.weaponLabel;
  if (!weapon || !detail.roll) return "";

  const subtitle = [
    profile.projectileClass ? `${escape(profile.projectileClass)} projectile` : "",
    Number.isFinite(Number(profile.armorPiercing)) && Number(profile.armorPiercing) > 0
      ? `AP ${profile.armorPiercing}`
      : "",
  ].filter(Boolean).join(" · ");
  const image = weaponImage(event.sourceUuid, commitment.weaponId);
  const weaponBlock = `<div class="vsa-weapon">${
    image ? `<img class="vsa-weapon-img" src="${escape(image)}" alt="">` : ""
  }<div class="vsa-weapon-text"><span class="vsa-name">${escape(weapon)}</span>${
    subtitle ? `<span class="vsa-subtitle">${subtitle}</span>` : ""
  }</div></div>`;

  const target = documentLabel(event.targetUuids?.[0]);
  const targetBlock = target
    ? `<div class="vsa-target">${CROSSHAIR_ICON}<span>${escape(target)}</span></div>`
    : "";

  const outcomeClass = roll.hit ? (roll.critical ? "vsa-critical" : "vsa-hit") : "vsa-miss";
  const rollBlock = `<div class="vsa-roll"><div class="vsa-box vsa-dice"><span class="vsa-box-value">1d20</span></div>${modifierBoxes(commitment.categories)}</div>`;

  const resultBoxes = [
    `<div class="vsa-box vsa-total ${outcomeClass}"><span class="vsa-box-value">${escape(roll.total ?? "—")}</span><span class="vsa-vs">AC ${escape(roll.ac ?? "—")}</span></div>`,
  ];
  if (roll.hit && damage.totals) {
    resultBoxes.push(
      statBox("Hull", Number(damage.totals.hullDamage), Number(damage.totals.hullDamage) > 0 ? "vsa-hull" : "vsa-dim"),
      statBox("Shield", Number(damage.totals.shieldDamage ?? 0), Number(damage.totals.shieldDamage) > 0 ? "vsa-shield" : "vsa-dim"),
      statBox("Heat", Number(damage.totals.heatDamage)),
    );
  }
  const resultBlock = `<div class="vsa-result">${resultBoxes.join("")}</div><div class="vsa-hits">${escape(roll.effectiveHits ?? 0)} effective hit${roll.effectiveHits === 1 ? "" : "s"}</div>`;

  const hullTarget = detail.targetHull;
  const footerCells = [];
  if (Number.isFinite(Number(hullTarget?.before)) && hullTarget.before !== hullTarget.after) {
    footerCells.push(
      `<div class="vsa-foot"><span class="vsa-foot-label">Hull Integrity</span><span class="vsa-foot-value">${escape(hullTarget.before)} → ${escape(hullTarget.after)}</span></div>`,
    );
  }
  if (damage.sector) {
    footerCells.push(
      `<div class="vsa-foot"><span class="vsa-foot-label">Location · Arc</span><span class="vsa-foot-value">${escape(damage.sector)}</span></div>`,
    );
  }
  const footerBlock = footerCells.length
    ? `<div class="vsa-footer">${footerCells.join("")}</div>`
    : "";

  const notes = [conditionSummary(damage.conditionEvent), fateSummary(damage.fate)].filter(Boolean);
  const tags = attackTags(detail);
  return `<section class="vira-ship-event vira-attack-card">${weaponBlock}${targetBlock}${rollBlock}${resultBlock}${footerBlock}${
    notes.length ? `<p class="vsa-notes">${escape(notes.join(" "))}</p>` : ""
  }${tags ? `<div class="vsa-tags">${tags}</div>` : ""}</section>`;
}

/** Only deliberate player-facing summaries belong in chat; full events remain in the audit log. */
function eventPresentation(event) {
  if (typeof event === "string") return { title: "Ship event", message: event };
  if (!event || typeof event !== "object") return null;
  const detail = event.detail ?? {};
  let title;
  let message;
  switch (event.type) {
    case "attack": title = "Ship attack"; message = attackSummary(detail); break;
    case "maneuver":
    case "coast": title = "Ship collision"; message = collisionSummary(detail); break;
    case "ping": title = "Active sensor ping"; message = `Detected ${detail.detected?.length ?? 0} contact(s).`; break;
    case "acquire": title = "Target acquisition"; message = detail.acquired ? "Target acquired." : "Target acquisition failed."; break;
    case "analyze": title = "Defense analysis"; message = "Target defenses revealed."; break;
    case "deepScan": title = "Deep scan"; message = `Target systems revealed; ${detail.identifiedSubsystems?.length ?? 0} subsystem(s) identified.`; break;
    case "firingSolution": title = "Firing solution"; message = detail.alreadyReady ? "Firing solution already ready." : `Firing solution ready: +${detail.modifier} to the next attack.`; break;
    case "fade": title = "Sensor evasion"; message = `${detail.lostBy?.length ?? 0} observer(s) lost contact.`; break;
    case "jam": title = "Electronic jamming"; message = detail.success ? "Target jammed." : "Jamming failed."; break;
    case "breakLock": title = "Break target lock"; message = detail.broken ? "Target lock broken." : "No target lock was broken."; break;
    case "burnThrough": title = "Burn through jamming"; message = detail.removed ? "Jamming removed." : "Jamming remains in effect."; break;
    case "armEvasion": title = "Evasion"; message = "Evasion armed."; break;
    case "disarmEvasion": title = "Evasion"; message = "Evasion disarmed."; break;
    case "beginReload": title = "Weapon reload"; message = `Reload started; ${detail.required} work required.`; break;
    case "reload": {
      const reload = detail.contribution?.public;
      title = "Weapon reload";
      message = reload?.complete ? "Reload complete." : reload ? `Reload progress: ${reload.current} of ${reload.required} work.` : "";
      break;
    }
    case "cancelReload": title = "Weapon reload"; message = "Reload canceled."; break;
    case "repair": title = "Damage control"; message = detail.check?.success ? `Repair succeeded: ${detail.change.before} → ${detail.change.after}.` : "Repair check failed; condition unchanged."; break;
    case "recoveryWork": title = "Subsystem recovery"; message = detail.complete ? "Subsystem recovery complete." : `Recovery progress: ${detail.current} of ${detail.required} work.`; break;
    case "hullRepair": title = "Hull repair"; message = `Restored ${detail.repaired} hull; hull now ${detail.hull}.`; break;
    case "cooling": title = "Active cooling"; message = `Removed ${detail.removed} heat; heat now ${detail.heat}.`; break;
    case "vent": title = "Emergency vent"; message = `Removed ${detail.removed} heat; heat now ${detail.heat}.`; break;
    case "contributeWork": title = "Work"; message = detail.complete ? "Work job complete." : `Work progress: ${detail.current} of ${detail.required} work.`; break;
    case "routePower": {
      title = "Power routing";
      const changes = detail.tierChanges ?? [];
      message = changes.length
        ? `Power: ${changes.map(({ system, from, to }) => `${system} ${from} → ${to}`).join("; ")}.`
        : "Power routing unchanged.";
      break;
    }
    case "toggleWeapon": title = "Weapon power"; message = `${detail.from?.status ?? "off"} → ${detail.to?.status ?? "off"}.`; break;
    case "routeDefense": title = "Shield routing"; message = `Shields: ${detail.totalAllocation} routed, ${detail.totalHp} online.`; break;
    case "operation.rejected": title = event.title ?? "Ship operation failed"; message = event.message; break;
    // Bookkeeping and routine transforms are still persisted, but never produce chat cards.
    case "rotate":
    case "reposition":
    case "enterCombat":
    case "leaveCombat":
    case "setRoster":
    case "refreshResources":
    case "spendResource":
    case "takeControl":
    case "endPhase":
    case "startPhase":
    case "resolveFate":
      return null;
    default:
      // Explicit prose notices are allowed; unknown technical event payloads are not.
      title = event.title ?? event.label ?? "Ship event";
      message = event.message ?? event.summary ?? event.text;
  }
  return typeof message === "string" && message ? { title, message } : null;
}

/** Render only approved prose, never event payloads or trusted HTML. */
export function renderShipEvent(event) {
  const presentation = eventPresentation(event);
  if (!presentation) return "";
  return `<section class="vira-ship-event"><h3>${escape(presentation.title)}</h3><p>${escape(presentation.message)}</p></section>`;
}

function speakerData(speaker) {
  return speaker ?? foundry.documents.ChatMessage.implementation.getSpeaker({ alias: CHAT_ALIAS });
}

async function createMessages(events, { speaker, whisper, visibility } = {}) {
  if (!Array.isArray(events)) return [];
  const messageData = [];
  for (const event of events) {
    const content = renderShipEvent(event);
    if (!content) continue;
    messageData.push({
      speaker: speakerData(speaker),
      content,
      ...(whisper?.length ? { whisper } : {}),
      flags: { [MODULE_ID]: { shipEvent: true, visibility } },
    });
  }
  if (!messageData.length) return [];
  return foundry.documents.ChatMessage.implementation.createDocuments(messageData);
}

function gmWhisperIds() {
  return (game.users ?? []).filter((user) => user.isGM).map((user) => user.id);
}

/**
 * Attack cards come exclusively from the GM-channel detail (the public payload is
 * deliberately sanitized), so their chat messages are created here. A card is
 * player-visible when the attacker ship is player-accessible, or when the module
 * setting opts into public NPC cards; otherwise it is a GM-only whisper.
 */
async function createAttackMessages(attackEvents, options = {}) {
  if (!Array.isArray(attackEvents) || !attackEvents.length) return [];
  const whisper = gmWhisperIds();
  const publicData = [];
  const whisperData = [];
  for (const event of attackEvents) {
    const content = renderAttackCard(event) || renderShipEvent(event);
    if (!content) continue;
    if (attackVisibilitySetting() === "all" || attackerIsPlayerFacing(event.sourceUuid)) {
      publicData.push({
        speaker: attackerSpeaker(event.sourceUuid),
        content,
        flags: { [MODULE_ID]: { shipEvent: true, visibility: "public", attackCard: true } },
      });
    } else if (whisper.length) {
      whisperData.push({
        speaker: attackerSpeaker(event.sourceUuid),
        content,
        whisper,
        flags: { [MODULE_ID]: { shipEvent: true, visibility: "gm", attackCard: true } },
      });
    }
  }
  const [publicMessages, whisperMessages] = await Promise.all([
    publicData.length
      ? foundry.documents.ChatMessage.implementation.createDocuments(publicData)
      : [],
    whisperData.length
      ? foundry.documents.ChatMessage.implementation.createDocuments(whisperData)
      : [],
  ]);
  return [...publicMessages, ...whisperMessages];
}

/** Create ordinary player-visible chat messages from sanitized public events only. */
export function createPublicEventMessages(publicEvents, options = {}) {
  const visible = (Array.isArray(publicEvents) ? publicEvents : [])
    .filter((event) => event?.type !== "attack");
  return createMessages(visible, { speaker: options.speaker, visibility: "public" });
}

/** Create readable notices from the GM channel, whispered only to GM users. */
export function createGmEventMessages(gmEvents, options = {}) {
  const whisper = gmWhisperIds();
  if (!whisper.length) return Promise.resolve([]);
  const visible = (Array.isArray(gmEvents) ? gmEvents : [])
    .filter((event) => event?.type !== "attack");
  return createMessages(visible, { speaker: options.speaker, whisper, visibility: "gm" });
}

/** Publish the two visibility channels without ever combining their event data. */
export async function publishOperationEvents(result, options = {}) {
  if (!result || typeof result !== "object") return { publicMessages: [], gmMessages: [], attackMessages: [] };
  const gmEvents = Array.isArray(result.gmEvents) ? result.gmEvents : [];
  const [publicMessages, gmMessages, attackMessages] = await Promise.all([
    createPublicEventMessages(result.publicEvents, options),
    createGmEventMessages(gmEvents, options),
    createAttackMessages(
      gmEvents.filter((event) => event?.type === "attack"),
      options,
    ),
  ]);
  return { publicMessages, gmMessages, attackMessages };
}

/**
 * Chat cards render outside any module Application, so Foundry's on-demand style
 * loading may never fire for them; make sure the card stylesheet is in the document.
 */
export function ensureChatCardStyles() {
  if (typeof document === "undefined") return;
  if ([...document.styleSheets].some((sheet) => (sheet.href ?? "").includes("styles/chat-card.css"))) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `modules/${MODULE_ID}/styles/chat-card.css`;
  document.head.appendChild(link);
}
