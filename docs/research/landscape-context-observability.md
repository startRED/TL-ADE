# Estado da arte: context engineering, memória, saída de ferramenta e observabilidade de tokens

Rodada de rearquitetação da TL-ADE. Data da pesquisa: 2026-09-16. Alvo: decisões de contexto da ADE
(context packets, Tool Output Firewall, memória, telemetria por missão, harness doctor).

Cada afirmação traz `[verificado: fonte]`, `[inferido]` ou `[hipótese]`. URLs completas na seção
[Fontes](#fontes). Ambiente de verificação: Claude Code 2.1.271, Codex CLI 0.154.0, Node 24.16.0,
Windows 11.

---

## 0. Resumo das decisões

| # | Decisão | Recomendação | Confiança |
| :--- | :--- | :--- | :--- |
| 1 | Ordem do pack | Volatilidade crescente: ferramentas → papel → invariantes → skills (ordem estável) → contexto recuperado → spec/eval → formato de saída. Teto duro de 40k tokens por pack | verificado (regra de cache) + inferido (tetos) |
| 1b | Sessão nova por story | Sim, e compactação vira **alarme**, não estratégia | inferido (convergência de 4 fontes; sem A/B público) |
| 2 | Tool Output Firewall | Dois níveis: executor da ADE (portões, universal) + camada nativa por família (Claude Code hooks, `AGENTS.md` no Codex) | verificado |
| 3 | Memória | Arquivos markdown versionados por repositório + índice com teto. Memória por usuário e sistemas de memória: YAGNI na v1 | verificado + inferido |
| 4 | Telemetria | Journal JSONL como fonte de verdade; OTel como exportação opcional. Mapear para `gen_ai.*` sabendo que cache e custo **não têm convenção** | verificado |
| 5 | Harness doctor | v1 coleta contadores por skill/regra; v2 executa o A/B com Caliper (não reimplementar) | verificado (ferramenta) + hipótese (ganho) |

---

## 1. Modelo de contexto por chamada (context packet)

### 1.1 O que a spec v1 já resolve

O `tl-orchestrator` já tem política formal de contexto: dez classes de informação, três modos de
entrega (`inline` / `excerpt` com digest SHA-256 / `on_demand` com ponteiro), matriz por fase
(planning, implementation, review, rework, debate) e três métricas — Retrieval Amplification (RA),
Tool Delivery Ratio (TDR) e Bootstrap Cost. Também define confinamento de leitura
(`reads_outside_allowed_set`) e isolamento de árvores arquivadas.
`[verificado: tl-orchestrator-release/docs/CONTEXT_POLICY.md]`

**A ADE não precisa reinventar o modelo de classes.** O que falta na v1 é a dimensão de *cache* — a
ordem dos blocos — e os tetos por seção.

### 1.2 A regra que decide a ordem: hierarquia de invalidação do cache

O prefix cache da API Claude é hierárquico: `tools → system → messages`. Mudança num nível invalida
esse nível e todos os seguintes. Mudar definições de ferramenta invalida **tudo**.
`[verificado: platform.claude.com/docs/en/build-with-claude/prompt-caching]`

Outros parâmetros duros da mesma fonte `[verificado]`:

| Parâmetro | Valor |
| :--- | :--- |
| Mínimo cacheável | 512 tokens (Fable 5.1, Mythos 5.1, Opus 5, Fable 5, Mythos 5); 1.024 (Opus 4.8, Sonnet 5/4.6/4.5, Opus 4.1/4); 2.048–4.096 (Opus 4.6/4.5, Haiku 3.5); 4.096 (Haiku 4.5) |
| Preço | write 5 min = 1,25x; write 1 h = 2,0x; read = 0,1x (0,025x em Fable 5.1 / Mythos 5.1) |
| Breakpoints explícitos | máximo 4 por requisição; janela de lookback de 20 blocos |
| Campos de uso | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` |
| TTL na prática (Claude Code) | 1 h em assinatura; 5 min em API key, provedor de nuvem ou usage credits |

O Manus chega à mesma conclusão por medição de produção: "KV-cache hit rate é a métrica mais
importante de um agente em produção"; com Sonnet, token cacheado custava US$0,30/MTok contra
US$3,00/MTok não cacheado — 10x. Daí as regras: prefixo estável, contexto append-only, serialização
determinística, e **mascarar em vez de remover** ferramentas (remover invalida o KV-cache e deixa
referências órfãs no histórico). `[verificado: manus.im/blog/Context-Engineering-for-AI-Agents]`

> Consequência direta para a ADE: **o conjunto de ferramentas oferecido a um agente não pode variar
> por story.** Se o adapter passa `--allowedTools` diferente a cada story, o prefixo nunca bate.
> Varia-se a *permissão* (contain, hooks de bloqueio), não a *definição*. `[inferido]`

### 1.3 Ordem proposta do pack (da menos volátil para a mais volátil)

| Ordem | Bloco | Varia com | Teto sugerido |
| ---: | :--- | :--- | ---: |
| 1 | Definições de ferramenta | nunca (por família) | — |
| 2 | Instruções de papel (Maker / Checker / Avaliador / Classificador) | papel | 1.000 tok |
| 3 | Invariantes do repositório (`CLAUDE.md`/`AGENTS.md` mínimo, fronteiras do `contain`, guardrails) | repositório | 1.500 tok |
| 4 | Corpos das skills selecionadas, **ordenados por id estável** | story (≤ 3 skills) | 2.500/skill, 7.500 total |
| 5 | Contexto recuperado (esqueleto Graft, excerpts com digest, `dependency_outputs`) | story | 6.000 tok |
| 6 | Spec da story + eval obrigatório + `unresolved_items` + plano vivo (recitation) | story/rodada | 2.000 tok |
| 7 | Contrato de saída (formato do relatório/JSON) | papel | 300 tok |

Breakpoints de cache (usar 3 dos 4): depois de (2), depois de (4), depois de (5). Assim (6) e (7),
que mudam a cada rodada de rework, ficam fora do cache e o resto é lido a 0,1x. `[inferido]`

Detalhes que o desenho tem de respeitar `[inferido, derivado de verificados]`:

- **Skills em ordem estável, não por relevância.** Ordenar por score de relevância muda o prefixo a
  cada story e mata o cache do bloco (4). Ordene por id; a relevância decide *quais*, não *onde*.
- **Skill como bloco do pack, não como leitura.** A spec v2 §9 diz "corpo do `SKILL.md` entra no
  contexto do agente como leitura". Se entrar como `tool_result`, fica depois do prefixo estável e
  vira candidato à limpeza automática de resultados de ferramenta (§1.5). Deve ser bloco fixo.
- **Teto duro de 40k tokens de pack.** Acima disso a story está mal dimensionada. Justificativa em
  §1.4.
- O teto de 2.500 tok/skill é mais apertado que o do Claude Code por escolha: o Claude Code reinjeta
  skills após compactação com cap de **5.000 tokens por skill e 25.000 no total**, descartando as
  mais antigas, e a truncagem preserva o **início** do arquivo.
  `[verificado: code.claude.com/docs/en/context-window]`

### 1.4 Por que teto de pack e não "usar a janela"

O estudo Context Rot da Chroma testou 18 modelos (Anthropic, OpenAI, Google, Alibaba) em quatro
variantes de needle-in-a-haystack, mais LongMemEval e uma tarefa de palavras repetidas.
`[verificado: trychroma.com/research/context-rot]`

| Achado | Consequência para o pack |
| :--- | :--- |
| Todos os modelos degradam com o comprimento da entrada; "modelos não usam o contexto de forma uniforme" | Janela grande ≠ contexto grande útil |
| **Um único distrator** já reduz o desempenho, e o efeito amplifica em entradas longas | Contexto "por via das dúvidas" tem custo de acurácia, não só de token |
| LongMemEval: ~113k tokens (completo) contra ~300 tokens (focado) → acurácia bem maior no focado | Excerpt com digest > arquivo inteiro |
| Menor similaridade pergunta–agulha = queda mais íngreme com o comprimento | Spec vaga + contexto grande é o pior par |
| Haystack embaralhado rende **melhor** que haystack logicamente estruturado (contraintuitivo) | Não presuma que "organizar melhor" resolve; cortar resolve |
| Precisão cai com a posição, especialmente além de ~2.500 palavras | O que importa vai no fim (spec) ou no começo (invariantes), não no meio |

A Anthropic descreve o mesmo fenômeno como "attention budget" e "context rot", com a explicação
arquitetural (n tokens ⇒ n² relações par a par; treino enviesado para sequências curtas) e a
conclusão de que é "um gradiente de desempenho, não um precipício". A recomendação é curar "o menor
conjunto possível de tokens de alto sinal".
`[verificado: anthropic.com/engineering/effective-context-engineering-for-ai-agents]`

### 1.5 Sessão nova por story vs sessão longa com compactação

**Evidência a favor de sessão nova + estado externo:**

| Evidência | Classificação |
| :--- | :--- |
| "Claude Code envia sua conversa inteira a cada requisição, e cada uso de ferramenta envia outra requisição carregando aquele lote de resultados"; uma pergunta de uma linha numa sessão aberta o dia todo ainda cobra a conversa inteira | `[verificado: code.claude.com/docs/en/costs]` |
| "`/compact` lê a conversa que resume, então compactar um contexto grande é em si uma requisição grande. Quando você quer um começo limpo, `/clear` não custa nada" | `[verificado: idem]` |
| Compactação server-side tem iteração de amostragem própria e cobrada; o exemplo do doc mostra `{"type":"compaction","input_tokens":180000,"output_tokens":3500}` além da mensagem normal | `[verificado: platform.claude.com/docs/en/build-with-claude/compaction]` |
| Compactação **perde** coisas: skills truncadas ao cap, apenas 5 arquivos relidos (arquivo >5.000 tok volta só como referência de caminho), `CLAUDE.md` aninhados e regras `paths:` somem até serem regatilhadas | `[verificado: code.claude.com/docs/en/context-window]` |
| Degradação por comprimento e por distrator (§1.4) | `[verificado: Chroma]` |
| O harness de longa duração recomendado pela Anthropic é sessão nova por unidade com arquivo de progresso + checklist de features, e nomeia os dois modos de falha: **over-ambition** (tenta tudo, acaba o contexto no meio) e **premature completion** (a sessão seguinte vê progresso e declara pronto) | `[verificado: anthropic.com/engineering/effective-harnesses-for-long-running-agents]` |
| "Trabalhe em uma feature por vez" é apontado como "crítico para a tendência do agente de fazer coisas demais de uma vez" | `[verificado: idem]` |

**Contraevidência / limite:** o artigo da Anthropic sobre harnesses **não publica números
comparativos** contra a linha de base; é observação empírica de modos de falha. Não encontrei nenhum
A/B público de "sessão nova por tarefa + estado externo" contra "sessão longa com compaction".
`[verificado: ausência confirmada na busca de 2026-09-16]`

> **Conclusão:** a superioridade de sessão nova por story é `[inferido]` a partir de cinco fontes
> convergentes, não `[verificado]`. A ADE deve tratá-la como hipótese de projeto **medida pelo
> próprio harness doctor** (§5), não como fato.

**Corolário operacional:** se uma story dispara compactação, a story estava mal dimensionada. A ADE
deve registrar `compaction_events` por story e tratar `> 0` como defeito do plano, não como
funcionamento normal. `[inferido]`

**Nota de implementação:** `/clear` não existe em modo headless. O equivalente da ADE é **processo
novo sem `--resume`**. Para reprodutibilidade forte, `claude --bare -p` pula a descoberta automática
de hooks, skills, comandos, subagentes, plugins, servidores MCP, auto memory e `CLAUDE.md` — o que é
exatamente o comportamento desejado num pack determinístico, mas exige passar as skills por
`--plugin-dir` / `--add-dir`. A doc diz que `--bare` "será o padrão para `-p` numa versão futura".
`[verificado: code.claude.com/docs/en/headless]`

### 1.6 Mecanismos server-side que a ADE pode ignorar (mas deve conhecer)

Só se aplicam a quem chama a API direto. A ADE chama por CLI, então são referência de contrato, não
implementação. `[verificado: platform.claude.com, beta header `context-management-2025-06-27`]`

| Mecanismo | Forma |
| :--- | :--- |
| Limpeza de resultados de ferramenta | `context_management.edits[].type = "clear_tool_uses_20250919"`, com `trigger` (padrão `{input_tokens: 100000}`), `keep` (padrão `{tool_uses: 3}`), `clear_at_least`, `exclude_tools`, `clear_tool_inputs` (padrão `false`) |
| Limpeza de thinking | `clear_thinking_20251015`, `keep: "all"` ou `{thinking_turns: N}`; quando combinado, **vem primeiro** na lista |
| Compactação | `compact_20260112`, `trigger` padrão 150.000 input tokens (mínimo 50.000), `pause_after_compaction`, `instructions` |
| Observabilidade | resposta traz `context_management.applied_edits[]` com `cleared_input_tokens`; `usage.iterations[]` separa a iteração de compactação; `count_tokens` devolve `context_management.original_input_tokens` |
| Interação com cache | limpar resultados **invalida** o prefixo — daí `clear_at_least`, para que a limpeza pague o rewrite |

Os dois recados que importam para a ADE: (a) `clear_tool_uses` prova que resultado de ferramenta é
*a* fonte de inchaço reconhecida pelo fornecedor; (b) `pause_after_compaction` existe justamente
para o cliente gravar estado externo antes de continuar — o padrão que a ADE já implementa com
journal + checkpoint.

---

## 2. Tool Output Firewall

### 2.1 O padrão comprovado: artifact + extrato + drill-down

As três camadas, todas com fonte:

1. **Artifact.** "Use o sistema de arquivos como contexto": guarde a observação grande fora da
   janela, mantendo no contexto uma referência restaurável (URL, caminho).
   `[verificado: Manus]` A Anthropic chama o mesmo de "structured note-taking" e "memória persistente
   com overhead mínimo". `[verificado: Anthropic context engineering]`
2. **Extrato.** "Em vez de o Claude ler um log de 10.000 linhas para achar erros, um hook pode dar
   grep em `ERROR` e devolver só as linhas que casam, **reduzindo o contexto de dezenas de milhares
   de tokens para centenas**." `[verificado: code.claude.com/docs/en/costs]`
3. **Drill-down.** O bruto continua recuperável sob demanda. É o contrato do `rtk`: saída condensada
   declara como recuperar (`rtk recall <id>`), e `rtk proxy <cmd>` repete sem filtro.
   `[verificado: tl-orchestrator-release/docs/TOKEN_TOOLS.md]`

Regra de *losslessness* herdada do v1 e que deve continuar: **falha contratual nunca é resumida.**
Sucesso é resumível; erro vai inteiro. E, no Checker, "saída condensada não é prova" — leitura de
diff, log de portão ou erro vem da fonte bruta. `[verificado: idem]`

Complemento do Manus, que vale contra o instinto de limpar tudo: **"mantenha as coisas erradas no
contexto"** — apagar ações falhas e traços de erro remove a evidência de que o modelo precisa para
adaptar. `[verificado: Manus]` Ou seja, o firewall corta *volume de sucesso*, não *evidência de
falha*.

### 2.2 Onde implementar

| Camada | Mecanismo | Cobertura | Veredito |
| :--- | :--- | :--- | :--- |
| Executor da ADE (portões, `git`, `gh`, build, testes) | o próprio runtime executa e escreve bruto em `artifacts/`, entregando extrato | as três famílias | **Primário.** É onde está o volume e onde a ADE já tem controle total |
| Claude Code `PreToolUse` | `hookSpecificOutput.updatedInput` reescreve o comando antes de rodar (ex.: `\| grep -A 5 -E '(FAIL\|ERROR)' \| head -100`) | só Claude Code | Secundário, para comandos que o agente inventa |
| Claude Code `PostToolUse` | `hookSpecificOutput.updatedResponse` **substitui o `tool_response` que o modelo vê** | só Claude Code | Secundário, como cap de tamanho e redação |
| Codex | instrução global em `~/.codex/AGENTS.md` (o Codex declara `rtk` em todo comando) | só Codex | Secundário, best-effort — é instrução, não enforcement |
| Gemini/Antigravity | não verificado nesta rodada | — | Assumir ausente |

`[verificado: code.claude.com/docs/en/hooks]` para os campos exatos `tool_name`, `tool_input`,
`tool_response`, `updatedInput`, `updatedResponse`, `additionalContext`.
`[verificado: TOKEN_TOOLS.md]` para o arranjo Codex.

> **Correção à spec v2 §12.** O texto diz "portões rodam via wrapper que descarta o que passou e
> devolve só falhas (o padrão dos hooks de filtro)". São dois mecanismos distintos e ambos
> exclusivos do Claude Code: `PreToolUse.updatedInput` (reescreve o comando — é o exemplo oficial da
> Anthropic) e `PostToolUse.updatedResponse` (substitui o resultado). Para três famílias, o firewall
> tem de morar no executor da ADE; os hooks são reforço, não a implementação.

O Claude Code também tem `PostToolUseFailure` e `PostToolBatch`, além de `PreCompact`/`PostCompact`
— úteis para instrumentação, não para o firewall. `[verificado: code.claude.com/docs/en/hooks]`

### 2.3 Como medir o ganho

Duas métricas por chamada, gravadas no step do journal:

- **TDR** (já definido no v1) = `bytes entregues ao modelo / bytes brutos emitidos pela ferramenta`.
  Alvo: ≤ 0,2 em portão verde; 1,0 (sem corte) em falha. `[verificado: CONTEXT_POLICY.md]`
- **RA** = `bytes carregados das fontes / bytes das seções efetivamente usadas`, onde "usada" = o
  digest canônico aparece na lista `sources` do resultado emitido. `[verificado: idem]`

Conferência independente sem instrumentar nada: o evento OTel `claude_code.tool_result` já traz
`tool_input_size_bytes`, `tool_result_size_bytes` e `duration_ms`.
`[verificado: code.claude.com/docs/en/monitoring-usage]` É a medida exata do firewall, vinda do
próprio harness.

**Ganho em custo** mede-se no nível da story, com o protocolo de ablação (§5): mesma fixture, com e
sem firewall, comparando `cache_read_input_tokens` e custo. O precedente local:

> Mesma tarefa, mesma configuração pessoal, com as quatro ferramentas de economia ligadas e
> desligadas, duas rodadas cada: **cache lido caiu 45% a 65%**; custo caiu 12% numa rodada e empatou
> na outra; cache **escrito subiu ~4.000 tokens por sessão** (o custo fixo das regras). Mesmos
> turnos, mesmas quatro entregas, sem perda observável de qualidade. Em sessão curta o resultado é
> neutro a levemente positivo; o ganho cresce com volume de saída de ferramenta e número de turnos.
> `[verificado: tl-orchestrator-release/docs/TOKEN_TOOLS.md, medição 2026-09-14, Windows 11, Claude
> Code 2.1.271]`

Isso é a evidência mais próxima que existe para o perfil da ADE, e diz duas coisas: o firewall paga
em sessões com volume de ferramenta (o perfil de uma story despachada), e **toda regra fixa tem
preço** (~4k tokens de cache write por sessão), o que é o argumento inteiro do harness doctor.

---

## 3. Memória

### 3.1 Que memória a ADE precisa

| Escopo | Precisa? | Mecanismo | Justificativa |
| :--- | :--- | :--- | :--- |
| **Por missão (lote)** | Já existe | Journal JSONL + `artifacts/` + plano vivo reinjetado no pack | É o "recitation" do Manus: o `todo.md` atualizado a cada passo empurra o objetivo para o fim da janela de atenção, mitigando lost-in-the-middle `[verificado: Manus]`. Na ADE é a seção (6) do pack, não um arquivo que o agente edita livremente |
| **Por repositório** | Sim | `<repo>/.ade/memory/` versionado em git: `INDEX.md` (uma linha por nota, teto 200 linhas / 25 KB) + notas por tópico lidas sob demanda | Padrão validado por dois produtos (§3.2). Conteúdo: decisões, armadilhas do repo, comandos que funcionam, evals que nunca falharam |
| **Por usuário** | **Não na v1** | — | Preferência do operador cabe em `~/.ade/config.json`. Sem evidência de ganho para o fluxo da ADE e com risco de vazar contexto entre projetos `[inferido]` |

Escrita: step explícito `memory_write` no fim da story, com o mesmo `contain` de qualquer outro
efeito — não escrita livre do agente. `[inferido]`

### 3.2 O mecanismo mínimo já é padrão de mercado

| Produto | Forma | Detalhes verificados |
| :--- | :--- | :--- |
| Memory tool da API Claude | `{"type": "memory_20250818", "name": "memory"}`, comandos `view`, `create`, `str_replace`, `insert`, `delete`, `rename` sob `/memories` | **Client-side**: a aplicação executa; o prompt de sistema injetado automaticamente diz "ASSUME INTERRUPTION: sua janela de contexto pode ser resetada a qualquer momento". Requer proteção contra path traversal, cap de tamanho e expiração — responsabilidade do implementador `[verificado: platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool]` |
| Auto memory do Claude Code | `~/.claude/projects/<project>/memory/` com `MEMORY.md` índice + arquivos por tópico | Índice carregado em toda sessão até **200 linhas ou 25 KB**; arquivos de tópico lidos sob demanda; quatro tipos (`user`, `feedback`, `project`, `reference`); **por repositório**, compartilhado entre worktrees, local à máquina; **não** entra em subagentes `[verificado: code.claude.com/docs/en/memory]` |

A Anthropic também publica o padrão multissessão para desenvolvimento: sessão inicializadora cria os
arquivos de memória antes de qualquer trabalho (log de progresso, checklist de features, referência
ao script de init); sessões seguintes abrem lendo esses arquivos; toda sessão atualiza o log antes de
encerrar; uma feature só é marcada completa após verificação ponta a ponta, não quando o código foi
escrito. `[verificado: memory-tool doc + effective-harnesses-for-long-running-agents]`

**Isto é isomorfo ao ciclo da story da ADE** (`prepare → … → gates → … → complete`) e ao journal.
A memória por repositório da ADE é o "progress log" promovido a artefato versionado. `[inferido]`

### 3.3 Por que não Mem0 / Letta / Zep na v1

| Sistema | Números publicados | Problema |
| :--- | :--- | :--- |
| Mem0 | 92,5 LoCoMo / 94,4 LongMemEval; 1,8k tokens por consulta contra 26k de full-context; p95 de latência 91% menor (1,44 s vs 17,12 s); algoritmo 2026: 93,4% LongMemEval e 91,6% LoCoMo com < 7.000 tokens por recuperação | Números do próprio fornecedor |
| Letta (MemGPT) | 58,10% no LoCoMo; p95 de busca 59,82 s | Latência inviável para loop interativo |
| Zep | reivindica 75,14% ± 0,17 e contesta publicamente a metodologia do Mem0 | **Disputa aberta entre fornecedores sobre os mesmos benchmarks** |

`[verificado: mem0.ai/research, blog.getzep.com, agregadores 2026 — ver Fontes]`

Três razões para não adotar `[inferido]`:

1. **O benchmark é do problema errado.** LoCoMo e LongMemEval medem QA sobre conversas longas.
   Nenhum mede "o agente fechou a story com o eval passando". A ADE otimiza a segunda coisa.
2. **Os números estão em disputa entre os próprios vendedores** — hierarquia de fontes manda tratar
   como marketing até haver replicação independente.
3. **O ganho reivindicado (menos tokens por recuperação) a ADE já obtém** com excerpt por digest +
   Graft, sem serviço externo, sem embedding, sem novo modo de falha.

**YAGNI explícito na v1:** memória por usuário; embeddings ou RAG sobre a memória; grafo de memória;
qualquer serviço de memória externo; resumo automático de sessões passadas.

### 3.4 Decisão nova: desligar a auto memory do Claude Code nas sessões despachadas

A auto memory está **ligada por padrão**, escreve por repositório e é local à máquina.
`[verificado: code.claude.com/docs/en/memory]` Numa sessão despachada pela ADE isso significa: o
pack deixa de ser determinístico, a paridade de testes fica dependente do histórico da máquina, e
duas ADEs no mesmo repo divergem.

Recomendação: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (ou `--bare`) em toda sessão despachada; a memória
que conta é a da ADE, versionada e auditável. `[inferido]`

---

## 4. Telemetria

### 4.1 Esquema mínimo por chamada

Um registro por step `model_call`, anexado ao journal (que já é a fonte de verdade):

```
mission_id, story_id, step_id, call_id
family            claude | codex | gemini
model             string
role              maker | checker | classifier | evaluator | researcher
effort            low | medium | high | xhigh | max | unknown
started_at, duration_ms, ttft_ms
tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
cost_usd          number | "unknown"
cost_source       reported | estimated | unknown
pack_tokens_est, pack_bytes
pack_sections[]   { name, bytes }          // as 7 seções de §1.3
skills_injected[] { name, source, bytes }
tool_calls_count
tool_bytes_raw, tool_bytes_delivered, tdr
compaction_events, retries
outcome           ok | retry | rework | park | stop
eval_result       pass | fail | n/a
```

Agregação por story e por missão é derivada — nada de contador redundante no journal.

### 4.2 Mapa para OTel GenAI (e onde a convenção não cobre)

A família `gen_ai.*` migrou para repositório próprio; **todos os atributos e métricas estão marcados
"Development"**, não estáveis. `[verificado: github.com/open-telemetry/semantic-conventions-genai]`

| Campo da ADE | Convenção OTel | Situação |
| :--- | :--- | :--- |
| `tokens_in` / `tokens_out` | `gen_ai.client.token.usage` (Histogram, `{token}`), atributos obrigatórios `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.token.type` | Coberto |
| `tokens_cache_read` / `tokens_cache_write` | **nenhuma.** `gen_ai.token.type` só define os valores `input` e `output` | **Lacuna.** Usar atributo próprio `ade.token.cache ∈ {none, read, write}` junto de `gen_ai.token.type` mantém conformidade |
| `duration_ms` | `gen_ai.client.operation.duration` (Histogram, `s`) | Coberto |
| `ttft_ms` | `gen_ai.client.operation.time_to_first_chunk` | Coberto |
| story | `gen_ai.invoke_agent.duration` + `gen_ai.invoke_agent.inference_calls` + `gen_ai.invoke_agent.tool_calls`, com `gen_ai.agent.name` = papel | Coberto |
| missão/lote | `gen_ai.invoke_workflow.duration` | Coberto |
| ferramenta | `gen_ai.execute_tool.duration`, atributos `gen_ai.tool.name` (obrigatório), `gen_ai.tool.type`, `error.type` | Coberto |
| `cost_usd` | **nenhuma** | `ade.cost.usd` |
| `pack_tokens_est`, `skills_injected`, `tdr` | **nenhuma** | `ade.pack.tokens`, `ade.skill.name`, `ade.tool.output.ratio` |

`gen_ai.operation.name` tem valores bem conhecidos úteis para a ADE: `chat`, `invoke_agent`,
`invoke_workflow`, `execute_tool`, `plan`, `create_memory`, `search_memory`, `update_memory`.
`[verificado: idem]`

> **Recomendação:** congelar a versão da convenção no schema da ADE. `gen_ai.*` é Development e vai
> mudar. `[inferido]`

### 4.3 O que cada CLI já exporta — campos exatos

**Claude Code, saída headless** `[verificado: code.claude.com/docs/en/headless + agent-sdk/cost-tracking]`

`--output-format json` devolve, na mensagem `result`: `result`, `session_id`, `structured_output`
(com `--json-schema`), `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`,
`permission_denials`, `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`) e `modelUsage` por modelo (`costUSD`, `inputTokens`, `outputTokens`,
`cacheReadInputTokens`, `cacheCreationInputTokens`, `costBasis ∈ list|managed|unknown`).

Três armadilhas que a ADE precisa codificar `[verificado: agent-sdk/cost-tracking]`:

| Armadilha | Regra |
| :--- | :--- |
| `usage` no result **exclui subagentes**; `total_cost_usd` e `modelUsage` **incluem** | Contabilizar sempre por `modelUsage`, nunca por `usage` |
| `output_tokens` das mensagens `assistant` é **placeholder** (valor do `message_start`) | Ler output só do `result` |
| `total_cost_usd` é estimativa client-side a preço de tabela; multiplica por 1,1 quando `inference_geo: "us"` | Gravar `cost_source = estimated`; nunca tratar como fatura |
| Em `error_during_execution` após crash, todo campo de custo pode vir zerado | Recuperar somando o `usage` das mensagens assistant (só input/cache) |

Chamadas em `stream-json`: mensagens de subagente trazem `parent_tool_use_id` com o id do tool call
que as gerou (main = `null`) — é a chave de atribuição por subagente. `[verificado: headless]`

**Claude Code, OpenTelemetry** `[verificado: code.claude.com/docs/en/monitoring-usage]`

Habilitação: `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER`
(`otlp|prometheus|console|none`), `OTEL_EXPORTER_OTLP_PROTOCOL` / `_ENDPOINT` / `_HEADERS`,
`OTEL_METRIC_EXPORT_INTERVAL` (padrão 60000 ms), `OTEL_LOGS_EXPORT_INTERVAL` (5000 ms).
Traces são **beta**: exigem `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER`.

Métricas: `claude_code.session.count`, `claude_code.lines_of_code.count`,
`claude_code.pull_request.count`, `claude_code.commit.count`, `claude_code.cost.usage` (USD),
`claude_code.token.usage` (tokens), `claude_code.code_edit_tool.decision`,
`claude_code.active_time.total` (s).

O ponto de ouro para o harness doctor: `claude_code.token.usage` e `claude_code.cost.usage` carregam
os atributos `type` (`input` | `output` | `cacheRead` | `cacheCreation`), `model`, `query_source`
(`main` | `subagent` | `auxiliary`), `speed`, `effort`, **`agent.name`, `skill.name`, `plugin.name`,
`marketplace.name`, `mcp_server.name`, `mcp_tool.name`.** Ou seja: **custo por skill já vem de
fábrica.**

Eventos: `claude_code.user_prompt`, `claude_code.assistant_response`, `claude_code.tool_result`,
`claude_code.api_request`, `claude_code.api_error`. Campos relevantes:

- `claude_code.api_request`: `model`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`, `query_source`,
  `effort`, `agent.name`, `skill.name`, `mcp_tool.name`.
- `claude_code.tool_result`: `tool_name`, `tool_use_id`, `success`, `duration_ms`, `error_type`,
  **`tool_input_size_bytes`, `tool_result_size_bytes`**, `decision_type`, `decision_source`.

Controle de cardinalidade: `OTEL_METRICS_INCLUDE_SESSION_ID` (true), `_INCLUDE_VERSION` (false),
`_INCLUDE_ACCOUNT_UUID` (true), `_INCLUDE_ENTRYPOINT` (false), `_INCLUDE_REPOSITORY` (false).
Conteúdo redigido por padrão: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
`OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`; cap `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` (61440).

Spans beta: `claude_code.interaction` → `claude_code.llm_request` / `claude_code.hook` /
`claude_code.tool` → `claude_code.tool.blocked_on_user` / `claude_code.tool.execution`. O span de
LLM já emite `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.id`,
`gen_ai.response.finish_reasons`, além de `ttft_ms`, `input_tokens`, `cache_read_tokens`; o span de
ferramenta emite `gen_ai.tool.call.id`, `result_tokens`, `skill_name`, `subagent_type`.

**Codex** `[verificado: openai/codex codex-rs/otel/README.md; learn.chatgpt.com/docs/non-interactive-mode]`

- `codex exec --json` emite `thread.started` (com id), `turn.started`, `turn.completed`,
  `turn.failed`, `item.*` (`command_execution`, `agent_message`, `reasoning`, chamadas MCP, mudanças
  de arquivo, buscas web, atualizações de plano), `error`. O `turn.completed` traz
  **`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`**.
  **Não há campo de custo em USD, nem `total_tokens`.**
- OTel opt-in, configurado em `~/.codex/config.toml` sob `[otel]`. `OtelSettings` expõe
  `environment`, `service_name`, `service_version`, `codex_home`, `exporter`, `trace_exporter`,
  `metrics_exporter`, `runtime_metrics`, `span_attributes`, `tracestate`; exporters
  `OtlpHttp` (protocolo `Binary`/`Json`, TLS opcional), `OtlpGrpc`, `Statsig`, `None`.
  Eventos de sessão via `SessionTelemetry`; `log_user_prompts` é parâmetro dela.
- Nomes de métrica (`codex-rs/otel/src/metrics/names.rs`): `codex.turn.token_usage`,
  `codex.api_request`, `codex.tool.call`, `codex.turn.e2e_duration_ms`, `codex.turn.ttft.duration_ms`,
  `codex.guardian.review`, `codex.hooks.run`, `codex.startup.phase.duration_ms`, `codex.goal.created`.
  `[inferido: via DeepWiki citando os arquivos-fonte; não li o `names.rs` diretamente]`

**Gemini / Antigravity:** não verificado nesta rodada. Assumir `unknown` em custo e tokens até que o
`ade doctor` sonde o binário existente. `[hipótese]`

### 4.4 O que a ADE tem de inferir

| Item | Motivo |
| :--- | :--- |
| Custo em USD do Codex e do Gemini | Nenhum dos dois reporta. Tabela de preços própria na ADE, ou `cost_usd: "unknown"` (regra que o runtime v0.17.0 já aplica: teto em dólar só vale sobre chamadas cujo adapter reportou custo) `[verificado: RUNTIME.md]` |
| `pack_tokens_est` | Contagem local; para Claude, `/v1/messages/count_tokens` daria exato, mas a ADE não fala com a API |
| `tdr`, `tool_bytes_raw` | Só a ADE conhece o bruto; nenhuma CLI expõe |
| `skills_injected` por chamada | Claude Code entrega via atributo `skill.name`; Codex não. A ADE sabe o que injetou — grave na origem |
| Custo por story quando o agente usa subagentes | Somar `modelUsage`, não `usage` |

### 4.5 Recomendação de arquitetura de coleta

**Não construir collector.** O journal JSONL já é a fonte de verdade durável, com cadeia de hash e
reconstrução do índice SQLite. `[verificado: RUNTIME.md]` O OTel entra como exportação opcional
(`ade serve --otlp <endpoint>`), porque:

- o modo OTel do Claude Code exige env vars por sessão despachada e um collector de pé — dependência
  operacional que o operador "preguiçoso" da ADE não deve montar `[inferido]`;
- o painel lê do índice SQLite, não de um backend de métricas (decisão já fixada na spec §4);
- as métricas que importam para a ADE (pack, TDR, skills, eval) não existem em convenção nenhuma.

O que **vale** ligar por padrão nas sessões despachadas é apenas `--output-format json` (Claude) e
`--json` (Codex), que dão tokens e (no Claude) custo sem nenhuma infraestrutura. `[inferido]`

---

## 5. Harness doctor: métricas e protocolo de poda

### 5.1 Métricas por item do harness (regra, skill, bloco de prompt)

| Métrica | Cálculo | Fonte |
| :--- | :--- | :--- |
| Taxa de injeção | chamadas que incluíram o item / chamadas do papel | journal (`skills_injected`, `pack_sections`) |
| Custo de injeção | tokens do bloco × chamadas, separando cache write de read | journal; conferência por `claude_code.token.usage{skill.name}` |
| Taxa de citação | resultado da chamada referenciou o digest do item em `sources` | é o critério de "seção usada" do RA `[verificado: CONTEXT_POLICY.md]` |
| Correlação com resultado | pass rate do eval, nº de rodadas de rework, nota visual, com e sem o item | journal |
| Redundância | mesma instrução em dois arquivos do harness; sobreposição de n-gramas | análise estática |
| Obsolescência | o prompt cita flag, caminho ou versão inexistente | checável deterministicamente, sem modelo |

Três candidatos automáticos à poda: **skill com injeção > 0 e citação = 0** em ≥ N stories; **regra
que o modelo cumpre igual sem ela**; **prompt obsoleto** (verificável sem A/B). `[inferido]`

### 5.2 Protocolo de poda (adotar Caliper, não reimplementar)

O Caliper é exatamente a ferramenta desta função. `[verificado: github.com/edonadei/caliper]`

| Aspecto | Como funciona |
| :--- | :--- |
| Instalação do item | "Caliper nunca cola sua skill no prompt. Ele a instala onde o agente procura por skills e deixa o agente decidir" — logo a corrida mede **descrição** (dispara?) e **corpo** (funciona?) juntos |
| Protocolo | `caliper run spec.yaml` → `caliper run spec.yaml --ablate <skill>` → `caliper compare` |
| Métrica primária | success rate bruto (quantas vezes uma execução funciona) |
| Métricas secundárias | `pass@k` (≥1 sucesso em k, otimista) e `pass^k` (todas as k, estrito) |
| Contabilidade | por tentativa: input tokens, output tokens, cache read, cache creation, wall-clock; tentativas inutilizáveis (timeout, erro de infra, falha do juiz) contadas à parte para não distorcer a média |
| Spec | YAML com `skills:` (vizinhança, path ou git), `tasks:` (`expect`/`assert`/`activates`), `sandbox:`, `mcp:`; modelo e juiz são parâmetros de runtime (`--model`, `--judge-model`) |
| Backends | Claude Code, Codex, Pi, Hermes |

Regra de decisão proposta para a ADE: **remove se Δ success rate ≤ 0 dentro do ruído de k execuções
e Δ custo ≥ limiar.** Usar `pass^k` para itens de qualidade (design, segurança), onde "funciona às
vezes" não serve. Toda remoção vira ADR curto + commit revertível. `[inferido]`

### 5.3 Que evidência existe de que poda funciona

| Evidência | Classificação |
| :--- | :--- |
| Exemplo publicado no Caliper: uma skill commit-writer leva a tarefa de **33,3% → 100%** de sucesso, com **290K → 180K tokens** (−38%) e **1m01s → 42s** (−31%) | `[verificado: README do Caliper]` — mas é um exemplo do README, não estudo revisado |
| Medição local com/sem as quatro ferramentas de economia: cache lido −45% a −65%, custo −12%/empate, cache escrito +~4k por sessão | `[verificado: TOKEN_TOOLS.md, 2026-09-14]` — prova que **o custo fixo de regra é mensurável** |
| O próprio `/doctor` do Claude Code já propõe trims de `CLAUDE.md`: "corta o que o Claude pode derivar do código (layout de diretórios, listas de dependência, visões de arquitetura) e mantém armadilhas, racional e convenções que diferem dos padrões da ferramenta" | `[verificado: code.claude.com/docs/en/memory]` — é exatamente o critério "menos-é-mais" da spec §12, validado pelo fornecedor |
| `/usage` do Claude Code já atribui uso recente a skills, subagentes, plugins e servidores MCP individuais, e sinaliza comportamentos (long context, cache miss) que respondam por ≥10% do uso | `[verificado: code.claude.com/docs/en/costs]` |
| Alvo de tamanho do `CLAUDE.md`: **< 200 linhas**; "arquivos mais longos consomem mais contexto e reduzem a aderência"; imports com `@path` **não reduzem** contexto, só organizam | `[verificado: code.claude.com/docs/en/memory]` |
| Que a poda **melhore o resultado final** de forma sistemática | `[hipótese]` — nenhum estudo independente encontrado |

> **Recomendação de escopo contra a spec v2.** A spec põe "poda medida do harness (Caliper-style A/B
> + passe doctor a cada modelo novo)" no backlog v2. Puxe **só a coleta** para a v1: contadores de
> injeção, citação e custo por skill/regra no journal. Coleta sem execução é barata (é um campo no
> step); execução sem coleta é impossível. `[inferido]`

