// Política compartilhada pelo planejamento da demo e sua avaliação sem executar missões.
export const PLANNING_POLICY = `PLANEJAMENTO PROPORCIONAL:
Comece com uma única story que entrega e prova o resultado inteiro. Divida apenas quando existir entrega verificável independente, dependência real que precise de checkpoint, risco distinto ou contexto que não caiba numa execução coerente.
Não divida por número de palavras, critérios, arquivos ou linhas de diff. Não crie uma story por função, camada, teste ou documento. Código, testes, integração e documentação do mesmo comportamento ficam juntos.
Revisar, rodar a suíte e commitar o próprio trabalho são gates do harness, não stories extras. Não crie uma story de revisão para tornar o próprio plano independente. Quando o software pedido é um motor que revisa código, retoma execução ou entrega em Git, esses itens são CAPACIDADES A IMPLEMENTAR E TESTAR no produto, não instruções para revisar ou publicar esta execução. Não substitua uma capacidade pedida por documentação, preparação ou promessa de que o motor a fará depois. Uma story apenas de testes ou documentação cabe quando esse é o resultado explicitamente pedido, não como separação automática da implementação.
Cada story de um plano com várias stories traz split_reason: por que esta fronteira é necessária e por que juntar com a vizinha prejudicaria execução ou verificação. Paralelismo só justifica separação quando os resultados e contratos são independentes.
O implementador é capaz de investigar e decidir detalhes locais. Fixe resultados, restrições, interfaces compartilhadas e decisões irreversíveis; não antecipe cada variável, mensagem ou passo de edição. recipe e examples podem ser vazios quando não acrescentam informação ao aceite.
Escreva somente as decisões necessárias. Critérios suficientes para provar o pedido, sem quantidade mínima artificial. Não invente escopo para preencher listas. O plano cobre TODO o escopo aprovado; nunca omita o restante por atingir uma contagem de stories.`

export function versionProgram(brief, index = 0) {
  const version = brief?.versions?.[index]
  if (!version?.name || !version.goal) return null
  const acceptance = version.includes?.length ? version.includes : [version.goal]
  return {
    title: version.name,
    explanation: `${version.name}: ${version.goal}. Um épico preserva este marco; as stories seguem os resultados necessários.`,
    epics: [{ id: 'e1', title: version.name, goal: `${version.goal}\nEntregar integralmente: ${acceptance.join('; ')}. Respeitar o briefing, o roadmap e as restrições aprovadas. Não implementar versões futuras.`, acceptance, depends_on: [] }],
  }
}

export function planIssues(plan) {
  if (!Array.isArray(plan?.stories) || !plan.stories.length) return ['Plano sem stories']
  const issues = [], seen = new Set()
  for (const st of plan.stories) {
    if (!st.id || seen.has(st.id)) issues.push('ID de story ausente ou repetido')
    if (!st.request?.trim()) issues.push(`${st.id}: falta resultado pedido`)
    if (!st.acceptance?.length) issues.push(`${st.id}: falta critério de aceite`)
    if (!st.scope_paths?.length) issues.push(`${st.id}: falta scope_paths`)
    if (plan.stories.length > 1 && !st.split_reason?.trim()) issues.push(`${st.id}: falta split_reason para justificar a separação`)
    for (const dep of st.depends_on || []) if (!seen.has(dep)) issues.push(`${st.id}: dependência ${dep} não existe antes desta story`)
    seen.add(st.id)
  }
  return issues
}

export function needsPlanCritic(intent) {
  return intent?.difficulty === 'hard' || (intent?.domains || []).some(d => ['security', 'database'].includes(d))
}

export function canCombineProof(settings, baseline, story) {
  return settings.prova_com_codigo !== false && baseline?.named !== false && !story.red_retry
}

export function skillsForStory(skills, story, forced = []) {
  const files = [...(story.scope_paths || []), ...(story.files || [])]
  const visual = files.some(f => /\.(jsx|tsx|html|css|scss|vue|svelte)$|(^|\/)(ui|frontend|components)\//i.test(f)) || /\b(interface visual|layout|frontend|acessibilidade|tela|painel|botão)\b/i.test(`${story.title || ''} ${story.request || ''}`)
  return skills.filter(s => visual || forced.includes(s.id) || !['design-taste-frontend', 'impeccable'].includes(s.id))
}

// O relatório do scout é UMA vaga na missão inteira. A condição de renová-lo era `i > 0`, o índice do épico dentro do
// programa da VERSÃO atual — então um programa de um épico só nunca renovava, e cada versão nova recomeça em i=0.
// m-mu8usf5z: a v0.3 foi planejada com o relatório da v0.2, de doze horas antes e sobre outro subsistema (Checker e
// adapters). O planejador ficou sem os fatos do código que ia mexer, e o revisor cobrou justamente isso — `story.guardrails`
// que o motor não produz, `committed` onde o motor grava `delivered`, `evals[].cmd` onde o plan-load normaliza `argv`.
// Renova por ÉPICO; não repete o mesmo épico; o primeiro épico da primeira versão segue coberto pelo scout da missão.
// A chave leva a versão junto: cada programa numera os épicos a partir de e1, então "e1" da v0.3 colide com "e1" da v0.2 e
// o relatório velho passaria por novo — a mesma colisão de ID que o revisor cobrou desta missão.
export function scoutKey(epicId, versionIndex = 0) { return `${versionIndex}:${epicId}` }
export function needsScout(scout, epicId, index = 0, versionIndex = 0) {
  if (!epicId || scout?.epic === scoutKey(epicId, versionIndex)) return false
  return index > 0 || versionIndex > 0
}

// Pedido curto não é pedido de baixo risco: "remova a autenticação da rota de pagamento" tem verbo de ajuste e cabe em uma
// linha. Superfície sensível sai da faixa rápida e ganha plano com escopo e revisão completos.
export const RISK_WORDS = /\b(autentica\w*|login|senha\w*|token\w*|segredo\w*|credencia\w*|pagamento\w*|cobran[çc]a\w*|dinheiro|saldo|permiss\w*|autoriza\w*|seguran[çc]a|criptogra\w*|migra[çc]\w*|banco de dados|dados? d[eo]s? (usu[áa]rios?|clientes?)|admin\w*|sess[ãa]o|cookie\w*|webhook\w*)\b/i
