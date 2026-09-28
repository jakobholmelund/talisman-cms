/** A package that ships D1 migrations: `NNNN_name.sql` files directly in `dir`. */
interface MigrationSource {
    /** The owner named in errors and in the assembled folder's `sources.json`, normally the package name. */
    name: string;
    /** An absolute path to the folder holding the `.sql` files. */
    dir: string;
}
interface MigrationFile {
    /** The file name, which `wrangler d1 migrations apply` records in `d1_migrations` and which must never change. */
    name: string;
    /** The `name` of the source that ships it. */
    source: string;
    /** The absolute path of the file in its source. */
    path: string;
}
/**
 * Wrangler's order for the files of a migrations folder: by the number before the first `_`, files
 * without one last, ties by plain string comparison. One sequence therefore runs across every source.
 */
declare function compareMigrationNames(a: string, b: string): number;
/**
 * The migrations of every source in the order wrangler applies them. Two sources may not ship a file
 * of the same name, nor two files with the same leading number: a name, once applied to a database,
 * identifies that migration for good, and a number shared by two files would order them by chance.
 */
declare function listMigrationSources(sources: MigrationSource[]): MigrationFile[];
/**
 * Copies the migrations of every source into `outDir`, the one folder a D1 binding's `migrations_dir`
 * can point at, removing `.sql` files it wrote on an earlier run that no source ships any more.
 * `sources.json` beside them names each file's owner. Returns the files in wrangler's order.
 *
 * A `.sql` file in `outDir` that no source ships and no earlier run wrote is somebody's own migration:
 * wrangler would apply it with the others, and deleting it would lose it without a word, so it is refused.
 */
declare function assembleMigrations({ sources, outDir }: {
    sources: MigrationSource[];
    outDir: string;
}): MigrationFile[];

export { type MigrationFile, type MigrationSource, assembleMigrations, compareMigrationNames, listMigrationSources };
