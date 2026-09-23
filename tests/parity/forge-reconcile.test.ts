import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DeliveryInvalidInputError,
  reconcileCiRerun,
  reconcilePullRequest,
  reconcileRemoteMerge,
} from '../../src/step/reconcile-delivery.ts'
import { EFFECT_CLASSES } from '../../src/step/step.ts'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignora falhas de limpeza no teardown
    }
  }
  tempDirs = []
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeBareRepo(): { dir: string } {
  const dir = makeTempDir('ade-forge-bare-')
  execFileSync('git', ['init', '--bare'], { cwd: dir, encoding: 'utf8' })
  return { dir }
}

interface ForgeFixtureData {
  prOpen: {
    state: string
    baseRefName: string
    headRefOid: string
    mergedAt: string | null
  }
  prMerged: {
    state: string
    baseRefName: string
    headRefOid: string
    mergedAt: string | null
  }
  networkDown: {
    code: string
    message: string
  }
}

function loadForgeFixtures(): ForgeFixtureData {
  const root = path.resolve(__dirname, '../..')
  const prOpen = JSON.parse(
    readFileSync(path.join(root, 'fixtures/scenarios/forge/pr-open.json'), 'utf8'),
  )
  const prMerged = JSON.parse(
    readFileSync(path.join(root, 'fixtures/scenarios/forge/pr-merged.json'), 'utf8'),
  )
  const networkDown = JSON.parse(
    readFileSync(path.join(root, 'fixtures/scenarios/forge/network-down.json'), 'utf8'),
  )
  return { prOpen, prMerged, networkDown }
}

export class FakeForgePort {
  calls = 0
  networkError = false
  networkErrorCode = 'ENETUNREACH'
  bareDir?: string
  prData: {
    state: string
    baseRefName: string
    headRefOid: string
    mergedAt: string | null
  } | null = null

  constructor(options: {
    prData?: {
      state: string
      baseRefName: string
      headRefOid: string
      mergedAt: string | null
    } | null
    networkError?: boolean
    networkErrorCode?: string
    bareDir?: string
  } = {}) {
    this.prData = options.prData ?? null
    this.networkError = options.networkError ?? false
    if (options.networkErrorCode) {
      this.networkErrorCode = options.networkErrorCode
    }
    this.bareDir = options.bareDir
  }

  async findPullRequest({ headRef }: { headRef?: string } = {}): Promise<{
    state: string
    baseRefName: string
    headRefOid: string
    mergedAt: string | null
  } | null> {
    this.calls++
    if (this.networkError) {
      const err = new Error(`connect ${this.networkErrorCode}`)
      ;(err as any).code = this.networkErrorCode
      throw err
    }

    if (this.bareDir && headRef && !this.prData) {
      try {
        const oid = execFileSync('git', ['--git-dir', this.bareDir, 'rev-parse', headRef], {
          encoding: 'utf8',
        }).trim()
        return {
          state: 'OPEN',
          baseRefName: 'main',
          headRefOid: oid,
          mergedAt: null,
        }
      } catch {
        return null
      }
    }

    return this.prData
  }
}

