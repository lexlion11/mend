// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four
// formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
// V4A patch format, and text-editor tool calls as JSON — and applies it to a tree of
// text files, changing every file or none. Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

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
  /** For a move edit that succeeded: new path -> old path. */
  readonly moves = new Map<string, string>();
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

// ---- section 5: matching lines at three tiers ----

type Tier = 0 | 1 | 2;

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const tiers = (strict: boolean): Tier[] => (strict ? ([0] as Tier[]) : ([0, 1, 2] as Tier[]));

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchOcc(lines: string[], pos: number, o: string[], tier: Tier): boolean {
  if (pos + o.length > lines.length) return false;
  for (let i = 0; i < o.length; i++) {
    if (!lineEq(lines[pos + i]!, o[i]!, tier)) return false;
  }
  return true;
}

/** Every position at or after `from` where o occurs at `tier`; an end-of-file chunk
 *  (eofOnly) takes only occurrences that end at the file's last line. */
function occurrences(lines: string[], o: string[], tier: Tier, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(from, 0); i + o.length <= lines.length; i++) {
    if (matchOcc(lines, i, o, tier) && (!eofOnly || i + o.length === lines.length)) out.push(i);
  }
  return out;
}

/** The occurrence whose 0-based position is nearest to target; of two equally near, the earlier. */
function nearest(occ: number[], target: number): number {
  let best = occ[0]!;
  for (const p of occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  return best;
}

// ---- files as lines (section 3) ----

interface FL {
  lines: string[];
  final: boolean;
  br: string;
}

function toFL(text: string): FL {
  if (text === '') return { lines: [], final: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, final, br };
}

function fromFL(fl: FL): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

// ---- hunk and chunk bodies ----

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'nl';
  text: string;
  /** The raw patch line was empty (unified: trailing empty lines are not part of a body). */
  wasEmpty: boolean;
}

/** O: the context and `-` lines, in body order. */
function oLines(body: BodyLine[]): string[] {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
}

/** N's length: the context and `+` lines. */
function nLen(body: BodyLine[]): number {
  return body.filter((b) => b.kind === 'ctx' || b.kind === 'new').length;
}

/** A `\` line follows the body's last context or `+` line. */
function noNewlineAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.kind === 'nl';
}

function stripTrailingEmpty(body: BodyLine[]): void {
  while (body.length > 0 && body[body.length - 1]!.wasEmpty) body.pop();
}

/**
 * Replace the k matched lines at `pos` with the body's lines. A context line is written
 * as the file's own matched line; at tier 2 every other line of N is re-indented: F is
 * the leading spaces and tabs of the file's first matched line, P those of O's first line.
 */
