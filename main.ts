// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, text-editor tool calls as JSON) and applies it to a
// tree of text files, changing every file or none. Lines are matched at the
// first of three tiers (exact; trailing whitespace ignored; leading and
// trailing whitespace ignored), so an edit still lands when the model drifted
// the whitespace or the line numbers. Implements SPEC.md version 1 in full.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A fault in the patch text itself; reported as `error: parse <line>`. */
class ParseFault extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit failed; reported as `error: <code> <path>`. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** The patch's lines (SPEC.md section 3): split at \n, one trailing \r removed. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and
 *  none of its segments is empty, `.` or `..` (SPEC.md section 3). */
function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order of the UTF-8 encoding, for sorting output rows (SPEC.md section 2). */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The leading spaces and tabs of a line. */
function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** One file's text, split into lines the way SPEC.md section 3 says. */
interface Doc {
  lines: string[];
  eol: '\n' | '\r\n';
  finalBreak: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const firstNl = text.indexOf('\n');
  const eol: '\n' | '\r\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(eol);
  const parts = text.split(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.eol) + (d.finalBreak ? d.eol : '');
}

/**
 * The tree as the edits leave it. `before` is what the files held when first
 * read from disk; `after` holds what the edits set (null: deleted). A path
 * never touched is read from disk, so the tree is only ever the files the
 * edits named plus the disk.
 */
class Workspace {
  private readonly before = new Map<string, string | null>();
  private after = new Map<string, string | null>();
  /** Successful moves, for the `R old -> new` output lines. */
  moves: Array<{ from: string; to: string }> = [];

  readOriginal(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  read(p: string): string | null {
    return this.after.has(p) ? this.after.get(p)! : this.readOriginal(p);
  }

  write(p: string, text: string | null): void {
    this.after.set(p, text);
  }

  doc(p: string): Doc | null {
    const t = this.read(p);
    return t === null ? null : readDoc(t);
  }

  putDoc(p: string, d: Doc): void {
    this.write(p, writeDoc(d));
  }

  touched(): string[] {
    return [...this.after.keys()];
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.after);
  }

  restore(s: Map<string, string | null>): void {
    this.after = new Map(s);
  }
}

/** One parsed edit: apply it to the tree, or throw an EditFault. */
type Edit = (ws: Workspace) => void;

