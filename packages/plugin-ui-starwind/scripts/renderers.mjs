import { readFileSync } from 'node:fs';
import path from 'node:path';

// A supported composition must ship working source. Generation never creates a placeholder.
export function validateRenderers(manifest, packageRoot) {
  const errors = [];
  for (const item of manifest.items.filter((item) => item.coverageStatus !== 'unsupported')) {
    const relativePath = item.rendererTarget?.localFilePath;
    const file = relativePath && path.resolve(packageRoot, relativePath);
    if (!item.adapter || !file || !file.startsWith(path.resolve(packageRoot, 'src/renderers') + path.sep)) {
      errors.push(`${item.upstreamItemId}: supported item needs an adapter and a local renderer in src/renderers.`);
      continue;
    }
    try {
      const source = readFileSync(file, 'utf8');
      if (source.includes('data-talisman-ui-stub') || !/<(?:section|div|a)\b/.test(source)) {
        errors.push(`${item.upstreamItemId}: renderer is a placeholder or has no rendered composition.`);
      }
    } catch {
      errors.push(`${item.upstreamItemId}: renderer does not exist: ${relativePath}.`);
    }
  }
  return errors;
}
