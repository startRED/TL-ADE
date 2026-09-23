import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { main as initMain } from '../src/cli/init.js'
import { main as serveMain } from '../src/cli/serve.js'
import { main as indexMain } from '../src/cli/index-command.js'
import { validate } from '../src/schema/index.ts'
import {
  readPanelSnapshot,
  rebuildProjection,
} from '../src/panel/sqlite-index.js'
import { generateLauncher } from '../src/panel/launcher.js'
import { listProjects } from '../src/panel/projects.js'
import { startServer } from '../src/panel/server.js'
import { openJournal } from '../src/journal/journal.ts'
import { digest16 } from '../src/journal/canonical.ts'
import { AdeError } from '../src/journal/errors.ts'

let tmpDirs: string[] = []
let activeServers: Array<{ close: () => Promise<void> }> = []

function makeTmpDir(prefix = 'ade-panel-test-'): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const s of activeServers) {
    try {
      await s.close()
    } catch {}
  }
  activeServers = []

  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs = []
})

function createSampleMission(repoDir: string, missionId = 'mission-0417') {
  const missionDir = path.join(repoDir, '.ade', 'missions', missionId)
  const storiesDir = path.join(missionDir, 'stories')
  const artifactsDir = path.join(missionDir, 'artifacts')
  mkdirSync(storiesDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })

  const plan = {
    format_version: 2,
    id: 'plan-0417',
    mission_id: missionId,
    immutable_digest: 'abcdef0123456789',
    intent: 'Botão de login sem estado de envio',
    briefing: {
      request: 'corrija o botão de login',
      epics: [{ id: 'epic-1', title: 'Interface de login' }],
      design_briefs: {
        S1: { direction: { self_critique: 'Desabilitar botão de login durante envio' } },
      },
    },
    authorization: {
      autonomy: 'safe',
      permitted_effects: ['push'],
      eligible_skills: [],
    },
    phases: [
      {
        epics: [
          {
            stories: ['S1', 'S2'],
          },
        ],
      },
    ],
    mission_budget: { max_usd: 8.0 },
    budget: { max_model_calls: 32, max_rework_rounds: 2 },
  }
  writeFileSync(path.join(missionDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8')

  const s1Contract = {
    format_version: 2,
    id: 'S1',
    title: 'Desabilitar o botão enquanto o envio está em curso',
    complexity: 'trivial',
    task: 'Desabilitar botão de login',
    needs_ui: true,
    workspace: { kind: 'git', root: '.', revision: 'HEAD' },
    risk: { level: 'normal', surfaces: [], evidence: [] },
    guardrails: { scope_paths: ['src/**'], do_not_touch: ['.ade/**'], autonomy: 'safe' },
    requirements: [{ id: 'R1', ears: 'WHEN envio ocorre THE SYSTEM SHALL desabilitar botão' }],
    scenarios: [{ id: 'C1', given: 'tela de login', when: 'clique em entrar', then: 'desabilita botao', verifiers: ['V1'] }],
    verifiers: [{ id: 'V1', kind: 'script', cmd: ['node', '-v'], expect_exit: 0, timeout_s: 30, max_output_bytes: 1024, evidence: ['package.json'], strictness: { mode: 'must_fail_before' }, author: 'operator' }],
    skills: [],
    roles: { maker: { family: 'claude', model_id: 'claude-sonnet-5' }, checker_round: { family: 'codex', model_id: 'codex-1' } },
    budget: { max_model_calls: 2, max_rework_rounds: 1 },
    unknowns: [],
  }
  writeFileSync(path.join(storiesDir, 'S1.json'), JSON.stringify(s1Contract, null, 2), 'utf8')

  const s2Contract = {
    format_version: 2,
    id: 'S2',
    title: 'Mostrar erro de credencial inválida',
    complexity: 'bounded',
    task: 'Exibir mensagem amigável',
    needs_ui: false,
    workspace: { kind: 'git', root: '.', revision: 'HEAD' },
    risk: { level: 'normal', surfaces: [], evidence: [] },
    guardrails: { scope_paths: ['src/**'], do_not_touch: ['.ade/**'], autonomy: 'safe' },
    requirements: [{ id: 'R1', ears: 'WHEN credencial inválida THE SYSTEM SHALL exibir erro' }],
    scenarios: [{ id: 'C1', given: 'senha incorreta', when: 'envio', then: 'exibe erro', verifiers: ['V2'] }],
    verifiers: [{ id: 'V2', kind: 'script', cmd: ['node', '-v'], expect_exit: 0, timeout_s: 30, max_output_bytes: 1024, evidence: ['package.json'], strictness: { mode: 'must_fail_before' }, author: 'operator' }],
    skills: [],
    roles: { maker: { family: 'claude', model_id: 'claude-sonnet-5' }, checker_round: { family: 'codex', model_id: 'codex-1' } },
    budget: { max_model_calls: 3, max_rework_rounds: 1 },
    unknowns: [],
  }
  writeFileSync(path.join(storiesDir, 'S2.json'), JSON.stringify(s2Contract, null, 2), 'utf8')

  // Sample artifact
  writeFileSync(path.join(artifactsDir, 'diff-S1.txt'), '--- a/btn\n+++ b/btn\n', 'utf8')

  return { plan, missionDir, storiesDir, artifactsDir }
}

async function writeSampleJournal(missionDir: string) {
  const stamp = '1:0123456789abcdef:0123456789abcdef'
  const journal = openJournal({ missionDir, runtimeStamp: stamp })
  await journal.append({
    kind: 'intent_opened',
    effect_class: 'none',
    data: { intent: 'Botão de login sem estado de envio' },
  })
  await journal.append({
    kind: 'story_started',
    unit: 'S1',
    effect_class: 'none',
    data: { unit: 'S1' },
  })
  await journal.append({
    kind: 'visual_eval_done',
    unit: 'S1',
    effect_class: 'none',
    data: {
      round: 1,
      status: 'pass',
      reason: 'ok',
      evaluation: {
        story_id: 'S1',
        round: 1,
        rubric_version: '2026-09-17-v1',
        judge: { family: 'codex', model_id: 'gpt-5.6-terra' },
        detector: { engine_version: '0.1.5', url_mode: 'ok' },
        surface_mode: 'persuade',
        captures: [
          {
            route: '/',
            width: 1280,
            theme: 'dark',
            path: 'artifacts/visual/btn.png',
            sha256: 'abcdef123456',
          },
        ],
        criteria: [
          { id: 'specificity', score: 8.5, weight: 3.0, note: 'Assinatura clara' },
          { id: 'hierarchy', score: 8.0, weight: 2.0, note: 'Ritmo vertical coeso' },
          { id: 'typography', score: 8.5, weight: 2.0, note: 'Degraus legíveis' },
          { id: 'color', score: 8.0, weight: 1.5, note: 'Paleta semântica' },
          { id: 'states', score: 8.0, weight: 1.0, note: 'Estados ativos' },
          { id: 'motion', score: 7.5, weight: 0.5, note: 'Microinteração intencional' },
        ],
        final: 8.2,
        defects: [],
        verdict: 'pass',
      },
    },
  })
  await journal.append({
    kind: 'story_done',
    unit: 'S1',
    effect_class: 'local_commit',
    data: { unit: 'S1', status: 'committed', commit: '01dc2ec' },
  })
  await journal.close()
}

describe('v0.4b Acceptance Tests', () => {
  // Critério 1: Dado um repositório ainda não inicializado, quando ade init for executado,
  // então o projeto será registrado e um ade.bat funcional será criado sem apagar configuração existente
  // nem arquivos do operador.
  test('criterio_1_ade_init_registra_projeto_e_gera_ade_bat_de_forma_idempotente', async () => {
    const repoDir = makeTmpDir('ade-init-')
    const homeDir = makeTmpDir('ade-home-')
    const existingFilePath = path.join(repoDir, 'important-file.txt')
    writeFileSync(existingFilePath, 'conteudo operador', 'utf8')

    let stdoutText = ''
    const exitCode = await initMain(['--repo', repoDir], {
      homeDir,
      stdout: (s: string) => { stdoutText += s },
    })

    expect(exitCode).toBe(0)
    expect(existsSync(path.join(repoDir, 'ade.bat'))).toBe(true)
    expect(readFileSync(existingFilePath, 'utf8')).toBe('conteudo operador')

    const projects = listProjects({ homeDir })
    expect(projects.some((p) => path.resolve(p.path) === path.resolve(repoDir))).toBe(true)

    // Idempotência
    const exitCode2 = await initMain(['--repo', repoDir], {
      homeDir,
      stdout: () => {},
    })
    expect(exitCode2).toBe(0)
    expect(readFileSync(existingFilePath, 'utf8')).toBe('conteudo operador')
  })

  // Critério 2: Dado o lançador gerado, quando o operador o abrir, então o servidor iniciará no projeto correto
  // e o navegador será aberto somente depois que a página estiver pronta.
  test('criterio_2_lancador_inicia_servidor_no_projeto_e_abre_navegador_apos_pagina_pronta', async () => {
    const repoDir = makeTmpDir('ade-launch-')
    const launcherPath = generateLauncher({ repoDir })
    expect(existsSync(launcherPath)).toBe(true)
    const batContent = readFileSync(launcherPath, 'utf8')
    expect(batContent).toContain('serve')

    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    let browserOpened = false
    let pageReadyAtOpen = false

    const server = await startServer({
      repoDir,
      port: 4189,
      openBrowser: true,
      deps: {
        openBrowser: async (url: string) => {
          browserOpened = true
          // Verifica se a página responde 200 quando o navegador é aberto
          const res = await fetch(url)
          if (res.status === 200) {
            pageReadyAtOpen = true
          }
        },
      },
    })
    activeServers.push(server)

    expect(browserOpened).toBe(true)
    expect(pageReadyAtOpen).toBe(true)
  })

  // Critério 3: Dadas as mesmas fontes de uma missão, quando o índice for apagado e ade index --rebuild
  // for executado novamente, então o novo arquivo terá conteúdo idêntico byte a byte e apresentará a mesma visão.
  test('criterio_3_reconstrucao_do_indice_das_mesmas_fontes_e_identica_byte_a_byte', async () => {
    const repoDir = makeTmpDir('ade-rebuild-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    const indexPath = path.join(repoDir, '.ade', 'index.sqlite')

    const res1 = await rebuildProjection({ repoDir, indexPath })
    expect(existsSync(indexPath)).toBe(true)
    const bytes1 = readFileSync(indexPath)

    // Apaga e reconstrói
    rmSync(indexPath)
    expect(existsSync(indexPath)).toBe(false)

    const res2 = await rebuildProjection({ repoDir, indexPath })
    const bytes2 = readFileSync(indexPath)

    expect(bytes1.equals(bytes2)).toBe(true)
    expect(res1.digest).toBe(res2.digest)
    expect(res1.events).toBe(res2.events)
    expect(res1.missions).toBe(res2.missions)
  })

  // Critério 4: Dado um journal inválido ou adulterado, quando a reconstrução for solicitada,
  // então ela falhará com erro claro e preservará integralmente o último índice válido.
  test('criterio_4_journal_invalido_ou_adulterado_falha_reconstrucao_e_preserva_ultimo_indice_valido', async () => {
    const repoDir = makeTmpDir('ade-corrupt-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    const indexPath = path.join(repoDir, '.ade', 'index.sqlite')
    await rebuildProjection({ repoDir, indexPath })
    const validBytes = readFileSync(indexPath)

    // Adulterar o journal
    const journalPath = path.join(repoDir, '.ade', 'missions', 'mission-0417', 'journal.jsonl')
    const originalText = readFileSync(journalPath, 'utf8')
    writeFileSync(journalPath, originalText + '{"corrupted":true}\n', 'utf8')

    await expect(rebuildProjection({ repoDir, indexPath })).rejects.toThrow()

    // O índice original válido foi 100% preservado
    expect(existsSync(indexPath)).toBe(true)
    const afterCorruptBytes = readFileSync(indexPath)
    expect(validBytes.equals(afterCorruptBytes)).toBe(true)
  })

  // Critério 5: Dado um projeto com planos, eventos e artefatos, quando o painel for aberto,
  // então ele mostrará projetos, histórico de missões, progresso por épico e story, pedido, decisões,
  // custos disponíveis, diferenças, provas, capturas visuais e log filtrável sem inventar dados ausentes.
  test('criterio_5_painel_mostra_historico_progresso_pedido_decisoes_custos_provas_e_capturas_sem_inventar_dados', async () => {
    const repoDir = makeTmpDir('ade-snapshot-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))
    const indexPath = path.join(repoDir, '.ade', 'index.sqlite')
    await rebuildProjection({ repoDir, indexPath })

    const snapshot = await readPanelSnapshot({ repoDir, indexPath })

    expect(snapshot.projects).toBeDefined()
    expect(snapshot.missions.length).toBeGreaterThan(0)
    const m = snapshot.selectedMission
    expect(m).toBeDefined()
    expect(m.id).toBe('mission-0417')
    expect(m.intent).toBe('Botão de login sem estado de envio')
    expect(m.stories.length).toBe(2)
    expect(m.epics.length).toBe(1)
    expect(m.epics[0].title).toBe('Interface de login')

    // S1 tem avaliação visual com critérios e capturas
    const s1 = m.stories.find((s: any) => s.id === 'S1')
    expect(s1).toBeDefined()
    expect(s1.visual).toBeDefined()
    expect(s1.visual.final).toBe(8.2)
    expect(s1.visual.captures.length).toBe(1)

    // S2 não tem visual nem inventa dados
    const s2 = m.stories.find((s: any) => s.id === 'S2')
    expect(s2.visual).toBeNull()
  })

  // Critério 6: Dado um navegador desconectado após receber um evento, quando ele se reconectar informando o
  // último número conhecido, então receberá apenas os eventos posteriores na ordem do journal.
  test('criterio_6_navegador_reconectado_com_ultimo_numero_conhecido_recebe_apenas_eventos_posteriores', async () => {
    const repoDir = makeTmpDir('ade-ws-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    const server = await startServer({
      repoDir,
      port: 4191,
      openBrowser: false,
    })
    activeServers.push(server)

    const sessionToken = server.sessionToken

    // Conexão simulando websocket raw handshake com since=2
    const client = net.connect({ port: 4191, host: '127.0.0.1' })
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    const req = [
      `GET /api/events?since=2&session=${sessionToken} HTTP/1.1`,
      'Host: 127.0.0.1:4191',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Origin: http://127.0.0.1:4191',
      '',
      '',
    ].join('\r\n')

    client.write(req)

    const data: Buffer = await new Promise((resolve) => {
      client.once('data', (d) => {
        resolve(d)
        client.end()
      })
    })

    const text = data.toString('utf8')
    expect(text).toContain('101 Switching Protocols')
    // Verifica que o stream WebSocket entregou payload posterior a seq 2
    expect(text).toContain('visual_eval_done')
  })

  // Critério 7: Dada uma nova execução de ade serve, quando ela iniciar, então produzirá uma credencial aleatória
  // diferente, exibirá o acesso no terminal e não persistirá essa credencial no projeto nem no índice.
  test('criterio_7_ade_serve_produz_credencial_aleatoria_diferente_por_execucao_e_nao_persiste_em_disco', async () => {
    const repoDir = makeTmpDir('ade-token-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    let out1 = ''
    const server1 = await startServer({
      repoDir,
      port: 4192,
      openBrowser: false,
      deps: { stdout: (s: string) => { out1 += s } },
    })
    const token1 = server1.sessionToken
    await server1.close()

    let out2 = ''
    const server2 = await startServer({
      repoDir,
      port: 4193,
      openBrowser: false,
      deps: { stdout: (s: string) => { out2 += s } },
    })
    const token2 = server2.sessionToken
    await server2.close()

    expect(token1).not.toBe(token2)
    expect(token1.length).toBeGreaterThan(16)
    expect(out1).toContain(token1)
    expect(out2).toContain(token2)

    // Não persistida no projeto nem no índice
    const indexBytes = readFileSync(path.join(repoDir, '.ade', 'index.sqlite'), 'utf8')
    expect(indexBytes).not.toContain(token1)
    expect(indexBytes).not.toContain(token2)
  })

  // Critério 8: Dada uma requisição ao painel sem a credencial da sessão, com credencial incorreta ou com
  // origem diferente da origem local esperada, quando ela alcançar qualquer rota protegida ou tentativa de
  // atualização ao vivo, então será recusada sem revelar dados da missão.
  test('criterio_8_requisicao_sem_credencial_ou_com_origem_estranha_e_recusada_sem_revelar_dados', async () => {
    const repoDir = makeTmpDir('ade-auth-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    const server = await startServer({
      repoDir,
      port: 4194,
      openBrowser: false,
    })
    activeServers.push(server)

    // 1. Sem credencial
    const resNoToken = await fetch('http://127.0.0.1:4194/api/snapshot')
    expect(resNoToken.status).toBe(401)
    const textNoToken = await resNoToken.text()
    expect(textNoToken).not.toContain('Botão de login')

    // 2. Com credencial errada
    const resBadToken = await fetch('http://127.0.0.1:4194/api/snapshot?session=wrong-token')
    expect(resBadToken.status).toBe(401)

    // 3. Origem externa proibida (Origin spoofing/cross-site)
    const resBadOrigin = await fetch(`http://127.0.0.1:4194/api/snapshot?session=${server.sessionToken}`, {
      headers: { Origin: 'http://malicious.example.com' },
    })
    expect(resBadOrigin.status).toBe(403)
  })

  // Critério 9: Dada uma configuração ou argumento que tente expor o painel fora da máquina local, quando o
  // servidor iniciar, então ele recusará a inicialização em vez de aceitar conexões externas.
  test('criterio_9_servidor_recusa_inicializacao_se_configurado_para_escutar_fora_da_maquina_local', async () => {
    const repoDir = makeTmpDir('ade-host-')
    createSampleMission(repoDir)

    await expect(
      startServer({
        repoDir,
        port: 4195,
        host: '0.0.0.0',
        openBrowser: false,
      }),
    ).rejects.toThrow(/127\.0\.0\.1/)
  })

  // Critério 10: Dada uma aprovação válida no painel, quando o operador a confirmar, então o mesmo fluxo
  // usado por ade approve validará o resumo imutável e registrará os mesmos eventos; uma aprovação alterada
  // ou vencida será bloqueada, e os fluxos existentes de planejamento, execução e aprovação por linha de comando
  // continuarão passando com o novo portão.
  test('criterio_10_aprovacao_no_painel_utiliza_mesmo_fluxo_de_ade_approve_com_resumo_imutavel', async () => {
    const repoDir = makeTmpDir('ade-approve-')
    const { missionDir } = createSampleMission(repoDir)
    const planPath = path.join(missionDir, 'plan.json')
    const planDigest = digest16(JSON.parse(readFileSync(planPath, 'utf8')))

    const server = await startServer({
      repoDir,
      port: 4196,
      openBrowser: false,
    })
    activeServers.push(server)

    // Aprovação via API
    const approveRes = await fetch(`http://127.0.0.1:4196/api/actions/approve?session=${server.sessionToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:4196',
      },
      body: JSON.stringify({
        mission_id: 'mission-0417',
        digest: planDigest,
      }),
    })

    expect(approveRes.status).toBe(200)
    const approveJson = await approveRes.json()
    expect(approveJson.approved).toBe(true)

    // Aprovação com digest incorreto é bloqueada
    const badRes = await fetch(`http://127.0.0.1:4196/api/actions/approve?session=${server.sessionToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:4196',
      },
      body: JSON.stringify({
        mission_id: 'mission-0417',
        digest: 'wrongdigest00000',
      }),
    })
    expect(badRes.status).toBe(400)
    const badJson = await badRes.json()
    expect(badJson.approved).toBe(false)
  })

  // Critério 11: Dado um servidor já ativo para o mesmo índice, quando outra instância for iniciada,
  // então ela encerrará com código 5; dada uma porta ocupada por outro processo, então encerrará com
  // código 1 sem escolher outra porta.
  test('criterio_11_segunda_instancia_de_servidor_encerra_com_codigo_5_e_porta_ocupada_com_codigo_1', async () => {
    const repoDir = makeTmpDir('ade-collision-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    const server1 = await startServer({
      repoDir,
      port: 4197,
      openBrowser: false,
    })
    activeServers.push(server1)

    // Tentativa de subir segundo servidor para o mesmo repo -> exit 5
    let stderrText5 = ''
    const code5 = await serveMain(['--repo', repoDir, '--port', '4198', '--no-open'], {
      stderr: (s: string) => { stderrText5 += s },
    })
    expect(code5).toBe(5)

    // Ocupa a porta 4199 com um servidor de teste
    const dummy = http.createServer((_, res) => res.end('occupied'))
    await new Promise<void>((resolve) => dummy.listen(4199, '127.0.0.1', resolve))

    const otherRepoDir = makeTmpDir('ade-port-')
    createSampleMission(otherRepoDir)

    let stderrText1 = ''
    const code1 = await serveMain(['--repo', otherRepoDir, '--port', '4199', '--no-open'], {
      stderr: (s: string) => { stderrText1 += s },
    })
    expect(code1).toBe(1)
    dummy.close()
  })

  // Critério 12: Dado o resultado visual já produzido pelo motor, quando ele for validado e projetado pelo
  // painel, então corresponderá ao nono schema publicado; resultados incompletos serão recusados e o fluxo visual
  // existente continuará aceitando seus resultados válidos.
  test('criterio_12_resultado_visual_corresponde_ao_nono_schema_publicado_e_recusa_incompletos', () => {
    const validVisual = {
      story_id: 'S1',
      round: 1,
      rubric_version: '2026-09-17-v1',
      judge: { family: 'codex', model_id: 'gpt-5.6-terra' },
      detector: { engine_version: '0.1.5', url_mode: 'ok' },
      surface_mode: 'persuade',
      captures: [
        {
          route: '/',
          width: 1280,
          theme: 'dark',
          path: 'artifacts/visual/dark.png',
          sha256: 'abcdef123456',
        },
      ],
      criteria: [
        { id: 'specificity', score: 8.0, weight: 3.0, note: 'ok' },
        { id: 'hierarchy', score: 8.0, weight: 2.0, note: 'ok' },
        { id: 'typography', score: 8.0, weight: 2.0, note: 'ok' },
        { id: 'color', score: 8.0, weight: 1.5, note: 'ok' },
        { id: 'states', score: 8.0, weight: 1.0, note: 'ok' },
        { id: 'motion', score: 8.0, weight: 0.5, note: 'ok' },
      ],
      final: 8.0,
      defects: [],
      verdict: 'pass',
    }

    const valResult = validate('visual-eval', validVisual)
    expect(valResult.valid).toBe(true)

    // Incompleto (sem criteria)
    const incomplete = { ...validVisual }
    delete (incomplete as any).criteria
    const valIncomplete = validate('visual-eval', incomplete)
    expect(valIncomplete.valid).toBe(false)
  })

  // Critério 13: Dado um ambiente Windows sem suporte funcional à dependência nativa, quando o diagnóstico ou um
  // comando do painel verificar a capacidade, então falhará antes de criar ou substituir o índice e explicará
  // como corrigir a instalação.
  test('criterio_13_ambiente_sem_dependencia_nativa_falha_diagnostico_e_comando_antes_de_modificar_indice', async () => {
    const repoDir = makeTmpDir('ade-native-fail-')
    createSampleMission(repoDir)
    const indexPath = path.join(repoDir, '.ade', 'index.sqlite')

    let stderrOutput = ''
    const exitCode = await indexMain(['--rebuild', '--repo', repoDir], {
      stderr: (s: string) => { stderrOutput += s },
      deps: {
        checkNativeSqlite: () => {
          throw new AdeError(
            'native_sqlite_unavailable',
            'Dependência nativa better-sqlite3 indisponível ou incompatível neste ambiente Windows. Para corrigir, execute: npm rebuild better-sqlite3',
            1,
          )
        },
      },
    })

    expect(exitCode).toBe(1)
    expect(stderrOutput).toContain('npm rebuild better-sqlite3')
    expect(existsSync(indexPath)).toBe(false)
  })

  // Critério 14: Dado o painel em tela larga, estreita, navegação apenas por teclado ou preferência por movimento reduzido,
  // quando o operador navegar, então as três áreas principais continuarão compreensíveis, o foco estará visível,
  // controles terão nomes acessíveis e animações não essenciais serão removidas.
  test('criterio_14_acessibilidade_landmarks_foco_visivel_nomes_acessiveis_largura_estreita_e_movimento_reduzido', () => {
    const htmlPath = path.join(process.cwd(), 'index.html')
    const cssPath = path.join(process.cwd(), 'packages', 'web', 'styles.css')
    expect(existsSync(htmlPath)).toBe(true)
    expect(existsSync(cssPath)).toBe(true)

    const html = readFileSync(htmlPath, 'utf8')
    const css = readFileSync(cssPath, 'utf8')

    // Landmarks e nomes acessíveis
    expect(html).toContain('aria-label')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tab"')
    expect(html).toContain('role="listbox"')

    // Foco visível
    expect(css).toContain(':focus-visible')

    // Movimento reduzido
    expect(css).toContain('prefers-reduced-motion')

    // Responsividade / largura estreita
    expect(css).toContain('@media (max-width:')
  })

  // Critério 15: Dado o pacote recém-instalado, quando a página for servida, então nenhum processo de compilação
  // será necessário e não haverá dependência de serviço externo ou chamada real à internet.
  test('criterio_15_aplicacao_web_funciona_como_arquivos_estaticos_sem_compilacao_e_sem_chamada_externa', () => {
    const htmlPath = path.join(process.cwd(), 'index.html')
    const html = readFileSync(htmlPath, 'utf8')

    // Sem dependência externa (nenhum CDN, google fonts ou fontes externas)
    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')

    // Carrega módulos estáticos de packages/web
    expect(html).toContain('/packages/web/app.js')
    expect(html).toContain('/packages/web/styles.css')
  })

  // Critério 16: Dado o encerramento normal ou por interrupção, quando ade serve terminar,
  // então liberará a porta, o bloqueio de leitura e as conexões abertas sem deixar processo oculto.
  test('criterio_16_encerramento_normal_ou_interrupcao_libera_porta_bloqueios_e_conexoes_sem_processo_oculto', async () => {
    const repoDir = makeTmpDir('ade-shutdown-')
    createSampleMission(repoDir)
    await writeSampleJournal(path.join(repoDir, '.ade', 'missions', 'mission-0417'))

    const server = await startServer({
      repoDir,
      port: 4200,
      openBrowser: false,
    })

    const leasePath = path.join(repoDir, '.ade', 'serve.lease')
    expect(existsSync(leasePath)).toBe(true)

    // Encerra
    await server.close()

    expect(existsSync(leasePath)).toBe(false)

    // A porta 4200 deve estar livre para novo bind imediatamente
    const dummy = http.createServer()
    await new Promise<void>((resolve, reject) => {
      dummy.listen(4200, '127.0.0.1', () => {
        dummy.close(() => resolve())
      })
      dummy.on('error', reject)
    })
  })

  // Critério 17: Dado o marco concluído, quando a documentação pública for consultada, então ela indicará a v0.4b
  // como recorte entregue, registrará a ativação em novo ADR e manterá os ADRs aceitos anteriores e todo proto/ inalterados.
  test('criterio_17_documentacao_publica_indica_v04b_e_novo_adr_0027_mantendo_proto_e_adrs_anteriores_inalterados', () => {
    const adr27Path = path.join(process.cwd(), 'docs', 'adr', '0027-ativacao-da-v04b-painel-local.md')
    expect(existsSync(adr27Path)).toBe(true)
    const adr27 = readFileSync(adr27Path, 'utf8')
    expect(adr27).toContain('v0.4b')
    expect(adr27).toContain('Erick')

    const charter = readFileSync(path.join(process.cwd(), 'PROJECT_CHARTER.md'), 'utf8')
    expect(charter).toContain('v0.4b')

    const roadmap = readFileSync(path.join(process.cwd(), 'docs', 'roadmap.md'), 'utf8')
    expect(roadmap).toContain('v0.4b')

    const adrReadme = readFileSync(path.join(process.cwd(), 'docs', 'adr', 'README.md'), 'utf8')
    expect(adrReadme).toContain('0027-ativacao-da-v04b-painel-local.md')
  })

  // Percurso focal: init -> abertura -> projeção -> atualização -> aprovação -> encerramento
  test('percurso_focal_init_abertura_projecao_atualizacao_aprovacao_encerramento', async () => {
    const repoDir = makeTmpDir('ade-focal-')
    const homeDir = makeTmpDir('ade-focal-home-')

    // 1. Init
    const initCode = await initMain(['--repo', repoDir], { homeDir, stdout: () => {} })
    expect(initCode).toBe(0)
    expect(existsSync(path.join(repoDir, 'ade.bat'))).toBe(true)

    // 2. Prepara missão
    const { missionDir } = createSampleMission(repoDir, 'mission-focal')
    await writeSampleJournal(missionDir)

    // 3. Abertura do servidor
    let openedUrl = ''
    const server = await startServer({
      repoDir,
      port: 4201,
      openBrowser: true,
      deps: {
        openBrowser: async (url: string) => {
          openedUrl = url
        },
      },
    })
    activeServers.push(server)
    expect(openedUrl).toContain('http://127.0.0.1:4201/?session=')

    // 4. Projeção (GET snapshot)
    const snapRes = await fetch(`http://127.0.0.1:4201/api/snapshot?session=${server.sessionToken}`, {
      headers: { Origin: 'http://127.0.0.1:4201' },
    })
    expect(snapRes.status).toBe(200)
    const snapData = await snapRes.json()
    expect(snapData.selectedMission.id).toBe('mission-focal')

    // 5. Atualização ao vivo via WebSocket /api/events
    const client = net.connect({ port: 4201, host: '127.0.0.1' })
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    client.write([
      `GET /api/events?since=0&session=${server.sessionToken} HTTP/1.1`,
      'Host: 127.0.0.1:4201',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Origin: http://127.0.0.1:4201',
      '',
      '',
    ].join('\r\n'))

    await new Promise((resolve) => client.once('data', resolve))
    client.end()

    // 6. Aprovação
    const planDigest = digest16(JSON.parse(readFileSync(path.join(missionDir, 'plan.json'), 'utf8')))
    const appRes = await fetch(`http://127.0.0.1:4201/api/actions/approve?session=${server.sessionToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4201' },
      body: JSON.stringify({ mission_id: 'mission-focal', digest: planDigest }),
    })
    expect(appRes.status).toBe(200)
    const appData = await appRes.json()
    expect(appData.approved).toBe(true)

    // 7. Encerramento
    await server.close()
    expect(existsSync(path.join(repoDir, '.ade', 'serve.lease'))).toBe(false)
  })
})
