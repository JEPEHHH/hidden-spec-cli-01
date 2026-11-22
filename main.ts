// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** The move edits that ran, as (from, to) pairs: a pair that lands is one `R` line. */
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines. An old block O is looked for at three tiers: every line equal, then equal once
// trailing spaces and tabs are removed, then equal once leading and trailing ones are removed.

interface Ent {
  k: 'c' | 'o' | 'n';
  t: string;
  /** read from a blank line: not part of a body when it is at the body's end */
  b: boolean;
  /** a `\` line follows it: no line break after it */
  x: boolean;
}

const mkEnt = (k: 'c' | 'o' | 'n', t: string, b: boolean): Ent => ({ k, t, b, x: false });

interface Hit {
  tier: number;
  at: number[];
}

const LEAD = /^[ \t]*/;
const lead = (s: string): string => LEAD.exec(s)![0];
const rtrim = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => rtrim(s).replace(/^[ \t]+/, '');

function fold(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? rtrim(s) : trimBoth(s);
}

const topTier = (strict: boolean): number => (strict ? 0 : 2);

/** The first tier at which O occurs in `file`, and every position where it does (they may overlap). */
function findAll(file: string[], old: string[], strict: boolean): Hit | null {
  for (let tier = 0; tier <= topTier(strict); tier += 1) {
    const o = old.map((l) => fold(l, tier));
    const at: number[] = [];
    for (let i = 0; i + o.length <= file.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (fold(file[i + j]!, tier) !== o[j]!) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier that has one. */
function findFrom(file: string[], old: string[], from: number, strict: boolean, eof: boolean): { tier: number; at: number } | null {
  for (let tier = 0; tier <= topTier(strict); tier += 1) {
    const o = old.map((l) => fold(l, tier));
    for (let i = Math.max(0, from); i + o.length <= file.length; i += 1) {
      if (eof && i + o.length !== file.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (fold(file[i + j]!, tier) !== o[j]!) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, at: i };
    }
  }
  return null;
}

/** The first line at or after `from` equal to `anchor`, at the first tier that has one. */
function findAnchor(file: string[], anchor: string, from: number, strict: boolean): number | null {
  for (let tier = 0; tier <= topTier(strict); tier += 1) {
    const a = fold(anchor, tier);
    for (let i = Math.max(0, from); i < file.length; i += 1) if (fold(file[i]!, tier) === a) return i;
  }
  return null;
}

interface Doc {
  lines: string[];
  /** the text ended with its line break: the last line ends with one */
  last: boolean;
  crlf: boolean;
}

function splitText(text: string): Doc {
  if (text === '') return { lines: [], last: false, crlf: false };
  const nl = text.indexOf('\n');
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const parts = text.split(crlf ? '\r\n' : '\n');
  const last = text.endsWith(crlf ? '\r\n' : '\n');
  if (last) parts.pop();
  return { lines: parts, last, crlf };
}

function joinText(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  const br = doc.crlf ? '\r\n' : '\n';
  return doc.lines.join(br) + (doc.last ? br : '');
}

/** Section 5: at tier 2 the lines of N that start with O's indentation take the file's. */
function reindent(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** N, built from the file's own matched context lines and the patch's new lines. */
function replaceLines(body: Ent[], file: string[], at: number, tier: number, oldFirst: string): string[] {
  const p = lead(oldFirst);
  const f = at < file.length ? lead(file[at]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.k === 'c') {
      out.push(file[at + oi] ?? '');
      oi += 1;
    } else if (e.k === 'o') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(e.t, p, f) : e.t);
    }
  }
  return out;
}

const firstOld = (body: Ent[]): string => {
  for (const e of body) if (e.k !== 'n') return e.t;
  return '';
};

/** Whether the last line of N is followed by a `\` line: the result then ends without a line break. */
function endsWithoutBreak(body: Ent[]): boolean {
  let last: Ent | null = null;
  for (const e of body) if (e.k !== 'o') last = e;
  return last !== null && last.x;
}

const splice = (doc: Doc, at: number, k: number, repl: string[], last: boolean): Doc => ({
  lines: [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + k)],
  last,
  crlf: doc.crlf,
});

