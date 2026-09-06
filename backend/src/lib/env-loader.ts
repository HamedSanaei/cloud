/**
 * Local development environment loader — the ONLY place that reads env files.
 *
 * Precedence (highest first):
 *   1. existing process environment variables
 *   2. backend/.env.local
 *   3. backend/.env
 *   4. application defaults (config.ts)
 *
 * Explicit process env vars are NEVER overwritten by file values. Missing
 * files are a no-op, so production (injected env/secrets only) never depends
 * on these files. Additionally, when NODE_ENV=production the files are not
 * read at all.
 *
 * Paths are resolved from this module's own location (src/lib -> backend/),
 * so commands work from any working directory and from the compiled dist.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENV_LOCAL_FILENAME = '.env.local'
export const ENV_FILENAME = '.env'

/** Deterministic backend project root, independent of the shell cwd. */
export function backendRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/lib/env-loader.ts or dist/lib/env-loader.js -> ../../ = backend/
  return resolve(here, '..', '..')
}

/**
 * Parse .env-style content. Supports `KEY=VALUE`, optional single/double
 * quotes around the value, `#` comments, blank lines and an optional
 * `export ` prefix. Unknown/malformed lines are ignored.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    out[m[1]!] = value
  }
  return out
}

/** Apply parsed values into the target env, never overwriting existing keys. */
export function mergeEnvFile(parsed: Record<string, string>, target: NodeJS.ProcessEnv): string[] {
  const applied: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) {
      target[key] = value
      applied.push(key)
    }
  }
  return applied
}

export interface EnvLoadResult {
  envLocalPath: string
  envPath: string
  envLocalFound: boolean
  envFound: boolean
  appliedFromLocal: string[]
  appliedFromEnv: string[]
}

/**
 * Load backend/.env.local then backend/.env into `target` (process.env by
 * default). Returns what was found/applied — never any secret values.
 */
export function loadLocalEnvFiles(
  opts: { rootDir?: string; target?: NodeJS.ProcessEnv; force?: boolean } = {},
): EnvLoadResult {
  const root = opts.rootDir ?? backendRootDir()
  const target = opts.target ?? process.env
  const envLocalPath = join(root, ENV_LOCAL_FILENAME)
  const envPath = join(root, ENV_FILENAME)

  // Production relies exclusively on injected env/secrets.
  const production = process.env.NODE_ENV === 'production' && opts.force !== true
  const envLocalFound = !production && existsSync(envLocalPath)
  const envFound = !production && existsSync(envPath)
  const appliedFromLocal = envLocalFound ? mergeEnvFile(parseEnvFile(readFileSync(envLocalPath, 'utf8')), target) : []
  const appliedFromEnv = envFound ? mergeEnvFile(parseEnvFile(readFileSync(envPath, 'utf8')), target) : []
  return { envLocalPath, envPath, envLocalFound, envFound, appliedFromLocal, appliedFromEnv }
}

// ---------------------------------------------------------------------------
// Safe diagnostics — never returns secret values.
// ---------------------------------------------------------------------------

export interface SafeLocalEnvState {
  envLocalPath: string
  envLocalFound: boolean
  apiKey: 'configured' | 'missing'
  mode: string | 'unset'
  orderingEnabled: 'true' | 'false' | 'unset'
}

export function describeLocalEnv(target: NodeJS.ProcessEnv = process.env): SafeLocalEnvState {
  const path = join(backendRootDir(), ENV_LOCAL_FILENAME)
  const ordering = target.LEASEWEB_ORDERING_ENABLED
  return {
    envLocalPath: path,
    envLocalFound: existsSync(path),
    apiKey: target.LEASEWEB_API_KEY && target.LEASEWEB_API_KEY.length > 0 ? 'configured' : 'missing',
    mode: target.LEASEWEB_MODE ?? 'unset',
    orderingEnabled: ordering === undefined ? 'unset' : ordering === 'true' || ordering === '1' ? 'true' : 'false',
  }
}