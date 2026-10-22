# Helmsman environment conventions for agents

This repository's toolchain is managed by **Nix flake + direnv (nix-direnv)**, not nvm / Homebrew / a global Node.

## Load the environment first, then decide whether something is missing

An agent's non-interactive shell does **not** run zsh's `direnv hook`, so a bare `which node` / `which pnpm` is often empty. That does not mean the tools aren't installed on this machine, and you should never:

- install Node with nvm / fnm / volta
- install Node with Homebrew / apt
- substitute the Node bundled with Cursor / Zed, or `corepack`
- edit the user's `~/.zshrc` / nix config

The right way is to load this repository's direnv first, then run the command:

```bash
# Single command (recommended)
direnv exec . <command>

# Inject PATH into the current shell (later commands all use the Nix environment)
eval "$(direnv export bash)"
```

Once loaded you should see something like:

- `node` → Nix's Node.js 22 (currently 22.23.2)
- `pnpm` → Nix's pnpm (currently 11.20.0)

If `direnv exec .` fails: run `direnv allow` at the repository root first; do not install a toolchain yourself.

## Machine-local files (do not commit, do not delete)

These are the developer's local environment and are already in `.gitignore`:

| Path | Purpose |
|---|---|
| `.envrc` | `use flake .` (the direnv entry point) |
| `.direnv/` | the devShell cached by nix-direnv |
| `flake.nix` / `flake.lock` | the local flake (if present) |

It's normal not to see `flake.nix` in the repository: the environment lives on the local machine and is not checked into git.

## Everyday commands

Run them all from the repository root, through direnv:

```bash
direnv exec . bash -lc 'cd dsh && pnpm install'
direnv exec . bash -lc 'cd web && pnpm dev'
```
