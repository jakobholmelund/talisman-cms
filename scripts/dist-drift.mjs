// Compares the build output in the working tree with the committed (staged) copy. Importing this
// module runs nothing; check-dist-drift.mjs and publish-packages.mjs call it.
//
// tsup's declaration build is not deterministic: from one run to the next, TypeScript may print the
// members of an inferred union, or the properties of an inferred object type, in another order. A
// changed .d.ts file therefore passes when it differs only in the order of the members of a union
// written on one line, of the object types of a union printed over several lines (`{ … } | { … }`),
// or of the member lines directly inside one multi-line `{ … }` block. Anything else counts, such as
// a union member or property that moves to another declaration, and other files must match exactly.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');

/** The build output that is committed: every package's dist/ and the UI plugins' src/generated.ts. */
export const BUILD_OUTPUT_PATHSPECS = [':(glob)packages/*/dist/**', ':(glob)packages/*/src/generated.ts'];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// -z output keeps paths unquoted, whatever characters they contain.
const paths = (cwd, ...args) => git(cwd, ...args, '-z', '--', ...BUILD_OUTPUT_PATHSPECS).split('\0').filter(Boolean);

const TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z0-9_$#]+|=>|\.\.\.|\S/g;
const BRACKETS = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);
const CLOSERS = new Set(BRACKETS.values());
// A union's members follow the last of these before its first `|`: a property or parameter name,
// a type alias, a default, or a function type's parameters.
const UNION_START = new Set([':', '=', '=>']);
// Operators that bind more loosely than `|`. A union next to one is left in its printed order.
const LOOSER_THAN_UNION = new Set(['?', ':', '=', '=>', 'extends', 'infer', 'is', 'asserts']);
// A block member's name ends at the first of these, so overloads share a name and keep their order.
const NAME_END = new Set([':', '?', ';', ',', '=']);
// A union of object types printed over several lines: a line that ends in `{` opens the first object,
// each `} | {` line closes one and opens the next, and a line that starts with `}` closes the last.
// The objects are only sorted when the `{` follows one of OBJECT_UNION_BEFORE and the last `}` is
// followed by one of OBJECT_UNION_AFTER (or nothing), so no `&`, `[]` or `keyof` binds to one of them.
const NEXT_OBJECT = '} | {';
const OBJECT_UNION_BEFORE = new Set([':', '=', '=>', '<', '(', ',', '|']);
const OBJECT_UNION_AFTER = new Set([undefined, '|', '>', ')', ']', ',', ';']);

/** Splits one line into tokens, with each bracket pair as a group. Unmatched brackets stay tokens. */
function parseLine(text) {
  const top = { items: [] };
  const stack = [top];
  for (const token of text.match(TOKEN) ?? []) {
    const current = stack[stack.length - 1];
    if (BRACKETS.has(token)) {
      const group = { open: token, items: [], closed: false };
      current.items.push(group);
      stack.push(group);
    } else if (CLOSERS.has(token) && current !== top && BRACKETS.get(current.open) === token) {
      current.closed = true;
      stack.pop();
    } else {
      current.items.push(token);
    }
  }
  return top.items;
}

const isComplete = (item) => (typeof item === 'string' ? !BRACKETS.has(item) && !CLOSERS.has(item) : item.closed);
const canonicalItem = (item) =>
  typeof item === 'string' ? item : `${item.open} ${canonicalSequence(item.items)} ${item.closed ? BRACKETS.get(item.open) : ''}`;
const joinItems = (items) => items.map(canonicalItem).join(' ');

/** The items between `,` and `;` separators, each with the members of a union sorted. */
function canonicalSequence(items) {
  const parts = [];
  let segment = [];
  for (const item of items) {
    if (item === ',' || item === ';') {
      parts.push(canonicalSegment(segment), item);
      segment = [];
    } else {
      segment.push(item);
    }
  }
  parts.push(canonicalSegment(segment));
  return parts.filter(Boolean).join(' ');
}

function canonicalSegment(items) {
  const firstBar = items.indexOf('|');
  if (firstBar < 0) return joinItems(items);
  let start = 0;
  for (let index = 0; index < firstBar; index += 1) if (UNION_START.has(items[index])) start = index + 1;
  const union = items.slice(start);
  // Only a union that is complete on this line, with nothing looser than `|` in it, is sorted.
  if (!union.every(isComplete) || union.some((item) => LOOSER_THAN_UNION.has(item))) return joinItems(items);
  const members = [[]];
  for (const item of union) {
    if (item === '|') members.push([]);
    else members[members.length - 1].push(item);
  }
  const sorted = members.filter((member) => member.length).map(joinItems).sort().join(' | ');
  return [joinItems(items.slice(0, start)), sorted].filter(Boolean).join(' ');
}

const isComment = (text) => /^(\/\/|\/\*|\*)/.test(text);

function canonicalLine(text) {
  // Comments are compared as written, apart from whitespace.
  if (isComment(text) || text.includes('//') || text.includes('/*')) return (text.match(TOKEN) ?? []).join(' ');
  return canonicalSequence(parseLine(text));
}

/** The name a block member is sorted by: the tokens before its type, parameters or type parameters. */
function memberName(text) {
  const name = [];
  for (const item of parseLine(text)) {
    if (typeof item === 'string' ? NAME_END.has(item) : item.open !== '[') break;
    name.push(canonicalItem(item));
  }
  return name.join(' ');
}

