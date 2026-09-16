import { MODULE_ID } from "../constants.js";

const CHAT_ALIAS = "Vira Ship Combat";

function escape(value) {
  return foundry.utils.escapeHTML(value ?? "");
}

function eventTitle(event) {
  return event?.title ?? event?.label ?? event?.type ?? event?.code ?? "Ship event";
}

function eventMessage(event) {
  if (typeof event === "string") return event;
  return event?.message ?? event?.summary ?? event?.text ?? "";
}

function eventDetails(event) {
  if (!event || typeof event !== "object") return null;
  if (event.details !== undefined) return event.details;
  const details = Object.fromEntries(Object.entries(event).filter(([key]) => ![
    "title",
    "label",
    "type",
    "code",
    "message",
    "summary",
    "text",
  ].includes(key)));
  return Object.keys(details).length ? details : null;
}

/**
 * Render a rules event without ever treating event data as trusted HTML.
 * Public callers should pass only events from result.publicEvents.
 */
export function renderShipEvent(event, { includeDetails = false } = {}) {
  const title = escape(eventTitle(event));
  const message = escape(eventMessage(event));
  const details = includeDetails ? eventDetails(event) : null;
  const detailHtml = details == null
    ? ""
    : `<pre class="vira-ship-event-details">${escape(JSON.stringify(details, null, 2))}</pre>`;
  const messageHtml = message ? `<p>${message}</p>` : "";
  return `<section class="vira-ship-event"><h3>${title}</h3>${messageHtml}${detailHtml}</section>`;
}

function speakerData(speaker) {
  return speaker ?? foundry.documents.ChatMessage.implementation.getSpeaker({ alias: CHAT_ALIAS });
}

async function createMessages(events, { speaker, whisper, includeDetails, visibility } = {}) {
  const list = Array.isArray(events) ? events.filter((event) => event != null) : [];
  if (!list.length) return [];
  const messageData = list.map((event) => ({
    speaker: speakerData(speaker),
    content: renderShipEvent(event, { includeDetails }),
    ...(whisper?.length ? { whisper } : {}),
    flags: { [MODULE_ID]: { shipEvent: true, visibility } },
  }));
  return foundry.documents.ChatMessage.implementation.createDocuments(messageData);
}

/** Create ordinary player-visible chat messages from sanitized public events only. */
export function createPublicEventMessages(publicEvents, options = {}) {
  return createMessages(publicEvents, {
    speaker: options.speaker,
    includeDetails: true,
    visibility: "public",
  });
}

/** Create full-detail whispers visible to GM users only. */
export function createGmEventMessages(gmEvents, options = {}) {
  const whisper = game.users
    .filter((user) => user.isGM)
    .map((user) => user.id);
  if (!whisper.length) return Promise.resolve([]);
  return createMessages(gmEvents, {
    speaker: options.speaker,
    whisper,
    includeDetails: true,
    visibility: "gm",
  });
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
