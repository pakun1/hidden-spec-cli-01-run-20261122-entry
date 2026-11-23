// mend — one patch tool for every AI edit format (SPEC.md v1).
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// The working directory is the root of a tree of text files. A patch in one
// of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits) is
// read, its edits are applied in order to the tree, and every change is
// written — or none is, when any edit fails. Node 22, standard library only.
//
// When MAKEFUN_ENV_URL is set, this file hands the trial over to runner.ts
// (see the entry point at the bottom), which runs main.ts on each check.

import { runTrial } from './runner.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------- tiny string helpers ----------

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------- a file as lines ----------
//
// A file's line break is CRLF when its first line feed follows a carriage
// return, and LF otherwise. Its lines are its text split at that break. It
// ends with a line break when its text ends with that break; that last, empty
// piece is not a line. An empty file has no lines and no final break.

interface Doc {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let eol = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    eol = true;
  }
  return { lines: parts, br, eol };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.eol ? d.br : '');
}

// ---------- paths ----------

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------- matching lines (section 5) ----------
//
// O is found at the first of three tiers at which it occurs at least once:
// tier 0 every line equal, tier 1 equal once trailing spaces and tabs are
// removed from both, tier 2 equal once leading and trailing spaces and tabs
// are removed from both.

function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEqAt(O[j], lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTierOcc(lines: string[], O: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// At tier 2 every line of N other than a context line is re-indented: F is
// the leading spaces and tabs of the file's first matched line, P those of
// O's first line; a line that is not empty and not only whitespace, and starts
// with P, has that P replaced by F; any other line is written as it is.

function reindent(line: string, F: string, P: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

// Replace O's lines at position `at` by N's lines. A context line is written
// as the file's own matched line, never the patch's; nCtx[j] holds the O
// index of N's j-th line when it is a context line, and null otherwise.

function spliceLines(lines: string[], at: number, O: string[], N: string[], nCtx: (number | null)[], tier: number): string[] {
  const F = at < lines.length ? leadWs(lines[at]) : '';
  const P = O.length > 0 ? leadWs(O[0]) : '';
  const made: string[] = [];
  for (let j = 0; j < N.length; j++) {
    const ci = nCtx[j];
    if (ci !== null) {
      made.push(lines[at + ci]);
    } else if (tier === 2) {
      made.push(reindent(N[j], F, P));
    } else {
      made.push(N[j]);
    }
  }
  return [...lines.slice(0, at), ...made, ...lines.slice(at + O.length)];
}

// ---------- the tree ----------

type Tree = Map<string, Doc>;

function cloneTree(t: Tree): Tree {
  const out: Tree = new Map();
  for (const [p, d] of t) out.set(p, { lines: [...d.lines], br: d.br, eol: d.eol });
  return out;
}

function readTree(): Tree {
  const out: Tree = new Map();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      const rel = prefix === '' ? name : prefix + '/' + name;
      if (st.isDirectory()) walk(p, rel);
      else if (st.isFile()) out.set(rel, parseDoc(readFileSync(p, 'utf8')));
    }
  };
  walk('.', '');
  return out;
}

function writeTree(tree: Tree): void {
  for (const [p, d] of tree) {
    const dir = dirname(p);
    if (dir !== '.') mkdirSync(dir, { recursive: true });
    writeFileSync(p, writeDoc(d), 'utf8');
  }
}

function removePaths(paths: string[]): void {
  for (const p of paths) {
    if (existsSync(p)) unlinkSync(p);
  }
}

// ---------- output ----------

function say(line: string): void {
  process.stdout.write(line + '\n');
}

// ---------- errors that stop the run ----------

class ParseFail extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

class UsageFail extends Error {}

class PatchReadFail extends Error {}

// ---------- arguments (section 1) ----------

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function parseArgs(argv: string[]): Options {
  let format = 'auto';
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('--format=')) {
      if (seenFormat) throw new UsageFail();
      seenFormat = true;
      const v = a.slice('--format='.length);
      if (!FORMATS.includes(v)) throw new UsageFail();
      format = v;
      continue;
    }
    if (!afterDashDash && a === '--check') {
      if (seenCheck) throw new UsageFail();
      seenCheck = true;
      check = true;
      continue;
    }
    if (!afterDashDash && a === '--strict') {
      if (seenStrict) throw new UsageFail();
      seenStrict = true;
      strict = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') throw new UsageFail();
    if (patch !== null) throw new UsageFail();
    patch = a;
  }
  return { format, check, strict, patch };
}

