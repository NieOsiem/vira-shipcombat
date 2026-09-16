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
          initial: 1
        }),
        config: new ObjectField({
          required: true,
          nullable: false,
          initial: () => ({ schemaVersion: 1 })
        }),
        state: new ObjectField({
          required: true,
          nullable: false,
          initial: () => ({ schemaVersion: 1 })
        })
      })
    });
  }
}
