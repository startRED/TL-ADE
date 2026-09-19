import fs, { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createGitPort } from '../../src/git/gitport.js'
import { Journal, openJournal } from '../../src/journal/journal.js'
import { startingReceipt, withRunning, withTerminal, writeReceipt } from '../../src/runner/receipt.js'
import { createStepRunner } from '../../src/step/step.js'

const [cenario, missionDir, worktreeDir] = process.argv.slice(2)

const RUNTIME_STAMP = '1:aaaaaaaa:bbbbbbbb'

// receiptPath(missionDir, 'T042:r1:maker') produz um nome de arquivo com dois-pontos, que o
// Windows interpreta como fluxo de dados alternativo do NTFS e recusa com ENOENT; o recibo é
// gravado num caminho equivalente sem dois-pontos e referenciado por esse mesmo caminho em
// `receiptPath` do step(), para que a leitura na reconciliação bata com a escrita.
const MAKER_RECEIPT_FILE = path.join(missionDir, 'jobs', 'T042-r1-maker.json')

async function runModelCall(step) {
  const scenarioDir = process.env.ADE_FAKE_SCENARIO || path.join(missionDir, 'scenario')
  const counterFile = path.join(scenarioDir, 'maker.count')

  await step(
    {
      unit: 'T042',
      id: 'T042:r1:maker',
      effect_class: 'model_call',
      input: { pack: 'v1' },
      receiptPath: MAKER_RECEIPT_FILE,
    },
    async () => {
      const count = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('contador Maker inválido')
      fs.mkdirSync(scenarioDir, { recursive: true })
      fs.writeFileSync(counterFile, String(count + 1), 'utf8')

      writeFileSync(path.join(worktreeDir, 'maker.txt'), 'obra do maker\n')

      const req = {
        unit: 'T042',
        authorization: 'maker',
        cwd: worktreeDir,
        argv: ['node', 'fake.js'],
        timeout: 60,
        result_file: path.join(missionDir, 'r.json'),
      }
      let r = startingReceipt({ missionId: 'T042', stepId: 'T042:r1:maker', request: req })
      r = withRunning(r, { pid: process.pid, start_time: null, host: 'test' })
      r = withTerminal(r, 'exited', { exitCode: 0, reason: 'exit' })
      writeReceipt(MAKER_RECEIPT_FILE, r)

      return { ok: true }
    },
  )
}

async function runCommit(step, gitPort) {
  writeFileSync(path.join(worktreeDir, 'obra.txt'), 'obra\n')
  const head = await gitPort.headInfo()
  const treeBefore = await gitPort.worktreeTree()

  await step(
    {
      unit: 'T042',
      id: 'T042:commit',
      effect_class: 'local_commit',
      input: { story: 'T042' },
      intent_context: { parent_commit: head.commit, tree_before: treeBefore },
    },
    () => gitPort.commit({ message: 'maker: obra' }),
  )
}

async function runStory(step, gitPort, journal) {
  await runModelCall(step)
  await runCommit(step, gitPort)
  await journal.append({
    kind: 'story_done',
    unit: 'T042',
    data: {
      status: 'committed',
      unit: 'T042',
    },
  })
}

async function main() {
  if (cenario === 'command') {
    const append = Journal.prototype.append
    Journal.prototype.append = function (event) {
      if (event.kind === 'step_result' && event.effect_class === 'model_call' && event.status === 'ok') {
        process.abort()
      }
      return append.call(this, event)
    }
    const { main: runCommand } = await import('../../src/cli/index.js')
    process.exit(await runCommand(['run', '--plan', missionDir, '--repo', worktreeDir]))
  }
  const journal = openJournal({ missionDir, runtimeStamp: RUNTIME_STAMP })
  const gitPort = createGitPort({ worktreeDir })
  const { step } = createStepRunner({ journal, missionDir, gitPort })

  if (cenario === 'model_call') {
    await runModelCall(step)
  } else if (cenario === 'commit') {
    await runCommit(step, gitPort)
  } else if (cenario === 'story') {
    await runStory(step, gitPort, journal)
  } else {
    throw new Error('cenário desconhecido: ' + cenario)
  }
}

try {
  await main()
  process.exit(0)
} catch (err) {
  console.error(err)
  process.exit(1)
}
