import { SCHEMA_VERSION } from "../constants.js";

const { NumberField, ObjectField, SchemaField } = foundry.data.fields;

/** @extends {dnd5e.dataModels.actor.VehicleData} */
export class ShipDataModel extends globalThis.dnd5e.dataModels.actor.VehicleData {
  /** @returns {Record<string, foundry.data.fields.DataField>} */
  static defineSchema() {
    return this.mergeSchema(super.defineSchema(), {
      shipCombat: new SchemaField({
        schemaVersion: new NumberField({
          required: true,
          nullable: false,
          integer: true,
          min: 1,
          initial: SCHEMA_VERSION
        }),
        config: new ObjectField({
          required: true,
          nullable: false,
          initial: () => ({ schemaVersion: SCHEMA_VERSION })
        }),
        state: new ObjectField({
          required: true,
          nullable: false,
          initial: () => ({ schemaVersion: SCHEMA_VERSION })
        })
      })
    });
  }
}
