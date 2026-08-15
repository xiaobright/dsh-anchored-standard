import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../preset/agent.cordis.yml', import.meta.url), 'utf8')

/** Extract one `- id: <id>` entry's lines (including its nested config) by indentation. */
function entryBlock(id) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`)
  assert.ok(start >= 0, `${id} row must exist in preset/agent.cordis.yml`)
  const indent = (lines[start].match(/^\s*/) ?? [''])[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    const lineIndent = (line.match(/^\s*/) ?? [''])[0].length
    if (lineIndent <= indent) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** Read one `key: value` scalar from an entry block. */
function configValue(block, key) {
  const match = block.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, 'm'))
  assert.ok(match, `${key} must be configured in the block`)
  return match[1].trim()
}

test('the persistent shell picks /bin/bash when present, else falls back to PATH lookup', () => {
  const terminalBash = entryBlock('terminal-bash')
  const shellPath = configValue(terminalBash, 'shellPath')
  // The loader `!!js` expression keeps the previous absolute default on
  // hosts that ship /bin/bash and only switches to PATH lookup where it is
  // missing (NixOS etc.) — where the absolute default makes every bash call
  // fail with "PTY shell exited during startup".
  assert.match(shellPath, /existsSync\('\/bin\/bash'\)/)
  assert.match(shellPath, /'\/bin\/bash'\s*:\s*'bash'/)
  assert.match(shellPath, /!!js/)
})

test('the Minimal bash schema rows stay mounted beside the shellPath override', () => {
  const persistentBash = entryBlock('persistent-bash')
  assert.match(persistentBash, /Run commands in a bash shell/)
  assert.equal(configValue(entryBlock('terminal-bash'), 'timeoutMs'), '300000')
})
