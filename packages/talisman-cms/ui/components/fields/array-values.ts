import { getPresetComponentSlug, insertArrayItem, moveArrayItem } from '../../lib/page-builder';

// Changes to array and slot values go through the TanStack Form field API, so validation and the
// dirty state follow. Each one blurs the field, which runs its validators.

/** Adds a value to a slot: appended when the slot hasMany, otherwise it becomes the slot's value. */
export function addSlotValue(slot: any, fieldApi: any, nextValue: any) {
  if (slot.hasMany) {
    fieldApi.pushValue(nextValue);
    return;
  }

  fieldApi.handleChange(nextValue);
  fieldApi.handleBlur();
}

export function removeSlotValue(slot: any, fieldApi: any, index: number) {
  if (slot.hasMany) {
    fieldApi.removeValue(index);
    return;
  }

  fieldApi.handleChange(null);
  fieldApi.handleBlur();
}

export function reorderFieldArrayValue(fieldApi: any, fromIndex: number, toIndex: number) {
  const currentValue = Array.isArray(fieldApi.state.value) ? fieldApi.state.value : [];
  const nextValue = moveArrayItem(currentValue, fromIndex, toIndex);

  if (nextValue === currentValue) {
    return;
  }

  fieldApi.handleChange(nextValue);
  fieldApi.handleBlur();
}

export function insertFieldArrayValue(fieldApi: any, index: number, nextValue: any) {
  const currentValue = Array.isArray(fieldApi.state.value) ? fieldApi.state.value : [];
  fieldApi.handleChange(insertArrayItem(currentValue, index, nextValue));
  fieldApi.handleBlur();
}

/** Inserts at `index` in a hasMany slot; without an index, or in a single slot, adds instead. */
export function insertSlotValue(slot: any, fieldApi: any, index: number | null, nextValue: any) {
  if (!slot.hasMany || index === null) {
    addSlotValue(slot, fieldApi, nextValue);
    return;
  }

  insertFieldArrayValue(fieldApi, index, nextValue);
}

/** The saved presets a slot accepts: those made from one of its component types. */
export function getAllowedPresetEntries(slot: any, presetEntries: any[]) {
  const allowedComponentSlugs = new Set((slot.components || []).map((component: any) => component.slug));
  return presetEntries.filter((preset) => allowedComponentSlugs.has(getPresetComponentSlug(preset)));
}
