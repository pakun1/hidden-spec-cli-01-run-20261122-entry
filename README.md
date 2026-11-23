# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pakun1/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pakun1/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies an AI-written edit to a tree of
text files, in any of the four formats models write. It reads the patch,
finds the lines each edit names even when the model drifted their whitespace
or indentation, and changes every file or none.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI
edit format" bounty. Referral code: `gcf6w5vx`.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the root of the tree. `PATCH` is the path of the
patch file, relative to the working directory; when it is absent or `-`, the
patch is read from standard input. `--format=NAME` reads the patch in one
format (`unified`, `search-replace`, `v4a`, `json`); `auto`, the default,
detects it. `--check` does everything but write. `--strict` matches lines
exactly, with no fuzzy tiers.

## The four formats

- **Unified diff** — `diff --git` sections with `---`/`+++` headers and
  `@@` hunks. Hunks are matched by content, not by their (often wrong) line
  numbers: of the occurrences at the tier where the old lines are found, the
  one nearest the hunk's stated position wins. Creations, deletions and
  renames are all handled, and a `\ No newline at end of file` marker decides
  whether the result ends with a line break.
- **SEARCH/REPLACE blocks** — a path line, then `<<<<<<< SEARCH`, the old
  lines, `=======`, the new lines and `>>>>>>> REPLACE`. The old lines must
  occur exactly once at their tier, or the block is ambiguous.
- **V4A** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections. Update chunks carry an
  optional `@@` anchor and a cursor that moves through the file; a
  `*** End of File` chunk must land at the file's last line, and
  `*** Move to:` moves the file.
- **JSON** — one JSON array of edit objects, or one edit object per line
  (JSON Lines). Commands are `create`, `str_replace` and `insert`, with
  exact matching and CRLF-aware replacement.

## Matching

Old lines are found at the first of three tiers at which they occur at
least once: exact, then ignoring trailing spaces and tabs, then ignoring
leading and trailing spaces and tabs. Context lines are written as the
file's own lines, and at the loosest tier the other new lines are re-indented
to the file's indentation. `--strict` tries the exact tier only.

## Output and exit codes

On success mend prints one line per changed path (`A`, `D`, `M`, or
`R old -> new` for a move), then `ok: <n> files`, and exits 0. When an edit
fails it prints one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, exits 1, and writes nothing. A usage, missing
patch, undetected format or unparsable patch error prints one line and
exits 2.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as it is.
- `check.ts` — runs `main.ts` on the kit's 100 practice checks.
- `SPEC.md` — the full specification this tool implements.

Run the practice set with:

```
node check.ts <kit>/program/generator/practice.json
```

The current implementation passes all 100 practice checks (practice score
1000): unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15,
and gives the same result on every run — no times, no randomness, no
network.

## License

MIT. See `LICENSE`.
