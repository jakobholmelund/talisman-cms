import React, { useContext, useId } from 'react';
import { Button } from '../ui/button';
import { MediaFieldInput } from '../MediaFieldInput';
import { formatFieldErrors, PageBuilderComposer, ServerFieldErrorsContext } from '../PageBuilderComposer';
import { RichTextEditor } from '../RichTextEditor';
import { buildDefaultValues, isRelationshipFieldType } from '../../lib/page-builder';
import { RelationFieldSummary } from './RelationFieldSummary';
import { RelationshipPicker } from './RelationshipPicker';
import type { RelationOptions, RelationSupportEntries } from './relations';

/** The admin API base path (normally /admin) for controls that call the API, such as the media field. */
export const AdminBasePathContext = React.createContext('/admin');

export type FieldRendererProps = {
  field: any;
  form: any;
  /** The form path of the value that holds this field: '' at the top level, `layout[0]` inside a block. */
  fieldPath: string;
  relationOptions: RelationOptions;
  relationSupportEntries: RelationSupportEntries;
  /** Where the page builder remembers collapsed cards; the editor derives one key per entry. */
  collapseStorageKey?: string;
};

// A date input takes YYYY-MM-DD only, so a stored ISO timestamp is trimmed to its date.
function toInputValue(field: any, value: unknown) {
  if (value === undefined || value === null) return '';
  return field.type === 'date' && typeof value === 'string' ? value.slice(0, 10) : (value as any);
}

/**
 * Renders one configured field of a form: a native control, a relation picker, rich text, media,
 * a group, an array of rows or the page builder for a blocks field. Nested fields go through the
 * same switch, so an entry and a global look and behave the same. Server errors and their
 * clearing come from ServerFieldErrorsContext; without a provider the field shows client errors only.
 */
