import path from 'node:path';
import process from 'node:process';
import {
  buildCoverageReport,
  createGeneratedSource,
  ensureRendererStubs,
  formatCoverageReport,
  mergeManifestWithUpstreamCatalog,
  readManifest,
  readUpstreamCatalog,
  validateManifest,
  writeGeneratedSourceFile,
  writeJson,
} from '../../talisman-cms/scripts/ui-library-manifest.mjs';

const cwd = process.cwd();
const manifestPath = path.join(cwd, 'catalog.manifest.json');
const upstreamCatalogPath = path.join(cwd, 'catalog.upstream.json');

function getGeneratedFilePath(manifest) {
  return path.join(cwd, manifest.generation.generatedFilePath);
}

function exitWithErrors(errors) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

function loadInputs() {
  const manifest = readManifest(manifestPath);
  const upstreamCatalog = readUpstreamCatalog(upstreamCatalogPath);
  return { manifest, upstreamCatalog };
}

function runGenerate() {
  const { manifest, upstreamCatalog } = loadInputs();
  const validation = validateManifest(manifest, upstreamCatalog);
  if (validation.errors.length > 0) {
    exitWithErrors(validation.errors);
  }

  const source = createGeneratedSource({
    manifest,
    libraryExportName: 'daisyUiLibrary',
    pluginExportName: 'daisyUiPlugin',
  });

  writeGeneratedSourceFile(getGeneratedFilePath(manifest), source);
  const createdStubs = ensureRendererStubs(manifest, cwd);
  console.log(`Generated ${manifest.generation.generatedFilePath}`);
  if (createdStubs.length > 0) {
    console.log(`Created renderer stubs: ${createdStubs.join(', ')}`);
  }
}

function runCoverage(json) {
  const { manifest, upstreamCatalog } = loadInputs();
  const validation = validateManifest(manifest, upstreamCatalog);
  const report = buildCoverageReport(manifest, upstreamCatalog);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatCoverageReport(report));
  }

  if (validation.errors.length > 0) {
    process.exit(1);
  }
}

function runImportCatalog(importPathArg) {
  const manifest = readManifest(manifestPath);
  const importPath = importPathArg ? path.resolve(cwd, importPathArg) : upstreamCatalogPath;
  const upstreamCatalog = readUpstreamCatalog(importPath);
  const mergedManifest = mergeManifestWithUpstreamCatalog(manifest, upstreamCatalog);
  writeJson(manifestPath, mergedManifest);
  console.log(`Merged ${upstreamCatalog.length} upstream items into catalog.manifest.json`);
}

const command = process.argv[2];

if (command === 'generate') {
  runGenerate();
} else if (command === 'coverage') {
  runCoverage(process.argv.includes('--json'));
} else if (command === 'import-catalog') {
  runImportCatalog(process.argv[3]);
} else {
  console.error('Usage: node ./scripts/catalog.mjs <generate|coverage|import-catalog> [--json|path]');
  process.exit(1);
}