function applyBody(lines: string[], pos: number, body: BodyLine[], tier: Tier): string[] {
  const o = oLines(body);
  const f = leadWs(lines[pos]!);
  const p = leadWs(o[0]!);
  const out: string[] = [];
  let mi = 0;
  for (const bl of body) {
    if (bl.kind === 'ctx') {
      out.push(lines[pos + mi]!);
      mi += 1;
    } else if (bl.kind === 'old') {
      mi += 1;
    } else if (bl.kind === 'new') {
      if (tier === 2 && bl.text.trim() !== '' && bl.text.startsWith(p)) out.push(f + bl.text.slice(p.length));
      else out.push(bl.text);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

/** Apply a section's hunks to a file's text (sections 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FL {
  const fl = toFL(text);
  let lines = fl.lines;
  let final = fl.final;
  let d = 0;
  for (const h of hunks) {
    const body = h.body;
    const o = oLines(body);
    const nl = nLen(body);
    if (o.length === 0) {
      const add = body.filter((b) => b.kind === 'new').map((b) => b.text);
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...add, ...lines.slice(at)];
      d += add.length;
      if (atEnd) final = !noNewlineAfterLast(body);
    } else {
      let tier: Tier | null = null;
      let pos = -1;
      for (const t of tiers(strict)) {
        const occ = occurrences(lines, o, t, 0, false);
        if (occ.length > 0) {
          tier = t;
          pos = nearest(occ, h.a - 1 + d);
          break;
        }
      }
      if (tier === null) throw new Fail('no-match', path);
      const runsToEnd = pos + o.length === lines.length;
      lines = applyBody(lines, pos, body, tier);
      d += nl - o.length;
      if (runsToEnd) final = !noNewlineAfterLast(body);
    }
  }
  if (lines.length === 0) final = false;
  return { lines, final, br: fl.br };
}

// ---- section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  hasPair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  line: number;
}

/** The path on a `--- ` or `+++ ` line: the text after the four characters, up to the
 *  first tab, surrounding spaces removed; /dev/null is no file; a leading a/ or b/ removed. */
function hdrPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hasPair = false;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const newSection = (gitOld: string | null, gitNew: string | null, line: number): void => {
    sec = { gitOld, gitNew, headerOld: null, headerNew: null, renameOld: null, renameNew: null, hasPair: false, create: false, del: false, hunks: [], line };
    hasPair = false;
    inBody = false;
    curHunk = null;
    sections.push(sec);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (inBody) {
      if (l.startsWith('--- ') && next.startsWith('+++ ')) {
        // the body ends here; the pair starts a new section, handled below
      } else if (l === '') {
        curHunk!.body.push({ kind: 'ctx', text: '', wasEmpty: true });
        continue;
      } else if (l[0] === ' ') {
        curHunk!.body.push({ kind: 'ctx', text: l.slice(1), wasEmpty: false });
        continue;
      } else if (l[0] === '-') {
        curHunk!.body.push({ kind: 'old', text: l.slice(1), wasEmpty: false });
        continue;
      } else if (l[0] === '+') {
        curHunk!.body.push({ kind: 'new', text: l.slice(1), wasEmpty: false });
        continue;
      } else if (l[0] === '\\') {
        curHunk!.body.push({ kind: 'nl', text: l, wasEmpty: false });
        continue;
      }
      // the body ends at the first other line
      inBody = false;
      stripTrailingEmpty(curHunk!.body);
      curHunk = null;
    }
    // not in a body
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      const j = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (j < 0) throw new Exit2(`error: parse ${i + 1}`);
      newSection(rest.slice(2, j), rest.slice(j + 3), i + 1);
      continue;
    }
    if (l.startsWith('--- ')) {
      if (!next.startsWith('+++ ')) {
        // a --- line not followed by a +++ line, inside a section's header, is a parse error
        if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
        continue; // otherwise ignored
      }
      if (sec !== null && sec.hunks.length === 0 && !hasPair) {
        sec.headerOld = hdrPath(l);
        sec.headerNew = hdrPath(next);
        sec.hasPair = true;
        hasPair = true;
        i += 1;
        continue;
      }
      newSection(null, null, i + 1);
      sec!.headerOld = hdrPath(l);
      sec!.headerNew = hdrPath(next);
      sec!.hasPair = true;
      hasPair = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: Number.parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(curHunk);
      inBody = true;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // within a section, before its first hunk
      if (l.startsWith('rename from ')) {
        sec.renameOld = l.slice('rename from '.length);
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameNew = l.slice('rename to '.length);
        continue;
      }
      if (l === 'new file mode') {
        sec.create = true;
        continue;
      }
      if (l === 'deleted file mode') {
        sec.del = true;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and
      // any other line are ignored
      continue;
    }
    // outside bodies, lines that are not part of a section header are ignored
  }
  if (inBody) stripTrailingEmpty(curHunk!.body);
  return sections;
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.headerOld : sec.renameOld ?? sec.gitOld;
  const newP = sec.hasPair ? sec.headerNew : sec.renameNew ?? sec.gitNew;
  const creation = sec.create || oldP === null;
  const deletion = !creation && (sec.del || newP === null);
  const move = !creation && !deletion && oldP !== newP;
  return (tree: Tree) => {
    if (creation) {
      if (newP === null) throw new Exit2(`error: parse ${sec.line}`);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      // the file is the `+` lines of all its hunks, in order
      const addLines: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        const plus = h.body.filter((b) => b.kind === 'new').map((b) => b.text);
        if (plus.length > 0) {
          addLines.push(...plus);
          noFinal = noNewlineAfterLast(h.body);
        }
      }
      tree.now.set(newP, addLines.length === 0 ? '' : addLines.join('\n') + (noFinal ? '' : '\n'));
    } else if (deletion) {
      if (oldP === null) throw new Exit2(`error: parse ${sec.line}`);
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    } else if (move) {
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      if (!safe(newP!)) throw new Fail('unsafe', newP!);
      const t = tree.get(oldP!);
      if (t === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const fl = applyHunks(t, sec.hunks, strict, oldP!);
      tree.now.set(newP!, fromFL(fl));
      tree.now.set(oldP!, null);
      tree.moves.set(newP!, oldP!);
    } else {
      if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
      const t = tree.get(oldP!);
      if (t === null) throw new Fail('missing', oldP!);
      const fl = applyHunks(t, sec.hunks, strict, oldP!);
      tree.now.set(oldP!, fromFL(fl));
    }
  };
}

// ---- section 7: SEARCH/REPLACE blocks ----

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let lastPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchN = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchN}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchN}`);
    const old = lines.slice(i + 1, j);
    const nw = lines.slice(j + 1, k);
    // the path: the nearest line before the SEARCH line, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks
    let p: string | null = null;
    for (let x = i - 1; x >= searchFrom; x--) {
      const t = lines[x]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${searchN}`);
      p = lastPath;
    } else {
      lastPath = p;
    }
    blocks.push({ path: p, old, new: nw });
    searchFrom = k + 1;
    i = k + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      // old lines empty: the file is created with the new lines
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const fl = toFL(t);
    let tier: Tier | null = null;
    let pos = -1;
    for (const t2 of tiers(strict)) {
      const occ = occurrences(fl.lines, b.old, t2, 0, false);
      if (occ.length > 0) {
        tier = t2;
        pos = occ[0]!;
        if (occ.length > 1) throw new Fail('ambiguous', p);
        break;
      }
    }
    if (tier === null) throw new Fail('no-match', p);
    // the new lines replace them; at tier 2 every line of N is re-indented
    const f = leadWs(fl.lines[pos]!);
    const pp = leadWs(b.old[0]!);
    const out: string[] = [];
    for (const line of b.new) {
      if (tier === 2 && line.trim() !== '' && line.startsWith(pp)) out.push(f + line.slice(pp.length));
      else out.push(line);
    }
    const lines = [...fl.lines.slice(0, pos), ...out, ...fl.lines.slice(pos + b.old.length)];
    tree.now.set(p, fromFL({ lines, final: lines.length === 0 ? false : fl.final, br: fl.br }));
  };
}