/** A body's trailing blank lines are not part of it. */
function trimBody(body: Ent[]): void {
  while (body.length > 0 && body[body.length - 1]!.b) body.pop();
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.

interface Hunk {
  /** A: the old start line the header names */
  a: number;
  body: Ent[];
}

interface Sect {
  gitOld: string | null;
  gitNew: string | null;
  pair: boolean;
  oldP: string | null;
  newP: string | null;
  oldNull: boolean;
  newNull: boolean;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const newSect = (gitOld: string | null, gitNew: string | null): Sect => ({
  gitOld,
  gitNew,
  pair: false,
  oldP: null,
  newP: null,
  oldNull: false,
  newNull: false,
  renFrom: null,
  renTo: null,
  create: false,
  del: false,
  hunks: [],
});

/** A `--- ` or `+++ ` path: after four characters, up to the first tab, trimmed; `a/` or `b/` removed. */
function uPath(l: string): { p: string | null; nul: boolean } {
  let t = l.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return { p: null, nul: true };
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return { p: t, nul: false };
}

/** The old start line of a hunk header, or null when the line is not one. */
function hunkHead(l: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

const uBody = (l: string): Ent => {
  if (l === '') return mkEnt('c', '', true);
  const c = l[0]!;
  if (c === ' ') return mkEnt('c', l.slice(1), false);
  if (c === '-') return mkEnt('o', l.slice(1), false);
  return mkEnt('n', l.slice(1), false);
};

const isPairHead = (lines: string[], i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

/** One section's edit: a creation, a deletion, a move, or a change of one path. */
function uEdit(s: Sect, strict: boolean): Edit {
  const oldP = s.pair ? (s.oldNull ? null : s.oldP) : s.renFrom !== null || s.renTo !== null ? s.renFrom : s.gitOld;
  const newP = s.pair ? (s.newNull ? null : s.newP) : s.renFrom !== null || s.renTo !== null ? s.renTo : s.gitNew;
  const create = s.create || (s.pair && s.oldNull);
  const drop = s.del || (s.pair && s.newNull);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (create) {
      const p = newP ?? '';
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let nl = false;
      for (const h of s.hunks) {
        for (const e of h.body) {
          if (e.k === 'n') {
            lines.push(e.t);
            nl = e.x;
          }
        }
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (nl ? '' : '\n'));
      return;
    }
    if (drop) {
      const p = oldP ?? '';
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldP ?? '';
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    const move = newP !== null && newP !== src;
    if (move && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let doc = splitText(before);
    let d = 0;
    for (const h of s.hunks) {
      const old = h.body.filter((e) => e.k !== 'n').map((e) => e.t);
      const added = h.body.filter((e) => e.k !== 'o').length;
      let at: number;
      let tier = 0;
      if (old.length === 0) {
        at = Math.min(Math.max(0, h.a + d), doc.lines.length);
      } else {
        const hit = findAll(doc.lines, old, strict);
        if (hit === null) throw new Fail('no-match', src);
        tier = hit.tier;
        const want = h.a - 1 + d;
        at = hit.at[0]!;
        for (const p of hit.at) if (Math.abs(p - want) < Math.abs(at - want)) at = p;
      }
      const repl = replaceLines(h.body, doc.lines, at, tier, firstOld(h.body));
      const toEnd = at + old.length === doc.lines.length;
      doc = splice(doc, at, old.length, repl, toEnd ? !endsWithoutBreak(h.body) : doc.last);
      d += added - old.length;
    }
    const text = joinText(doc);
    if (move) {
      tree.now.set(newP!, text);
      tree.now.set(src, null);
      tree.moves.push({ from: src, to: newP! });
    } else tree.now.set(src, text);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sects: Sect[] = [];
  const edits: Edit[] = [];
  let cur: Sect | null = null;
  let inHead = false;
  let hunk: Hunk | null = null;
  let i = 0;
  const closeBody = (): void => {
    if (hunk !== null) {
      trimBody(hunk.body);
      hunk = null;
    }
  };
  const start = (s: Sect): void => {
    cur = s;
    sects.push(s);
    inHead = true;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (l.startsWith('diff --git ') || isPairHead(lines, i)) {
        closeBody();
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        hunk.body.push(uBody(l));
        i += 1;
        continue;
      }
      if (l.startsWith('\\')) {
        const last = hunk.body[hunk.body.length - 1];
        if (last !== undefined) last.x = true;
        i += 1;
        continue;
      }
      closeBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      start(newSect(m[1]!, m[2]!));
      i += 1;
      continue;
    }
    if (isPairHead(lines, i)) {
      const old = uPath(l);
      const nu = uPath(lines[i + 1]!);
      let s: Sect;
      if (inHead && cur !== null && !cur.pair) {
        // the pair that names this section: already part of its header
        s = cur;
      } else {
        s = newSect(null, null);
        start(s);
      }
      s.pair = true;
      s.oldP = old.p;
      s.newP = nu.p;
      s.oldNull = old.nul;
      s.newNull = nu.nul;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHead(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a, body: [] };
      cur.hunks.push(hunk);
      inHead = false;
      i += 1;
      continue;
    }
    if (inHead && cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      else if (l.startsWith('rename from ')) cur.renFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice(10).trim();
    }
    i += 1;
  }
  closeBody();
  for (const s of sects) edits.push(uEdit(s, strict));
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

const mark = (l: string, m: string): boolean => rtrim(l) === m;

function srEdit(path: string, old: string[], nu: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nu.length === 0 ? '' : `${nu.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = splitText(before);
    const hit = findAll(doc.lines, old, strict);
    if (hit === null) throw new Fail('no-match', path);
    if (hit.at.length > 1) throw new Fail('ambiguous', path);
    const at = hit.at[0]!;
    const repl = replaceLines(
      nu.map((t) => mkEnt('n', t, false)),
      doc.lines,
      at,
      hit.tier,
      old[0]!,
    );
    tree.now.set(path, joinText(splice(doc, at, old.length, repl, doc.last)));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let from = 0;
  let prev: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!mark(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= from; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prev;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = rtrim(lines[j]!);
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${i + 1}`);
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (mark(lines[j]!, '>>>>>>> REPLACE')) {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prev = path;
    from = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: Ent[];
}

interface VSect {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  move: string | null;
  chunks: Chunk[];
  added: Ent[];
}

const V_START = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

const vStart = (l: string): 'add' | 'del' | 'upd' | null => {
  if (l.startsWith(V_START[0]!)) return 'add';
  if (l.startsWith(V_START[1]!)) return 'del';
  if (l.startsWith(V_START[2]!)) return 'upd';
  return null;
};

function v4aBody(l: string): Ent | null {
  if (l.trim() === '') return mkEnt('c', l.slice(1), true);
  const c = l[0]!;
  if (c === ' ') return mkEnt('c', l.slice(1), false);
  if (c === '-') return mkEnt('o', l.slice(1), false);
  if (c === '+') return mkEnt('n', l.slice(1), false);
  return null;
}

function vEdit(s: VSect, strict: boolean): Edit {
  if (s.kind === 'add') {
    const path = s.path;
    const text = s.added.length === 0 ? '' : `${s.added.map((e) => e.t).join('\n')}\n`;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }
  if (s.kind === 'del') {
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = s.path;
  const move = s.move;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (move !== null && !safe(move)) throw new Fail('unsafe', move);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    let doc = splitText(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(doc.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const old = ch.body.filter((e) => e.k !== 'n').map((e) => e.t);
      let at: number;
      let tier = 0;
      if (old.length === 0) {
        at = ch.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
      } else {
        const hit = findFrom(doc.lines, old, cursor, strict, ch.eof);
        if (hit === null) throw new Fail('no-match', path);
        at = hit.at;
        tier = hit.tier;
      }
      const repl = replaceLines(ch.body, doc.lines, at, tier, firstOld(ch.body));
      doc = splice(doc, at, old.length, repl, doc.last);
      cursor = at + repl.length;
    }
    const text = joinText(doc);
    if (move !== null) {
      tree.now.set(move, text);
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: move });
    } else tree.now.set(path, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sects: VSect[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = vStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(V_START[kind === 'add' ? 0 : kind === 'del' ? 1 : 2]!.length).trim();
    const s: VSect = { kind, path, line: i + 1, move: null, chunks: [], added: [] };
    i += 1;
    if (kind === 'add') {
      while (i < last && vStart(lines[i]!) === null) {
        const t = lines[i]!;
        if (blank(t)) s.added.push(mkEnt('n', '', true));
        else if (t.startsWith('+')) s.added.push(mkEnt('n', t.slice(1), false));
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      trimBody(s.added);
    } else if (kind === 'del') {
      while (i < last && vStart(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else {
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        s.move = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      let cur: Chunk | null = null;
      while (i < last && vStart(lines[i]!) === null) {
        const t = lines[i]!;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          s.chunks.push(cur);
          i += 1;
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        const b = v4aBody(t);
        if (b === null) throw new Exit2(`error: parse ${i + 1}`);
        if (cur === null) {
          if (s.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, eof: false, body: [] };
          s.chunks.push(cur);
        }
        cur.body.push(b);
        i += 1;
      }
      for (let c = s.chunks.length - 1; c >= 0; c -= 1) {
        trimBody(s.chunks[c]!.body);
        if (s.chunks[c]!.body.length > 0) break;
      }
      if (s.chunks.length === 0 && s.move === null) throw new Exit2(`error: parse ${s.line}`);
    }
    sects.push(s);
  }
  return sects.map((s) => vEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const moved = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) moved.set(m.to, m.from);
  }
  const out: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const from = moved.get(p);
    if (from !== undefined) out.push({ key: p, line: `R ${from} -> ${p}` });
    else if ([...moved.values()].includes(p)) continue;
    else out.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  out.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  for (const r of out) rows.push(r.line);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const now = tree.now.get(p)!;
    if (tree.original(p) === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