// ---------- the patch as lines (section 3) ----------

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function readPatch(patch: string | null): string[] {
  let text: string;
  if (patch === null || patch === '-') {
    text = readFileSync(0, 'utf8');
  } else {
    try {
      text = readFileSync(patch, 'utf8');
    } catch {
      throw new PatchReadFail();
    }
  }
  return patchLines(text);
}

// ---------- detecting the format (section 4) ----------

function detectFormat(lines: string[]): string {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return '';
  const firstText = lines[first].trim();
  if (firstText === '*** Begin Patch') return 'v4a';
  const firstChar = firstText.charAt(0);
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (rtrimWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return '';
}

// ---------- edits ----------

interface Fail {
  code: string;
  path: string;
}

type EditOutcome = { ok: true } | { ok: false; fail: Fail };

interface Edit {
  paths: string[];
  move: { oldPath: string; newPath: string } | null;
  apply: (tree: Tree, maxTier: number) => EditOutcome;
}

function failOut(code: string, path: string): EditOutcome {
  return { ok: false, fail: { code, path } };
}

// ---------- unified diffs (section 6) ----------

interface UniHunk {
  A: number;
  body: string[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDash: boolean;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

function uniPathFromDash(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseFail(i + 1);
      cur = { gitOld: m[1], gitNew: m[2], dashOld: null, dashNew: null, hasDash: false, renOld: null, renNew: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.dashOld = uniPathFromDash(line);
        cur.dashNew = uniPathFromDash(lines[i + 1]);
        cur.hasDash = true;
        i += 2;
        continue;
      }
      cur = { gitOld: null, gitNew: null, dashOld: uniPathFromDash(line), dashNew: uniPathFromDash(lines[i + 1]), hasDash: true, renOld: null, renNew: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFail(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseFail(i + 1);
      const A = parseInt(m[1], 10);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ A, body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseFail(i + 2);
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) edits.push(uniSectionEdit(s));
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

// Split a hunk body into O (context and `-` lines) and N (context and `+`
// lines). nCtx[j] holds the O index of N's j-th line when it is a context
// line, and null otherwise. `\` lines carry no content.

function hunkON(body: string[]): { O: string[]; N: string[]; nCtx: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ')) {
      nCtx.push(O.length);
      O.push(bl.slice(1));
      N.push(bl.slice(1));
    } else if (bl.startsWith('-')) {
      O.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      nCtx.push(null);
      N.push(bl.slice(1));
    } else if (bl === '') {
      nCtx.push(O.length);
      O.push('');
      N.push('');
    }
  }
  return { O, N, nCtx };
}

// Whether a `\` line follows the hunk's last context or `+` line. That is
// the only `\` that decides whether the result ends with a line break.

function backslashAfterLast(body: string[]): boolean {
  let idx = -1;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k].startsWith(' ') || body[k].startsWith('+')) {
      idx = k;
      break;
    }
  }
  if (idx === -1) return false;
  return idx + 1 < body.length && body[idx + 1].startsWith('\\');
}

// Apply one section's hunks, in order, to a document. Each hunk works on the
// result of the ones before it; d is the running sum of (N length - O length).

function applyUniHunks(doc: Doc, hunks: UniHunk[], maxTier: number): { doc: Doc } | { fail: Fail } {
  let lines = [...doc.lines];
  let eol = doc.eol;
  let d = 0;
  for (const h of hunks) {
    const { O, N, nCtx } = hunkON(h.body);
    if (O.length === 0) {
      const oldLen = lines.length;
      const pos = Math.min(h.A + d, oldLen);
      lines = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
      if (pos === oldLen) eol = !backslashAfterLast(h.body);
      d += N.length;
      continue;
    }
    const found = firstTierOcc(lines, O, 0, maxTier);
    if (found === null) return { fail: { code: 'no-match', path: '' } };
    const target = h.A - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const at = best;
    const touchesEnd = at + O.length === lines.length;
    lines = spliceLines(lines, at, O, N, nCtx, found.tier);
    if (touchesEnd) eol = !backslashAfterLast(h.body);
    d += N.length - O.length;
  }
  return { doc: { lines, br: doc.br, eol } };
}

