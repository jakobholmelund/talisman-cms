import { buildZodSchemaForFields, type UiLibraryDefinition } from './types';

export function getUiLibraryComponentDefinition(
  libraries: UiLibraryDefinition[] | undefined,
  libraryId: string | undefined,
  componentSlug: string | undefined,
) {
  if (!libraries || !libraryId || !componentSlug) return null;

  return libraries
    .find((library) => library.id === libraryId)
    ?.components?.find((componentAdapter) => componentAdapter.component.slug === componentSlug)
    ?.component || null;
}

export function parsePresetPropsJson(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { success: true as const, data: {} };
  }

  try {
    return {
      success: true as const,
      data: JSON.parse(value),
    };
  } catch (error: any) {
    return {
      success: false as const,
      error: error?.message || 'Invalid JSON',
    };
  }
}

export function validatePresetPayload(
  libraries: UiLibraryDefinition[] | undefined,
  data: Record<string, any>,
) {
  const component = getUiLibraryComponentDefinition(libraries, data.libraryId, data.componentSlug);

  if (!component) {
    return {
      success: false as const,
      issues: [
        {
          path: ['componentSlug'],
          message: 'Selected component is not registered for the chosen library.',
        }
      ],
    };
  }

  const parsedProps = parsePresetPropsJson(data.propsJson);
  if (!parsedProps.success) {
    return {
      success: false as const,
      issues: [
        {
          path: ['propsJson'],
          message: `Preset props must be valid JSON: ${parsedProps.error}`,
        }
      ],
    };
  }

  const propsSchema = buildZodSchemaForFields(component.fields);
  const validatedProps = propsSchema.safeParse(parsedProps.data);
  if (!validatedProps.success) {
    return {
      success: false as const,
      issues: validatedProps.error.issues.map((issue) => ({
        path: ['presetProps', ...issue.path],
        message: issue.message,
      })),
    };
  }

  return {
    success: true as const,
    component,
    props: validatedProps.data,
    normalizedData: {
      ...data,
      propsJson: JSON.stringify(validatedProps.data),
    },
  };
}
