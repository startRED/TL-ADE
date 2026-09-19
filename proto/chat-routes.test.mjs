import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as chatChanges from './chat-changes.mjs'

describe('chatCommand', () => {
  it('CA1: Claude permite somente ferramentas de edição e repassa esforço válido', () => {
    const command = chatChanges.chatCommand('claude', {
      model: 'sonnet', effort: 'high', cwd: 'W', prompt: 'P'
    })

    assert.equal(command.cmd, 'claude')
    assert.equal(command.cwd, 'W')
    assert.equal(command.stdin, 'P')
    const tools = command.args.indexOf('--tools')
    assert.deepEqual(command.args.slice(tools, tools + 9), [
      '--tools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'WebFetch', 'WebSearch'
    ])
    assert.deepEqual(command.args.slice(-11), [
      '--tools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'WebFetch', 'WebSearch', '--effort', 'high'
    ])
    assert.ok(command.args.includes('--permission-mode'))
    assert.equal(command.args[command.args.indexOf('--permission-mode') + 1], 'acceptEdits')
    assert.ok(!command.args.includes('Bash'))
    assert.ok(!command.args.includes('plan'))
  })

  it('CA2: Codex escreve somente na cópia e recebe o prompt por stdin', () => {
    const command = chatChanges.chatCommand('codex', {
      model: 'gpt-5.6-sol', effort: 'high', cwd: 'W', prompt: 'P'
    })

    assert.equal(command.cmd, 'codex')
    assert.equal(command.cwd, 'W')
    assert.equal(command.stdin, 'P')
    assert.deepEqual(command.args.slice(command.args.indexOf('--sandbox'), command.args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write'])
    assert.deepEqual(command.args.slice(command.args.indexOf('-C'), command.args.indexOf('-C') + 2), ['-C', 'W'])
    assert.deepEqual(command.args.slice(command.args.indexOf('-m'), command.args.indexOf('-m') + 2), ['-m', 'gpt-5.6-sol'])
    assert.ok(command.args.includes('model_reasoning_effort=high'))
    assert.equal(command.args.at(-1), '-')
    assert.ok(!command.args.includes('read-only'))
  })

  it('CA3: agy coloca o pedido sanitizado em print sem modo de plano', () => {
    const command = chatChanges.chatCommand('agy', {
      model: 'gemini-3.8-flash-high', effort: 'high', cwd: 'W', prompt: 'diga "oi"\nagora'
    })

    assert.equal(command.cmd, 'agy')
    assert.equal(command.cwd, 'W')
    assert.equal(command.stdin, undefined)
    assert.equal(command.args[0], "--print=diga 'oi' agora")
    assert.deepEqual(command.args.slice(command.args.indexOf('--model'), command.args.indexOf('--model') + 2), ['--model', 'gemini-3.8-flash-high'])
    assert.ok(command.args.includes('--dangerously-skip-permissions'))
    assert.ok(!command.args.includes('--mode'))
    assert.ok(!command.args.includes('plan'))
  })

  it('CA4: esforço inválido é omitido no Claude e vira medium no Codex', () => {
    const claude = chatChanges.chatCommand('claude', {
      model: 'sonnet', effort: undefined, cwd: 'W', prompt: 'P'
    })
    const codex = chatChanges.chatCommand('codex', {
      model: 'm', effort: 'turbo', cwd: 'W', prompt: 'P'
    })

    assert.ok(!claude.args.includes('--effort'))
    assert.ok(codex.args.includes('model_reasoning_effort=medium'))
  })
})