Referência de ordem de grandeza para o baseline do doctor `[verificado: code.claude.com/docs/en/context-window,
valores ilustrativos do simulador oficial]`: prompt de sistema ~4.200 tok, `CLAUDE.md` de projeto
~1.800, `~/.claude/CLAUDE.md` ~320, auto memory ~680, descrições de skills ~450, ferramentas MCP
diferidas ~120, info de ambiente ~280. O retorno de subagente ao contexto principal: ~420 tokens
para trabalho que consumiu milhares na janela isolada.

---

## 6. Surpresas e contradições com a spec v2 / com o prompt

1. **§12 "o padrão dos hooks de filtro" mistura dois mecanismos, e ambos são só do Claude Code.**
   `PreToolUse.updatedInput` reescreve o comando (é o exemplo oficial da Anthropic de filtro de
   teste); `PostToolUse.updatedResponse` substitui o resultado que o modelo vê. Nenhum existe nas
   três famílias. O firewall primário tem de morar no executor da ADE. `[verificado]`

2. **Codex não reporta custo em USD.** `codex exec --json` dá `input_tokens`, `cached_input_tokens`,
   `output_tokens`, `reasoning_output_tokens` e nada mais. A spec §13 dá ao Codex o papel de Checker
   padrão — logo a maior parte das revisões da ADE terá custo estimado ou `unknown`. `[verificado]`

