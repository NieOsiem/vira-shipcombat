import { MODULE_ID } from "./constants.js";
import {
  DEFAULT_REFERENCE_BUILD_ID,
  referenceBuild,
  referenceBuildChoices,
} from "./data/reference-builds.js";
import {
  createDefaultShipData,
  createInitialState,
} from "./model/defaults.js";
import { validateShipConfig } from "./model/validation.js";
import { registerShipActor } from "./foundry/ship-registration.js";
import { registerShipSheet } from "./foundry/ship-sheet.js";
import { registerShipHooks } from "./foundry/hooks.js";
import { registerShipComponent } from "./foundry/component-registration.js";
import { registerShipComponentSheet } from "./foundry/component-sheet.js";
import {
  initializeShipAuthority,
  submitShipOperation,
} from "./state/action-queue.js";
import {
  clearMovementPreview,
  registerCanvasIntegration,
  setMovementPreview,
} from "./canvas/overlays.js";

const SYSTEM_ID = "dnd5e";
const MINIMUM_SYSTEM_VERSION = "5.3.3";

const api = Object.freeze({
  createDefaultShipData,
  createInitialState,
  validateShipConfig,
  submitShipOperation,
  setMovementPreview,
  clearMovementPreview,
  defaultReferenceBuildId: DEFAULT_REFERENCE_BUILD_ID,
  referenceBuild,
  referenceBuildChoices,
});

let initComplete = false;
let setupComplete = false;
let readyComplete = false;
let environmentError = null;

function getEnvironmentError() {
  const module = game.modules.get(MODULE_ID);
  if (!module?.active) {
    return "Vira Ship Combat is not active; initialization was skipped.";
  }

  if (game.system.id !== SYSTEM_ID) {
    return `Vira Ship Combat requires the active ${SYSTEM_ID} system; initialization was skipped.`;
  }

  const version = game.system.version;
  if (!version || foundry.utils.isNewerVersion(MINIMUM_SYSTEM_VERSION, version)) {
    return `Vira Ship Combat requires ${SYSTEM_ID} ${MINIMUM_SYSTEM_VERSION} or newer; found ${version ?? "an unknown version"}. Initialization was skipped.`;
  }

  return null;
}

function initializeDocuments() {
  if (initComplete) return;
  environmentError = getEnvironmentError();
  if (environmentError) return;

  registerShipComponent();
  registerShipActor();
  registerShipSheet();
  registerShipComponentSheet();
  initComplete = true;
}

function exposeApi() {
  if (setupComplete || environmentError || !initComplete) return;
  game.modules.get(MODULE_ID).api = api;
  setupComplete = true;
}

async function initializeRuntime() {
  if (readyComplete) return;
  if (environmentError) {
    ui.notifications.error(environmentError);
    readyComplete = true;
    return;
  }

  exposeApi();
  await initializeShipAuthority();
  registerShipHooks();
  registerCanvasIntegration();
  readyComplete = true;
}

Hooks.once("init", initializeDocuments);
Hooks.once("setup", exposeApi);
Hooks.once("ready", initializeRuntime);
