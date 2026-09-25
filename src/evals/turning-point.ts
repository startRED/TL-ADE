// Ponto de virada (roadmap): um pedido pequeno sobre um projeto de exemplo atravessa o painel real (pedido, entrevista,
// briefing, plano, aprovação), é executado pelo `ade run --plan` de verdade e vira um registro gerado só do journal,
// do intake, de /api/models e do snapshot do painel. No modo dublê só a fronteira de modelo é trocada.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storyRisk } from '../intent/risk.ts'
import { AdeError } from '../journal/errors.ts'
import { readJournal } from '../journal/journal.ts'
import { tierOf } from '../models/catalog.ts'
import type { Family } from '../models/catalog.ts'
import { readModelSettings } from '../models/settings.ts'
import { spawnMissionRun } from '../panel/intake.ts'
import type { IntentPort } from '../panel/intake.ts'
import { startServer } from '../panel/server.ts'

/** Linhas `chave: valor` do registro, na ordem em que aparecem. */
export type TurningPointRecord = Record<string, string>

const FIXTURES = fileURLToPath(new URL('../../fixtures/ponto-de-virada/', import.meta.url))
const CAPABILITIES = fileURLToPath(new URL('../../fixtures/capabilities/claude-offline.json', import.meta.url))
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const POLL_MS = 300

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

export function renderTurningPointRecord(record: TurningPointRecord): string {
  const lines = Object.entries(record).map(([k, v]) => `- ${k}: ${v.replace(/\r?\n/g, ' ')}`)
  return `# Ponto de virada — registro gerado\n\nGerado por \`ade dogfood\` a partir do journal, do intake, de /api/models e do snapshot do painel.\n\n${lines.join('\n')}\n`
}

export function parseTurningPointRecord(markdown: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of markdown.matchAll(/^- ([a-z0-9_]+): (.*)$/gm)) out.set(m[1], m[2].trim())
  return out
}

/** Empresas com plano pago configurado na página Modelos da ADE; a revisão precisa de duas. */
function plannedFamilies(adeRepoDir: string): Partial<Record<Family, string>> {
  const { plans } = readModelSettings(adeRepoDir)
  const out: Partial<Record<Family, string>> = {}
  for (const [family, plan] of Object.entries(plans) as Array<[Family, string]>) {
    if ((tierOf(family, plan)?.size ?? 0) > 0) out[family] = plan
  }
  return out
}

/** Porta de intenção dublê: perguntas, depois briefing, depois o plano e o contrato das fixtures. */
function fixtureIntent(dir: string): IntentPort {
  return {
    async compile({ answers, briefing }) {
      if (!answers) return { questions: readJson(path.join(dir, 'questions.json')) }
      if (!briefing) return { briefing: readJson(path.join(dir, 'briefing.json')) }
      const storiesDir = path.join(dir, 'stories')
      return { plan: readJson(path.join(dir, 'plan.json')), contracts: fs.readdirSync(storiesDir).map((f) => readJson(path.join(storiesDir, f))) }
    },
  }
}

/** Casa temporária do modo dublê: a sondagem de capacidades das fixtures e um recibo oficial de cota com o relógio de agora. */
function doubleHome(scenarioDir: string, tmp: string): { homeDir: string; scenario: string } {
  const homeDir = path.join(tmp, 'home')
  const adeHome = path.join(homeDir, '.ade')
  fs.mkdirSync(adeHome, { recursive: true })
  const now = new Date()
  fs.writeFileSync(path.join(adeHome, 'capabilities.json'), JSON.stringify({ ...readJson(CAPABILITIES), probe_ok: true, probed_at: now.toISOString() }))
  fs.writeFileSync(path.join(adeHome, 'quota-receipt.json'), JSON.stringify({
    source: 'official',
    family: 'claude',
    used_percent: 0,
    reserved_percent: 0,
    observed_at: now.toISOString(),
    weekly_reset_at: new Date(now.getTime() + 7 * 86400000).toISOString(),
  }))
  // A CLI falsa grava contadores no cenário: cada execução usa a sua cópia.
  const scenario = path.join(tmp, 'scenario')
  fs.cpSync(path.join(scenarioDir, 'scenario'), scenario, { recursive: true })
  return { homeDir, scenario }
}

