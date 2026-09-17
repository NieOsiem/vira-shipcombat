import {
  COMPONENT_CLASSES,
  DRIVE_ROLES,
  MOUNT_SIZES,
  SCHEMA_VERSION,
} from "../constants.js";

const { NumberField, ObjectField, StringField } = foundry.data.fields;

/** @extends {dnd5e.dataModels.abstract.ItemDataModel} */
export class ShipComponentDataModel extends globalThis.dnd5e.dataModels.abstract.ItemDataModel {
  /** @returns {Record<string, foundry.data.fields.DataField>} */
  static defineSchema() {
    return {
      schemaVersion: new NumberField({
        required: true,
        nullable: false,
        integer: true,
        min: 1,
        initial: SCHEMA_VERSION,
      }),
      componentClass: new StringField({
        required: true,
        nullable: false,
        blank: false,
        choices: COMPONENT_CLASSES,
        initial: "reactor",
      }),
      size: new StringField({
        required: true,
        nullable: false,
        blank: false,
        choices: MOUNT_SIZES,
        initial: "medium",
      }),
      driveRole: new StringField({
        required: true,
        nullable: false,
        blank: true,
        choices: DRIVE_ROLES,
        initial: "",
      }),
      definition: new ObjectField({
        required: true,
        nullable: false,
        initial: () => ({}),
      }),
    };
  }
}
