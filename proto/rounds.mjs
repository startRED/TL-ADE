// Política de rodadas de quem escreve.
//
// Ser cortado no teto de turnos é trabalho INACABADO, não defeito. O motor antigo não distinguia os dois: a chamada era
// cortada no meio das edições, a suíte ficava vermelha por causa disso, e o motor lia a suíte vermelha como "problema
// grave" — escalava para um modelo mais caro E BAIXAVA o teto de 30 para 20 turnos. A chamada seguinte era cortada antes
// ainda, e a volta recomeçava. Na m-mu8usf5z, parte V02-R2, as rodadas 5 e 6 nasceram assim: as duas terminaram em 21
// turnos com error_max_turns, cada uma custou uma rodada inteira no degrau mais caro da cadeia e nenhuma entregou a parte.
// O prompt ainda dizia "você tem no máximo 30 ações" enquanto o teto real era 20: quem escreve planejava para 30 e morria
// no 20. Agora o número do prompt e o teto são o mesmo, escalar nunca dá menos turnos, e quem foi cortado repete no mesmo
// degrau com folga em vez de subir de modelo.

export function truncated(result, maxTurns) {
  if (!result) return false
  if (result.subtype === 'error_max_turns') return true
  return !!maxTurns && (result.num_turns || 0) >= maxTurns
}

// Teto de turnos da rodada. Escalar significa problema mais difícil, então nunca menos turnos que a rodada normal.
export function makerTurns({ wasTruncated = false, escalate = false } = {}) {
  return wasTruncated ? 60 : escalate ? 36 : 30
}

// Nomes das provas que JÁ estavam vermelhas no ponto de partida da missão: essas não são da parte.
// Os dois portões antigos eram tudo-ou-nada e se anulavam. "Já estava vermelha" só valia se TODAS as vermelhas fossem
// antigas; "prova instável" só valia se TODAS fossem novas. Uma mistura das duas escapava dos dois portões e abria rodada
// paga sem defeito algum (m-mu8usf5z, V02-R2f, rodadas 2 e 3: 4 vermelhas antigas + 6 estouros de 5 s com a máquina
// carregada, zero falha de verdade, e a parte subiu para o degrau mais caro da cadeia).
// Arquivos que a parte de CORREÇÃO já recebeu alterados da parte anterior.
// Ela é mandada a não refazer o trabalho ("corrija APENAS os problemas abaixo, no código existente"), mas o diff dela conta
// desde o mesmo commit base, então o contrato era conferido em cima do trabalho alheio. Na m-mu8usf5z a V02-R2f levou dois
// achados high por src/lease/process-info.js e src/adapters/claude/index.js, arquivos que a V02-R2 mexeu e que a revisão da
// V02-R2 aceitou. Achado high impede o approve E conta como problema grave, então a parte subia para o modelo mais caro e
// gastava rodadas para desfazer exatamente o que mandaram manter.
export function inheritedFiles(st, stories = []) {
  const prev = st?.fix_of && stories.find((x) => x.id === st.fix_of)
  if (!prev) return []
  const fromDiff = [...String(prev.diff || '').matchAll(/^diff --git a\/(\S+)/gm)].map((x) => x[1])
  return [...new Set([...fromDiff, ...(prev.files || []).map((f) => f.split('\\').join('/'))])]
}

