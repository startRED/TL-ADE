# ADR 0046 — Maker retoma a própria sessão na rodada seguinte do mesmo degrau

**Status:** Aceito (pedido de Erick, 2026-09-26: menos rodadas desperdiçadas)

## Contexto

Nas duas missões reais medidas (`mission-0103879188cd` e `mission-c6e019b88bea`) a escada subiu 26 vezes: 13 por
revisão com mudanças pedidas, 5 por corte no teto de turnos, 5 por `no_change` e 3 por prova verde falhando. Cada
rodada abria uma sessão nova do maker: ele relia o pack inteiro, redescobria o código e às vezes repetia o mesmo erro,
porque não via o que já tinha tentado. Medido na mesma data com a isolação do ADR 0044: `claude -p --session-id X`
seguido de `claude -p --resume X`, com o mesmo `--append-system-prompt-file`, manteve o contexto e leu 31 mil tokens
do cache; o prompt da retomada pela entrada padrão também funcionou.

## Decisão

1. **A chamada seguinte do maker no mesmo degrau e no mesmo modelo retoma a sessão anterior** com `--resume <id>`
   (`resumableSession` em `src/engine/ladder.ts`). Vale para rodada reprovada (revisão, portão, prova verde, jornada,
   avaliação visual) e para a continuação depois de corte no teto de turnos.
2. **O pack não muda na retomada**: o mesmo arquivo vai em `--append-system-prompt-file`. Um pack novo mudaria o prompt
   de sistema e jogaria fora o cache da conversa inteira. O que mudou vai no prompt: o pedido de correção (provas
   vermelhas cobráveis e achados graves abertos, o mesmo `correction` do pack de retrabalho) ou "continue de onde
   parou" depois de um corte. O prompt vai pela entrada padrão, fora do argv, porque achados grandes passariam do
   teto de 32.767 caracteres do Windows.
3. **Sessão nova** ao trocar de degrau ou de modelo, depois de 2 retomadas seguidas na mesma sessão (o contexto fica
   poluído de tentativas falhas), depois de chamada perdida ou pausa por cota, e na retomada de uma parte pelo motor
   reiniciado (a sessão viva só existe na memória do laço).
4. **Durabilidade**: a retomada é um passo `model_call` como qualquer outro, com o `session_ref` da sessão retomada no
   `step_intent` e `resume_of` na entrada do passo; antes dela o journal ganha `decision: maker_resume` com a sessão e
   a contagem. Se a sessão não existe mais (outra máquina, arquivo apagado), a CLI sai 1 com "No conversation found";
   o motor registra `decision: maker_resume_fallback` e refaz a mesma rodada numa sessão nova, com o pack de
   retrabalho.
5. **Só o Claude retoma.** O `codex exec resume` (0.157.1) aceita `--output-schema`, `-o` e `--json`, mas não aceita
   `--sandbox`, `-C` nem `--color`, e o maker do Codex roda `--ephemeral`, sem sessão gravada. O agy não devolve
   sessão. Os dois continuam com sessão nova a cada rodada (comentário `ponytail` em `resumableSession`).

## Evidência

- `tests/adapter-claude.test.ts`: argv com `--resume` no lugar de `--session-id` e sem prompt no argv; prompt pela
  entrada padrão; sessão sumida acusada.
- `tests/correction_ladder.test.ts`: retomada no mesmo degrau com o mesmo pack e a prova vermelha no prompt; sessão
  nova ao subir de degrau; corte pede "continue"; terceira chamada seguida abre sessão nova; sessão sumida cai para
  sessão nova com decisão no journal; Codex fica com sessão nova.

## Trade-offs

- A sessão retomada carrega as tentativas anteriores. O teto de 2 retomadas limita a poluição; o preço é que a terceira
  chamada seguida no degrau relê tudo.
- O pack da retomada é o da sessão, não o de retrabalho: o painel mostra o pack da primeira chamada da sessão nas
  retomadas.
- Suposição conservadora: motor reiniciado não retoma sessão de antes do reinício. Retomar exigiria reconstruir a
  contagem de retomadas pelo journal e a sessão pode estar em outra máquina.

## Alternativas rejeitadas

- **Pack novo a cada retomada**: invalida o cache do prompt de sistema e perde metade do ganho.
- **Prompt da retomada no argv**: estoura o teto do argv do Windows com achados de jornada (DOM, console, prints).
- **Conferir o arquivo da sessão em `~/.claude/projects` antes de retomar**: depende do formato interno da pasta do
  Claude Code; a falha da CLI é o sinal estável e não gasta modelo.

## Como reverter

`resumableSession` devolvendo sempre `null` volta à sessão nova a cada rodada; o resto do caminho fica inerte.

## Consequências para outros documentos

Nenhum ADR aceito foi editado.