3. **OTel GenAI não tem tipo de token para cache.** `gen_ai.token.type` só define `input` e `output`.
   Qualquer painel "compatível com OTel" que mostre cache read/write usa atributo fora da convenção
   — inclusive o do próprio Claude Code (`type: cacheRead|cacheCreation`). `[verificado]`

4. **§9 "corpo do SKILL.md entra no contexto como leitura" conflita com o cache.** Entrar como
   `tool_result` coloca a skill depois do prefixo estável e a torna candidata à limpeza automática
   de resultados de ferramenta. Skill deve ser bloco fixo do pack, em ordem estável por id.
   `[inferido a partir de verificados]`

5. **§12 "equivalente automático do `/clear`" não existe em headless.** O equivalente é processo novo
   sem `--resume`; para determinismo real, `--bare` (que pula hooks, skills, plugins, MCP, auto
   memory e `CLAUDE.md` do host, exigindo que a ADE passe as skills explicitamente). `[verificado]`

6. **A auto memory do Claude Code está ligada por padrão e escreve por repositório.** Quebra o
   determinismo do pack e a paridade de testes da ADE. Precisa de desligamento explícito.
   `[verificado]`

7. **§9 "a seleção lê só o índice, nunca os corpos" está certa, mas o índice também custa.** As
   descrições de skills já ocupam contexto no startup do Claude Code. Injetar o índice de centenas de
   skills no classificador anula o ganho: o classificador barato precisa de um índice **pré-filtrado
   por domínio**, não do índice inteiro. `[inferido]`

