import assert from 'node:assert/strict'
import test from 'node:test'

import { toWindowsPath } from '../preset/gitbash-executor.mjs'

test('converts every single-letter MSYS drive path', { skip: process.platform !== 'win32' }, () => {
  assert.equal(toWindowsPath('/c/Users/10531'), 'C:\\Users\\10531')
  assert.equal(toWindowsPath('/d/foo/bar.txt'), 'D:\\foo\\bar.txt')
  assert.equal(toWindowsPath('/e'), 'E:\\')
  assert.equal(toWindowsPath('/f/'), 'F:\\')
  assert.equal(toWindowsPath('/C/Windows'), 'C:\\Windows')
})

test('leaves non-drive MSYS root paths untouched', () => {
  if (process.platform !== 'win32') {
    assert.equal(toWindowsPath('/usr/bin'), '/usr/bin')
    return
  }
  assert.equal(toWindowsPath('/usr/bin'), '/usr/bin')
  assert.equal(toWindowsPath('/tmp/x'), '/tmp/x')
  assert.equal(toWindowsPath('/home/user'), '/home/user')
})

test('leaves Windows-native and relative paths untouched', () => {
  assert.equal(toWindowsPath('C:\\Users\\x'), 'C:\\Users\\x')
  assert.equal(toWindowsPath('D:/foo'), 'D:/foo')
  assert.equal(toWindowsPath('foo/bar'), 'foo/bar')
  assert.equal(toWindowsPath(''), '')
  assert.equal(toWindowsPath(undefined), undefined)
})
