/**
 * Local env loader tests. Uses temporary directories — never the real
 * backend/.env.local and never a real API key.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadLocalEnvFiles,
  parseEnvFile,
  mergeEnvFile,
  describeLocalEnv,
  backendRootDir,
} from '../../src/lib/env-loader.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-loader-test-'))
  tempDirs.push(dir)
  return dir
}

function writeEnv(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('env file loader', () => {
  it('loads backend/.env.local values', () => {
    const dir = makeTempDir()
    writeEnv(dir, '.env.local', 'LEASEWEB_API_KEY=local-secret\nLEASEWEB_MODE=live\nLEASEWEB_ORDERING_ENABLED=false\n')
    const target: NodeJS.ProcessEnv = {}
    const res = loadLocalEnvFiles({ rootDir: dir, target })
    expect(res.envLocalFound).toBe(true)
    expect(target.LEASEWEB_MODE).toBe('live')
    expect(target.LEASEWEB_ORDERING_ENABLED).toBe('false')
    expect(target.LEASEWEB_API_KEY).toBe('local-secret')
    expect(res.appliedFromLocal).toContain('LEASEWEB_API_KEY')
  })

  it('existing process env overrides .env.local', () => {
    const dir = makeTempDir()
    writeEnv(dir, '.env.local', 'LEASEWEB_MODE=live\nLEASEWEB_API_KEY=file-secret\n')
    const target: NodeJS.ProcessEnv = { LEASEWEB_MODE: 'mock', LEASEWEB_API_KEY: 'process-secret' }
    loadLocalEnvFiles({ rootDir: dir, target })
    expect(target.LEASEWEB_MODE).toBe('mock')
    expect(target.LEASEWEB_API_KEY).toBe('process-secret')
  })

  it('.env.local wins over .env (both applied after process env)', () => {
    const dir = makeTempDir()
    writeEnv(dir, '.env', 'LEASEWEB_MODE=mock\nLEASEWEB_API_KEY=from-env\n')
    writeEnv(dir, '.env.local', 'LEASEWEB_API_KEY=from-local\n')
    const target: NodeJS.ProcessEnv = {}
    loadLocalEnvFiles({ rootDir: dir, target })
    expect(target.LEASEWEB_API_KEY).toBe('from-local')
    expect(target.LEASEWEB_MODE).toBe('mock')
  })

  it('missing .env.local does not crash', () => {
    const dir = makeTempDir() // empty
    const target: NodeJS.ProcessEnv = {}
    const res = loadLocalEnvFiles({ rootDir: dir, target })
    expect(res.envLocalFound).toBe(false)
    expect(res.envFound).toBe(false)
    expect(res.appliedFromLocal).toEqual([])
  })

  it('production mode does not read env files (injected env only)', () => {
    const dir = makeTempDir()
    writeEnv(dir, '.env.local', 'LEASEWEB_API_KEY=should-not-load\n')
    const prev = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      const target: NodeJS.ProcessEnv = {}
      const res = loadLocalEnvFiles({ rootDir: dir, target })
      expect(res.envLocalFound).toBe(false)
      expect(target.LEASEWEB_API_KEY).toBeUndefined()
      // force:true still allows explicit local loading when desired.
      const forced = loadLocalEnvFiles({ rootDir: dir, target, force: true })
      expect(forced.envLocalFound).toBe(true)
      expect(target.LEASEWEB_API_KEY).toBe('should-not-load')
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('safe diagnostics never return secret values', () => {
    const dir = makeTempDir()
    writeEnv(dir, '.env.local', 'LEASEWEB_API_KEY=super-secret-value\n')
    const target: NodeJS.ProcessEnv = { LEASEWEB_API_KEY: 'super-secret-value', LEASEWEB_MODE: 'live', LEASEWEB_ORDERING_ENABLED: 'false' }
    const state = describeLocalEnv(target)
    expect(state.apiKey).toBe('configured')
    expect(JSON.stringify(state)).not.toContain('super-secret-value')
    const missing = describeLocalEnv({})
    expect(missing.apiKey).toBe('missing')
    expect(missing.mode).toBe('unset')
  })

  it('parses comments, quotes, export prefix and blank lines', () => {
    const parsed = parseEnvFile(
      [
        '# comment',
        '',
        'export LEASEWEB_MODE=live',
        'LEASEWEB_API_KEY="quoted value"',
        "TRAILING=with 'single quotes'",
        'MALFORMED LINE WITHOUT EQUALS',
        'EMPTY_VALUE=',
      ].join('\n'),
    )
    expect(parsed.LEASEWEB_MODE).toBe('live')
    expect(parsed.LEASEWEB_API_KEY).toBe('quoted value')
    expect(parsed.TRAILING).toBe("with 'single quotes'")
    expect(parsed.MALFORMED).toBeUndefined()
    expect(parsed.EMPTY_VALUE).toBe('')
  })

  it('mergeEnvFile never overwrites and reports applied keys', () => {
    const target: NodeJS.ProcessEnv = { KEEP: 'mine' }
    const applied = mergeEnvFile({ KEEP: 'file', NEW: 'value' }, target)
    expect(target.KEEP).toBe('mine')
    expect(target.NEW).toBe('value')
    expect(applied).toEqual(['NEW'])
  })

  it('resolves the backend root deterministically', () => {
    expect(backendRootDir().endsWith('backend')).toBe(true)
  })
})