export async function runTurningPoint(opts: { exampleDir: string; adeRepoDir: string; outPath: string; mode: 'real' | 'double'; scenarioDir?: string }): Promise<{ exitCode: 0 | 2 | 3 | 4; record: TurningPointRecord }> {
  const plans = plannedFamilies(opts.adeRepoDir)
  if (Object.keys(plans).length < 2) {
    throw new AdeError('revisao_mesma_empresa', 'a revisão exige outra empresa: configure o plano de uma segunda família na página Modelos', 4)
  }
  const exampleDir = path.resolve(opts.exampleDir)
  const pedido = fs.readFileSync(path.join(exampleDir, 'PEDIDO.md'), 'utf8').trim()
  const adeHead = git(opts.adeRepoDir, ['rev-parse', 'HEAD'])
  const started = Date.now()

  // Cópia com git próprio e sem remoto: o motor cria worktree e branch nela, nunca na pasta versionada.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-ponto-de-virada-'))
  const repoDir = path.join(tmp, 'projeto')
  fs.cpSync(exampleDir, repoDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.ade|\.git)$/.test(src) })
  git(repoDir, ['init', '-q', '-b', 'main'])
  git(repoDir, ['config', 'user.email', 'ade@local'])
  git(repoDir, ['config', 'user.name', 'TL-ADE'])
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-q', '-m', 'exemplo ponto de virada'])
  // O exemplo não tem dependência: a pasta vazia é a instalação completa que a pré-checagem do motor exige.
  fs.mkdirSync(path.join(repoDir, 'node_modules'))
  fs.mkdirSync(path.join(repoDir, '.ade'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, '.ade', 'config.json'), JSON.stringify({ models: { plans } }, null, 2) + '\n')

  const double = opts.mode === 'double' ? doubleHome(opts.scenarioDir ?? FIXTURES, tmp) : null
  const childEnv: NodeJS.ProcessEnv | undefined = double
    ? { ...process.env, CI: 'true', ADE_FAKE_CLI: '1', ADE_FAKE_SCENARIO: double.scenario, ADE_HOME: double.homeDir }
    : undefined
  const server = await startServer({
    repoDir,
    openBrowser: false,
    port: 0,
    deps: {
      stdout: () => {},
      ...(double ? { homeDir: double.homeDir, intent: fixtureIntent(path.join(opts.scenarioDir ?? FIXTURES, 'intent')) } : {}),
      runMission: (args) => spawnMissionRun({ ...args, env: childEnv }),
    },
  })
  try {
    const port = (server.server.address() as AddressInfo).port
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { 'x-ade-session': server.sessionToken, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json: any = await res.json()
      if (!res.ok) throw new AdeError('dogfood_painel', `painel respondeu ${res.status} em ${method} ${p}: ${json?.message ?? json?.error}`, 2)
      return json
    }
    const base = `/api/projects/${encodeURIComponent(server.projects.list()[0].id)}`

    const { mission_id: missionId } = await api('POST', `${base}/requests`, { text: pedido })
    const stages: string[] = []
    const answered: string[] = []
    let intake = await api('GET', `${base}/intake`)
    while (intake.stage !== 'running') {
      stages.push(intake.stage)
      if (intake.stage === 'interview') {
        // Sem operador: a primeira opção, que o intake já ordena como a recomendada.
        const answers = Object.fromEntries(intake.questions.map((q: any) => [q.id, q.options[0].id]))
        for (const q of intake.questions) answered.push(`${q.id} ${q.text} → ${q.options[0].label}`)
        intake = await api('POST', `${base}/intake/interview`, { answers })
      } else if (intake.stage === 'briefing' || intake.stage === 'plan') {
        intake = await api('POST', `${base}/intake/${intake.stage}/approve`, { digest: intake.digest })
      } else {
        throw new AdeError('dogfood_intake', `o intake parou na etapa ${intake.stage}: ${intake.reason ?? intake.error ?? ''}`, 2)
      }
    }
    stages.push('running')
    const deadline = Date.now() + ((intake.plan?.mission_budget?.max_wall_clock_seconds ?? 3600) + 120) * 1000
    while (intake.stage === 'running') {
      if (Date.now() > deadline) throw new AdeError('dogfood_timeout', `a missão ${missionId} não terminou no teto de tempo do plano`, 3)
      await new Promise((r) => setTimeout(r, POLL_MS))
      intake = await api('GET', `${base}/intake`)
    }
    stages.push(intake.stage)

    const models = await api('GET', '/api/models')
    const snapshot = await api('GET', `${base}/snapshot`)
    const mission = snapshot.missions.find((m: any) => m.id === missionId)
    fs.writeFileSync(path.join(tmp, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
    const record = buildRecord({ opts, repoDir, missionId, stages, answered, intake, models, mission, started, adeHead })
    fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true })
    fs.writeFileSync(opts.outPath, renderTurningPointRecord(record))
    return { exitCode: record.resultado === 'entregue' ? 0 : 3, record }
  } finally {
    await server.close()
  }
}

