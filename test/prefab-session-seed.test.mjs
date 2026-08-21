import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** Flush the seeder's microtask + async skill re-render chain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

import {
  apply,
  buildSeedPlan,
  loadPrefabTemplate,
  loadInstructionBundle,
  readyTitleForPreset,
  renderLiveSkillResults,
  renderSkillSearchResult,
  seedSession,
  synchronizeAgentTurnCursor,
} from '../prefab/prefab-session-seed.mjs'

test('ready title distinguishes the generic and Project2 modes', () => {
  assert.equal(readyTitleForPreset('prefab-anchored-standard'), 'Prefab Anchored Standard - Ready')
  assert.equal(readyTitleForPreset('prefab-anchored-project2'), 'Prefab Anchored Project2 - Ready')
})

function fakeSession(cwd = 'C:\\target') {
  const events = []
  let publishing = false
  let listener
  return {
    id: 'session-target',
    header: { cwd },
    events,
    set listener(value) { listener = value },
    append(type, data, opts) {
      if (publishing) throw new Error('session append cannot reenter while another append is being published')
      const event = { type, seq: events.length, time: Date.now(), data, ...(opts ?? {}) }
      events.push(event)
      if (listener !== undefined) {
        publishing = true
        try { listener(this, event) } finally { publishing = false }
      }
      return event
    },
  }
}