// ---------------------------------------------------------------------------
// Matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** A line as a tier compares it: tier 0 exact, tier 1 trailing whitespace
 *  stripped, tier 2 leading and trailing whitespace stripped. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where `oldLines` occur in
 *  `fileLines` at one tier. Occurrences may overlap. */
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const want = oldLines.map((l) => tierKey(l, tier));
  const out: number[] = [];
  for (let i = from; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (tierKey(fileLines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `oldLines` occur at least once at or after `from`,
 *  with every occurrence there; null when they occur at no tier. */
function firstTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from = 0,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(fileLines, oldLines, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/**
 * The lines that replace the `oldLines.length` lines at `at`: `newLines` with
 * each context line written as the file's own matched line (never the patch's)
 * and, at tier 2, every other line re-indented from the old lines' leading
 * whitespace to the file's. `ctx[i]` is the index into `oldLines` of the
 * context line behind `newLines[i]`, or -1 when it is not one.
 */
function spliceLines(
  fileLines: string[],
  at: number,
  oldLines: string[],
  newLines: string[],
  ctx: number[],
  tier: number,
): string[] {
  const built: string[] = [];
  let leadFile = '';
  let leadOld = '';
  if (tier === 2) {
    leadFile = leadingWs(fileLines[at] ?? '');
    leadOld = leadingWs(oldLines[0] ?? '');
  }
  for (let i = 0; i < newLines.length; i++) {
    const oi = ctx[i];
    if (oi !== undefined && oi >= 0) {
      built.push(fileLines[at + oi]);
    } else if (tier === 2) {
      const line = newLines[i];
      if (line !== '' && line.trim() !== '' && line.startsWith(leadOld)) {
        built.push(leadFile + line.slice(leadOld.length));
      } else {
        built.push(line);
      }
    } else {
      built.push(newLines[i]);
    }
  }
  return [...fileLines.slice(0, at), ...built, ...fileLines.slice(at + oldLines.length)];
}

/** Split a hunk or chunk body into its old lines, new lines, and the context
 *  map (new-line index -> old-line index, -1 for a line that is only new). */
function splitBody(
  body: Array<{ kind: string; text: string }>,
): { oldLines: string[]; newLines: string[]; ctx: number[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctx: number[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      const oi = oldLines.length;
      oldLines.push(b.text);
      newLines.push(b.text);
      ctx.push(oi);
    } else if (b.kind === '-') {
      oldLines.push(b.text);
    } else if (b.kind === '+') {
      newLines.push(b.text);
      ctx.push(-1);
    }
    // a '\' line is in neither side
  }
  return { oldLines, newLines, ctx };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UniHunk {
  /** The old-file start line (1-based) from the `@@ -A ... @@` header. */
  a: number;
  /** Body lines in order; kind is ' ' (context), '-' (old), '+' (new) or
   *  '\' (a `\ No newline at end of file` line). */
  body: Array<{ kind: string; text: string }>;
}

interface UniSection {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string;
  pairNew?: string;
  renameOld?: string;
  renameNew?: string;
  create: boolean;
  remove: boolean;
  hunks: UniHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` header line names: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

/** Strip one leading `a/` or `b/` from a `--- `/`+++ ` path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  const pairAt = (j: number): boolean =>
    j + 1 < n && lines[j].startsWith('--- ') && lines[j + 1].startsWith('+++ ');

  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      cur = { create: false, remove: false, hunks: [], diffOld: m[1], diffNew: m[2] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && pairAt(i)) {
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      cur = { create: false, remove: false, hunks: [] };
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]);
      sections.push(cur);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A lone `--- ` line inside a section's header is a parse fault at the
      // line after it; anywhere else it is prose.
      if (cur !== null && cur.hunks.length === 0) throw new ParseFault(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      if (cur === null) throw new ParseFault(i + 1);
      const a = parseInt(m[1], 10);
      i++;
      const raw: string[] = [];
      while (i < n) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && pairAt(i)) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          raw.push(b);
          i++;
        } else {
          break;
        }
      }
      while (raw.length > 0 && (raw[raw.length - 1] === '' || raw[raw.length - 1] === ' ')) raw.pop();
      const body = raw.map((b) => {
        if (b === '') return { kind: ' ', text: '' };
        if (b.startsWith(' ')) return { kind: ' ', text: b.slice(1) };
        if (b.startsWith('-')) return { kind: '-', text: b.slice(1) };
        if (b.startsWith('+')) return { kind: '+', text: b.slice(1) };
        return { kind: '\\', text: b };
      });
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      // index, mode, similarity and any other header line are ignored
      i++;
      continue;
    }
    // Prose, code fences and anything else outside a body: ignored.
    i++;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function hunkNoBreak(h: UniHunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j].kind === ' ' || h.body[j].kind === '+') last = j;
  }
  if (last < 0) return false;
  return last + 1 < h.body.length && h.body[last + 1].kind === '\\';
}

/** Apply a section's hunks in order to a document. */
function applyUniHunks(doc: Doc, hunks: UniHunk[], strict: boolean, path: string): Doc {
  let lines = [...doc.lines];
  let finalBreak = doc.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { oldLines: O, newLines: N, ctx } = splitBody(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
      if (atEnd) finalBreak = !hunkNoBreak(h);
      d += N.length;
      continue;
    }
    const found = firstTier(lines, O, strict);
    if (found === null) throw new EditFault('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.at) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const runsToEnd = best + O.length === lines.length;
    lines = spliceLines(lines, best, O, N, ctx, found.tier);
    if (runsToEnd) finalBreak = !hunkNoBreak(h);
    d += N.length - O.length;
  }
  return { lines, eol: doc.eol, finalBreak };
}

/** The `+` lines of a creation section, and whether its last `+` line is
 *  followed by a `\` line (so the file ends without a line break). */
function creationText(hunks: UniHunk[]): string {
  const plus: string[] = [];
  let noBreak = false;
  for (const h of hunks) {
    for (let j = 0; j < h.body.length; j++) {
      if (h.body[j].kind === '+') {
        plus.push(h.body[j].text);
        noBreak = j + 1 < h.body.length && h.body[j + 1].kind === '\\';
      }
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noBreak ? '' : '\n');
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  // Paths: the `--- `/`+++ ` pair names them, else `rename from`/`to`, else
  // the `diff --git` paths. `/dev/null` means no file.
  let oldP: string | undefined;
  let newP: string | undefined;
  if (s.pairOld !== undefined) {
    oldP = s.pairOld;
    newP = s.pairNew;
  } else if (s.renameOld !== undefined) {
    oldP = s.renameOld;
    newP = s.renameNew;
  } else if (s.diffOld !== undefined) {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  const oldPath = oldP === undefined || oldP === '/dev/null' ? null : s.pairOld !== undefined ? stripAB(oldP) : oldP;
  const newPath = newP === undefined || newP === '/dev/null' ? null : s.pairOld !== undefined ? stripAB(newP) : newP;
  return (ws: Workspace) => {
    for (const p of [oldPath, newPath]) {
      if (p !== null && !isSafePath(p)) throw new EditFault('unsafe', p);
    }
    if (oldPath === null && newPath === null) return; // nothing named
    if (oldPath === null || s.create) {
      if (newPath === null) return;
      if (ws.read(newPath) !== null) throw new EditFault('exists', newPath);
      ws.write(newPath, creationText(s.hunks));
      return;
    }
    if (newPath === null || s.remove) {
      if (ws.read(oldPath) === null) throw new EditFault('missing', oldPath);
      ws.write(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const doc = ws.doc(oldPath);
      if (doc === null) throw new EditFault('missing', oldPath);
      if (ws.read(newPath) !== null) throw new EditFault('exists', newPath);
      const out = applyUniHunks(doc, s.hunks, strict, oldPath);
      ws.write(newPath, writeDoc(out));
      ws.write(oldPath, null);
      ws.moves.push({ from: oldPath, to: newPath });
      return;
    }
    const doc = ws.doc(oldPath);
    if (doc === null) throw new EditFault('missing', oldPath);
    const out = applyUniHunks(doc, s.hunks, strict, oldPath);
    ws.putDoc(oldPath, out);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

/** A marker line, with its trailing whitespace removed. */
function marker(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1; // index just after the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    const si = lines.findIndex((l, j) => j >= i && marker(l) === '<<<<<<< SEARCH');
    if (si < 0) break;
    // The path: the nearest line before SEARCH, after the previous block, that
    // is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = si - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(si + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < n; j++) {
      const m = marker(lines[j]);
      if (m === '=======') {
        eq = j;
        break;
      }
      if (m === '>>>>>>> REPLACE' || m === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new ParseFault(si + 1);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (marker(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(si + 1);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (ws: Workspace) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (ws.read(path) !== null) throw new EditFault('exists', path);
      ws.write(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const doc = ws.doc(path);
    if (doc === null) throw new EditFault('missing', path);
    const found = firstTier(doc.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.at.length > 1) throw new EditFault('ambiguous', path);
    const built = spliceLines(doc.lines, found.at[0], oldLines, newLines, newLines.map(() => -1), found.tier);
    ws.putDoc(path, { lines: built, eol: doc.eol, finalBreak: doc.finalBreak });
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** The anchor text after `@@`, or null when the chunk has none. */
  anchor: string | null;
  /** True when a `*** End of File` line closed the chunk. */
  eof: boolean;
  body: string[];
}

const isV4aHeader = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < end) {
        const l = lines[i];
        if (isV4aHeader(l) || l.trim() === '*** End Patch') break;
        if (isBlank(l)) {
          fileLines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(p, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < end && isBlank(lines[i])) i++;
      if (i < end && !isV4aHeader(lines[i]) && lines[i].trim() !== '*** End Patch') {
        throw new ParseFault(i + 1);
      }
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const p = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < end) {
        const l = lines[i];
        if (isV4aHeader(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseFault(i + 1);
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, body: [] };
              chunks.push(cur);
            } else {
              throw new ParseFault(i + 1);
            }
          }
          cur.body.push(l);
          i++;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1];
        while (tail.body.length > 0 && (tail.body[tail.body.length - 1] === '' || tail.body[tail.body.length - 1] === ' ')) {
          tail.body.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (ws: Workspace) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (ws.read(path) !== null) throw new EditFault('exists', path);
    ws.write(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (ws: Workspace) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (ws.read(path) === null) throw new EditFault('missing', path);
    ws.write(path, null);
  };
}

/** A chunk's body as old lines, new lines and the context map. */
function chunkSplit(ch: V4aChunk): { oldLines: string[]; newLines: string[]; ctx: number[] } {
  const body = ch.body.map((l) => {
    if (l === '') return { kind: ' ', text: '' };
    if (l.startsWith(' ')) return { kind: ' ', text: l.slice(1) };
    if (l.startsWith('-')) return { kind: '-', text: l.slice(1) };
    return { kind: '+', text: l.slice(1) };
  });
  return splitBody(body);
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (ws: Workspace) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const doc = ws.doc(path);
    if (doc === null) throw new EditFault('missing', path);
    if (moveTo !== null && ws.read(moveTo) !== null) throw new EditFault('exists', moveTo);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = firstTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new EditFault('no-match', path);
        cursor = found.at[0] + 1;
      }
      const { oldLines: O, newLines: N, ctx } = chunkSplit(ch);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
        cursor = at + N.length;
        continue;
      }
      const found = firstTier(lines, O, strict, cursor);
      if (found === null) throw new EditFault('no-match', path);
      let at: number | null = null;
      for (const pos of found.at) {
        if (ch.eof && pos + O.length !== lines.length) continue;
        at = pos;
        break;
      }
      if (at === null) throw new EditFault('no-match', path);
      lines = spliceLines(lines, at, O, N, ctx, found.tier);
      cursor = at + N.length;
    }
    const out: Doc = { lines, eol: doc.eol, finalBreak: doc.finalBreak };
    if (moveTo !== null) {
      ws.write(moveTo, writeDoc(out));
      ws.write(path, null);
      ws.moves.push({ from: path, to: moveTo });
    } else {
      ws.putDoc(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object as an edit, or null when it is not one. */
function jsonEditToFn(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (ws: Workspace) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (ws.read(p) !== null) throw new EditFault('exists', p);
      ws.write(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (ws: Workspace) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = ws.read(p);
      if (before === null) throw new EditFault('missing', p);
      const firstNl = before.indexOf('\n');
      const crlf = firstNl > 0 && before[firstNl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      const rep = toLf(newStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + rep + t.slice(at + old.length);
      ws.write(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (ws: Workspace) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = ws.read(p);
      if (before === null) throw new EditFault('missing', p);
      const doc = readDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFault('no-match', p);
      const lines = [...doc.lines];
      lines.splice(lineNo, 0, ...add);
      ws.putDoc(p, { lines, eol: doc.eol, finalBreak: doc.finalBreak });
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const item of v) {
      const e = jsonEditToFn(item);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseFault(i + 1);
    }
    const e = jsonEditToFn(v);
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

/** The output rows for the tree the edits left, in byte order of the paths,
 *  with a move's `D` and `A` lines replaced by one `R old -> new` line that
 *  sorts by the new path (SPEC.md section 2). */
function buildRows(ws: Workspace): string[] {
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const seenMove = new Set<string>();
  for (const m of ws.moves) {
    const key = `${m.from}\0${m.to}`;
    if (seenMove.has(key)) continue;
    seenMove.add(key);
    const oldOrig = ws.readOriginal(m.from);
    const oldNow = ws.read(m.from);
    const newOrig = ws.readOriginal(m.to);
    const newNow = ws.read(m.to);
    if (oldOrig !== null && oldNow === null && newOrig === null && newNow !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      movedOld.add(m.from);
      movedNew.add(m.to);
    }
  }
  for (const p of ws.touched()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = ws.readOriginal(p);
    const now = ws.read(p);
    if (was === now) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return rows.map((r) => r.line);
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (checkOnly) return { code: 2, out: ['error: usage'] };
        checkOnly = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 ? null : positional[0]!;
  const patchFile = patchArg === null || patchArg === '-' ? null : patchArg;
  let patchText = '';
  try {
    patchText = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(patchText, lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const ws = new Workspace();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snap = ws.snapshot();
    const movesLen = ws.moves.length;
    try {
      edit(ws);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      ws.restore(snap);
      ws.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = buildRows(ws);
  if (!checkOnly) {
    for (const p of ws.touched()) {
      const now = ws.read(p);
      const was = ws.readOriginal(p);
      if (now === was) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
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