function buildRecord({ opts, repoDir, missionId, stages, answered, intake, models, mission, started, adeHead }: {
  opts: { adeRepoDir: string; mode: 'real' | 'double' }
  repoDir: string
  missionId: string
  stages: string[]
  answered: string[]
  intake: any
  models: any
  mission: any
  started: number
  adeHead: string
}): TurningPointRecord {
  const { events, tornTail } = readJournal(path.join(repoDir, '.ade', 'missions', missionId, 'journal.jsonl'))
  const story = mission?.stories?.[0]
  const storyId: string = story?.id ?? intake.parts?.[0]?.id ?? 'desconhecida'
  const done = events.filter((e) => e.kind === 'story_done' && (e.unit ?? e.data?.unit) === storyId).at(-1)
  const status: string = story?.status ?? 'desconhecido'
  const delivered = status === 'committed' || status === 'delivered'
  const branch = `ade/${missionId}/${storyId}`
  const commit = git(repoDir, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`]) || 'nenhum'
  // Mesma regra de routeStory: a parte leve é escrita pela fila do código leve.
  const writerRole = storyRisk(readJson(path.join(repoDir, '.ade', 'missions', missionId, 'stories', `${storyId}.json`))) === 'light' ? 'impl_light' : 'impl'
  const telemetry = (role: string) => events.filter((e) => e.kind === 'telemetry' && e.data?.role === role).at(-1)?.data
  const who = (t: any) => (t ? `${t.family}/${t.models?.find((m: any) => m.role === 'executor')?.model_id ?? t.models?.[0]?.model_id}` : 'nenhum')
  const maker = telemetry('maker')
  const checker = telemetry('checker_round')
  const review = events.filter((e) => e.kind === 'review_result' && (e.unit ?? e.data?.unit) === storyId).at(-1)
  const head = (role: string) => {
    const slot = models.chains?.[role]?.find((s: any) => !s.reserve)
    return slot ? `${slot.family}/${slot.model_id}` : 'nenhum'
  }
  // A prova vermelha antes do Maker e a verde depois dele são passos do journal (eval:<id>:red|green:<árvore>).
  const evalVerdict = (phase: string) => String(events.filter((e) => e.kind === 'step_result' && e.data?.result?.phase === phase).at(-1)?.data?.result?.verdict ?? 'nenhum')
  const cost = events.filter((e) => e.kind === 'telemetry').reduce((sum, e) => sum + (Number(e.data?.cost_usd ?? e.data?.usage?.cost_usd) || 0), 0)
  const remotes = git(repoDir, ['remote'])

  const record: TurningPointRecord = {
    origem: opts.mode === 'double' ? 'dublê' : 'real',
    resultado: delivered ? 'entregue' : 'parada',
  }
  if (!delivered) record.motivo = String(done?.data?.reason ?? intake.error ?? status)
  Object.assign(record, {
    mission_id: missionId,
    estagios: stages.join(' → '),
    perguntas: String(answered.length),
  })
  answered.forEach((a, i) => { record[`resposta_${i + 1}`] = a })
  Object.assign(record, {
    story: storyId,
    story_status: status,
    branch,
    commit,
    prova_vermelha: evalVerdict('red'),
    prova_verde: evalVerdict('green'),
    maker: who(maker),
    checker: who(checker),
    fila_origem: 'planos',
    fila_papel: writerRole,
    fila_impl: head(writerRole),
    fila_checker: head('checker'),
    verdict: String(review?.data?.verdict ?? 'nenhum'),
    revisor_familia: String(checker?.family ?? 'nenhum'),
    revisor_modelo: who(checker).split('/')[1] ?? 'nenhum',
    revisao_outra_empresa: maker && checker && maker.family !== checker.family ? 'sim' : 'não',
    eventos: String(events.length),
    cadeia: events.length === 0 ? 'vazia' : tornTail ? 'cauda_rasgada' : 'valida',
    duracao_s: String(Math.round((Date.now() - started) / 1000)),
    custo_usd_informativo: cost.toFixed(4),
    remotos: remotes || 'nenhum',
    head_ade_inalterado: git(opts.adeRepoDir, ['rev-parse', 'HEAD']) === adeHead ? 'sim' : 'não',
    copia: repoDir,
  })
  return record
}
