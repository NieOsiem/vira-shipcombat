import { MODULE_ID, RuleViolation } from "../constants.js";
import { cloneDocumentData } from "./token-state.js";

const LOG_FLAG = "operationLog";
const LOG_MARKER = "isOperationLog";
const LOG_NAME = "Vira Ship Combat — Operation Log";
function internalOptions() {
  return { viraShipCombatInternal: true };
}

let journal = null;

function noneOwnership() {
  return globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;
}

function isMarkedLog(entry) {
  return entry?.getFlag?.(MODULE_ID, LOG_MARKER) === true
    || entry?.flags?.[MODULE_ID]?.[LOG_MARKER] === true;
}

function journalEntries() {
  const collection = globalThis.game?.journal;
  if (!collection) return [];
  return typeof collection.values === "function" ? [...collection.values()] : Array.from(collection);
}

function requireActiveGM() {
  if (!globalThis.game?.user?.isGM) {
    throw new RuleViolation("GM_ONLY", "The ship combat operation log is visible only to a GM.");
  }
}

export async function initializeOperationLog() {
  requireActiveGM();
  if (journal && !journal.invalid) return journal;
  journal = journalEntries().find(isMarkedLog) ?? null;
  const ownership = { default: noneOwnership() };
  if (!journal) {
    if (!globalThis.JournalEntry?.create) throw new Error("JournalEntry is unavailable");
    journal = await globalThis.JournalEntry.create({
      name: LOG_NAME,
      ownership,
      flags: { [MODULE_ID]: { [LOG_MARKER]: true, [LOG_FLAG]: "[]" } },
    }, internalOptions());
  } else if (journal.ownership?.default !== ownership.default
    || Object.keys(journal.ownership ?? {}).some((key) => key !== "default")) {
    await journal.update({
      ownership: foundry.data.operators.ForcedReplacement.create(ownership),
    }, internalOptions());
  }
  return journal;
}

export async function readOperationEntries() {
  requireActiveGM();
  const document = await initializeOperationLog();
  const stored = document.getFlag?.(MODULE_ID, LOG_FLAG)
    ?? document.flags?.[MODULE_ID]?.[LOG_FLAG]
    ?? "[]";
  if (Array.isArray(stored)) return cloneDocumentData(stored);
  if (typeof stored !== "string") {
    throw new RuleViolation(
      "INVALID_OPERATION_LOG",
      "The ship combat operation log flag must contain a JSON array.",
    );
  }
  let entries;
  try {
    entries = JSON.parse(stored);
  } catch (error) {
    throw new RuleViolation(
      "INVALID_OPERATION_LOG",
      "The ship combat operation log flag contains malformed JSON.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!Array.isArray(entries)) {
    throw new RuleViolation(
      "INVALID_OPERATION_LOG",
      "The ship combat operation log flag must contain a JSON array.",
    );
  }
  return cloneDocumentData(entries);
}

export async function findOperationEntry(id) {
  const entries = await readOperationEntries();
  return entries.find((entry) => entry?.id === id) ?? null;
}

export async function appendOperationEntry(entry) {
  const document = await initializeOperationLog();
  const entries = await readOperationEntries();
  const existing = entries.find((item) => item?.id === entry?.id);
  if (existing) return cloneDocumentData(existing);
  entries.push(cloneDocumentData(entry));
  await document.update({ [`flags.${MODULE_ID}.${LOG_FLAG}`]: JSON.stringify(entries) }, internalOptions());
  return cloneDocumentData(entry);
}

export async function removeOperationEntry(id) {
  const document = await initializeOperationLog();
  const entries = await readOperationEntries();
  const filtered = entries.filter((entry) => entry?.id !== id);
  if (filtered.length !== entries.length) {
    await document.update({ [`flags.${MODULE_ID}.${LOG_FLAG}`]: JSON.stringify(filtered) }, internalOptions());
  }
}