function uniSectionEdit(s: UniSection): Edit {
  const oldPath = s.hasDash ? s.dashOld : s.renOld !== null ? s.renOld : s.gitOld;
  const newPath = s.hasDash ? s.dashNew : s.renNew !== null ? s.renNew : s.gitNew;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = newPath === null || s.deletedFile;
  if (isCreate) {
    const path = newPath !== null ? newPath : oldPath !== null ? oldPath : '';
    const plusLines: string[] = [];
    let noEol = false;
    for (const h of s.hunks) {
      for (const bl of h.body) {
        if (bl.startsWith('+')) plusLines.push(bl.slice(1));
      }
    }
    if (s.hunks.length > 0) noEol = backslashAfterLast(s.hunks[s.hunks.length - 1].body);
    const eol = plusLines.length === 0 ? false : !noEol;
    return {
      paths: [path],
      move: null,
      apply: (tree) => {
        if (tree.has(path)) return failOut('exists', path);
        tree.set(path, { lines: plusLines, br: '\n', eol });
        return { ok: true };
      },
    };
  }
  if (isDelete) {
    const path = oldPath !== null ? oldPath : newPath !== null ? newPath : '';
    return {
      paths: [path],
      move: null,
      apply: (tree) => {
        if (!tree.has(path)) return failOut('missing', path);
        tree.delete(path);
        return { ok: true };
      },
    };
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return {
      paths: [oldPath, newPath],
      move: { oldPath, newPath },
      apply: (tree, maxTier) => {
        if (!tree.has(oldPath)) return failOut('missing', oldPath);
        if (tree.has(newPath)) return failOut('exists', newPath);
        const doc = tree.get(oldPath) as Doc;
        const res = applyUniHunks(doc, s.hunks, maxTier);
        if ('fail' in res) return failOut(res.fail.code, oldPath);
        tree.delete(oldPath);
        tree.set(newPath, res.doc);
        return { ok: true };
      },
    };
  }
  const path = oldPath !== null ? oldPath : newPath !== null ? newPath : '';
  return {
    paths: [path],
    move: null,
    apply: (tree, maxTier) => {
      if (!tree.has(path)) return failOut('missing', path);
      const doc = tree.get(path) as Doc;
      const res = applyUniHunks(doc, s.hunks, maxTier);
      if ('fail' in res) return failOut(res.fail.code, path);
      tree.set(path, res.doc);
      return { ok: true };
    },
  };
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFail(searchLine);
      path = prevPath;
    }
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (rtrimWs(lines[k]) === '=======') {
        sep = k;
        break;
      }
    }
    if (sep !== -1) {
      for (let k = sep + 1; k < lines.length; k++) {
        if (rtrimWs(lines[k]) === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (sep === -1 || end === -1) throw new ParseFail(searchLine);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  if (oldLines.length === 0) {
    return {
      paths: [path],
      move: null,
      apply: (tree) => {
        if (tree.has(path)) return failOut('exists', path);
        const eol = newLines.length === 0 ? false : true;
        tree.set(path, { lines: [...newLines], br: '\n', eol });
        return { ok: true };
      },
    };
  }
  return {
    paths: [path],
    move: null,
    apply: (tree, maxTier) => {
      if (!tree.has(path)) return failOut('missing', path);
      const doc = tree.get(path) as Doc;
      const found = firstTierOcc(doc.lines, oldLines, 0, maxTier);
      if (found === null) return failOut('no-match', path);
      if (found.occ.length > 1) return failOut('ambiguous', path);
      const at = found.occ[0];
      const nCtx: (number | null)[] = newLines.map(() => null);
      const lines = spliceLines(doc.lines, at, oldLines, newLines, nCtx, found.tier);
      tree.set(path, { lines, br: doc.br, eol: doc.eol });
      return { ok: true };
    },
  };
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function isVSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

// Blank lines at the end of a V4A section are not part of it. A body line
// is blank when it is empty or only whitespace — a single space is a context
// line with empty text, and it is still a blank line for this rule.

function stripTrailingBlankBodyLines(body: string[]): string[] {
  const out = [...body];
  while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
  return out;
}

function stripTrailingBlanks(body: string[]): string[] {
  const out = [...body];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function parseV4a(lines: string[]): Edit[] {
  let beginIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      beginIdx = i;
      break;
    }
  }
  if (beginIdx === -1 || lines[beginIdx].trim() !== '*** Begin Patch') {
    throw new ParseFail(beginIdx === -1 ? 1 : beginIdx + 1);
  }
  let endIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      endIdx = i;
      break;
    }
  }
  if (lines[endIdx].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);
  const sections: VSection[] = [];
  let i = beginIdx + 1;
  while (i < endIdx) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < endIdx) {
        const l = lines[i];
        if (isVSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
        } else if (l === '') {
          fileLines.push('');
          i++;
        } else if (isBlank(l)) {
          // A whitespace-only line is a blank line, not part of the section
          // when it sits at the end of the section; anywhere else it is a
          // line the format does not allow.
          let trailing = true;
          for (let k = i + 1; k < endIdx; k++) {
            const lk = lines[k];
            if (isVSectionStart(lk) || lk.trim() === '*** End Patch') break;
            if (!isBlank(lk)) {
              trailing = false;
              break;
            }
          }
          if (!trailing) throw new ParseFail(i + 1);
          break;
        } else throw new ParseFail(i + 1);
      }
      sections.push({ kind: 'add', path, lines: stripTrailingBlanks(fileLines), moveTo: null, chunks: [] });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [] });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < endIdx && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (i < endIdx) {
        const l = lines[i];
        if (isVSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          if (cur !== null) {
            chunks.push({ anchor: cur.anchor, eof: cur.eof, body: cur.body });
            cur = null;
          }
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          firstChunk = false;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseFail(i + 1);
          cur.eof = true;
          chunks.push({ anchor: cur.anchor, eof: cur.eof, body: cur.body });
          cur = null;
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (!firstChunk) throw new ParseFail(i + 1);
            cur = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          cur.body.push(l);
          i++;
          continue;
        }
        throw new ParseFail(i + 1);
      }
      if (cur !== null) {
        chunks.push({ anchor: cur.anchor, eof: cur.eof, body: stripTrailingBlankBodyLines(cur.body) });
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFail(updateLineNo);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks });
      continue;
    }
    throw new ParseFail(i + 1);
  }
  const edits: Edit[] = [];
  for (const s of sections) edits.push(vSectionEdit(s));
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

