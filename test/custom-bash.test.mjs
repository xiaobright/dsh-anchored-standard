import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, bashCandidates, name, inject, normalizeGitBashWorkdir } from '../shared/custom-bash.mjs'

function register(config) {
  const registered = []
  const spawnCalls = []
  const resolved = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) {
        resolved.push(path)
        return path
      },
      spawn(options) {
        spawnCalls.push(options)
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom() { return { text: 'hello from bash' } } },
            stderr: { readFrom() { return { text: '' } } },
          },
        }
      },
    },
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
  }
  apply(ctx, config)
  return { tool: registered[0], spawnCalls, resolved, ctx }
}

/** Redirect every env var bashCandidates() reads at a nonexistent root. */
function isolateBashEnv(root) {
  const keys = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'USERPROFILE']
  const saved = keys.map((key) => [key, process.env[key]])
  for (const key of keys) process.env[key] = join(root, 'nowhere')
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const exec = (overrides = {}) => ({
  agent: { session: { id: 's', header: { cwd: 'C:/work' } } },
  signal: undefined,
  ...overrides,
})

test('exports a diagnostic plugin name and injects subprocess + tools', () => {
  assert.equal(name, 'custom-bash')
  assert.deepEqual(inject.sort(), ['subprocess', 'tools'].sort())
})

test('registers the bash tool with a Minimal-compatible description', () => {
  const { tool } = register()
  assert.equal(tool.name, 'bash')
  assert.match(tool.description, /Run commands in a bash shell/)
  assert.ok(tool.parameters.required.includes('command'))
  assert.ok(tool.output.schema)
})

test('execute spawns `bash -c <command>` and returns the combined output', async () => {
  const { tool, spawnCalls } = register({ bashPath: 'C:/Program Files/Git/bin/bash.exe' })
  const result = await tool.execute({ command: 'echo hi' }, exec())
  assert.equal(result.text, 'hello from bash')
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].argv, ['C:/Program Files/Git/bin/bash.exe', '-c', 'echo hi'])
})

test('an explicit bashPath bypasses inference entirely (issue #24)', async () => {
  const { tool, resolved } = register({ bashPath: 'D:/shims/git-bash.exe' })
  await tool.execute({ command: 'echo hi' }, exec())
  assert.deepEqual(resolved, ['D:/shims/git-bash.exe'])
})

test('execute passes the session cwd by default and honors an explicit workdir', async () => {
  const { tool, spawnCalls } = register()
  await tool.execute({ command: 'pwd' }, exec())
  assert.equal(spawnCalls[0].cwd, 'C:/work')
  await tool.execute({ command: 'pwd', workdir: 'D:/other' }, exec())
  assert.equal(spawnCalls[1].cwd, 'D:/other')
})

test('normalizeGitBashWorkdir converts /e/foo on Windows and leaves Unix paths alone', () => {
  assert.equal(normalizeGitBashWorkdir('/e/yaogan-jingjiaozheng', 'win32'), 'E:\\yaogan-jingjiaozheng')
  assert.equal(normalizeGitBashWorkdir('/e', 'win32'), 'E:\\')
  assert.equal(normalizeGitBashWorkdir('/usr/bin', 'win32'), '/usr/bin')
  assert.equal(normalizeGitBashWorkdir('/tmp', 'win32'), '/tmp')
  assert.equal(normalizeGitBashWorkdir('/e/foo', 'linux'), '/e/foo')
  assert.equal(normalizeGitBashWorkdir('D:/other', 'win32'), 'D:/other')
})

test('execute converts a Git Bash workdir on Windows (issue #55)', async () => {
  const { tool, spawnCalls } = register({ bashPath: 'C:/Program Files/Git/bin/bash.exe' })
  await tool.execute({ command: 'pwd', workdir: '/e/yaogan-jingjiaozheng' }, exec())
  if (process.platform === 'win32') {
    assert.equal(spawnCalls[0].cwd, 'E:\\yaogan-jingjiaozheng')
  } else {
    assert.equal(spawnCalls[0].cwd, '/e/yaogan-jingjiaozheng')
  }
})

