# File dedupe CLI —— design notes

> Goal: implement an **order-preserving dedupe** command-line tool with **zero Node dependencies**.
> Given a list of file paths, output the list with entries whose content (or path) is duplicated removed, **keeping the original order**.

---

## 1. Goals and boundaries

### 1.1 Goals

- Dedupe the input list of file paths while keeping the input order (**the first occurrence is kept**, later duplicates are removed).
- Dedupe by **file content** by default (identical content counts as a duplicate); provide a mode that dedupes by **path**.
- Use only Node.js built-in modules (`fs` / `crypto` / `stream` / `readline` / `path` / `process`),
  with no npm dependencies; a single file is enough to run it.
- Support large files and large numbers of files: hashing reads as a stream, so memory use is bounded.

### 1.2 Non-goals (not in this iteration)

- No cross-device/distributed dedupe; no post-dedupe tidying beyond **physical deletion** (move, rename, hard-link merging).
- No incremental index/cache (every run computes everything; see §6 for extensions).
- No similarity-based dedupe (exact dedupe only).

---

## 2. Usage scenarios and CLI shape

```bash
# Input from command-line arguments (most common)
dedup a.txt b.txt a.txt c.txt            # outputs a.txt b.txt c.txt

# Piped input together with find / xargs
find . -name '*.log' | dedup

# Use NUL separators when file names may contain newlines (compatible with find -print0)
find . -type f -print0 | dedup --null

# Scan a directory, then dedupe
dedup --recursive --dir ./assets

# List duplicates without changing anything (safe rehearsal)
dedup --dir ./photos --dry-run --list-dups

# Delete duplicate files (keep only the first of each group)
dedup --dir ./downloads --delete --dry-run
```

The three input modes are mutually exclusive (`--args` is the default; positional arguments are ignored once `--stdin` or `--dir` is given).

---

## 3. Semantics

### 3.1 Order-preserving rule

- The input sequence is numbered in order of appearance. **The first occurrence stays in its original position**; later items that duplicate it are removed from the output; all other items keep their positions.
- Example: `[A, B, A, C, B]` → `[A, B, C]`. This is the standard "order-preserving dedupe" semantics (like Unix `awk '!seen[$0]++'`).

### 3.2 Duplicate key

| Mode | Key | Notes |
|---|---|---|
| `--by-content` (default) | File content | Byte-identical content is a duplicate |
| `--by-path` | Normalized path | The same path (or hard links to the same inode, see below) appearing more than once is a duplicate |

### 3.3 Group semantics

- Within a group of mutually duplicate files, keep the one **earliest in input order** (`--keep-last` keeps the latest instead).
- Removed items disappear from the output; in `--delete` mode they are deleted (rehearse with `--dry-run` first).

---

## 4. Algorithm design

### 4.1 Overall flow

```
Parse arguments → collect input paths (args / stdin / directory scan) → decide duplicates item by item → order-preserving output
```

### 4.2 Content check: two-level filter

1. **File size (O(1), no hashing cost beyond the I/O)**
   - Different sizes ⇒ the content must differ, so it is immediately not a duplicate.
   - Only candidates with the same size go on to hash comparison. `fs.stat` gives the size (and the inode as well, see 4.4).
2. **Streaming SHA-256 hash**
   - `crypto.createHash('sha256')` + `fs.createReadStream` fed chunk by chunk (64 KB by default);
     `hash.digest('hex')` gives a 64-character key. Streaming ⇒ memory use is independent of file size.
   - Hash cache: within one run, the second occurrence of the same path reuses the hash result directly (path dedupe + content check both apply).

### 4.3 Dedupe table and order-preserving output

- `seen: Map<key, firstIndex>`: key → input index of the first occurrence.
- The output phase walks the input in order: if the key's firstIndex in `seen` equals its own index ⇒ output; otherwise ⇒ removed.
- Complexity: time `O(n)` (each check is amortized O(1); hashing I/O is the bottleneck); space `O(number of entries after dedupe)` (the seen table + output buffer).