function vSectionEdit(s: VSection): Edit {
  if (s.kind === 'add') {
    return {
      paths: [s.path],
      move: null,
      apply: (tree) => {
        if (tree.has(s.path)) return failOut('exists', s.path);
        const eol = s.lines.length === 0 ? false : true;
        tree.set(s.path, { lines: [...s.lines], br: '\n', eol });
        return { ok: true };
      },
    };
  }
  if (s.kind === 'delete') {
    return {
      paths: [s.path],
      move: null,
      apply: (tree) => {
        if (!tree.has(s.path)) return failOut('missing', s.path);
        tree.delete(s.path);
        return { ok: true };
      },
    };
  }
  const paths = s.moveTo !== null ? [s.path, s.moveTo] : [s.path];
  return {
    paths,
    move: s.moveTo !== null ? { oldPath: s.path, newPath: s.moveTo } : null,
    apply: (tree, maxTier) => {
      if (!tree.has(s.path)) return failOut('missing', s.path);
      if (s.moveTo !== null && tree.has(s.moveTo)) return failOut('exists', s.moveTo);
      const doc = tree.get(s.path) as Doc;
      const res = applyVChunks(doc, s.chunks, maxTier);
      if ('fail' in res) return failOut(res.fail.code, s.path);
      if (s.moveTo !== null) {
        tree.delete(s.path);
        tree.set(s.moveTo, res.doc);
      } else {
        tree.set(s.path, res.doc);
      }
      return { ok: true };
    },
  };
}

