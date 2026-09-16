import { ShipDataModel } from "../model/ship-model.js";

export const SHIP_ACTOR_TYPE = "vira-shipcombat.ship";
export const SHIP_ACTOR_TYPE_LABEL = "TYPES.Actor.vira-shipcombat.ship";
export const SHIP_ACTOR_DEFAULT_ART = "systems/dnd5e/icons/svg/actors/vehicle.svg";

const patchedActorClasses = new WeakSet();

/** @returns {void} */
export function registerShipActorType() {
  CONFIG.Actor.dataModels[SHIP_ACTOR_TYPE] = ShipDataModel;
  CONFIG.Actor.typeLabels[SHIP_ACTOR_TYPE] = SHIP_ACTOR_TYPE_LABEL;
  CONFIG.DND5E.defaultArtwork.Actor[SHIP_ACTOR_TYPE] = SHIP_ACTOR_DEFAULT_ART;
}

/** @returns {void} */
export function registerShipActorPrepareDataCacheReset() {
  const Actor5e = CONFIG.Actor.documentClass;
  if ( patchedActorClasses.has(Actor5e) ) return;

  const prepareData = Actor5e.prototype.prepareData;
  Actor5e.prototype.prepareData = function(...args) {
    if ( this.type === SHIP_ACTOR_TYPE ) this._clearCachedValues();
    return prepareData.apply(this, args);
  };
  patchedActorClasses.add(Actor5e);
}

/** @returns {void} */
export function registerShipActor() {
  registerShipActorType();
  registerShipActorPrepareDataCacheReset();
}
