# ADR 0041 — Chat com memória persistente, skills por pergunta e busca nas conversas (ideias do Hermes Agent)

**Status:** Aceito (pedido de Erick, 2026-09-24)

## Contexto

Em 2026-09-24 Erick pediu que a TL-ADE deixe de ser só executora de missões de código e vire uma central de IA
onde a pessoa faz tudo num lugar só, sem pensar muito, e pediu para trazer do Hermes Agent (NousResearch,
v0.21.5, MIT) o que fosse útil. Na mesma conversa fixou a restrição: **sem pagar API** — tudo continua pelas CLIs
oficiais com assinatura (`claude`, `codex`, `agy`), como já manda a carta.

A carta diz que a ADE "não é um chat de propósito geral" e o roadmap deixa "Memória por usuário" (item 7) no
backlog pós-v1. A redefinição completa do produto (a central) pede um ADR próprio quando Erick fixar o escopo;
este ADR decide só o primeiro passo, que já cabe no chat do painel que existe (`src/panel/chat/`).

O estudo do código do Hermes (`tools/memory_tool*.py`, `agent/background_review.py`, `hermes_state_search.py`,
`cron/`, `tools/approval*.py`, `agent/context_compressor.py`) mostrou três mecanismos baratos de portar e que
não dependem de API paga.

## Decisão

1. **Memória persistente entre conversas** (`src/memory/memory.ts`), no formato do Hermes: `~/.ade/memory/MEMORY.md`
   (fatos do ambiente e do trabalho) e `USER.md` (quem é a pessoa), entradas separadas por `\n§\n`, tetos de 2200 e
   1375 caracteres, conferidos no resultado final de cada lote de operações; lote que estoura ou falha não grava nada.
   Toda entrada nova passa pelos padrões do SkillGuard e por padrões de injeção ("ignore previous instructions");
   entrada suspeita no arquivo não entra no prompt.
2. **O modelo grava por marca na resposta**, porque a CLI não chama ferramenta da TL-ADE:
   `<memoria alvo="usuario">…</memoria>`, `troca="…"` e `apaga="…"/`. A TL-ADE aplica, tira a marca do texto e
   mostra no turno o que guardou (ou por que recusou). A cada 10 perguntas o prompt lembra de revisar o que vale
   guardar — o nudge do Hermes sem a chamada extra de revisão em segundo plano.
3. **Skills por pergunta**: cada pergunta do chat passa pelo seletor determinístico que já existe (BM25 sobre o
   catálogo, fora da quarentena, sem scripts, fonte ligada no projeto), no máximo 2 skills com placar ≥ 4, lidas
   conferindo os bytes contra o índice. O turno registra quais entraram. Catálogo divergente não derruba a conversa.
4. **"Nova conversa" arquiva em vez de apagar** (`.ade/chat/arquivo/`), e **a busca** (`GET /api/chat/search?q=`)
   acha nas conversas atuais e arquivadas de todos os projetos abertos, por FTS5 na memória montado a cada busca a
   partir dos arquivos duráveis (nada a sincronizar). Cada palavra vira termo entre aspas, então nenhuma sintaxe do
   FTS5 passa; sem resultado com todos os termos, tenta com qualquer um.
5. **Painel**: o turno mostra "Skills usadas" e as notas de memória; a coluna da conversa ganha "Buscar nas
   conversas" e "Memória entre conversas", onde a pessoa vê o uso de cada arquivo e apaga entradas
   (`GET/POST /api/memory`).

## Evidência

- Hermes: `tools/memory_tool_store.py` (delimitador, tetos, recusa com consolidação), `agent/turn_context.py:709-718`
  (nudge a cada 10 turnos), `hermes_state_search.py:793-855` (sanitização e fallback OR; a busca não usa LLM).
- `tests/memory.test.ts` e o bloco "ideias do Hermes" de `tests/panel_web_chat.test.ts` (API e navegador).
- Sondagem no catálogo real (18 skills): pedido que casa ("code review", "typescript") passa de 8; conversa comum fica
  abaixo de 1,5 — daí o corte em 4.

## Trade-offs

- O catálogo é em inglês: pergunta em português só casa por termo técnico. Casar por sentido pede o interceptador
  com modelo leve, que fica para depois da medição.
- A marca de memória depende de o modelo segui-la; a recusa aparece no turno, não some calada.
- A memória é global e entra em toda conversa: um arquivo hostil lido pelo agente pode tentar gravar uma entrada. Os
  padrões de injeção barram o comum, e cada gravação aparece no turno e pode ser apagada no painel.
- A busca remonta o índice a cada consulta: ótimo até dezenas de milhares de turnos; depois, índice persistente.

## Alternativas rejeitadas

- **Revisão de memória em segundo plano a cada 10 turnos (como o Hermes):** uma chamada de CLI a mais por ciclo,
  gastando cota; o lembrete no prompt entrega o grosso sem custo.
- **Índice FTS5 persistente dentro de `.ade/index.sqlite`:** esse índice é reconstruído byte a byte das projeções do
  journal; misturar o chat quebraria essa garantia.
- **Criação automática de skills, cron, aprovação de comando perigoso, compressão de contexto:** úteis, mas cada um
  pede decisão própria (custo de cota, segurança, superfície); ficam para os próximos ADRs da central.

## Como reverter

Um ADR novo que emende este. Tirar `context` do `ChatAgentInput` desliga memória e skills no chat; os arquivos em
`~/.ade/memory` e `.ade/chat/arquivo` ficam e podem ser apagados à mão.

## Consequências para outros documentos

- `docs/adr/README.md`: índice cita o 0041.
- `docs/roadmap.md` §10: o item 7 (memória por usuário) sobe por pedido de Erick, na forma deste ADR.
- `PROJECT_CHARTER.md`: a mudança de "não é chat de propósito geral" para central de IA vem no ADR da central.
