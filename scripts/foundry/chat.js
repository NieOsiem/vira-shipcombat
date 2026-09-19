import { MODULE_ID } from "../constants.js";
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
  const fate = fateSummary(damage?.fate);
  if (fate) parts.push(fate);
  return parts.join(" ");
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

function endPhaseSummary(detail) {
  const parts = [];
  for (const event of detail.events ?? []) {
    if (event.type === "overspeedDamage" && event.hullDamage > 0) parts.push(`Overspeed caused ${event.hullDamage} hull damage.`);
    if (event.type === "heatOverflow" && event.hullDamage > 0) parts.push(`Heat overflow caused ${event.hullDamage} hull damage.`);
    if (event.type === "hazardDamage") {
      for (const hazard of event.events ?? []) {
        if (hazard.type === "fireHullDamage" && hazard.hullDamage > 0) parts.push(`Fire caused ${hazard.hullDamage} hull damage.`);
        if (hazard.type === "breachReminder") parts.push(`Hull breach in ${hazard.region}; severity: ${hazard.severity}.`);
        if (hazard.type === "fireFault" && hazard.applied) parts.push(`Fire damaged a subsystem; severity: ${hazard.severity}.`);
      }
    }
    if (event.type === "persistentEffects") {
      for (const effect of event.applied ?? []) {
        if (effect.hullDamage > 0 || effect.heat > 0) parts.push(`Ongoing effect: ${effect.hullDamage} hull damage and ${effect.heat} heat.`);
      }
    }
  }
  const fate = fateSummary(detail.fate?.public);
  if (fate) parts.push(fate);
  return parts.join(" ");
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
    case "endPhase": title = "End-of-turn damage"; message = endPhaseSummary(detail); break;
    case "startPhase": {
      const notices = detail.deferredPassiveNotices ?? [];
      const acquired = notices.filter((notice) => notice.type === "passiveContactAcquired").length;
      const lost = notices.filter((notice) => notice.type === "trackLost").length;
      title = "Sensor contacts";
      message = acquired || lost ? `${acquired} contact(s) acquired; ${lost} track(s) lost.` : "";
      break;
    }
    case "resolveFate": title = "Ship fate"; message = fateSummary(detail); break;
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
    case "contributeWork":
    case "routePower":
    case "toggleWeapon":
    case "routeDefense":
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

/** Create ordinary player-visible chat messages from sanitized public events only. */
export function createPublicEventMessages(publicEvents, options = {}) {
  return createMessages(publicEvents, { speaker: options.speaker, visibility: "public" });
}

/** Create readable notices from the GM channel, whispered only to GM users. */
export function createGmEventMessages(gmEvents, options = {}) {
  const whisper = game.users.filter((user) => user.isGM).map((user) => user.id);
  if (!whisper.length) return Promise.resolve([]);
  return createMessages(gmEvents, { speaker: options.speaker, whisper, visibility: "gm" });
}

/** Publish the two visibility channels without ever combining their event data. */
export async function publishOperationEvents(result, options = {}) {
  if (!result || typeof result !== "object") return { publicMessages: [], gmMessages: [] };
  const [publicMessages, gmMessages] = await Promise.all([
    createPublicEventMessages(result.publicEvents, options),
    createGmEventMessages(result.gmEvents, options),
  ]);
  return { publicMessages, gmMessages };
}