test('execute falls back to the session cwd when an explicit workdir is ENOENT (issue #55)', async () => {
  const registered = []
  const spawnCalls = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn(options) {
        spawnCalls.push(options)
        if (options.cwd === 'D:/missing') {
          return { done: Promise.reject(new Error('spawn C:\\Program Files\\Git\\bin\\bash.exe ENOENT')) }
        }
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom() { return { text: 'ok' } } },
            stderr: { readFrom() { return { text: '' } } },
          },
        }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  const result = await registered[0].execute({ command: 'pwd', workdir: 'D:/missing' }, exec())
  assert.equal(spawnCalls.length, 2)
  assert.equal(spawnCalls[0].cwd, 'D:/missing')
  assert.equal(spawnCalls[1].cwd, 'C:/work')
  assert.match(result.text, /fell back to session cwd/)
  assert.match(result.text, /ok/)
})

test('a non-zero exit throws with the captured output', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 2 }),
          collected: {
            stdout: { readFrom() { return { text: 'boom' } } },
            stderr: { readFrom() { return { text: '' } } },
          },
        }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  await assert.rejects(() => registered[0].execute({ command: 'false' }, exec()), /boom/)
})

test('a spawn-level failure throws a descriptive error', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn() {
        return { done: Promise.reject(new Error('EPERM: operation not permitted')) }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  await assert.rejects(() => registered[0].execute({ command: 'x' }, exec()), /bash spawn failed/)
})

test('missing output readers degrade to the exit code text', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { return path },
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom() { throw new Error('unavailable') } },
            stderr: { readFrom() { throw new Error('unavailable') } },
          },
        }
      },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx)
  const result = await registered[0].execute({ command: 'x' }, exec())
  assert.match(result.text, /exit code: 0/)
})

test('the default falls back to `bash` on PATH after probing git (issue #24)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-bash-'))
  const restoreEnv = isolateBashEnv(dir)
  try {
    const registered = []
    const resolved = []
    const ctx = {
      subprocess: {
        // Identity resolution: `git` stays a bare name, so the install-root
        // derivation is skipped and no well-known root exists under `dir`.
        async resolveExecutable(path) { resolved.push(path); return path },
        spawn() { return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom() { return { text: 'ok' } } }, stderr: { readFrom() { return { text: '' } } } } } },
      },
      tools: { register(t) { registered.push(t) } },
    }
    apply(ctx)
    await registered[0].execute({ command: 'x' }, exec())
    assert.deepEqual(resolved, ['git', 'bash'])
  } finally {
    restoreEnv()
    await rm(dir, { recursive: true, force: true })
  }
})