// Lines that open the body of an enum or a namespace: their members keep their printed order.
const ORDERED_BLOCK = /^(export\s+)?(declare\s+)?(const\s+)?(enum|namespace|module|global)\b/;

/** Nests each line under the closest line before it that is indented less. Blank lines are dropped. */
function indentationTree(text) {
  const tree = { indent: -1, children: [] };
  const stack = [tree];
  for (const line of text.split('\n')) {
    const content = line.trim();
    if (!content) continue;
    const node = { indent: line.length - line.trimStart().length, text: content, children: [] };
    while (stack[stack.length - 1].indent >= node.indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return tree;
}

function canonicalNode(node) {
  const opensBlock = !isComment(node.text) && node.text.endsWith('{') && !ORDERED_BLOCK.test(node.text);
  return [canonicalLine(node.text), ...canonicalChildren(node.children, opensBlock)];
}

/**
 * The canonical lines of the lines nested under one line. Directly inside a `{ … }` block, each
 * member (its comments, its line, what is nested under it, and closing lines such as `}[];`) is
 * sorted by name. Array sort is stable, so members with the same name, such as overloads, keep their
 * order.
 */
function canonicalChildren(children, sortMembers) {
  const members = [];
  let comments = [];
  for (const child of children) {
    if (isComment(child.text)) {
      comments.push(child);
    } else if (/^[)\]}>]/.test(child.text) && members.length && !comments.length) {
      members[members.length - 1].nodes.push(child);
    } else {
      members.push({ name: memberName(child.text), nodes: [...comments, child] });
      comments = [];
    }
  }
  if (comments.length) members.push({ name: '￿', nodes: comments });
  if (sortMembers) members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return members.flatMap((member) => canonicalNodes(member.nodes));
}

const lineTokens = (text) => (isComment(text) || text.includes('//') || text.includes('/*') ? [] : text.match(TOKEN) ?? []);

function opensObjectUnion(text) {
  const tokens = lineTokens(text);
  return tokens.at(-1) === '{' && OBJECT_UNION_BEFORE.has(tokens.at(-2));
}

function closesObjectUnion(text) {
  const tokens = lineTokens(text);
  return tokens[0] === '}' && OBJECT_UNION_AFTER.has(tokens[1]);
}

/**
 * The canonical lines of one block member's lines (the line, what is nested under it, and the lines
 * that close it), with the objects of each union printed over several lines sorted.
 */
function canonicalNodes(nodes) {
  const lines = [];
  for (let index = 0; index < nodes.length; index += 1) {
    let end = index + 1;
    while (end < nodes.length && nodes[end].text === NEXT_OBJECT) end += 1;
    if (end === index + 1 || end === nodes.length || !opensObjectUnion(nodes[index].text) || !closesObjectUnion(nodes[end].text)) {
      lines.push(...canonicalNode(nodes[index]));
      continue;
    }
    const objects = nodes.slice(index, end).map((node) => canonicalChildren(node.children, true).join('\n')).sort();
    lines.push(canonicalLine(nodes[index].text), objects.join(`\n${canonicalLine(NEXT_OBJECT)}\n`));
    // The closing line is next, and may itself open another union.
    index = end - 1;
  }
  return lines;
}

/** A declaration file in a form where only the member order tsup changes between builds is ignored. */
export function canonicalDeclarations(text) {
  return canonicalChildren(indentationTree(text).children, false).join('\n');
}

/**
 * Lists how the build output differs from the committed files. `drift` holds a line for each real
 * difference. `reordered` holds the .d.ts files whose union members or block members only changed order.
 */
export function findDistDrift(cwd = root) {
  const drift = [];
  const reordered = [];
  for (const path of paths(cwd, 'ls-files', '--others', '--exclude-standard')) {
    drift.push(`${path}: new file, not committed`);
  }
  for (const path of paths(cwd, 'diff', '--name-only', '--diff-filter=D')) {
    drift.push(`${path}: committed, but the build no longer creates it`);
  }
  for (const path of paths(cwd, 'diff', '--name-only', '--diff-filter=M')) {
    if (
      path.endsWith('.d.ts') &&
      canonicalDeclarations(git(cwd, 'show', `:${path}`)) === canonicalDeclarations(readFileSync(resolve(cwd, path), 'utf8'))
    ) {
      reordered.push(path);
    } else {
      drift.push(`${path}: differs from the committed file`);
    }
  }
  return { drift, reordered };
}

/**
 * Puts back the committed copy of declaration files that only changed order. pnpm publish refuses
 * a working tree with changes, and every pack or publish rebuilds, so this runs after each one.
 */
export function restoreReordered(reordered, cwd = root) {
  if (!reordered.length) return;
  git(cwd, '--literal-pathspecs', 'restore', '--', ...reordered);
  console.log(`Put back the committed copy of ${reordered.length} rebuilt declaration file${reordered.length === 1 ? '' : 's'} whose members only changed order:`);
  for (const path of reordered) console.log(`  ${path}`);
}

/** Prints the real differences and how to fix them. */
export function reportDrift(drift) {
  console.error(`The committed build output is stale (${drift.length} file${drift.length === 1 ? '' : 's'}):`);
  for (const line of drift) console.error(`  ${line}`);
  console.error('\nRun `pnpm build` and commit packages/*/dist (and src/generated.ts of the UI plugins).');
}
