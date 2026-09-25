import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { canonicalDeclarations, findDistDrift, restoreReordered } from '../dist-drift.mjs';

// Git run from a hook exports GIT_DIR, GIT_INDEX_FILE and similar, which would point every git call
// below, and findDistDrift's, at the real repository instead of the temporary one.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

// Declarations as TypeScript prints them: four spaces per level, one member per line.
const DECLARATIONS = `type Status = 'draft' | 'published' | 'archived';
interface SeoSettings {
    /** The schema.org page type. */
    type?: 'WebPage' | 'CollectionPage' | 'AboutPage';
    title: string;
    noindex?: boolean;
}
interface ResolvedSeo {
    openGraphType: 'website';
    robots: string;
}
interface Loader {
    load(id: string): Entry;
    load(ids: string[]): Entry[];
    readonly name: string;
}
declare function loadEntry(id: string): Promise<{
    id: string;
    status: "draft" | "published" | "archived";
    tags: {
        name: string;
        count: number;
    }[];
    publishedSlug: string | null;
}>;
interface CommerceApi {
    webhooks: {
        handleStripe(payload: string): Promise<{
            success: boolean;
            orderId: string;
            duplicate: boolean;
        } | {
            success: boolean;
            event: string;
            ignored?: undefined;
        } | null>;
    };
}
`;

// The same declarations as another build may print them: union members and block members reordered.
const REORDERED = `type Status = 'draft' | 'published' | 'archived';
interface SeoSettings {
    noindex?: boolean;
    title: string;
    /** The schema.org page type. */
    type?: 'AboutPage' | 'WebPage' | 'CollectionPage';
}
interface ResolvedSeo {
    robots: string;
    openGraphType: 'website';
}
interface Loader {
    readonly name: string;
    load(id: string): Entry;
    load(ids: string[]): Entry[];
}
declare function loadEntry(id: string): Promise<{
    publishedSlug: string | null;
    tags: {
        count: number;
        name: string;
    }[];
    id: string;
    status: "published" | "archived" | "draft";
}>;
interface CommerceApi {
    webhooks: {
        handleStripe(payload: string): Promise<{
            event: string;
            success: boolean;
            ignored?: undefined;
        } | {
            success: boolean;
            orderId: string;
            duplicate: boolean;
        } | null>;
    };
}
`;

const COMMITTED = {
  'packages/core/dist/index.js': 'export const answer = 42;\n',
  'packages/core/dist/index.d.ts': DECLARATIONS,
  'packages/core/dist/other.d.ts': 'declare const value: number;\n',
  'packages/core/dist/removed.d.ts': 'export {};\n',
  'packages/core/src/index.ts': 'export const answer = 42;\n',
  'packages/ui/src/generated.ts': 'export const items = [];\n',
};

let repo;
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const read = (path) => readFileSync(join(repo, path), 'utf8');
const edit = (search, replacement) => {
  assert.ok(DECLARATIONS.includes(search), `fixture contains ${search}`);
  return DECLARATIONS.replace(search, replacement);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'talisman-dist-drift-'));
  git('init', '--quiet');
  for (const [path, text] of Object.entries(COMMITTED)) write(path, text);
  git('add', '--all');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', '-m', 'build');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('a declaration file whose members only changed order passes and is put back', () => {
  write('packages/core/dist/index.d.ts', REORDERED);

  const result = findDistDrift(repo);
  assert.deepEqual(result, { drift: [], reordered: ['packages/core/dist/index.d.ts'] });

  restoreReordered(result.reordered, repo);
  assert.equal(read('packages/core/dist/index.d.ts'), DECLARATIONS);
  assert.equal(git('status', '--porcelain'), '');
});

test('a union member that moves to another declaration is drift and stays in place', () => {
  const moved = edit("type?: 'WebPage' | 'CollectionPage' | 'AboutPage';", "type?: 'WebPage' | 'CollectionPage';")
    .replace("openGraphType: 'website';", "openGraphType: 'website' | 'AboutPage';");
  write('packages/core/dist/index.d.ts', moved);

  const { drift, reordered } = findDistDrift(repo);
  assert.deepEqual(drift, ['packages/core/dist/index.d.ts: differs from the committed file']);
  assert.deepEqual(reordered, []);
  restoreReordered(reordered, repo);
  assert.equal(read('packages/core/dist/index.d.ts'), moved);
});