8. **A evidência para "sessão nova por tarefa" é convergente, não medida.** O artigo de harnesses da
   Anthropic descreve modos de falha, não publica comparação quantitativa. Não existe A/B público
   contra sessão longa com compactação. `[verificado: ausência]`

9. **O prompt lista Chisle e RTK como "técnicas de redução de saída"; a medição local disponível não
   isola cada uma.** A única medição A/B local mede as quatro ferramentas juntas (rtk, headroom,
   ponytail, caveman), e o próprio documento adverte que são "medições pontuais desse ambiente, não
   taxas transferíveis". `[verificado: TOKEN_TOOLS.md]`

---

## 7. Perguntas abertas

1. **Quanto do pack da ADE realmente cacheia?** A ADE controla o texto do prompt, mas o `claude -p`
   monta o system prompt e as definições de ferramenta por conta própria. O prefixo cacheável real é
   decidido pela CLI. Medir com a linha `Prompt cache (main)` do `/usage` (v2.1.251+), que reporta
   requisições, % de input vindo do cache, misses e causa provável.
2. **Gemini / Antigravity:** formato de saída estruturada, campos de uso e existência de custo — não
   verificados nesta rodada.
3. **`--bare` vale a pena?** Ganha determinismo, perde as skills do host; custo/benefício de passar
   tudo por `--plugin-dir` não medido.
