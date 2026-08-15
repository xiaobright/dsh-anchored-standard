import assert from 'node:assert/strict'
import test from 'node:test'

import { join as winJoin } from 'node:path/win32'
import { detectShellPath, name, resolveConfig, toWindowsPath } from '../preset/gitbash-executor.mjs'

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'gitbash-executor')
})

test('toWindowsPath converts MSYS drive paths on win32', { skip: process.platform !== 'win32' }, () => {
  assert.equal(toWindowsPath('/c/Users/10531'), winJoin('C:', 'Users', '10531'))
  assert.equal(toWindowsPath('/d/foo/bar.txt'), winJoin('D:', 'foo', 'bar.txt'))
})

test('toWindowsPath is a no-op outside win32', { skip: process.platform === 'win32' }, () => {
  assert.equal(toWindowsPath('/c/Users/10531'), '/c/Users/10531')
})

test('detectShellPath prefers an explicit path', () => {
  const explicit = process.platform === 'win32' ? winJoin('C:', 'Program Files', 'Git', 'bin', 'bash.exe') : '/opt/bin/bash'
  assert.equal(detectShellPath(explicit, {}), explicit)
})

test('resolveConfig applies defaults and positive validation', () => {
  const resolved = resolveConfig({}, {})
  assert.equal(resolved.timeoutMs, 120000)
  assert.equal(resolved.maxTimeoutMs, 600000)
  assert.equal(resolved.maxOutputBytes, 64000)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs/)
})
