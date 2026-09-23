# ADR 0032 — A cota dos planos manda e o dólar por missão é informativo (emenda o ADR 0026)

**Status:** Aceito (escolha de Erick na entrevista da versão definitiva, 2026-09-22)

## Contexto

O [ADR 0026](0026-governanca-execucao-custos.md) fixou um teto absoluto de US$ 300 por missão: a reserva cujo total
acumulado chegasse a esse valor era recusada antes do despacho. Os modelos rodam pelos planos de assinatura, cujo limite
real é a cota da família, e não o dólar estimado. Na entrevista da versão definitiva o usuário escolheu: "só a cota dos
planos manda; o valor em dólar é informativo".

A demo ensinou também que a cota esgotada precisa pausar e retomar sozinha (proto/server.mjs, m-mu8usf5z V1-3): o motor
confundiu texto de conversa e `error_max_turns` com cota e bloqueou o Claude por 1 h com a cota real em 0% e 3%.

ADR aceito não se edita (`AGENTS.md`); este ADR emenda o 0026 sem alterar o arquivo dele.

## Decisão

1. **Dólar informativo.** `authorizePaidCall` não recusa mais por `absolute_usd_cap` nem por `budget_usd_exceeded`. O
   total (gasto observado + reservas abertas + pedido) volta em `usd_total` e fica no `budget_reserved` do journal.
2. **A cota manda.** O recibo oficial da família, as reservas de chamadas, turnos, contexto e o tempo de parede continuam
   bloqueando como no 0026.
3. **Cota esgotada pausa.** Só o erro da CLI (`is_error` com mensagem de limite) é cota; `error_max_turns` e texto de
   conversa nunca são (`classifyCallFailure` em `src/engine/quota.ts`). A pausa grava `mission_paused {reason:'quota',
   resume_at}` sem gastar rodada da escada; sem hora legível, espera 1 h.
4. **Retomada automática.** Na hora de renovação o laço grava `mission_resumed` e segue sem aprovação nova, porque o plano
   aprovado não mudou. Reinício antes da renovação lê a pausa aberta do journal e mantém a mesma hora.

## Evidência

- `tests/quota_pause_resume.test.ts`: pausa com a hora da CLI, retomada pelo relógio injetado, classificação que ignora
  texto e `error_max_turns`, gasto acima de US$ 300 sem bloqueio e reinício que preserva a hora.
- `tests/budget-controls.test.ts` e `tests/engine-quota.test.ts`: as provas de teto absoluto passam a afirmar registro sem
  bloqueio.

## Trade-offs

- Sem teto em dólar, uma estimativa de custo errada não para a missão; o limite passa a ser a cota real do plano.
- A validação de configuração que recusa `max_usd` acima de 300 no plano continua; ela descreve o plano, não bloqueia
  chamada.

## Como reverter

Abrir um ADR novo que volte a recusar em `authorizePaidCall` quando `usd_total` alcança o teto.
