import {
  COMPONENT_CLASSES,
  DRIVE_ROLES,
  MOUNT_SIZES,
  SCHEMA_VERSION,
} from "../constants.js";

const { NumberField, ObjectField, StringField } = foundry.data.fields;

const ItemDataModel = globalThis.dnd5e?.dataModels?.abstract?.ItemDataModel ?? class {};
const ItemDescriptionTemplate = globalThis.dnd5e?.dataModels?.item?.ItemDescriptionTemplate;
const PhysicalItemTemplate = globalThis.dnd5e?.dataModels?.item?.PhysicalItemTemplate;

const BaseClass = (ItemDescriptionTemplate && PhysicalItemTemplate && typeof ItemDataModel.mixin === "function")
  ? ItemDataModel.mixin(ItemDescriptionTemplate, PhysicalItemTemplate)
  : ItemDataModel;

/** @extends {dnd5e.dataModels.abstract.ItemDataModel} */
export class ShipComponentDataModel extends BaseClass {
  /** @returns {Record<string, foundry.data.fields.DataField>} */
  static defineSchema() {
    const fields = foundry.data.fields;
    const schema = {
      schemaVersion: new fields.NumberField({
        required: true,
        nullable: false,
        integer: true,
        min: 1,
        initial: SCHEMA_VERSION,
      }),
      componentClass: new fields.StringField({
        required: true,
        nullable: false,
        blank: false,
        choices: COMPONENT_CLASSES,
        initial: "reactor",
      }),
      size: new fields.StringField({
        required: true,
        nullable: false,
        blank: false,
        choices: MOUNT_SIZES,
        initial: "medium",
      }),
      driveRole: new fields.StringField({
        required: true,
        nullable: false,
        blank: true,
        choices: DRIVE_ROLES,
        initial: "",
      }),
      definition: new fields.ObjectField({
        required: true,
        nullable: false,
        initial: () => ({}),
      }),
    };
    return typeof super.defineSchema === "function" && typeof this.mergeSchema === "function"
      ? this.mergeSchema(super.defineSchema(), schema)
      : schema;
  }
}