// Apply an Update File section's chunks, in order, to a document. The cursor
// starts at line 0; an anchored chunk first finds its anchor at or after the
// cursor, and the cursor moves past it. After a chunk the cursor moves to
// just after the lines written.

function applyVChunks(doc: Doc, chunks: VChunk[], maxTier: number): { doc: Doc } | { fail: Fail } {
  let lines = [...doc.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const foundAnchor = findSingleLine(lines, ch.anchor, cursor, maxTier);
      if (foundAnchor === -1) return { fail: { code: 'no-match', path: '' } };
      cursor = foundAnchor + 1;
    }
    const { O, N, nCtx } = hunkON(ch.body);
    if (O.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      lines = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
      cursor = pos + N.length;
      continue;
    }
    const placed = findChunkOcc(lines, O, cursor, maxTier, ch.eof);
    if (placed === null) return { fail: { code: 'no-match', path: '' } };
    const at = placed.at;
    lines = spliceLines(lines, at, O, N, nCtx, placed.tier);
    cursor = at + N.length;
  }
  return { doc: { lines, br: doc.br, eol: doc.eol } };
}

// The first line at or after `from` equal to `needle` at the first tier
// where one is (both sides a single line); -1 when there is none.

function findSingleLine(lines: string[], needle: string, from: number, maxTier: number): number {
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEqAt(needle, lines[i], t)) return i;
    }
  }
  return -1;
}

// The first occurrence of O at or after the cursor, at the first tier with
// one; an end-of-file chunk takes only an occurrence that ends at the file's
// last line. Returns the position and the tier it was found at.

function findChunkOcc(lines: string[], O: string[], cursor: number, maxTier: number, eof: boolean): { at: number; tier: number } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, O, t, cursor);
    for (const p of occ) {
      if (!eof || p + O.length === lines.length) return { at: p, tier: t };
    }
  }
  return null;
}

// ---------- JSON edits (section 9) ----------

type JsonEditData =
  | { kind: 'jcreate'; path: string; text: string }
  | { kind: 'jstr'; path: string; oldStr: string; newStr: string }
  | { kind: 'jinsert'; path: string; line: number; newStr: string };

