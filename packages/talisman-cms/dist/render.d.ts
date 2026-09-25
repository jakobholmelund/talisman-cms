type RendererRegistry = Record<string, any>;
declare function buildPresetMap(presets: any[] | undefined | null): any;
declare function resolvePresetComponentValue(preset: any): {
    componentType: any;
    props: any;
    libraryId: any;
    variant: any;
    name: any;
};
declare function mergeRendererRegistries(...registries: Array<RendererRegistry | undefined>): any;

export { type RendererRegistry, buildPresetMap, mergeRendererRegistries, resolvePresetComponentValue };