export function FieldRenderer({ field, form, fieldPath, relationOptions, relationSupportEntries, collapseStorageKey }: FieldRendererProps) {
  const fieldName = fieldPath ? `${fieldPath}.${field.name}` : field.name;
  // Links each label to its control, and each control to its error message.
  const controlId = useId();
  const labelId = `${controlId}-label`;
  const errorId = `${controlId}-error`;
  const adminBasePath = useContext(AdminBasePathContext);
  const { errors: serverFieldErrors, clearError: clearServerFieldError } = useContext(ServerFieldErrorsContext);
  const getErrorMessages = (fieldApi: any) =>
    [...new Set([...formatFieldErrors(fieldApi.state.meta.errors), ...(serverFieldErrors[fieldName] || [])])];
  const nestedProps = { form, relationOptions, relationSupportEntries, collapseStorageKey };

  if (field.type === 'array') {
    return (
      <form.Field
        name={fieldName}
        mode="array"
        children={(fieldApi: any) => {
          const value = fieldApi.state.value || [];
          const errorMessages = getErrorMessages(fieldApi);
          return (
            <div role="group" aria-labelledby={labelId} className="border border-white/10 rounded-lg p-5 space-y-4 bg-zinc-950/40 shadow-inner">
              <div className="flex items-center justify-between pb-3 border-b border-white/5">
                <div id={labelId} className="text-sm font-medium text-zinc-300">{field.label}</div>
                <Button size="sm" variant="outline" type="button" onClick={() => { clearServerFieldError(fieldName); fieldApi.pushValue(buildDefaultValues(field.fields)); }}>Add Row</Button>
              </div>
              {errorMessages.length > 0 && (
                <p role="alert" className="text-xs text-red-500">{errorMessages.join(', ')}</p>
              )}
              {value.map((_: any, i: number) => (
                <div key={i} role="group" aria-label={`${field.label} row ${i + 1}`} className="p-5 border border-white/5 bg-white/[0.02] rounded-lg relative group transition-colors hover:bg-white/[0.04]">
                  <Button
                    size="sm"
                    variant="destructive"
                    type="button"
                    aria-label={`Remove ${field.label} row ${i + 1}`}
                    className="absolute -right-2 -top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity h-6 w-6 p-0 rounded-full"
                    onClick={() => { clearServerFieldError(fieldName); fieldApi.removeValue(i); }}
                  >
                    &times;
                  </Button>
                  <div className="space-y-4">
                    {field.fields?.map((subField: any) => (
                      <FieldRenderer key={subField.name} field={subField} fieldPath={`${fieldName}[${i}]`} {...nestedProps} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        }}
      />
    );
  }

  if (field.type === 'blocks') {
    return (
      <PageBuilderComposer
        field={field}
        fieldName={fieldName}
        form={form}
        relationSupportEntries={relationSupportEntries}
        collapseStorageKey={collapseStorageKey}
        renderField={(nestedField, nestedFieldPath) => (
          <FieldRenderer key={`${nestedFieldPath}:${nestedField.name}`} field={nestedField} fieldPath={nestedFieldPath} {...nestedProps} />
        )}
      />
    );
  }

  if (field.type === 'group') {
    return (
      <div role="group" aria-labelledby={labelId} className="border border-white/10 rounded-lg p-5 space-y-4 bg-zinc-950/40 shadow-inner">
        <div className="pb-3 border-b border-white/5">
          <div id={labelId} className="text-sm font-medium text-zinc-300">{field.label}</div>
        </div>
        <div className="space-y-4">
          {field.fields?.map((subField: any) => (
            <FieldRenderer key={subField.name} field={subField} fieldPath={fieldName} {...nestedProps} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <form.Field
      name={fieldName}
      children={(fieldApi: any) => {
        const errorMessages = getErrorMessages(fieldApi);
        const hasError = errorMessages.length > 0;
        const describedBy = hasError ? errorId : undefined;
        // Shared by the native controls: the label names them, the error describes them.
        const controlProps = {
          id: controlId,
          'aria-invalid': hasError || undefined,
          'aria-describedby': describedBy,
          'aria-required': field.required || undefined,
        };
        // Relation pickers and rich text are not single form controls, so they take the label by id.
        const labelNamesGroup = isRelationshipFieldType(field.type) || field.type === 'richtext';
        // A server error describes the value that was sent; drop it once the user edits the field.
        const handleValueChange = (nextValue: any) => {
          if (serverFieldErrors[fieldName]) clearServerFieldError(fieldName);
          fieldApi.handleChange(nextValue);
        };
        return (
          <div className="space-y-2">
            {field.type !== 'boolean' && (labelNamesGroup ? (
              <div id={labelId} className="text-sm font-medium block text-zinc-300">
                {field.label} {field.required && <span aria-hidden="true" className="text-red-400">*</span>}
              </div>
            ) : (
              <label id={labelId} htmlFor={controlId} className="text-sm font-medium block text-zinc-300">
                {field.label} {field.required && <span aria-hidden="true" className="text-red-400">*</span>}
              </label>
            ))}

            {field.type === 'media' ? (
              <MediaFieldInput
                inputId={controlId}
                describedBy={describedBy}
                invalid={hasError}
                required={Boolean(field.required)}
                adminBasePath={adminBasePath}
                value={(fieldApi.state.value as string) || ''}
                onChange={handleValueChange}
                onBlur={fieldApi.handleBlur}
              />
            ) : field.type === 'textarea' ? (
              <textarea
                {...controlProps}
                value={(fieldApi.state.value as string) || ''}
                onChange={(e) => handleValueChange(e.target.value)}
                onBlur={fieldApi.handleBlur}
                className={`w-full bg-zinc-950/50 border rounded-md p-3 text-sm focus:outline-none focus:ring-2 transition-all shadow-inner ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
              />
            ) : field.type === 'select' ? (
              <select
                {...controlProps}
                value={(fieldApi.state.value as string) || ''}
                onChange={(e) => handleValueChange(e.target.value)}
                onBlur={fieldApi.handleBlur}
                className={`w-full bg-zinc-950/50 border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all shadow-inner ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
              >
                <option value="">Select an option...</option>
                {(field.options || []).map((option: string) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : isRelationshipFieldType(field.type) ? (
              <RelationshipPicker
                field={field}
                value={fieldApi.state.value}
                onChange={handleValueChange}
                onBlur={fieldApi.handleBlur}
                relationOptions={relationOptions}
                relationSupportEntries={relationSupportEntries}
                labelId={labelId}
                describedBy={describedBy}
              />
            ) : field.type === 'richtext' ? (
              <RichTextEditor
                value={fieldApi.state.value} // ensure value format works with block editor
                onChange={(val: any) => handleValueChange(val)}
                hasError={hasError}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
              />
            ) : field.type === 'boolean' ? (
              <div className="flex items-center gap-2">
                <input
                  {...controlProps}
                  type="checkbox"
                  checked={!!fieldApi.state.value}
                  onChange={(e) => handleValueChange(e.target.checked)}
                  onBlur={fieldApi.handleBlur}
                  className="w-4 h-4 rounded border-zinc-700 text-indigo-500 focus:ring-indigo-500 bg-zinc-950"
                />
                <label id={labelId} htmlFor={controlId} className="text-sm font-medium">
                  {field.label} {field.required && <span aria-hidden="true" className="text-red-500">*</span>}
                </label>
              </div>
            ) : (
              <input
                {...controlProps}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                value={toInputValue(field, fieldApi.state.value)}
                // A cleared optional number is null, so saving clears it; a required one stays empty and shows "Required".
                onChange={(e) => handleValueChange(field.type === 'number' ? (e.target.value ? Number(e.target.value) : field.required ? undefined : null) : e.target.value)}
                onBlur={fieldApi.handleBlur}
                className={`w-full bg-zinc-950/50 border rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all shadow-inner ${hasError ? 'border-red-500/50 focus:ring-red-500/50' : 'border-white/10 focus:ring-indigo-500/50 focus:border-indigo-500/50'}`}
              />
            )}

            {isRelationshipFieldType(field.type) && (
              <RelationFieldSummary
                field={field}
                value={fieldApi.state.value}
                relationSupportEntries={relationSupportEntries}
              />
            )}

            {hasError && (
              <p id={errorId} role="alert" className="text-xs text-red-500">{errorMessages.join(', ')}</p>
            )}
          </div>
        );
      }}
    />
  );
}