function validJsonEdit(obj: unknown): JsonEditData | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'jcreate', path: o.path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { kind: 'jstr', path: o.path, oldStr: o.old_str, newStr: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'jinsert', path: o.path, line: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFail(1);
  const firstChar = lines[first].trim().charAt(0);
  const edits: Edit[] = [];
  if (firstChar === '[') {
    const text = lines.join('\n');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFail(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFail(first + 1);
    for (const el of parsed) {
      const e = validJsonEdit(el);
      if (e === null) throw new ParseFail(first + 1);
      edits.push(jsonEdit(e));
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new ParseFail(i + 1);
      }
      const e = validJsonEdit(parsed);
      if (e === null) throw new ParseFail(i + 1);
      edits.push(jsonEdit(e));
    }
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

function jsonEdit(e: JsonEditData): Edit {
  if (e.kind === 'jcreate') {
    return {
      paths: [e.path],
      move: null,
      apply: (tree) => {
        if (tree.has(e.path)) return failOut('exists', e.path);
        tree.set(e.path, parseDoc(e.text));
        return { ok: true };
      },
    };
  }
  if (e.kind === 'jstr') {
    return {
      paths: [e.path],
      move: null,
      apply: (tree) => {
        if (!tree.has(e.path)) return failOut('missing', e.path);
        const doc = tree.get(e.path) as Doc;
        const text = writeDoc(doc);
        let hay = text;
        let oldS = e.oldStr;
        let newS = e.newStr;
        let crlf = false;
        if (doc.br === '\r\n') {
          crlf = true;
          hay = text.replace(/\r\n/g, '\n');
          oldS = oldS.replace(/\r\n/g, '\n');
          newS = newS.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let idx = 0;
        while (true) {
          const f = hay.indexOf(oldS, idx);
          if (f === -1) break;
          count++;
          idx = f + 1;
        }
        if (count === 0) return failOut('no-match', e.path);
        if (count > 1) return failOut('ambiguous', e.path);
        const at = hay.indexOf(oldS);
        const replaced = hay.slice(0, at) + newS + hay.slice(at + oldS.length);
        const out = crlf ? replaced.replace(/\n/g, '\r\n') : replaced;
        tree.set(e.path, parseDoc(out));
        return { ok: true };
      },
    };
  }
  return {
    paths: [e.path],
    move: null,
    apply: (tree) => {
      if (!tree.has(e.path)) return failOut('missing', e.path);
      const doc = tree.get(e.path) as Doc;
      if (e.line < 0 || e.line > doc.lines.length) return failOut('no-match', e.path);
      const ins = patchLines(e.newStr);
      const lines = [...doc.lines.slice(0, e.line), ...ins, ...doc.lines.slice(e.line)];
      tree.set(e.path, { lines, br: doc.br, eol: doc.eol });
      return { ok: true };
    },
  };
}

// ---------- the run (sections 2 and 10) ----------

function main(): number {
  const argv = process.argv.slice(2);
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageFail) {
      say('error: usage');
      return 2;
    }
    throw e;
  }
  let lines: string[];
  try {
    lines = readPatch(opts.patch);
  } catch (e) {
    if (e instanceof PatchReadFail) {
      say('error: no-patch');
      return 2;
    }
    throw e;
  }
  let format = opts.format;
  if (format === 'auto') {
    format = detectFormat(lines);
    if (format === '') {
      say('error: format');
      return 2;
    }
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines);
  } catch (e) {
    if (e instanceof ParseFail) {
      say('error: parse ' + e.line);
      return 2;
    }
    throw e;
  }
  const maxTier = opts.strict ? 0 : 2;
  const orig = readTree();
  let tree = cloneTree(orig);
  const failures: Fail[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const edit of edits) {
    let unsafePath: string | null = null;
    for (const p of edit.paths) {
      if (!isSafePath(p)) {
        unsafePath = p;
        break;
      }
    }
    if (unsafePath !== null) {
      failures.push({ code: 'unsafe', path: unsafePath });
      continue;
    }
    const trial = cloneTree(tree);
    const res = edit.apply(trial, maxTier);
    if (res.ok) {
      tree = trial;
      if (edit.move !== null) moves.push(edit.move);
    } else {
      failures.push(res.fail);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) say('error: ' + f.code + ' ' + f.path);
    say('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    return 1;
  }
  const changed: { key: string; line: string }[] = [];
  for (const [p, odoc] of orig) {
    if (!tree.has(p)) {
      changed.push({ key: p, line: 'D ' + p });
    } else {
      const ndoc = tree.get(p) as Doc;
      if (writeDoc(odoc) !== writeDoc(ndoc)) changed.push({ key: p, line: 'M ' + p });
    }
  }
  for (const p of tree.keys()) {
    if (!orig.has(p)) changed.push({ key: p, line: 'A ' + p });
  }
  for (const m of moves) {
    const dIdx = changed.findIndex((c) => c.line === 'D ' + m.oldPath);
    const aIdx = changed.findIndex((c) => c.line === 'A ' + m.newPath);
    if (dIdx !== -1 && aIdx !== -1) {
      changed.splice(Math.max(dIdx, aIdx), 1);
      changed.splice(Math.min(dIdx, aIdx), 1);
      changed.push({ key: m.newPath, line: 'R ' + m.oldPath + ' -> ' + m.newPath });
    }
  }
  changed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!opts.check) {
    for (const p of orig.keys()) {
      if (!tree.has(p)) removePaths([p]);
    }
    for (const [p, d] of tree) {
      const od = orig.get(p);
      if (od === undefined || writeDoc(od) !== writeDoc(d)) {
        const dir = dirname(p);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(p, writeDoc(d), 'utf8');
      }
    }
  }
  for (const c of changed) say(c.line);
  say('ok: ' + changed.length + (changed.length === 1 ? ' file' : ' files'));
  return 0;
}

// ---------- entry point ----------
//
// With MAKEFUN_ENV_URL set, hand the trial over to runner.ts, which runs
// main.ts on each check and posts the results. Otherwise run the CLI.

const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  await runTrial(trialUrl);
} else {
  process.exitCode = main();
}
