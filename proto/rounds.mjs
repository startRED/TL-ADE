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
