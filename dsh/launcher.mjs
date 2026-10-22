#!/usr/bin/env node
// helmsman engine launcher: boots our cordis.yml with dsh-app-boot.
// Usage: node launcher.mjs [path/to/cordis.yml] (default ./cordis.yml)
// stdout is reserved for ACP JSON-RPC; diagnostics go to stderr.

import { existsSync } from 'node:fs'
import { boot, installFailLoud, loadLayeredEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'helmsman'
installFailLoud(NAME)
// Layered loading: inherited environment > project .env (cwd) > Harness home .env (~/.dsh/.env, contains DEEPSEEK_API_KEY)
loadLayeredEnv(NAME)

const requested = process.env['HELMSMAN_CORDIS'] ?? process.argv[2] ?? './cordis.yml'
const configPath = resolveConfigPath(requested, undefined)
if (!existsSync(configPath)) {
  process.stderr.write(`usage: node launcher.mjs <path/to/cordis.yml>\n`)
  process.exit(1)
}

// boot mounts the full composition. stdin EOF and SIGTERM → dispose the root context → graceful exit
// (flushes persistence; otherwise an external SIGKILL would lose trailing events).
const ctx = await boot(NAME, configPath)
const disposeAndExit = () => { void ctx.fiber.dispose().then(() => process.exit(0)) }
process.stdin.on('end', disposeAndExit)
process.on('SIGTERM', disposeAndExit)
