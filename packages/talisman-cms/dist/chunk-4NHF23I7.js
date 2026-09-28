// src/migrations.ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
function leadingNumber(name) {
  return parseInt(name.split("_")[0], 10);
}
function compareMigrationNames(a, b) {
  const aNumber = leadingNumber(a);
  const bNumber = leadingNumber(b);
  if (aNumber !== bNumber) {
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    if (Number.isFinite(aNumber)) return -1;
    if (Number.isFinite(bNumber)) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
function sqlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".sql") && !entry.name.startsWith(".")).map((entry) => entry.name);
}
function sourceFiles(source) {
  const files = [];
  for (const entry of readdirSync(source.dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(source.dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink() && statSync(path).isDirectory()) {
      const migration = join(path, "migration.sql");
      if (existsSync(migration)) files.push({ name: `${entry.name}.sql`, source: source.name, path: migration });
    } else if (entry.name.endsWith(".sql")) {
      files.push({ name: entry.name, source: source.name, path });
    }
  }
  return files;
}
function listMigrationSources(sources) {
  const files = [];
  for (const source of sources) {
    if (!existsSync(source.dir)) {
      throw new Error(`[talisman-cms] ${source.name}: migrations folder ${source.dir} does not exist.`);
    }
    files.push(...sourceFiles(source));
  }
  files.sort((a, b) => compareMigrationNames(a.name, b.name));
  const problems = [];
  const byName = /* @__PURE__ */ new Map();
  const byNumber = /* @__PURE__ */ new Map();
  for (const file of files) {
    byName.set(file.name, [...byName.get(file.name) || [], file]);
    const number = leadingNumber(file.name);
    if (Number.isFinite(number)) byNumber.set(number, [...byNumber.get(number) || [], file]);
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) problems.push(`${name} is shipped by ${owners.map((file) => file.source).join(" and ")}`);
  }
  for (const [number, owners] of byNumber) {
    const distinct = [...new Set(owners.map((file) => file.name))];
    if (distinct.length > 1) {
      problems.push(`${owners.map((file) => `${file.name} (${file.source})`).join(" and ")} share the number ${number}`);
    }
  }
  if (problems.length) {
    throw new Error(`[talisman-cms] Migrations conflict: ${problems.join("; ")}. The number before the first "_" orders the migrations of the core and every plugin in one folder, so each must be unique; generate the migration again to give it a new timestamp.`);
  }
  return files;
}
function previouslyAssembled(outDir) {
  const path = join(outDir, "sources.json");
  if (!existsSync(path)) return /* @__PURE__ */ new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed.map((entry) => entry?.name).filter((name) => typeof name === "string") : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function assembleMigrations({ sources, outDir }) {
  const files = listMigrationSources(sources);
  mkdirSync(outDir, { recursive: true });
  const wanted = new Set(files.map((file) => file.name));
  const previous = previouslyAssembled(outDir);
  for (const name of sqlFiles(outDir)) {
    if (wanted.has(name)) continue;
    if (!previous.has(name)) {
      throw new Error(`[talisman-cms] ${join(outDir, name)} was not written by the migrations assembler and no package ships it. The assembled folder holds only the migrations of the core and its plugins; keep the site's own migrations in another folder, under a second D1 binding with its own migrations_table.`);
    }
    rmSync(join(outDir, name));
  }
  for (const file of files) copyFileSync(file.path, join(outDir, file.name));
  writeFileSync(join(outDir, "sources.json"), `${JSON.stringify(files.map(({ name, source }) => ({ name, source })), null, 2)}
`);
  return files;
}

export {
  compareMigrationNames,
  listMigrationSources,
  assembleMigrations
};
