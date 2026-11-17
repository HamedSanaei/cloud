// Verify the actual installed matcher, not just its package/audit name.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const directory = resolve(process.argv[2] ?? '.')
const lock = JSON.parse(readFileSync(resolve(directory, 'package-lock.json'), 'utf8'))
const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/picomatch'))
assert.ok(copies.length, 'Expected the build-tool matcher in this dependency tree')
const checks = String.raw`
  const assert = require('node:assert/strict');
  const pm = require(process.argv[1]);
  for (const [pattern, yes, no] of [
    ['src/**/*.tsx', 'src/pages/Register.tsx', 'src/pages/Register.js'],
    ['{src,test}/**/*.{ts,tsx}', 'test/pages/auth.test.tsx', 'docs/readme.md'],
    ['+(foo|bar)', 'foobarfoo', 'foobaz'],
    ['+(*a)', 'aba', 'aaa!'],
    ['+(a*b)', 'abab', 'aba'],
    ['*(a*)b', 'b', 'aaa!'],
    ['*', 'visible', '.hidden']
  ]) {
    assert.equal(pm.isMatch(yes, pattern), true, pattern);
    assert.equal(pm.isMatch(no, pattern), false, pattern);
  }
  assert.equal(pm.isMatch('src\\pages\\Register.tsx', 'src/**/*.tsx', { windows: true }), true);
  // The original 4.0.7 blocks on these failing inputs; bound it in this child.
  for (const pattern of ['+(*a)', '+(*)b', '*(a*)b', '+(a*b)c', '+(*?a)']) {
    assert.equal(pm.isMatch('a'.repeat(10000) + '!', pattern), false, pattern);
  }
`
for (const [name, entry] of copies) {
  assert.equal(entry.name, '@ryotsu/picomatch', `Unpatched matcher in ${name}`)
  assert.equal(entry.version, '4.0.7-a')
  const installed = resolve(directory, name)
  const manifest = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, entry.name); assert.equal(manifest.version, entry.version)
  const result = spawnSync(process.execPath, ['-e', checks, installed], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `Matcher security/compatibility regression: ${result.stderr}`)
}
console.log(`Matcher security and compatibility passed (${copies.length} installed copy/copies in ${process.argv[2] ?? '.'})`)
