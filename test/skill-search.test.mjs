import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../shared/skill-search.mjs'

function register(skills = []) {
  const registered = []
  const injected = []
  const ctx = {
    skills: {
      async list() {
        return skills
      },
      async get(skillName) {
        return skills.find((skill) => skill.name === skillName)
      },
    },
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    agents: {},
  }
  apply(ctx)
  return { registered, injected, ctx }
}

const exec = () => ({
  agent: { session: { id: 's', header: { cwd: '/work' } } },
  signal: undefined,
})

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'skill-search')
})

test('registers skill_search and skill_load', () => {
  const { registered } = register()
  const names = registered.map((tool) => tool.name)
  assert.deepEqual(names.sort(), ['skill_load', 'skill_search'])
})

test('skill_search lists matching skills by keyword, summaries only', async () => {
  const { registered } = register([
    { name: 'pdf-tools', description: 'PDF manipulation toolkit' },
    { name: 'obsidian-vault', description: 'knowledge wiki' },
    { name: 'game-review', description: 'GDD review' },
  ])
  const search = registered.find((tool) => tool.name === 'skill_search')
  const result = await search.execute({ query: 'pdf' }, exec())
  assert.match(result.text, /pdf-tools/)
  assert.doesNotMatch(result.text, /obsidian-vault/)
  assert.doesNotMatch(result.text, /game-review/)
})

test('skill_search with no query lists everything (bounded)', async () => {
  const { registered } = register([{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }])
  const search = registered.find((tool) => tool.name === 'skill_search')
  const result = await search.execute({ query: '' }, exec())
  assert.match(result.text, /a:/)
  assert.match(result.text, /b:/)
})

test('skill_search with no matches says so', async () => {
  const { registered } = register([{ name: 'pdf-tools', description: 'PDF' }])
  const search = registered.find((tool) => tool.name === 'skill_search')
  const result = await search.execute({ query: 'quantum' }, exec())
  assert.match(result.text, /No skills match/)
})

test('skill_load injects the skill body for the next request via agent.inject', async () => {
  const { registered } = register([{ name: 'pdf-tools', description: 'PDF', content: '# PDF Tools\nfull instructions' }])
  let injected = null
  const agent = { session: { id: 's', header: { cwd: '/work' } }, inject(message) { injected = message } }
  const load = registered.find((tool) => tool.name === 'skill_load')
  const result = await load.execute({ name: 'pdf-tools' }, { agent })
  assert.match(result.text, /loaded/)
  assert.ok(injected)
  assert.equal(injected.source.kind, 'skill-invocation')
  assert.match(injected.content[0].text, /full instructions/)
})

test('skill_load with an unknown name reports without injecting', async () => {
  const { registered } = register([])
  const load = registered.find((tool) => tool.name === 'skill_load')
  const result = await load.execute({ name: 'nope' }, exec())
  assert.match(result.text, /No skill named/)
})

test('a throwing skills service degrades to a message, never throws', async () => {
  const spy = {
    skills: {
      async list() {
        throw new Error('skills registry unavailable')
      },
      async get() {
        throw new Error('skills registry unavailable')
      },
    },
    tools: { register(t) { (this.registered ??= []).push(t) } },
    agents: {},
  }
  apply(spy)
  const search = spy.tools.registered.find((tool) => tool.name === 'skill_search')
  const result = await search.execute({ query: 'pdf' }, exec())
  assert.match(result.text, /skill_search unavailable/)
})

test('skill_search matches a long natural query by token hits, ranked (#80 semantics)', async () => {
  const { registered } = register([
    { name: 'pdf', description: 'convert documents to PDF and merge' },
    { name: 'docx', description: 'work with word document files' },
    { name: 'unrelated', description: 'game walkthroughs' },
  ])
  const search = registered.find((tool) => tool.name === 'skill_search')
  // Under the old AND-over-all-tokens filter this returned "No skills match"
  // even though every word appears across the catalog.
  const result = await search.execute({ query: 'convert word document to pdf' }, exec())
  assert.match(result.text, /pdf:/)
  assert.match(result.text, /docx:/)
  assert.doesNotMatch(result.text, /unrelated/)
  // pdf hits 3 tokens (convert/pdf/…), docx hits 2 (word/document): ranked.
  assert.ok(result.text.indexOf('pdf:') < result.text.indexOf('docx:'))
})