4. **Qual a fronteira entre o firewall no executor e um proxy de compressão (headroom)?** O proxy
   comprime resultados já admitidos no histórico, antes de cada chamada — camada diferente do
   extrato. Vale na ADE ou é complexidade sem ganho, dado que a ADE já corta na origem?
5. **`compaction_events > 0` como defeito do plano:** qual o limiar de pack (tokens) acima do qual a
   ADE recusa a story e pede divisão? Proposta 40k, sem base empírica própria.
6. **Os nomes de métrica do Codex** (`codex.turn.token_usage` etc.) vieram de fonte secundária; falta
   ler `codex-rs/otel/src/metrics/names.rs` direto antes de codificar o parser.

---

## Fontes

**Documentação oficial Anthropic**

- Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Effective harnesses for long-running agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Memory tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Context editing — https://platform.claude.com/docs/en/build-with-claude/context-editing
- Compaction — https://platform.claude.com/docs/en/build-with-claude/compaction
- Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**Documentação oficial Claude Code** (acesso 2026-09-16)

- Manage costs effectively — https://code.claude.com/docs/en/costs
- Monitoring usage (OpenTelemetry) — https://code.claude.com/docs/en/monitoring-usage
- Hooks — https://code.claude.com/docs/en/hooks
- Explore the context window — https://code.claude.com/docs/en/context-window
- How Claude remembers your project (CLAUDE.md, auto memory) — https://code.claude.com/docs/en/memory
- Subagents — https://code.claude.com/docs/en/sub-agents
- Run Claude Code programmatically (headless) — https://code.claude.com/docs/en/headless
- Track cost and usage (Agent SDK) — https://code.claude.com/docs/en/agent-sdk/cost-tracking