describe('Reconciliar PR, merge remoto e CI', () => {
  // CA1: Dado PR OPEN com base e head exatos, quando reconciliado, então é adotado;
  // base ou head diferente não é adotado.
  // Exemplos:
  // - [CA1] {state:'OPEN',baseRefName:'main',headRefOid:'abc'} esperado {base_ref:'main',head_commit:'abc'} → {verdict:'ok'}
  // - [CA1] {state:'OPEN',baseRefName:'main',headRefOid:'def'} esperado head_commit:'abc' → {verdict:'ambiguous'}
  test('ca1_pr_open_with_exact_base_and_head_is_adopted', async () => {
    const { prOpen, prMerged, networkDown } = loadForgeFixtures()
    expect(prOpen).toBeDefined()
    expect(prMerged).toBeDefined()
    expect(networkDown).toBeDefined()

    const bare = makeBareRepo()

    // 1. Base e head exatos: adotado com verdict: 'ok'
    const portMatched = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prOpen, baseRefName: 'main', headRefOid: 'abc' },
    })
    const outcomeOk = await reconcilePullRequest({
      intent: {
        step_id: 'pr:1',
        effect_class: 'pull_request',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portMatched,
    })
    expect(outcomeOk.verdict).toBe('ok')
    expect(portMatched.calls).toBe(1)

    // 2. Head divergente ('def' vs esperado 'abc'): ambiguous
    const portHeadMismatch = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prOpen, baseRefName: 'main', headRefOid: 'def' },
    })
    const outcomeHeadMismatch = await reconcilePullRequest({
      intent: {
        step_id: 'pr:2',
        effect_class: 'pull_request',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portHeadMismatch,
    })
    expect(outcomeHeadMismatch.verdict).toBe('ambiguous')

    // 3. Base divergente ('dev' vs esperado 'main'): ambiguous
    const portBaseMismatch = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prOpen, baseRefName: 'dev', headRefOid: 'abc' },
    })
    const outcomeBaseMismatch = await reconcilePullRequest({
      intent: {
        step_id: 'pr:3',
        effect_class: 'pull_request',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portBaseMismatch,
    })
    expect(outcomeBaseMismatch.verdict).toBe('ambiguous')

    // 4. PR fechado em vez de OPEN: ambiguous
    const portClosed = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prOpen, state: 'CLOSED', baseRefName: 'main', headRefOid: 'abc' },
    })
    const outcomeClosed = await reconcilePullRequest({
      intent: {
        step_id: 'pr:4',
        effect_class: 'pull_request',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portClosed,
    })
    expect(outcomeClosed.verdict).toBe('ambiguous')

    // Validação de entrada inválida
    await expect(
      reconcilePullRequest({ intent: null as any, forgePort: portMatched }),
    ).rejects.toThrow(DeliveryInvalidInputError)
    await expect(
      reconcilePullRequest({
        intent: { step_id: 'pr:inv' } as any,
        forgePort: null as any,
      }),
    ).rejects.toThrow(DeliveryInvalidInputError)
  })

  // CA2: Dado PR MERGED no commit e base esperados, quando reconciliado, então a unidade completa;
  // CLOSED, outro head ou outra base produz ambiguous.
  // Exemplos:
  // - [CA2] {state:'MERGED',baseRefName:'main',headRefOid:'abc'} → {verdict:'ok'}
  // - [CA2] {state:'CLOSED',baseRefName:'main',headRefOid:'abc'} → {verdict:'ambiguous'}
  test('ca2_pr_merged_on_commit_and_base_completes_otherwise_ambiguous', async () => {
    const { prOpen, prMerged, networkDown } = loadForgeFixtures()
    expect(prOpen).toBeDefined()
    expect(prMerged).toBeDefined()
    expect(networkDown).toBeDefined()

    const bare = makeBareRepo()

    // 1. PR MERGED no commit e base esperados: verdict: 'ok'
    const portMergedOk = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prMerged, state: 'MERGED', baseRefName: 'main', headRefOid: 'abc' },
    })
    const outcomeOk = await reconcileRemoteMerge({
      intent: {
        step_id: 'merge:1',
        effect_class: 'pull_request_merge',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portMergedOk,
    })
    expect(outcomeOk.verdict).toBe('ok')
    expect(portMergedOk.calls).toBe(1)

    // 2. PR CLOSED no mesmo commit e base: ambiguous
    const portClosed = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prMerged, state: 'CLOSED', baseRefName: 'main', headRefOid: 'abc' },
    })
    const outcomeClosed = await reconcileRemoteMerge({
      intent: {
        step_id: 'merge:2',
        effect_class: 'pull_request_merge',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portClosed,
    })
    expect(outcomeClosed.verdict).toBe('ambiguous')

    // 3. Outro head: ambiguous
    const portDiffHead = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prMerged, state: 'MERGED', baseRefName: 'main', headRefOid: 'def' },
    })
    const outcomeDiffHead = await reconcileRemoteMerge({
      intent: {
        step_id: 'merge:3',
        effect_class: 'pull_request_merge',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portDiffHead,
    })
    expect(outcomeDiffHead.verdict).toBe('ambiguous')

    // 4. Outra base: ambiguous
    const portDiffBase = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prMerged, state: 'MERGED', baseRefName: 'dev', headRefOid: 'abc' },
    })
    const outcomeDiffBase = await reconcileRemoteMerge({
      intent: {
        step_id: 'merge:4',
        effect_class: 'pull_request_merge',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portDiffBase,
    })
    expect(outcomeDiffBase.verdict).toBe('ambiguous')

    // Validação de entrada inválida
    await expect(
      reconcileRemoteMerge({ intent: null as any, forgePort: portMergedOk }),
    ).rejects.toThrow(DeliveryInvalidInputError)
    await expect(
      reconcileRemoteMerge({
        intent: { step_id: 'merge:inv' } as any,
        forgePort: null as any,
      }),
    ).rejects.toThrow(DeliveryInvalidInputError)
  })

  // CA3: Dado comando de merge que apenas enfileira e mantém PR OPEN, quando verificado,
  // então o resultado é ambiguous e não success.
  // Exemplo:
  // - [CA3] merge enfileirado com estado final OPEN → {verdict:'ambiguous'}
  test('ca3_merge_command_enqueued_open_returns_ambiguous', async () => {
    const { prOpen, prMerged, networkDown } = loadForgeFixtures()
    expect(prOpen).toBeDefined()
    expect(prMerged).toBeDefined()
    expect(networkDown).toBeDefined()

    const bare = makeBareRepo()

    // PR ainda OPEN após comando de merge ser enfileirado
    const portEnqueued = new FakeForgePort({
      bareDir: bare.dir,
      prData: { ...prOpen, state: 'OPEN', baseRefName: 'main', headRefOid: 'abc' },
    })
    const outcome = await reconcileRemoteMerge({
      intent: {
        step_id: 'merge:enqueued',
        effect_class: 'pull_request_merge',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portEnqueued,
    })

    expect(outcome.verdict).toBe('ambiguous')
    expect(outcome.verdict).not.toBe('ok')
    expect(portEnqueued.calls).toBe(1)
  })

  // CA4: Dada intenção ci_rerun aberta, quando retomada, então é ambiguous,
  // conta uma tentativa e não chama rerun novamente.
  // Exemplo:
  // - [CA4] {effect_class:'ci_rerun'} → {verdict:'ambiguous',attempts:1,rerun_calls:0}
  test('ca4_ci_rerun_intent_resumed_is_ambiguous_and_never_retried', async () => {
    const { prOpen, prMerged, networkDown } = loadForgeFixtures()
    expect(prOpen).toBeDefined()
    expect(prMerged).toBeDefined()
    expect(networkDown).toBeDefined()

    const bare = makeBareRepo()
    const unusedPort = new FakeForgePort({ bareDir: bare.dir })

    const intent = {
      step_id: 'ci:rerun:1',
      effect_class: 'ci_rerun',
    }

    const outcome = reconcileCiRerun({ intent })

    expect(outcome.verdict).toBe('ambiguous')
    expect(outcome.attempts).toBe(1)
    expect(outcome.rerun_calls).toBe(0)
    expect(outcome.reason).toBe('ci_rerun_requires_operator')
    expect(outcome.evidence?.attempts).toBe(1)
    expect(unusedPort.calls).toBe(0)

    // Validação de entrada inválida
    expect(() => reconcileCiRerun({ intent: null as any })).toThrow(DeliveryInvalidInputError)
  })

  // CA5: Dada porta indisponível na retomada, quando qualquer estado remoto é consultado,
  // então o resultado é awaiting_operator com reason network, sem retry.
  // Exemplo:
  // - [CA5] findPullRequest lança ENETUNREACH → {state:'awaiting_operator',reason:'network',calls:1}
  test('ca5_unavailable_port_returns_awaiting_operator_with_reason_network_without_retry', async () => {
    const { prOpen, prMerged, networkDown } = loadForgeFixtures()
    expect(prOpen).toBeDefined()
    expect(prMerged).toBeDefined()
    expect(networkDown).toBeDefined()

    const bare = makeBareRepo()

    // 1. Falha em reconcilePullRequest
    const portDownPr = new FakeForgePort({
      bareDir: bare.dir,
      networkError: true,
      networkErrorCode: networkDown.code,
    })

    const outcomePr = await reconcilePullRequest({
      intent: {
        step_id: 'pr:net',
        effect_class: 'pull_request',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portDownPr,
    })

    expect(outcomePr.state).toBe('awaiting_operator')
    expect(outcomePr.reason).toBe('network')
    expect(outcomePr.verdict).toBe('ambiguous')
    expect(portDownPr.calls).toBe(1) // exatamente 1 chamada, sem retry

    // 2. Falha em reconcileRemoteMerge
    const portDownMerge = new FakeForgePort({
      bareDir: bare.dir,
      networkError: true,
      networkErrorCode: networkDown.code,
    })

    const outcomeMerge = await reconcileRemoteMerge({
      intent: {
        step_id: 'merge:net',
        effect_class: 'pull_request_merge',
        head_ref: 'feature',
        intent_context: {
          base_ref: 'main',
          head_commit: 'abc',
        },
      },
      forgePort: portDownMerge,
    })

    expect(outcomeMerge.state).toBe('awaiting_operator')
    expect(outcomeMerge.reason).toBe('network')
    expect(outcomeMerge.verdict).toBe('ambiguous')
    expect(portDownMerge.calls).toBe(1) // exatamente 1 chamada, sem retry

    // 3. Validação de EFFECT_CLASSES estendido
    expect(EFFECT_CLASSES).toContain('pull_request')
    expect(EFFECT_CLASSES).toContain('pull_request_merge')
    expect(EFFECT_CLASSES).toContain('ci_rerun')
  })
})
