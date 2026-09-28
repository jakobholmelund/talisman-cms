/**
 * A package that ships D1 migrations. `dir` holds them as drizzle-kit writes them, one folder per
 * migration named `<timestamp>_<name>` with a `migration.sql` inside (its `snapshot.json` is
 * drizzle-kit's own state), or as plain `<number>_<name>.sql` files. Both may be mixed.
 */
interface MigrationSource {
    /** The owner named in errors and in the assembled folder's `sources.json`, normally the package name. */
    name: string;
    /** An absolute path to the folder holding the migrations. */
    dir: string;
}
interface MigrationFile {
    /**
     * The file name in the assembled folder, `<timestamp>_<name>.sql`, which `wrangler d1 migrations
     * apply` records in `d1_migrations` and which must never change.
     */
    name: string;
    /** The `name` of the source that ships it. */
    source: string;
    /** The absolute path of the SQL file in its source. */
    path: string;
}
/**
 * Wrangler's order for the files of a migrations folder: by the number before the first `_`, files
 * without one last, ties by plain string comparison. drizzle-kit's timestamp prefixes
 * (`20260928143407_core_schema`) order the files of every source by the moment they were generated.
 */
declare function compareMigrationNames(a: string, b: string): number;
/**
 * The migrations of every source in the order wrangler applies them. Two sources may not ship a
 * migration of the same name, nor two with the same leading number: a name, once applied to a
 * database, identifies that migration for good, and a number shared by two files would order them
 * by chance. drizzle-kit's timestamps keep the numbers apart without any coordination between
 * packages, as long as no two migrations are generated in the same second.
 */
declare function listMigrationSources(sources: MigrationSource[]): MigrationFile[];
/**
 * Copies the migrations of every source into `outDir`, the one folder a D1 binding's `migrations_dir`
 * can point at, as flat `<name>.sql` files, removing the ones it wrote on an earlier run that no
 * source ships any more. `sources.json` beside them names each file's owner. Returns the files in
 * wrangler's order.
 *
 * A `.sql` file in `outDir` that no source ships and no earlier run wrote is somebody's own migration:
 * wrangler would apply it with the others, and deleting it would lose it without a word, so it is refused.
 */
declare function assembleMigrations({ sources, outDir }: {
    sources: MigrationSource[];
    outDir: string;
}): MigrationFile[];

export { type MigrationFile, type MigrationSource, assembleMigrations, compareMigrationNames, listMigrationSources };
