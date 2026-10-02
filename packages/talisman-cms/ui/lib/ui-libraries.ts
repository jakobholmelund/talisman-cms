// The full component catalog is needed for preset authoring, not ordinary entry editing.
let libraries: any[] = [];
let request: Promise<any[]> | null = null;
export function getLibraryDefinitions() { return libraries; }
export function loadLibraryDefinitions() {
  if (!request) {
    request = import('virtual:talisman-cms/ui-libraries').then((module) => {
      libraries = module.uiLibraries || [];
      return libraries;
    }).catch((error) => { request = null; throw error; });
  }
  return request;
}