### 4.4 Hard-link fast path (optional optimization)

- `fs.stat` returns `dev + ino`. Within one file system, hard links point to the same inode, so their content is necessarily identical.
- With `--hardlink-dedup` (on by default), first check duplicates by `dev:ino`; hits **skip hashing** and reuse the key of the group's first member.
- Note: `dev:ino` is only meaningful on the local machine and cannot be mixed across machines/devices (the design doesn't dedupe across devices, so this isn't an issue).

### 4.5 Empty-file edge case

- All empty files have identical content ⇒ they are all duplicates of each other. The behavior matches the definition (keep the first), but it should be stated explicitly in the docs and in `--verbose` output to avoid confusing users.

---

## 5. CLI interface design

### 5.1 Arguments

| Argument | Description | Default |
|---|---|---|
| `paths...` | Positional arguments used directly as input paths | — |
| `--stdin` | Read paths from stdin (one per line) | Enabled automatically when there are no positional arguments |
| `--null` / `-0` | NUL-separated input/output (works with `find -print0` / `xargs -0`) | Off |
| `--dir <d>` | Scan a directory; use with `--recursive` to recurse | None |
| `--recursive` | Scan `--dir` recursively | Off |
| `--by-content` | Dedupe by content (default) | On |
| `--by-path` | Dedupe by normalized path | Off |
| `--keep-first` / `--keep-last` | Keep the first / last of each duplicate group | `--keep-first` |
| `--delete` | Delete removed files (dangerous) | Off |
| `--dry-run` | Only report what would be done, delete nothing | Required as a rehearsal when `--delete` is on |
| `--list-dups` | Also output duplicate-group details (each member of a group) | Off |
| `--verbose` | Print progress to stderr (hashing/decision process) | Off |
| `--skip-errors` | Skip files whose read/stat fails instead of exiting with an error | Off |
| `--no-hardlink-dedup` | Disable the hard-link fast path | Hard-link fast path on |
| `--help` / `-h`, `--version` / `-v` | Help / version | — |

### 5.2 Output contract

- **stdout**: only the result list (one path per line, order preserved), so it can keep being piped downstream (`xargs` / loops).
- **stderr**: logs, warnings, errors (`--verbose` progress, the `--dry-run` rehearsal list).
- Strictly separating program output from logs is the first principle of "CLI composability".

### 5.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including a completed `--dry-run` rehearsal) |
| 1 | Runtime error (invalid arguments / unreadable file without `--skip-errors`) |
| 2 | Usage error (unknown argument, conflicting mutually exclusive arguments, missing required argument) |

### 5.4 Path normalization

- Input paths are compared after `path.resolve` (so `./a` and `a` are not treated as different).
- Relative paths are **output exactly as the user wrote them** (the normalized form is only used for decisions), respecting the user's expectations and pipe semantics.
- Symbolic links are **not followed** by default (`lstat`; directory scans record the link itself); `--follow-symlinks` enables following.

---

## 6. Zero-dependency implementation notes

1. **Single-file structure**: `dedup.js` (or `bin/dedup` with the shebang `#!/usr/bin/env node`),
   split into functions internally so unit tests can `require`/`import` them directly:

   ```
   parseArgs(argv) → Config
   collectInput(cfg) → string[]        // args / stdin / directory scan
   keyOf(path, cfg) → Promise<string>  // two-level size+hash check (including the dev:ino fast path)
   dedupe(list, cfg) → {kept[], groups[], removed[]}
   render(result, cfg) → void          // stdout output + stderr report
   main(argv) → exitCode
   ```

2. **Built-in modules used**: `fs` (stat/createReadStream/readdir), `crypto` (sha256),
   `stream/promises` (pipeline, for streaming hashes), `readline` (stdin line by line), `path`, `process`, `util` (promisify, or just `fs.promises`).
