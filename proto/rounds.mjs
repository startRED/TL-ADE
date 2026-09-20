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

export function preexistingReds(tests, before) {
  if (!tests?.tests?.length || !before?.length) return []
  const redBefore = new Set(before.filter((t) => t.status !== 'passed').map((t) => t.name))
  return tests.tests.filter((t) => t.status !== 'passed' && redBefore.has(t.name)).map((t) => t.name)
}
