// The Theme Builder imports the admin SDK (talisman-cms/ui/sdk), which reads this core virtual
// module. The types mirror packages/talisman-cms/src/virtual-modules.d.ts.
declare module 'virtual:talisman-cms/config' {
  import type { CollectionConfig, GlobalConfig } from 'talisman-cms';
  export const adminPath: string;
  export const collections: CollectionConfig[];
  export const globals: GlobalConfig[];
}