3. **Bounded memory**: hashing is streamed throughout; even if the output is held entirely in memory, it is on the order of "path string × entries after dedupe", which is acceptable.
4. **Parallel hashing (optional)**: with many files, do size/stat and hashing (I/O bound) in parallel at a fixed concurrency (e.g. 4),
   putting results back by input index so the order-preserving output is not broken. The implementation only needs built-in `Promise`, no concurrency library.
5. **Error isolation**: a stat/read failure on a single file terminates by default (exit code 1) and names the file; with `--skip-errors` it is skipped, and the count is summarized on stderr.

---

## 7. Edge cases and error handling checklist

| Scenario | Behavior |
|---|---|
| Empty input (no arguments, empty stdin, empty directory) | Empty output, exit code 0 |
| Empty files | All duplicates of each other; keep the first |
| A file is modified/deleted during the run | stat or the read stream fails ⇒ handled as an error (see 6.5) |
| Path doesn't exist | Error and exit 1 by default; skipped with `--skip-errors` |
| File name contains a newline | Warn outside `--null` mode (the input would be split incorrectly); suggest `-0` |
| Path contains spaces / Chinese / Unicode | Line-by-line / NUL transport is naturally safe; everything is UTF-8 internally |
| Directory scan hits a subdirectory without permission | Error by default; with `--skip-errors` skip that subtree and summarize |
| The same file referenced via different paths (`a` and `./a`) | Treated as the same path after normalization ⇒ deduped in path mode |
| `--delete` without `--dry-run` | Allowed to run, but `--verbose` prints each deletion; the docs strongly recommend rehearsing first |
| Hard links to the same inode with different paths | Content is necessarily identical; deduped via the fast path (on by default) |

---

## 8. Testing and acceptance criteria (for the later implementation)

> This task only delivers the design notes; the following is the acceptance baseline for the implementation, for development and review to reference.

1. **Order preservation**: content dedupe of `[A,B,A,C,B]` outputs `[A,B,C]`; `--keep-last` outputs `[A,C,B]`.
2. **Content vs path mode**: two files with the same content at different paths: duplicates under `--by-content`, not duplicates under `--by-path`.
3. **Size fast path**: files of different sizes don't trigger hashing (observe with `--verbose` or verify with an injected counter).
4. **Hard-link fast path**: two paths to the same inode are not hashed twice.
5. **Large files**: a ≥ 1 GB file is deduped within a peak memory budget of < 100 MB (validates streaming hashes).
6. **Pipe compatibility**: the whole chain `find ... -print0 | dedup -0 | xargs -0 ...` works.
7. **Exit codes**: usage error → 2; unreadable file without `--skip-errors` → 1; everything else → 0.
8. **`--dry-run` writes nothing**: zero file-system changes in rehearsal mode (verify by comparing `stat` of a temp directory before and after).
9. **Zero-dependency check**: `npm ls` (or no `node_modules` at all) and only built-in modules are `require`d.

---

## 9. Reference semantics (industry comparison)

- Unix convention: `awk '!seen[$0]++'` —— the classic order-preserving dedupe; this tool is its "file content version".
- `fdupes` / `rdfind` / `jdupes`: content dedupe but **without order-preserving output** (sorted by group/size), and they depend on the C ecosystem;
  this tool is positioned as their "zero-dependency, order-preserving, pipe-friendly" Node alternative.
- The "keep the first" and `--delete` semantics of `fdupes -N` match this design and can serve as a behavioral cross-check baseline.

---

## 10. Future extensions (not in this iteration, recorded only)

- A hash cache/index file (`.dedup-cache.json`), invalidated by mtime+size, to speed up repeated runs.
- Similar-content detection (rolling hashes / sampled blocks) feeding a "candidate similar groups" set.
- `--move-to <dir>` / `--merge-hardlinks` (replace duplicate files with hard links to save space).
- Output format extensions: `--format json` (machine-readable group details).
- A parallel-hashing concurrency parameter `--jobs <n>`.