test('inference spawns the bash.exe beside a resolved git executable (issue #24)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-bash-'))
  const restoreEnv = isolateBashEnv(dir)
  try {
    const gitRoot = join(dir, 'Git')
    const gitExe = join(gitRoot, 'cmd', 'git.exe')
    const bashExe = join(gitRoot, 'bin', 'bash.exe')
    await mkdir(join(gitRoot, 'cmd'), { recursive: true })
    await mkdir(join(gitRoot, 'bin'), { recursive: true })
    await writeFile(gitExe, '')
    await writeFile(bashExe, '')
    const registered = []
    const resolved = []
    const spawnCalls = []
    const ctx = {
      subprocess: {
        async resolveExecutable(path) {
          resolved.push(path)
          return path === 'git' ? gitExe : path
        },
        spawn(options) {
          spawnCalls.push(options)
          return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom() { return { text: 'ok' } } }, stderr: { readFrom() { return { text: '' } } } } }
        },
      },
      tools: { register(t) { registered.push(t) } },
    }
    apply(ctx)
    await registered[0].execute({ command: 'x' }, exec())
    assert.equal(spawnCalls[0].argv[0], bashExe)
    // The inference is memoized: a second execute resolves the found shell
    // directly instead of re-probing `git`.
    await registered[0].execute({ command: 'x' }, exec())
    assert.deepEqual(resolved, ['git', bashExe, bashExe])
  } finally {
    restoreEnv()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a totally unresolvable shell fails with an actionable error, not a raw ENOENT (issue #24)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-bash-'))
  const restoreEnv = isolateBashEnv(dir)
  try {
    const registered = []
    const ctx = {
      subprocess: {
        // Every lookup throws: `git`, every candidate, and the PATH fallback.
        async resolveExecutable() { throw new Error('ENOENT: no bash in PATH') },
        spawn() { throw new Error('spawn must not be reached') },
      },
      tools: { register(t) { registered.push(t) } },
    }
    apply(ctx)
    await assert.rejects(
      () => registered[0].execute({ command: 'x' }, exec()),
      /bash executable not found[\s\S]*`bashPath`[\s\S]*ENOENT/,
    )
  } finally {
    restoreEnv()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing-but-unresolvable candidate does not block the fallback chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-bash-'))
  const restoreEnv = isolateBashEnv(dir)
  try {
    const gitRoot = join(dir, 'Git')
    const gitExe = join(gitRoot, 'cmd', 'git.exe')
    const bashExe = join(gitRoot, 'bin', 'bash.exe')
    await mkdir(join(gitRoot, 'cmd'), { recursive: true })
    await mkdir(join(gitRoot, 'bin'), { recursive: true })
    await writeFile(gitExe, '')
    await writeFile(bashExe, '')
    const registered = []
    const resolved = []
    const spawnCalls = []
    const ctx = {
      subprocess: {
        async resolveExecutable(path) {
          resolved.push(path)
          if (path === 'git') return gitExe
          if (path === bashExe) throw new Error('EPERM: broken scoop junction')
          return path
        },
        spawn(options) {
          spawnCalls.push(options)
          return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom() { return { text: 'ok' } } }, stderr: { readFrom() { return { text: '' } } } } }
        },
      },
      tools: { register(t) { registered.push(t) } },
    }
    apply(ctx)
    await registered[0].execute({ command: 'x' }, exec())
    // The broken root is probed, skipped, and the PATH fallback serves the call.
    assert.deepEqual(resolved, ['git', bashExe, 'bash'])
    assert.equal(spawnCalls[0].argv[0], 'bash')
  } finally {
    restoreEnv()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a misconfigured explicit bashPath surfaces the raw resolution error, not the discovery hint', async () => {
  const registered = []
  const ctx = {
    subprocess: {
      async resolveExecutable(path) { throw new Error(`ENOENT: no ${path} on this machine`) },
      spawn() { throw new Error('spawn must not be reached') },
    },
    tools: { register(t) { registered.push(t) } },
  }
  apply(ctx, { bashPath: 'X:/no/such/bash.exe' })
  await assert.rejects(
    () => registered[0].execute({ command: 'x' }, exec()),
    (error) => error.message.includes('X:/no/such/bash.exe') && !error.message.includes('bash executable not found'),
  )
})

test('bashCandidates probes the git install root first, then env-derived roots', () => {
  // Expected values are built with join() so the assertions hold on both
  // path-module flavors (win32 normalizes to backslashes).
  const env = {
    ProgramFiles: 'C:/Program Files',
    'ProgramFiles(x86)': 'C:/Program Files (x86)',
    LOCALAPPDATA: 'C:/Users/u/AppData/Local',
    USERPROFILE: 'C:/Users/u',
  }
  const candidates = bashCandidates(env, 'C:/Program Files/Git/cmd/git.exe')
  assert.deepEqual(candidates, [
    join('C:/Program Files/Git', 'bin', 'bash.exe'),
    join('C:/Program Files/Git/cmd', 'bash.exe'),
    join('C:/Program Files', 'bin', 'bash.exe'),
    join('C:/Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join('C:/Users/u/AppData/Local', 'Programs', 'Git', 'bin', 'bash.exe'),
    join('C:/Users/u', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
  ])
})

test('bashCandidates derives the portable mingw64 layout and skips an unresolved git name', () => {
  const env = { USERPROFILE: '/home/u' }
  const portable = bashCandidates(env, '/opt/PortableGit/mingw64/bin/git.exe')
  assert.deepEqual(portable, [
    join('/opt/PortableGit/mingw64/bin', 'bash.exe'),
    join('/opt/PortableGit', 'bin', 'bash.exe'),
    join('/home/u', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
  ])
  // A bare `git` (identity resolution, no directory) yields env roots only.
  const envOnly = [join('/home/u', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe')]
  assert.deepEqual(bashCandidates(env, 'git'), envOnly)
  assert.deepEqual(bashCandidates(env, undefined), envOnly)
})