function fixture(dir) {
  const templatePath = join(dir, 'template.jsonl')
  const rows = [
    { type: 'session', id: 'source', cwd: 'C:\\source' },
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, data: { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect C:\\source' }] }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 9, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: 'We need inspect C:\\source.' }] } }, surfaceOp: 'append', sourceEventSeqs: [3, 4, 5, 6, 7, 8] },
    { type: 'tool/call', seq: 10, data: { turn: 1, step: 1, callId: 'call-read', name: 'str_replace_editor', arguments: '{"command":"view","path":"C:\\\\source\\\\AGENTS.md"}' } },
    { type: 'tool/result', seq: 11, data: { turn: 1, step: 1, message: { role: 'user', id: 'r1', source: { kind: 'tool', callId: 'call-read' }, content: [{ type: 'tool-result', toolCallId: 'call-read', content: [{ type: 'text', text: '# old rules' }], isError: false }] } }, surfaceOp: 'append', sourceEventSeqs: [10] },
    { type: 'tool/call', seq: 12, data: { turn: 1, step: 1, callId: 'call-unlock', name: 'dev_tool_search', arguments: '{"toolNames":["web_search","todo_write"]}' } },
    { type: 'tool/result', seq: 13, data: { turn: 1, step: 1, message: { role: 'user', id: 'r2', source: { kind: 'tool', callId: 'call-unlock' }, content: [{ type: 'tool-result', toolCallId: 'call-unlock', content: [{ type: 'text', text: 'Unlocked for the next request: web_search, todo_write' }], isError: false }] } }, surfaceOp: 'append', sourceEventSeqs: [12] },
    { type: 'assistant/message', seq: 14, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a2', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: 'Tool errors: retry the instruction read.' }, { type: 'tool-call', id: 'call-bad-read', name: 'str_replace_editor', arguments: '{"command":"view","path":"C:\\\\source\\\\AGENTS.md","view_range":null}' }] } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 15, data: { turn: 1, step: 2, callId: 'call-bad-read', name: 'str_replace_editor', arguments: '{"command":"view","path":"C:\\\\source\\\\AGENTS.md","view_range":null}' } },
    { type: 'tool/result', seq: 16, data: { turn: 1, step: 2, message: { role: 'user', id: 'r3', source: { kind: 'tool', callId: 'call-bad-read' }, content: [{ type: 'tool-result', toolCallId: 'call-bad-read', content: [{ type: 'text', text: 'Error: invalid arguments' }], isError: true }] } }, surfaceOp: 'append', sourceEventSeqs: [15] },
    { type: 'tool/call', seq: 17, data: { turn: 1, step: 2, callId: 'call-skill', name: 'skill_search', arguments: '{"query":"code"}' } },
    { type: 'tool/result', seq: 18, data: { turn: 1, step: 2, message: { role: 'user', id: 'r4', source: { kind: 'tool', callId: 'call-skill' }, content: [{ type: 'tool-result', toolCallId: 'call-skill', content: [{ type: 'text', text: 'Matching skills (2):\n- algorithmic-art: roll machine skill\n- doc-coauthoring: another roll machine skill\n\nLoad one with skill_load (exact name).' }], isError: false }] } }, surfaceOp: 'append', sourceEventSeqs: [17] },
    { type: 'step/end', seq: 19, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 20, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  writeFileSync(templatePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return templatePath
}

test('compact prefab plan preserves trajectory state and rewrites cwd plus AGENTS.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-seed-'))
  try {
    const template = loadPrefabTemplate(fixture(dir))
    const plan = buildSeedPlan(template, 'D:\\workspace', '# current rules')
    assert.equal(plan.some((event) => event.type === 'assistant/chunk'), false)
    assert.match(JSON.stringify(plan), /D:\\\\workspace/)
    assert.doesNotMatch(JSON.stringify(plan), /C:\\\\source/i)
    const result = plan.find((event) => event.seq === 11)
    assert.equal(result.data.message.content[0].content[0].text, '# current rules')
    assert.doesNotMatch(JSON.stringify(plan), /call-bad-read|invalid arguments|Tool errors:/)
    assert.match(JSON.stringify(plan), /read.*write.*edit.*glob.*grep.*ask_user_question.*todo_write.*web_search/)

    const session = fakeSession('D:\\workspace')
    assert.equal(seedSession(session, plan), true)
    assert.equal(seedSession(session, plan), false)
    assert.deepEqual(session.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [1])
    assert.equal(session.events.at(-1).data.title, 'Prefab Anchored Standard - Ready')
    const toolResult = session.events.find((event) => event.type === 'tool/result')
    const toolCall = session.events.find((event) => event.type === 'tool/call')
    assert.deepEqual(toolResult.sourceEventSeqs, [toolCall.seq])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preset selection seeds after publication and ignores other or nonblank sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-select-'))
  try {
    const handlers = new Map()
    const errors = []
    const ctx = {
      on(type, callback) { handlers.set(type, callback) },
      get(service) { return service === 'agents' ? this.agents : undefined },
      logger: { error(message) { errors.push(message) } },
    }
    const session = fakeSession(dir)
    const agent = { session, status: 'idle', phase: { kind: 'idle', lastTurn: 0 } }
    ctx.agents = { get(id) { return id === session.id ? agent : undefined } }
    apply(ctx, { templatePath: fixture(dir) })

    session.listener = handlers.get('session/event')
    session.append('agent-preset/selected', { agentPreset: 'other' })
    await settle()
    assert.equal(session.events.some((event) => event.type === 'turn/start'), false)

    session.append('agent-preset/selected', { agentPreset: 'prefab-anchored-standard' })
    await settle()
    assert.equal(session.events.some((event) => event.type === 'turn/start'), true)
    assert.equal(agent.phase.lastTurn, 1)
    const nextTurn = agent.phase.lastTurn + 1
    session.append('turn/start', { turn: nextTurn })
    agent.phase.lastTurn = nextTurn
    assert.deepEqual(session.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [1, 2])
    assert.deepEqual(errors, [])

    session.append('agent-preset/selected', { agentPreset: 'prefab-anchored-standard' })
    await settle()
    assert.equal(session.events.filter((event) => event.type === 'turn/start').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session created with the preset as default seeds on its first permission event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-born-'))
  try {
    const handlers = new Map()
    const errors = []
    const ctx = {
      on(type, callback) { handlers.set(type, callback) },
      get(service) { return service === 'agents' ? this.agents : undefined },
      logger: { error(message) { errors.push(message) } },
    }
    // A session CREATED with the preset: the header names it, and no
    // agent-preset/selected event is ever emitted. The first
    // permission/preset event must trigger seeding (agent may not exist yet).
    const session = fakeSession(dir)
    session.header.agentPreset = 'prefab-anchored-standard'
    ctx.agents = { get(id) { return id === session.id ? undefined : undefined } }
    apply(ctx, { templatePath: fixture(dir) })

    session.listener = handlers.get('session/event')
    session.append('permission/preset', { preset: 'workspace-write' })
    await settle()
    assert.equal(session.events.some((event) => event.type === 'turn/start'), true, 'born session must be seeded')
    assert.equal(session.events.at(-1).data.title, 'Prefab Anchored Standard - Ready')
    assert.deepEqual(errors, [], 'no agent on the born path must not error')

    // The turn/start guard must prevent a later double-seed.
    const countAfterFirst = session.events.filter((event) => event.type === 'turn/start').length
    session.append('permission/preset', { preset: 'workspace-write' })
    await settle()
    assert.equal(session.events.filter((event) => event.type === 'turn/start').length, countAfterFirst, 'no double-seed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default-preset seeding synchronizes an agent published while skills are loading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-born-race-'))
  try {
    const handlers = new Map()
    let publishSkills
    const skillsReady = new Promise((resolve) => { publishSkills = resolve })
    let agent
    const ctx = {
      on(type, callback) { handlers.set(type, callback) },
      get(service) {
        if (service === 'agents') return { get() { return agent } }
        if (service === 'skills') return { async list() { await skillsReady; return [] } }
        return undefined
      },
      logger: { error(error) { throw new Error(error) } },
    }
    const session = fakeSession(dir)
    session.header.agentPreset = 'prefab-anchored-standard'
    apply(ctx, { templatePath: fixture(dir) })
    session.listener = handlers.get('session/event')

    session.append('permission/preset', { preset: 'workspace-write' })
    await Promise.resolve()
    agent = { session, status: 'idle', phase: { kind: 'idle', lastTurn: 0 } }
    publishSkills()
    await settle()

    assert.equal(agent.phase.lastTurn, 1, 'late-published agent must see the seeded turn')
    assert.equal(agent.phase.lastTurn + 1, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session with a different preset header ignores permission events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-born-other-'))
  try {
    const handlers = new Map()
    const ctx = {
      on(type, callback) { handlers.set(type, callback) },
      get() { return undefined },
      logger: { error() {} },
    }
    const session = fakeSession(dir)
    session.header.agentPreset = 'standard'
    apply(ctx, { templatePath: fixture(dir) })
    session.listener = handlers.get('session/event')
    session.append('permission/preset', { preset: 'workspace-write' })
    await settle()
    assert.equal(session.events.some((event) => event.type === 'turn/start'), false, 'other preset must not seed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bundled two-turn template continues at turn three with a clean durable tool surface', () => {
  const template = loadPrefabTemplate()
  const plan = buildSeedPlan(template, 'D:\\workspace', '# current rules')
  const serialized = JSON.stringify(plan)
  assert.doesNotMatch(serialized, /invalid arguments|call_01_DatgXHdOtnchisU4rVJ05960|call_00_5YeUlYeebjHPf7E6FZJL0342/)
  for (const tool of ['read', 'write', 'edit', 'glob', 'grep', 'ask_user_question', 'todo_write', 'web_search']) {
    assert.match(serialized, new RegExp(`\\b${tool}\\b`))
  }

  const session = fakeSession('D:\\workspace')
  const agent = { session, status: 'idle', phase: { kind: 'idle', lastTurn: 0 } }
  assert.equal(seedSession(session, plan), true)
  assert.equal(synchronizeAgentTurnCursor(agent, session), 2)
  const nextTurn = agent.phase.lastTurn + 1
  assert.equal(nextTurn, 3)
})

test('instruction bundle injects global then workspace originals without project scanning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-instructions-'))
  try {
    const dshHome = join(dir, '.dsh')
    const workspace = join(dir, 'workspace')
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(dshHome, 'AGENTS.md'), '# global rules')
    writeFileSync(join(workspace, 'AGENTS.md'), '# workspace rules')
    const bundle = loadInstructionBundle(workspace, dshHome)
    assert.ok(bundle.indexOf('# global rules') < bundle.indexOf('# workspace rules'))
    assert.match(bundle, /<global-agents/)
    assert.match(bundle, /<workspace-agents/)
    assert.doesNotMatch(bundle, /README|project/i)

    writeFileSync(join(workspace, 'AGENTS.md'), '# global rules')
    assert.equal(loadInstructionBundle(workspace, dshHome), '# global rules')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderSkillSearchResult mirrors the live skill_search tool wording', () => {
  const skills = [
    { name: 'pdf', description: 'PDF work\nmore lines' },
    { name: 'doc-coauthoring', description: 'Co-author docs' },
  ]
  assert.equal(
    renderSkillSearchResult('pdf', skills),
    'Matching skills (1):\n- pdf: PDF work\n\nLoad one with skill_load (exact name).',
  )
  assert.equal(
    renderSkillSearchResult('missing', skills),
    'No skills match "missing". Use skill_search with other keywords.',
  )
})

test('buildSeedPlan re-renders skill_search results and never ships the roll catalog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-skill-'))
  try {
    const template = loadPrefabTemplate(fixture(dir))
    const baked = buildSeedPlan(template, 'D:\workspace', '# rules')
    assert.match(JSON.stringify(baked), /algorithmic-art: roll machine skill/)

    const live = buildSeedPlan(template, 'D:\workspace', '# rules', new Map([
      ['call-skill', 'No skills match "code". Use skill_search with other keywords.'],
    ]))
    assert.doesNotMatch(JSON.stringify(live), /algorithmic-art|doc-coauthoring: another/)
    assert.match(JSON.stringify(live), /No skills match .{0,4}code.{0,4} Use skill_search with other keywords/)
    // Other substitutions are untouched by the skill rewrite.
    assert.match(JSON.stringify(live), /Unlocked for the next request: read, write, edit, glob, grep, ask_user_question, todo_write, web_search/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderLiveSkillResults queries this registry and degrades to unavailable, never to the baked catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prefab-live-'))
  try {
    const plan = buildSeedPlan(loadPrefabTemplate(fixture(dir)), 'D:\workspace', '# rules')
    const cases = [
      {
        skills: { list: async () => [{ name: 'code-sweep', description: 'lives here' }] },
        expect: 'Matching skills (1):\n- code-sweep: lives here\n\nLoad one with skill_load (exact name).',
      },
      { skills: { list: async () => { throw new Error('boom') } }, expect: 'skill_search unavailable:' },
      { skills: undefined, expect: null },
    ]
    for (const { skills, expect } of cases) {
      const results = await renderLiveSkillResults({ get: (service) => (service === 'skills' ? skills : undefined) }, plan, undefined, 'D:\workspace')
      if (expect === null) {
        assert.equal(results.size, 0)
      } else {
        assert.equal(results.get('call-skill').startsWith(expect), true)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