test('only order within one union or one block is ignored', () => {
  const same = (text) => canonicalDeclarations(text) === canonicalDeclarations(DECLARATIONS);
  assert.ok(same(REORDERED));
  // Whitespace and blank lines carry no meaning.
  assert.ok(same(DECLARATIONS.replace('title: string;', 'title:  string ;').replace('interface Loader', '\ninterface Loader')));

  // A property that moves to another interface.
  assert.ok(!same(edit('    title: string;\n', '').replace('    robots: string;\n', '    robots: string;\n    title: string;\n')));
  // A nested property that moves out of its object type.
  assert.ok(!same(edit('        count: number;\n', '').replace('    publishedSlug:', '    count: number;\n    publishedSlug:')));
  // A `?` that moves to another property.
  assert.ok(!same(edit('    title: string;\n    noindex?: boolean;', '    title?: string;\n    noindex: boolean;')));
  // Union members that move between the unions of a function's parameter and return type.
  const signature = (text) => `declare function pick(mode: ${text}): 'a' | 'b';\n`;
  assert.notEqual(canonicalDeclarations(signature("'x' | 'a'").replace("'a' | 'b'", "'b'")),
    canonicalDeclarations(signature("'x'")));
  // Reworded documentation.
  assert.ok(!same(edit('/** The schema.org page type. */', '/** The page type. */')));
  // Overloads resolve in order, so swapping them counts.
  assert.ok(!same(edit('    load(id: string): Entry;\n    load(ids: string[]): Entry[];', '    load(ids: string[]): Entry[];\n    load(id: string): Entry;')));
  // Top-level declarations keep their order.
  assert.ok(!same(DECLARATIONS.replace(/^(type Status.*\n)((?:.*\n)*?)(declare function)/m, '$2$1$3')));
});

test('the objects of a union printed over several lines are sorted unless something binds to one', () => {
  const union = (open, close, objects) => `type Result = ${open}{\n${objects.map((lines) => `    ${lines.join('\n    ')}`).join('\n} | {\n')}\n}${close};\n`;
  const same = (open, close, objects, reordered) =>
    canonicalDeclarations(union(open, close, objects)) === canonicalDeclarations(union(open, close, reordered));
  const swapped = (open, close) => same(open, close, [['a: string;'], ['b: number;']], [['b: number;'], ['a: string;']]);

  assert.ok(swapped('', ''));
  assert.ok(swapped('Promise<', ' | null>'));
  assert.ok(swapped('Array<(', ')[]>'));
  assert.ok(swapped('string | ', ''));
  // A property that moves to another object of the union.
  assert.ok(!same('', '', [['a: string;', 'c: boolean;'], ['b: number;']], [['a: string;'], ['b: number;', 'c: boolean;']]));
  // `&`, `keyof` and `[]` bind more tightly than `|`, so they apply to the first or last object only.
  assert.ok(!swapped('Base & ', ''));
  assert.ok(!swapped('', ' & Base'));
  assert.ok(!swapped('keyof ', ''));
  assert.ok(!swapped('', '[]'));
  // The objects after `Base & { … }` are members of the union on their own, so they still sort.
  assert.ok(same('Base & ', '', [['a: string;'], ['b: number;'], ['c: boolean;']], [['a: string;'], ['c: boolean;'], ['b: number;']]));
  assert.ok(!same('Base & ', '', [['a: string;'], ['b: number;'], ['c: boolean;']], [['b: number;'], ['a: string;'], ['c: boolean;']]));
});

test('real differences in the build output are reported and left in place', () => {
  write('packages/core/dist/index.d.ts', REORDERED);
  write('packages/core/dist/index.js', 'export const answer = 43;\n');
  write('packages/core/dist/other.d.ts', 'declare const value: string;\n');
  write('packages/core/dist/new chunk ü.js', 'export {};\n');
  write('packages/ui/src/generated.ts', 'export const items = [1];\n');
  rmSync(join(repo, 'packages/core/dist/removed.d.ts'));
  // Sources are not build output, so the check leaves them alone.
  write('packages/core/src/index.ts', 'export const answer = 43;\n');

  const { drift, reordered } = findDistDrift(repo);
  assert.deepEqual(reordered, ['packages/core/dist/index.d.ts']);
  assert.deepEqual(drift.sort(), [
    'packages/core/dist/index.js: differs from the committed file',
    'packages/core/dist/new chunk ü.js: new file, not committed',
    'packages/core/dist/other.d.ts: differs from the committed file',
    'packages/core/dist/removed.d.ts: committed, but the build no longer creates it',
    'packages/ui/src/generated.ts: differs from the committed file',
  ]);

  restoreReordered(reordered, repo);
  assert.equal(read('packages/core/dist/index.d.ts'), DECLARATIONS);
  assert.equal(read('packages/core/dist/index.js'), 'export const answer = 43;\n');
  assert.equal(read('packages/core/dist/other.d.ts'), 'declare const value: string;\n');
  assert.equal(read('packages/core/src/index.ts'), 'export const answer = 43;\n');
});

test('a clean build output reports nothing and restores nothing', () => {
  assert.deepEqual(findDistDrift(repo), { drift: [], reordered: [] });
  restoreReordered([], repo);
  assert.equal(git('status', '--porcelain'), '');
});
