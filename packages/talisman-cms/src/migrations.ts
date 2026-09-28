import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A package that ships D1 migrations: `NNNN_name.sql` files directly in `dir`. */
export interface MigrationSource {
  /** The owner named in errors and in the assembled folder's `sources.json`, normally the package name. */
  name: string;
  /** An absolute path to the folder holding the `.sql` files. */
  dir: string;
}

export interface MigrationFile {
  /** The file name, which `wrangler d1 migrations apply` records in `d1_migrations` and which must never change. */
  name: string;
  /** The `name` of the source that ships it. */
  source: string;
  /** The absolute path of the file in its source. */
  path: string;
}

function leadingNumber(name: string) {
  return parseInt(name.split('_')[0], 10);
}

/**
 * Wrangler's order for the files of a migrations folder: by the number before the first `_`, files
 * without one last, ties by plain string comparison. One sequence therefore runs across every source.
 */
export function compareMigrationNames(a: string, b: string) {
  const aNumber = leadingNumber(a);
  const bNumber = leadingNumber(b);
  if (aNumber !== bNumber) {
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    if (Number.isFinite(aNumber)) return -1;
    if (Number.isFinite(bNumber)) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The `.sql` files directly in a folder, as wrangler lists them (no dotfiles, no subfolders). */
function sqlFiles(dir: string) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.sql') && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/**
 * The migrations of every source in the order wrangler applies them. Two sources may not ship a file
 * of the same name, nor two files with the same leading number: a name, once applied to a database,
 * identifies that migration for good, and a number shared by two files would order them by chance.
 */
export function listMigrationSources(sources: MigrationSource[]): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const source of sources) {
    if (!existsSync(source.dir)) {
      throw new Error(`[talisman-cms] ${source.name}: migrations folder ${source.dir} does not exist.`);
    }
    for (const name of sqlFiles(source.dir)) files.push({ name, source: source.name, path: join(source.dir, name) });
  }
  files.sort((a, b) => compareMigrationNames(a.name, b.name));

  const problems: string[] = [];
  const byName = new Map<string, MigrationFile[]>();
  const byNumber = new Map<number, MigrationFile[]>();
  for (const file of files) {
    byName.set(file.name, [...(byName.get(file.name) || []), file]);
    const number = leadingNumber(file.name);
    if (Number.isFinite(number)) byNumber.set(number, [...(byNumber.get(number) || []), file]);
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) problems.push(`${name} is shipped by ${owners.map((file) => file.source).join(' and ')}`);
  }
  for (const [number, owners] of byNumber) {
    const distinct = [...new Set(owners.map((file) => file.name))];
    if (distinct.length > 1) {
      problems.push(`${owners.map((file) => `${file.name} (${file.source})`).join(' and ')} share the number ${number}`);
    }
  }
  if (problems.length) {
    throw new Error(`[talisman-cms] Migrations conflict: ${problems.join('; ')}. One sequence of numbers runs across the core and every plugin, so the next migration anywhere takes the number after the highest one in use.`);
  }
  return files;
}

/** The file names an earlier run wrote into `outDir`, from its `sources.json`; none without one. */
function previouslyAssembled(outDir: string): Set<string> {
  const path = join(outDir, 'sources.json');
  if (!existsSync(path)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed.map((entry) => entry?.name).filter((name): name is string => typeof name === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Copies the migrations of every source into `outDir`, the one folder a D1 binding's `migrations_dir`
 * can point at, removing `.sql` files it wrote on an earlier run that no source ships any more.
 * `sources.json` beside them names each file's owner. Returns the files in wrangler's order.
 *
 * A `.sql` file in `outDir` that no source ships and no earlier run wrote is somebody's own migration:
 * wrangler would apply it with the others, and deleting it would lose it without a word, so it is refused.
 */
export function assembleMigrations({ sources, outDir }: { sources: MigrationSource[]; outDir: string }): MigrationFile[] {
  const files = listMigrationSources(sources);
  mkdirSync(outDir, { recursive: true });
  const wanted = new Set(files.map((file) => file.name));
  const previous = previouslyAssembled(outDir);
  for (const name of sqlFiles(outDir)) {
    if (wanted.has(name)) continue;
    if (!previous.has(name)) {
      throw new Error(`[talisman-cms] ${join(outDir, name)} was not written by the migrations assembler and no package ships it. The assembled folder holds only the migrations of the core and its plugins; keep the site's own migrations in another folder, applied through a second D1 binding.`);
    }
    rmSync(join(outDir, name));
  }
  for (const file of files) copyFileSync(file.path, join(outDir, file.name));
  writeFileSync(join(outDir, 'sources.json'), `${JSON.stringify(files.map(({ name, source }) => ({ name, source })), null, 2)}\n`);
  return files;
}