**OpenAI Codex**

- `codex-rs/otel/README.md` — https://github.com/openai/codex/blob/main/codex-rs/otel/README.md
- `codex-rs/otel/src/config.rs` — https://github.com/openai/codex/blob/main/codex-rs/otel/src/config.rs
- Non-interactive mode (`codex exec --json`) — https://learn.chatgpt.com/docs/non-interactive-mode
- Observability and telemetry (DeepWiki, fonte secundária) — https://deepwiki.com/openai/codex/9.4-observability-and-telemetry

**OpenTelemetry**

- GenAI semantic conventions (repositório dedicado) — https://github.com/open-telemetry/semantic-conventions-genai
- `docs/gen-ai/gen-ai-metrics.md` — https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md

**Pesquisa e engenharia de terceiros**

- Manus — Context Engineering for AI Agents — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Chroma — Context Rot — https://www.trychroma.com/research/context-rot
- LangChain — Context Engineering for Agents — https://www.langchain.com/blog/context-engineering-for-agents
- Caliper — https://github.com/edonadei/caliper
- Mem0 research (LoCoMo, LongMemEval, BEAM) — https://mem0.ai/research
- Zep — contestação da metodologia do Mem0 — https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- Mem0 — State of AI Agent Memory 2026 — https://mem0.ai/blog/state-of-ai-agent-memory-2026

**Repositório de referência (local)**

- `E:\Documentos\ProjetosIA\tl-orchestrator-release\docs\CONTEXT_POLICY.md`
- `E:\Documentos\ProjetosIA\tl-orchestrator-release\docs\TOKEN_TOOLS.md`
- `E:\Documentos\ProjetosIA\tl-orchestrator-release\docs\RUNTIME.md`
