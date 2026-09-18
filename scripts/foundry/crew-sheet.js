import { MODULE_ID, OPERATOR_TYPES } from "../constants.js";
import {
  CREW_FEATURE_IMG,
  ensureActorCrewFeature,
  getActorCrewData,
  normalizeRatings,
} from "./crew.js";

const { ItemSheetV2 } = globalThis.foundry?.applications?.sheets ?? {};
const { HandlebarsApplicationMixin } = globalThis.foundry?.applications?.api ?? {};

const BaseClass = (HandlebarsApplicationMixin && ItemSheetV2)
  ? class extends HandlebarsApplicationMixin(ItemSheetV2) {}
  : class {};

export class CrewRatingSheet extends BaseClass {
  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "ship-crew-sheet"],
    tag: "form",
    position: { width: 520, height: "auto" },
    form: {
      closeOnSubmit: true,
      submitOnChange: false,
      handler: CrewRatingSheet.#handleSubmit,
    },
    window: {
      resizable: true,
      title: "Ship Station Qualifications",
      icon: "fa-solid fa-id-badge",
    },
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/crew-qualifications.hbs`,
    },
  };

  get actor() {
    return this.document?.parent ?? (this.document?.documentName === "Actor" ? this.document : null);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext?.(options) ?? {};
    const item = this.document?.documentName === "Item" ? this.document : null;
    const actor = this.actor;
    const crewData = actor ? getActorCrewData(actor) : {
      ratings: normalizeRatings(item?.flags?.[MODULE_ID]?.crewRole?.ratings),
      type: item?.flags?.[MODULE_ID]?.crewRole?.type ?? "pc",
      capabilities: item?.flags?.[MODULE_ID]?.crewRole?.capabilities ?? { work: true },
    };

    const typeOptions = OPERATOR_TYPES.map((type) => ({
      value: type,
      label: type.toUpperCase(),
      selected: type === crewData.type,
    }));

    return {
      ...context,
      item,
      actor,
      actorName: actor?.name ?? item?.name ?? "Crew Member",
      label: actor?.name ?? item?.name ?? "Crew Member",
      img: item?.img ?? actor?.img ?? CREW_FEATURE_IMG,
      ratings: crewData.ratings,
      typeOptions,
      capabilities: crewData.capabilities,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const html = this.element;
    if (!html) return;

    html.querySelectorAll("input[type='range']").forEach((slider) => {
      const field = slider.name.replace(/^ratings\./, "");
      const output = html.querySelector(`output[data-rating-output='${field}']`);
      slider.addEventListener("input", () => {
        if (output) output.textContent = slider.value;
      });
    });
  }

  static async #handleSubmit(event, form, formData) {
    const data = formData.object;
    const actor = this.actor;
    const item = this.document?.documentName === "Item" ? this.document : null;

    const ratings = normalizeRatings({
      piloting: data["ratings.piloting"] ?? data.ratings?.piloting,
      gunnery: data["ratings.gunnery"] ?? data.ratings?.gunnery,
      sensors: data["ratings.sensors"] ?? data.ratings?.sensors,
      engineering: data["ratings.engineering"] ?? data.ratings?.engineering,
    });

    const type = data.type ?? "pc";
    const capabilities = {
      work: Boolean(data["capabilities.work"] ?? data.capabilities?.work),
      repairDrone: Boolean(data["capabilities.repairDrone"] ?? data.capabilities?.repairDrone),
      selfRepair: Boolean(data["capabilities.selfRepair"] ?? data.capabilities?.selfRepair),
    };

    if (actor) {
      await ensureActorCrewFeature(actor, { ratings, type, capabilities });
      syncAssignedShips(actor.id, { ratings, type, capabilities, label: actor.name, img: actor.img });
    } else if (item) {
      await item.update({
        [`flags.${MODULE_ID}.isCrewRole`]: true,
        [`flags.${MODULE_ID}.crewRole`]: { ratings, type, capabilities },
      });
    }
  }
}

/**
 * Sync updated operator profile details to all active ships on canvas that currently assign this Actor.
 * @param {string} actorId
 * @param {object} profileUpdates
 */
export async function syncAssignedShips(actorId, profileUpdates) {
  // Authority writes are GM-only: players hold OBSERVER ownership of ships, so a
  // player-side sync is denied by the server and rejects without a handler.
  if (!globalThis.game?.user?.isGM) return;
  if (!globalThis.game?.actors) return;
  const ships = globalThis.game.actors.filter((a) => a.type === "vira-shipcombat.ship");
  for (const ship of ships) {
    const config = ship.system?.shipCombat?.config;
    if (!config || !Array.isArray(config.operators)) continue;
    const existingIndex = config.operators.findIndex((o) => o.actorId === actorId || o.id === `actor-${actorId}`);
    if (existingIndex !== -1) {
      const updatedOperators = [...config.operators];
      updatedOperators[existingIndex] = {
        ...updatedOperators[existingIndex],
        ...profileUpdates,
        ratings: normalizeRatings(profileUpdates.ratings ?? updatedOperators[existingIndex].ratings),
      };
      await ship.update({ "system.shipCombat.config.operators": updatedOperators });
    }
  }
}

/**
 * Open the Crew Qualifications editor for an Actor or Item.
 * @param {object} actorOrItem
 */
export async function openCrewRatingEditor(actorOrItem) {
  if (!actorOrItem) return;
  let item = null;
  if (actorOrItem.documentName === "Item") {
    item = actorOrItem;
  } else if (actorOrItem.documentName === "Actor") {
    item = await ensureActorCrewFeature(actorOrItem);
  }
  if (item) {
    new CrewRatingSheet({ document: item }).render(true);
  }
}
