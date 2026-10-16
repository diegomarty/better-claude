import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { mayWrite } from '../src/tools.js'

describe('mayWrite', () => {
  test('the file tools write; reading, searching and asking do not', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) assert.equal(mayWrite(tool), true, tool)
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite', 'Agent', 'AskUserQuestion']) assert.equal(mayWrite(tool), false, tool)
  })

  test('Bash by its command', () => {
    assert.equal(mayWrite('Bash', { command: 'git status' }), false)
    assert.equal(mayWrite('Bash', { command: 'npm test' }), true)
    assert.equal(mayWrite('Bash', {}), true)
  })

  test('an MCP tool by what its name says; one that does not say, and an unknown tool, may write', () => {
    assert.equal(mayWrite('mcp__github__get_issue'), false)
    assert.equal(mayWrite('mcp__filesystem__list_directory'), false)
    assert.equal(mayWrite('mcp__filesystem__write_file'), true)
    assert.equal(mayWrite('mcp__codegen__apply'), true)
    // A verb that writes wins wherever it is in the name
    for (const tool of ['mcp__editor__find_and_replace', 'mcp__fs__search_and_replace', 'mcp__x__check_and_fix', 'mcp__db__get_or_create']) assert.equal(mayWrite(tool), true, tool)
    assert.equal(mayWrite('mcp__app__get_settings'), false)
    assert.equal(mayWrite('SomeNewTool'), true)
  })
})

test('a write verb past a read one: the tool may write', () => {
  for (const tool of ['mcp__x__fetch_and_store', 'mcp__x__get_or_add', 'mcp__x__check_and_format', 'mcp__x__read_and_append', 'mcp__x__search_and_download']) assert.equal(mayWrite(tool), true, tool)
})