// ---- section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  fileLines: string[];
  line: number;
}

function parseV4a(lines: string[]): V4aSection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind: V4aSection['kind'] = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = trimSpaces(l.slice(l.indexOf(': ') + 2));
      const line = i + 1;
      // collect the section's raw lines up to the next section or *** End Patch
      const raw: { text: string; n: number }[] = [];
      let j = i + 1;
      while (j < last) {
        const m = lines[j]!;
        if (!blank(m) && (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: '))) break;
        raw.push({ text: m, n: j + 1 });
        j += 1;
      }
      // blank lines at the end of a section are not part of it
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const e of raw) {
          if (e.text === '') {
            fileLines.push('');
          } else if (e.text[0] === '+') {
            fileLines.push(e.text.slice(1));
          } else {
            throw new Exit2(`error: parse ${e.n}`);
          }
        }
        sections.push({ kind, path, moveTo: null, chunks: [], fileLines, line });
      } else if (kind === 'delete') {
        if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
        sections.push({ kind, path, moveTo: null, chunks: [], fileLines: [], line });
      } else {
        let idx = 0;
        let moveTo: string | null = null;
        if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
          moveTo = trimSpaces(raw[idx]!.text.slice('*** Move to: '.length));
          idx += 1;
        }
        const chunks: V4aChunk[] = [];
        let cur: V4aChunk | null = null;
        while (idx < raw.length) {
          const e = raw[idx]!;
          if (e.text.startsWith('@@')) {
            cur = { anchor: trimSpaces(e.text.slice(2)) || null, eof: false, body: [] };
            chunks.push(cur);
            idx += 1;
          } else if (e.text === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${e.n}`);
            cur.eof = true;
            cur = null;
            idx += 1;
          } else if (e.text === '' || e.text[0] === ' ' || e.text[0] === '-' || e.text[0] === '+') {
            if (cur === null) {
              if (chunks.length > 0) throw new Exit2(`error: parse ${e.n}`);
              cur = { anchor: null, eof: false, body: [] };
              chunks.push(cur);
            }
            const t = e.text;
            cur.body.push({
              kind: t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new',
              text: t === '' ? '' : t.slice(1),
              wasEmpty: false,
            });
            idx += 1;
          } else {
            throw new Exit2(`error: parse ${e.n}`);
          }
        }
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${line}`);
        sections.push({ kind, path, moveTo, chunks, fileLines: [], line });
      }
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return sections;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree: Tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // update
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    let newP: string | null = null;
    if (sec.moveTo !== null) {
      newP = sec.moveTo;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
    }
    const fl = toFL(t);
    let lines = fl.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of tiers(strict)) {
          for (let q = cursor; q < lines.length; q++) {
            if (lineEq(lines[q]!, ch.anchor, tier)) {
              found = q;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o = oLines(ch.body);
      const nl = nLen(ch.body);
      if (o.length === 0) {
        const add = ch.body.filter((b) => b.kind === 'new').map((b) => b.text);
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...add, ...lines.slice(at)];
        cursor = at + add.length;
      } else {
        let tier: Tier | null = null;
        let pos = -1;
        for (const t2 of tiers(strict)) {
          const occ = occurrences(lines, o, t2, cursor, ch.eof);
          if (occ.length > 0) {
            tier = t2;
            pos = occ[0]!;
            break;
          }
        }
        if (tier === null) throw new Fail('no-match', p);
        lines = applyBody(lines, pos, ch.body, tier);
        cursor = pos + nl;
      }
    }
    const result: FL = { lines, final: lines.length === 0 ? false : fl.final, br: fl.br };
    if (newP !== null) {
      tree.now.set(newP, fromFL(result));
      tree.now.set(p, null);
      tree.moves.set(newP, p);
    } else {
      tree.now.set(p, fromFL(result));
    }
  };
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => uniEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSR(lines).map((b) => srEdit(b, strict));
    else if (kind === 'v4a') edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    else throw new Exit2('error: parse 1');
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // a move that succeeded replaces its D and A lines with an R line, sorted by the new path
  const moveNew = new Map<string, string>();
  const moveOld = new Set<string>();
  for (const [np, op] of tree.moves) {
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      moveNew.set(np, op);
      moveOld.add(op);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moveNew.has(p)) {
      rows.push(`R ${moveNew.get(p)} -> ${p}`);
      if (check) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
      rmSync(moveNew.get(p)!, { force: true });
      continue;
    }
    if (moveOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
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