// Linhas ACRESCENTADAS por um diff que afrouxam o tempo limite de uma prova (`{ timeout: 30000 }`, `testTimeout`, …).
// Afrouxar o tempo de uma prova para ela passar esconde instabilidade dentro do projeto para sempre, igual a enfraquecer
// asserção — e o motor empurrava quem escreve para isso ao mandar consertar prova que só estourava tempo. Na m-mu8usf5z a
// V02-R3f pôs `{ timeout: 30000 }` em quatro arquivos de prova que nem eram da story, e o revisor classificou como low:
// sem achado high, isso entraria no projeto no commit da parte.
export function loosenedTimeouts(diff, isTestFile = () => true) {
  const hits = []
  for (const sec of String(diff || '').split(/^diff --git a\//m).slice(1)) {
    const file = sec.slice(0, Math.max(0, sec.indexOf(' '))).trim()
    if (!file || !isTestFile(file)) continue
    for (const l of sec.split('\n')) if (/^\+(?!\+\+)/.test(l) && /\b(?:testTimeout|test-timeout|timeout)\b\W{0,3}\d{4,}/i.test(l)) hits.push(`${file}: ${l.slice(1, 120).trim()}`)
  }
  return hits
}

// Tipos e lint que o motor mesmo roda (m-mu8usf5z, 22/09: o portão de tipos do projeto é UMA prova só, vermelha desde a
// v0.4b; acceptPreexisting a desculpava pelo nome e cada parte commitou erro de tipo e de lint novo por baixo dela).
// Só comando que dá para chamar com `node` sem shell: tsc local e script de lint "node ...". Outro formato fica de fora.
export function staticCommands(pkg, hasTsc) {
  const out = []
  if (hasTsc) out.push({ name: 'tipos', args: ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'] })
  const lint = String(pkg?.scripts?.lint || '').trim()
  if (/^node\s/.test(lint) && !/[&|;<>]/.test(lint)) out.push({ name: 'lint', args: [...lint.split(/\s+/).slice(1), ...(/oxlint/.test(lint) ? ['--format', 'unix'] : [])] })
  return out
}
// "arq(10,5): error TS..." (tsc) e "arq:10:5: mensagem" (lint unix). A chave tira linha e coluna: código que só desceu de
// linha não vira erro novo.
export function parseDiagnostics(name, out) {
  const rows = []
  for (const l of String(out).split(/\r?\n/)) {
    const x = /^(\S[^:(]*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+)):\s*(.+)$/.exec(l.trim())
    if (x) { const file = x[1].replace(/\\/g, '/'); rows.push({ name, file, line: +(x[2] || x[4]), text: x[6].trim(), key: `${name}|${file}|${x[6].trim()}` }) }
  }
  return rows
}
// erros de agora que não estavam no último commit (contagem por chave: o mesmo erro repetido num lugar novo também conta)
export function newDiagnostics(before, after) {
  const left = new Map()
  for (const d of before || []) left.set(d.key, (left.get(d.key) || 0) + 1)
  return (after || []).filter((d) => { const n = left.get(d.key) || 0; if (n) { left.set(d.key, n - 1); return false } return true })
}

export function preexistingReds(tests, before) {
  if (!tests?.tests?.length || !before?.length) return []
  const redBefore = new Set(before.filter((t) => t.status !== 'passed').map((t) => t.name))
  return tests.tests.filter((t) => t.status !== 'passed' && redBefore.has(t.name)).map((t) => t.name)
}

// Argumentos do `git diff` que mede o trabalho de uma parte. Sem commit-base o diff vai contra HEAD, NUNCA contra o índice:
// arquivo já no índice — recuperação com `git checkout <ref> -- .`, operador que deu `git add`, quem escreve que preparou o
// commit — some de um `git diff` puro. A parte aparece vazia, o motor para em "no_changes" e o modo noturno pula a parte
// desfazendo a árvore. (m-mu8usf5z, v03-s4: 1993 linhas provadas e 8 provas verdes descartadas assim, e as duas partes que
// dependiam dela caíram junto; o épico inteiro voltou ao planejador.)
export function diffArgs(base, paths = [], excludes = []) {
  return ['diff', base || 'HEAD', '--', ...paths, ...excludes]
}

// Prova vermelha, por si só, não é gravidade. Numa parte que escreve prova e código na mesma chamada, a prova nova vermelha
// depois da rodada 1 é o estado NORMAL — a rodada 2 existe para isso. Grave é a parte QUEBRAR o que estava verde na largada.
// Antes qualquer vermelha na rodada 2 pulava a cadeia barata inteira e caía na de correção, e na rodada 3 subia dois degraus
// de uma vez. Mesma classe do defeito de truncamento (2310f4a, e357d83): o motor lia trabalho normal como emergência.
export function brokeGreen(after, before) {
  if (!after || after.ok || !before?.tests?.length) return false
  const green = new Set(before.tests.filter((t) => t.status === 'passed').map((t) => t.name))
  const pre = after.preexisting || []
  return after.tests.some((t) => t.status !== 'passed' && green.has(t.name) && !pre.includes(t.name))
}

// Linhas `@caminho` sozinhas são imports de CLAUDE.md (o CLAUDE.md deste repositório é só `@AGENTS.md`). O motor roda o
// Claude com --safe-mode — que desliga TODAS as personalizações, o CLAUDE.md do projeto junto — e reinjeta as regras do
// repositório à mão; estes dois expandem um nível de import.
const IMPORT_RX = /^[ \t]*@(\S+)[ \t]*$/gm
export function importsOf(text) { return [...String(text || '').matchAll(IMPORT_RX)].map((x) => x[1]) }
export function expandImports(text, contents = {}) { return String(text || '').replace(IMPORT_RX, (line, f) => contents[f] ?? line) }

// O Gemini (CLI agy) não tem teto de turnos — só --print-timeout — e roda comando de terminal em segundo plano. Mandado
// rodar provas, ele dispara, espera e consulta de novo, e cada consulta reenvia o contexto inteiro. m-mu8usf5z: as chamadas
// que rodaram provas gastaram 820k, 849k, 875k e 2356k tokens de entrada em 15 a 20 min, todas depois de "I have launched
// the test execution and will wait"; as que não rodaram ficaram entre 174k e 471k, em 2 a 8 min. Uma frase pedindo para
// não esperar (fix 21) não segurou: é comportamento da ferramenta, não escolha do modelo. Então o Gemini não recebe
// instrução nenhuma de rodar provas — o motor roda logo depois e confere o vermelho sozinho — e o teto no prompt passa a
// ser o de verdade, em minutos, em vez de um número de ações que ninguém aplica.
export const AGY_NO_TESTS = 'NÃO rode provas, suíte, typecheck, lint, build nem servidor: nesta ferramenta o comando roda em segundo plano e esperar por ele consome a chamada inteira. O motor roda as provas logo depois de você e devolve o resultado na próxima rodada. Leia, edite e termine.'
export function agyPrompt(prompt, minutes, dropPrefixes = []) {
  const kept = String(prompt || '').split('\n').filter((l) => !dropPrefixes.some((p) => l.startsWith(p)))
  return [...kept, AGY_NO_TESTS].join('\n').replace(/\b\d+ ações\b/g, `${minutes} minutos`).replace(/cortada nesse número/g, 'cortada nesse tempo')
}

// Último degrau que a escada de rodadas sobe. Degrau marcado `reserve` não é escalada: só entra quando os de cima ficam sem
// cota ou falham (withChain segue a cadeia). m-mu8usf5z, v03-s6f: a cadeia fix era Sol → Opus → Gemini com o Gemini de
// reserva, mas a escada tratava posição como força e deu as rodadas 4 a 6 ao Gemini — que levou a parte de 1 prova
// vermelha para 5 e desistiu na última rodada esperando a prova terminar.
export function climbLast(chain) {
  let i = (chain?.length || 0) - 1
  while (i > 0 && chain[i]?.reserve) i--
  return Math.max(0, i)
}

// Devolve arquivos guardados em memória ([caminho absoluto, conteúdo | null]). `git restore --source=<base>` num arquivo
// novo (intent-to-add) apaga o arquivo E a pasta que ficou vazia; o writeFile de volta falhava com ENOENT e o .catch calado
// engolia o erro. m-mu8usf5z, v0.4a S01, 21/09: src/skills/{catalog,skillguard,bm25,select}.js sumiram depois da conferência
// do vermelho, e a rodada seguinte recebeu "Does the file exist?". Recria a pasta e devolve os caminhos que não voltaram.
export async function putBack(saved) {
  const { mkdir, rm, writeFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const lost = []
  for (const [abs, body] of saved) {
    try {
      if (body == null) await rm(abs, { force: true })
      else { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, body) }
    } catch { lost.push(abs) }
  }
  return lost
}

// A árvore suja pertence à parte? Dentro do escopo, sempre. Parte INTERROMPIDA (pausa, queda do motor ou do PC no meio dela):
// a árvore é dela por construção, porque só quem escreve nesta parte mexeu nela desde o último commit; arquivo fora do escopo
// é assunto do revisor ("fora do contrato"), não motivo para apagar o trabalho. Arquivo proibido (do_not_touch, ex. proto/**)
// nunca: aí a árvore tem mão de fora. m-mu8usf5z, v0.5 V05-01, 22/09: o PC desligou na rodada 2; 16 de 17 arquivos no
// escopo e src/mission/plan-lifecycle.js (8 linhas pedidas pelo achado 1 do revisor) fora dele, e o continuar ia descartar tudo.
export function treeBelongs(files, { scope = [], blocked = [], interrupted = false } = {}) {
  if (files.some((f) => blocked.some((r) => r.test(f)))) return false
  if (interrupted) return true
  return scope.length > 0 && files.every((f) => scope.some((r) => r.test(f)))
}

// A saída estruturada da OpenAI (Codex) só aceita esquema estrito: todo objeto com additionalProperties false e todas as
// propriedades em required. Esquema sem isso voltava 400 invalid_json_schema e o papel inteiro caía (m-mud7qppy, 22/09: a
// pesquisa no Luna falhou em 6 s). Campo opcional vira obrigatório; o modelo devolve vazio quando não tem o que pôr.
export function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema)
  if (!s || typeof s !== 'object') return s
  const out = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, strictSchema(ps)])) : strictSchema(v)]))
  if (out.type === 'object' && out.properties) { out.additionalProperties = false; out.required = Object.keys(out.properties) }
  return out
}
