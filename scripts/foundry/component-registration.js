import { COMPONENT_ITEM_TYPE } from "../constants.js";
import { ShipComponentDataModel } from "../model/component-model.js";

export const COMPONENT_ITEM_TYPE_LABEL = "TYPES.Item.vira-shipcombat.component";
export const COMPONENT_ITEM_DEFAULT_ART = "icons/svg/clockwork.svg";

/** Register only the module Item subtype; D&D5e remains the Item document class. */
export function registerShipComponent() {
  CONFIG.Item.dataModels[COMPONENT_ITEM_TYPE] = ShipComponentDataModel;
  CONFIG.Item.typeLabels[COMPONENT_ITEM_TYPE] = COMPONENT_ITEM_TYPE_LABEL;
  CONFIG.DND5E.defaultArtwork.Item[COMPONENT_ITEM_TYPE] = COMPONENT_ITEM_DEFAULT_ART;
}
