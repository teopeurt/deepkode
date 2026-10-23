# Order-preserving dedupe CLI (dedupe) design notes

> Design notes for an order-preserving dedupe CLI implemented in Node with zero dependencies.
> Baseline: the project knowledge-base entry "Yolo validation - dedupe CLI" already has a zero-dependency prototype `dedupe.mjs` (~30 lines) that passed 5 test cases;
> this design standardizes it (adding stdin, `--help`, error classification, a CLI contract and acceptance cases) while keeping the core algorithm the same.

## 1. Background and goals

- **Background**: we need a small tool that removes duplicate lines from a file/pipe while keeping each line's first-occurrence order (log dedupe, config merging, list cleanup, etc.).
- **Goal**: an order-preserving dedupe CLI implemented in Node with **zero third-party dependencies** (Node built-in modules only).
- **Order-preserving semantics**: a duplicated line is kept only at its **first occurrence**; output order = the order in which lines first appear (not lexicographic, not last occurrence).
- **Deliverable**: a single-file ESM script `dedupe.mjs`, run directly with `node dedupe.mjs`; no install, no build.

## 2. Requirements

### 2.1 Functional requirements

| ID | Requirement | Notes |
|---|---|---|
| F1 | File dedupe | `node dedupe.mjs <file>` reads line by line, dedupes preserving order, writes to stdout |
| F2 | Pipe input | `cat in.txt \| node dedupe.mjs` (argument `-` or omitted) reads from stdin |
| F3 | CRLF compatible | both `\r\n` and `\n` split lines, `\r` is not part of the line content, output is always LF |
| F4 | Empty lines are deduped | an empty line is still a "line": repeated empty lines keep only the first |
| F5 | Empty input | empty file / empty stdin → no output, exit code 0 |
| F6 | File errors | file missing / unreadable → error on stderr, exit code 1 |
| F7 | Usage | `--help` / `-h` prints usage and exits 0; invalid arguments print usage and exit 1 |
| F8 | Content is identity | lines are compared **verbatim**: case-sensitive, leading/trailing spaces kept, Unicode/UTF-8 kept as-is |

### 2.2 Non-functional requirements

- **Zero dependencies**: only built-in modules such as `node:fs` and `node:process`; no package.json dependencies, no lockfile.
- **Deterministic**: the same input always gives the same output (Set membership and iteration order are both deterministic).
- **Simplicity first**: read everything into memory (`readFileSync`) in exchange for a simple implementation; a streaming approach for large files is left as an extension in §4.4 and is not in v1.

## 3. Overall design

```
                        ┌─────────────────────────────┐
   argv[2] ──┬─ <file> ─▶│  readInput(arg)             │
             │           │   - file: fs.readFileSync   │
   stdin ────┴─ - / none▶│   - stdin: fs.readFileSync(0)│
                        └──────────────┬──────────────┘
                                       ▼
                        ┌─────────────────────────────┐
                        │  dedupeLines(text)          │  ← pure function
                        │   normalize CRLF → split →  │
                        │   Set dedupe → ordered lines │
                        └──────────────┬──────────────┘
                                       ▼
                        ┌─────────────────────────────┐
                        │  stdout: join('\n') + '\n'   │
                        │  stderr: error message + exit 1 │
                        └─────────────────────────────┘
```

- A single file `dedupe.mjs` with three responsibilities: **argument parsing and error handling** (`main`), **input reading** (`readInput`), **pure dedupe logic** (`dedupeLines`).
- The dedupe core matches the validated prototype: a `Set` records lines already seen; while iterating, an unseen line is added to the `Set` and appended to the result array → order is preserved naturally.

## 4. Detailed design

### 4.1 Function breakdown

```
main(argv)            // entry: parse arguments, call readInput/dedupeLines, write stdout, set the exit code
readInput(arg)        // arg === '-' or undefined → stdin; otherwise read the file (ENOENT/EACCES are rethrown)
dedupeLines(text)     // pure function: (string) => string[], the deduped lines in order
```

### 4.2 Core algorithm (dedupeLines)

