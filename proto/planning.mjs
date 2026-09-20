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
