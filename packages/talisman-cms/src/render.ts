export type RendererRegistry = Record<string, any>;

function parsePresetProps(value: unknown) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (value && typeof value === 'object') {
    return value as Record<string, any>;
  }

  return {};
}

export function buildPresetMap(presets: any[] | undefined | null) {
  const entries = presets || [];
  return Object.fromEntries(entries.map((preset) => [preset.id, preset]));
}

export function resolvePresetComponentValue(preset: any) {
  const data = typeof preset?.data === 'string' ? parsePresetProps(preset.data) : (preset?.data || {});
  const props = parsePresetProps(data?.propsJson || data?.props || {});
  return {
    componentType: data?.componentSlug || preset?.componentSlug || '',
    props,
    libraryId: data?.libraryId || preset?.libraryId || '',
    variant: data?.variant || preset?.variant || '',
    name: data?.name || preset?.name || '',
  };
}

export function mergeRendererRegistries(...registries: Array<RendererRegistry | undefined>) {
  return Object.assign({}, ...registries.filter(Boolean));
}