```js
function dedupeLines(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const seen = new Set()
  const out = []
  for (const line of lines) {
    if (!seen.has(line)) { seen.add(line); out.push(line) }
  }
  return out
}
```

- **Normalize CRLF first**: `replaceAll('\r\n', '\n')` before `split('\n')`, so no `\r` is left at line ends, and "the last line has no trailing newline" still works (split still yields that line).
- **Dedupe granularity = the whole raw line**: empty strings, lines with spaces and Chinese characters are all compared as-is.
- **Order preserved**: the output array order is the iteration order = the order in which lines first appear.

### 4.3 CLI contract

```
Usage:
  node dedupe.mjs <file>         # order-preserving dedupe of a file
  cat in.txt | node dedupe.mjs  # order-preserving dedupe of stdin (argument omitted or -)
  node dedupe.mjs --help        # print usage, exit 0

Exit codes:
  0  success (including empty input → no output)
  1  file missing / unreadable / invalid arguments
```

- Output: a non-empty result = `join('\n') + '\n'` (one trailing newline added); an empty result = no output at all.
- Error messages go to stderr in the format `dedupe: <reason>` (e.g. `dedupe: ENOENT: no such file or directory, open 'x.txt'`).

### 4.4 Edge cases and trade-offs

| Scenario | Behavior |
|---|---|
| Empty file (0 bytes) | No output, exit 0 |
| Only newlines / repeated empty lines | Empty lines are deduped; repeated empty lines keep only the first |
| CRLF file | Line content contains no `\r`; output is always LF |
| Last line without a newline | Deduped normally; a trailing newline is added on output |
| Leading/trailing spaces / case differences | Compared verbatim: `a` vs `A`, `"a"` vs `" a "` are different lines |
| Chinese / emoji / any UTF-8 | `readFileSync(utf8)` reads and writes as-is, no transcoding |
| Large files | v1 reads everything into memory (simplicity first); extension: `readline` line by line + incremental Set, same interface |
| Permission denied / path is a directory | Catch EACCES and similar errors → stderr + exit 1 |

## 5. Acceptance plan

### 5.1 Baseline cases (the 5 cases already validated in the knowledge base)

| # | Case | Expected |
|---|---|---|
| ① | Basic dedupe `apple/banana/apple/cherry/banana` | `apple/banana/cherry` |
| ② | Repeated empty lines | Only the first empty line is kept |
| ③ | CRLF line endings | Lines split correctly, no `\r` in the output |
| ④ | Empty file | No output, exit code 0 |
| ⑤ | File missing | Error on stderr, exit code 1 |

### 5.2 New cases (extensions in this design)

| # | Case | Expected |
|---|---|---|
| ⑥ | stdin: `printf 'a\nb\na\n' \| node dedupe.mjs` | Output `a\nb` |
| ⑦ | `node dedupe.mjs -` (explicit `-`) | Same as ⑥ |
| ⑧ | `node dedupe.mjs --help` | Prints usage, exit code 0 |
| ⑨ | Last line without a newline: `printf 'x\ny\nx'` | Output `x\ny` (trailing newline added) |
| ⑩ | Case/space sensitive: `a`, `A`, ` a` | All three lines are kept |

### 5.3 Acceptance commands

```bash
# Case ①
printf 'apple\nbanana\napple\ncherry\nbanana\n' > /tmp/dedupe-in.txt
node dedupe.mjs /tmp/dedupe-in.txt   # expected: apple banana cherry (one per line)
# Case ④
: > /tmp/dedupe-empty.txt && node dedupe.mjs /tmp/dedupe-empty.txt && echo "exit=$?"  # exit=0 and no output
# Case ⑤
node dedupe.mjs /tmp/does-not-exist.txt; echo "exit=$?"   # error on stderr, exit=1
```

## 6. References

- Knowledge-base entry "Yolo validation - dedupe CLI": the prototype `dedupe.mjs` (zero-dependency Node ESM, ~30 lines, Set-based order-preserving dedupe) and its 5-case validation record.
- Knowledge-base entries "Calibration validation - calculator" / "Calibration validation - todo CLI": the established pattern for zero-dependency Node CLIs in the same style (usage, exit codes, error-handling conventions).
