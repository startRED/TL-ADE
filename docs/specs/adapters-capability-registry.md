# Spec — Adapters e Capability Registry

Componentes C12 (Adapters) e C13 (Capability Registry) de `architecture.md §3`. Contratos em
`architecture.md §4`; transporte e Checker em `architecture.md §7`. ADRs: 0004 (transporte bespoke v1),
0005 (duas famílias v1, Maker ≠ Checker por `model_id`), 0006 (Checker por comando), 0012 (engine dono do
processo), 0015 (autonomia), 0017 (doctor coleta primeiro), 0022 (restrições Windows).

Escopo: interface do adapter, comando exato por papel e família, parser, CLI falsa, `CapabilitySet`,
`ade doctor`, tabela de roteamento, modelo de custo e caminho para ACP. Fora de escopo: montagem do pack
(C10), firewall (C11), conteúdo dos prompts de papel.

## 1. Princípio: casca fina

O adapter não decide nada. Ele recebe uma `CallSpec` já resolvida pelo engine (papel, modelo, effort,
orçamento, caminhos, nível de autonomia) e devolve um `CallResult` normalizado. Toda escolha — qual
família, qual modelo, quais flags de autonomia — é do Capability Registry e do roteador, antes do
`spawn`. Isso mantém três arquivos de adapter na casa de 150–250 linhas cada e concentra o teste na
tabela, não no código.

```ts
type Role = 'maker' | 'checker_round' | 'checker_gate' | 'classifier'
          | 'intent_compiler' | 'judge' | 'research'

interface CallSpec {
  role: Role
  family: 'claude' | 'codex' | 'agy'
  model: string                       // id explícito, sempre; nunca default da CLI
  effort?: string                     // string opaca validada contra o CapabilitySet
  cwd: string                         // worktree da story
  packPath: string                    // sempre caminho, nunca texto (digest #31)
  schema?: { name: string; json: string; path: string }  // inline OU arquivo, por família
  sessionId?: string                  // pré-cunhado só onde a família aceita
  resume?: { sessionRef: string; fork: boolean }
  imagePaths?: string[]
  addDirs?: string[]
  budget: { maxUsd?: number; maxTurns?: number; timeoutMs: number }
  autonomy: 'safe' | 'controlled' | 'restricted'
  env: Record<string, string>         // env explícito e filtrado (I49); nunca process.env
}

interface CallResult {
  ok: boolean
  exitCode: number
  sessionRef: string | null           // null quando a família não publica id
  structured: unknown | null          // saída coagida por schema, já parseada
  text: string | null                 // última mensagem do agente
  usage: Usage                        // ver §5
  cost: { usd: number | null; source: 'reported' | 'estimated' | 'unknown' }
  denials: unknown[]                  // permission_denials | denied_actions | []
  rawPath: string                     // stdout/stderr brutos em artifacts/ (C11)
  unknownFields: string[]             // campos não reconhecidos, para o journal
  failure?: 'no_result' | 'schema_invalid' | 'timeout' | 'truncated' | 'transport'
}

interface AgentAdapter {
  readonly caps: CapabilitySet
  argv(spec: CallSpec): { file: string; args: string[]; stdin?: string; env: Record<string,string> }
  parse(rawStdout: string, rawStderr: string, exitCode: number): CallResult
  cost(usage: Usage, model: string): CallResult['cost']
}
```

`argv()` é pura e testável sem processo: a suíte compara argv esperado por papel × família × nível de
autonomia. `parse()` é pura sobre bytes. Quem faz `spawn`, mata (`taskkill /T /F /PID`), grava recibo e
reconcilia é o Runner (C5), não o adapter — ADR 0012.

## 2. Comando exato por papel — família `claude`

Claude Code 2.1.271 (`capabilities-claude-code.md` §1, §3, §4, §7). Invariantes de argv, os três valendo
sempre:

1. O prompt posicional vem **imediatamente após `-p`**, antes de qualquer flag variádica
   (`--allowedTools`, `--disallowedTools`, `--tools`, `--mcp-config`, `--plugin-url`, `--channels`,
   `--file`), que engoliriam o prompt como mais um valor (`capabilities-claude-code.md` §1).
2. `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` em toda chamada; nunca `--bare`, que força
   `ANTHROPIC_API_KEY` e quebra a assinatura (digest #9). `--safe-mode` nomeia CLAUDE.md, skills,
   plugins, hooks e MCP, mas **não** nomeia auto memory: a env var é a única chave medida que a desliga
   sem `--bare` — [hipótese] que a combinação seja redundante.
3. Orçamento nativo (`--max-budget-usd`, `--max-turns`) só existe com `-p` e é **teto secundário**: o
   teto real é o kill do engine (C5).

| Papel | Comando (partes que mudam por papel em **negrito**) |
| :--- | :--- |
| Maker | `claude -p "<prompt+{pack_path}>" --output-format json --model **sonnet** --effort **high** --session-id <uuid> --max-budget-usd <n> --max-turns <n> --safe-mode --permission-mode **bypassPermissions** --permission-prompts none --add-dir <worktree> --disallowedTools "Bash(git *)" "Bash(gh *)"` |
| Checker de rodada (fallback 1) | idem, mas `--json-schema '<review-result inline>' --model **opus** --permission-mode **plan** --tools ""` e **sem** `--session-id` reutilizado do Maker |
| Checker de portão | `claude -p "<prompt>" --output-format json --json-schema '<review-result inline>' --model **opus** --safe-mode --permission-mode **plan** --permission-prompts none --add-dir <worktree>` |
| Classificador | `claude -p "<prompt>" --output-format json --json-schema '<classify inline>' --model **haiku** --safe-mode --tools "" --max-turns 1 --max-budget-usd 0.05` |
| Intent Compiler | `claude -p "<prompt>" --output-format json --json-schema '<plan inline>' --model **opus[1m]** --effort **xhigh** --safe-mode --tools "" --max-budget-usd <n>` |
| Juiz visual | `claude -p "<prompt com caminho de cada screenshot>" --output-format json --json-schema '<visual-eval inline>' --model **opus** --safe-mode --tools "Read" --add-dir <artifacts>` |
| Pesquisa (fallback do `agy`) | `claude -p "<pergunta>" --output-format json --json-schema '<research-finding inline>' --model **sonnet[1m]** --safe-mode --tools "WebSearch" "WebFetch"` |

Detalhes que o adapter precisa carregar:

- **`--disallowedTools` tem espaço antes do `*`**: `Bash(git *)` casa `git push`; `Bash(git*)` casaria
  também `git-upload-pack` e qualquer programa com esse prefixo (`capabilities-claude-code.md` §4). A
  lista aceita separação por vírgula ou espaço; o adapter emite por espaço, um argumento por regra. É
  best-effort: a cerca real é o `env` filtrado e o engine ser o único a rodar `git`/`gh`
  (`architecture.md §7`).
- **Imagem entra por caminho de arquivo no texto do prompt.** Não existe `--image`
  (`capabilities-claude-code.md` §6). Por isso o juiz visual precisa de `--tools "Read"`: com
  `--tools ""` o modelo vê o caminho e não consegue abrir o arquivo.
- **`--advisor <fable|opus|sonnet|id>`** existe (digest #4) e é alavanca de custo opcional do Maker,
  desligada por padrão. Como o custo aparece em `modelUsage` por id de modelo, um advisor deveria
  produzir uma segunda chave — **[hipótese]**, não medida; ligar só sob telemetria.
- **Retomada e takeover**: `--resume <uuid>` funciona de qualquer diretório e a sessão criada em `-p` é
  retomável só por id (não aparece no picker nem em `--continue`). `--resume` **não** restaura
  `--add-dir`, `--settings`, `--mcp-config` nem modo de permissão — `ade takeover` imprime o comando com
  esses argumentos repetidos (`capabilities-claude-code.md` §2). `--fork-session` só é usado para
  reexecutar uma rodada sem contaminar a sessão original (ablação do harness doctor).
- **`--effort`** aceita `low|medium|high|xhigh|max` e ainda `ultracode` (aceito, ausente da lista do
  help; equivale a `xhigh` + workflows dinâmicos, `capabilities-claude-code.md` §3). `ultracode` não é
  default de nenhum papel na v1: orquestra agentes fora do controle do scheduler (C14).

## 3. Comando exato por papel — família `codex`

Codex CLI 0.154.0 (`capabilities-codex.md` §1, §3, §4, §7). Invariantes:

1. Prompt sempre por **stdin** com `codex exec -`, nunca em argv: evita o teto de 32.767 caracteres de
   `lpCommandLine` e o `{pack_path}` continua valendo para o pack (digest #31).
2. Schema é **arquivo** (`--output-schema <file>`), não inline. O resultado final vai também para
   `-o <file>`; o parser lê o arquivo, não extrai do JSONL (`addendum-checker-contract-review-result.md`
   §6.1).
3. Nunca `codex review` (sem `--json`/`--output-schema`) e nunca `codex exec review` para o papel de
   Checker: `--output-schema` é ignorado em silêncio ali (digest #6, ADR 0019). Nunca `--full-auto`
   (não existe no binário, digest #7). Nunca `--ephemeral` em story que possa virar takeover.

| Papel | Comando |
| :--- | :--- |
| Maker | `codex exec - --json --sandbox workspace-write --approve-for-me -C <worktree> --add-dir <artifacts> --skip-git-repo-check -m gpt-5.6-sol -c model_reasoning_effort="high" -o <jobs>/<step>.last.txt` |
| Checker de rodada (primário) | `codex exec - --json --sandbox read-only --ignore-user-config --skip-git-repo-check -C <worktree> --output-schema <state>/schemas/review-result.schema.json -o <state>/results/<step>.review.json -m gpt-5.6-terra` |
| Checker de portão (fallback 1) | idem com `-m gpt-5.6-sol` e `-c model_reasoning_effort="high"` |
| Classificador | `codex exec - --json --sandbox read-only --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --output-schema <state>/schemas/classify.schema.json -m gpt-5.6-luna -c model_reasoning_effort="low"` |
| Intent Compiler (fallback 1) | `codex exec - --json --sandbox read-only --ignore-user-config -C <repo> --output-schema <state>/schemas/plan.schema.json -m gpt-6-astra -c model_reasoning_effort="xhigh"` |
| Juiz visual | `codex exec - --json --sandbox read-only -C <artifacts> --skip-git-repo-check -i <shot-1280-light.png> -i <shot-390-dark.png> --output-schema <state>/schemas/visual-eval.schema.json -m gpt-5.6-sol` |
| Asset (`$imagegen`) | `codex exec "$imagegen <descrição>" --json --sandbox workspace-write --skip-git-repo-check -C <assets>` com **stdin fechado** (senão pendura, digest #20) |

Notas:

- **Sem `-a/--ask-for-approval` em `exec`**; o equivalente é `--approve-for-me`, que roteia aprovações
  por revisão automática dentro do sandbox `workspace-write` (digest #37). O portão é o sandbox de SO,
  que no Windows é nativo (`elevated`/`unelevated`), não um prompt.
- **`thread_id` nasce no processo**, no evento `thread.started`. Não há `--session-id`: o `step_intent`
  do journal grava `session_ref: null` e o `step_result` grava o id lido do primeiro evento. A correlação
  write-ahead para Codex depende do recibo durável em `<state>/jobs/<step>.json` (`architecture.md §6`),
  não do id.
- **Retomada**: `codex exec resume <thread_id> [prompt]` / `codex exec fork <thread_id>`; takeover
  interativo por `codex resume <thread_id> --include-non-interactive`.
- **Effort** é string opaca em `-c model_reasoning_effort="<v>"`, validada contra
  `codex debug models --bundled` e degradada para `high` se recusada: o catálogo do binário aceita
  `max`/`ultra` que a Configuration Reference não lista (`capabilities-codex.md` §3.2).
- **`--color never`** em toda chamada: o progresso vai para stderr e pode carregar ANSI.

## 4. Comando exato por papel — família `agy` (v0.5, pesquisa e fallback de Checker)

Antigravity CLI 1.2.4 (`capabilities-gemini-antigravity.md` §2.3, `addendum-gemini-family-viability.md`
§1–§7). Não existe binário `antigravity`; o Gemini CLI não faz parte da ADE (digest #2).

| Papel | Comando |
| :--- | :--- |
| Pesquisa | `agy -p "<pergunta>" --output-format json --json-schema <state>/schemas/research-finding.schema.json --model gemini-3.8-flash-high --effort high --add-dir <readonly> --dangerously-skip-permissions --print-timeout 4m` |
| Checker de rodada (fallback 2) | `agy -p "<prompt>" --output-format json --json-schema <…>/review-result.schema.json --model claude-sonnet-4-6 --add-dir <worktree>` — **sem** `--dangerously-skip-permissions` |

Regras específicas, todas medidas:

- **`--model` explícito em toda chamada, sem exceção.** `agy` serve `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking` e `gpt-oss-120b-medium` além dos Gemini (digest #3, confirmado por
  autoidentificação do modelo em `addendum-gemini-family-viability.md` §6). Nenhum evento reporta o
  modelo **efetivo** quando ele diverge do pedido: `request.model` é contrato, não observação.
- **Ler `structured_output`, nunca `response`.** `--json-schema` coage de verdade — com prompt mandando
  desobedecer, `structured_output` continuou conforme (§2 do mesmo addendum). `json_schema` volta ecoado
  e é gravado como evidência.
- **`--print-timeout` devolve exit 0, `status: "SUCCESS"` e corpo possivelmente vazio**; o aviso só sai
  em stderr. O parser marca `failure: 'timeout'` comparando `duration_seconds` com o timeout pedido
  **e** procurando a linha `[agy] print timeout` em stderr — nunca pelo `status`.
- **`--add-dir` não é fronteira.** O `agy` escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do
  diretório pedido, sem aviso (digest #38). Por isso o papel na v0.5 é somente-leitura e o canário de
  isolamento (§7) é pré-requisito de qualquer papel que escreva.
- **`conversation_id` nasce no processo** (evento `init` em `stream-json`, ou só no resultado em `json`):
  `preminted_session_id: false`, igual ao Codex.
- **`--input-format stream-json`** (NDJSON no stdin, um turno por linha, exige
  `--output-format stream-json`) é o caminho para multi-turno sem relançar processo. Não usado na v1.

## 5. Parser e forma do resultado por família

Regra única: **parser tolerante a campos desconhecidos**. Nenhum schema fechado na entrada; todo campo
não reconhecido vai para `unknownFields` e é gravado no journal, nunca descartado em silêncio. O motivo
é medido: `cache_write_input_tokens` existe no binário do Codex e não na doc (`capabilities-codex.md`
§1.3), e `structured_output`/`json_schema` do `agy` não aparecem em nenhuma referência de campo.

| Conceito | `claude` (`--output-format json`) | `codex` (`--json`, JSONL) | `agy` (`--output-format json`) |
| :--- | :--- | :--- | :--- |
| Id de sessão | `session_id` (= `--session-id` pré-cunhado) | `thread.started.thread_id` | `conversation_id` |
| Texto final | `result` | `item.completed` com `item.type = "agent_message"`, ou o arquivo de `-o` | `response` |
| Saída por schema | `structured_output` | arquivo de `-o` validado contra `--output-schema` | `structured_output` (+ `json_schema` ecoado) |
| Tokens | `usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`, `usage.output_tokens_details.thinking_tokens` | `turn.completed.usage.{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}` | `usage.{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}` |
| Custo | `total_cost_usd` + `modelUsage.<id>.{costUSD,costBasis,canonicalModel,contextWindow}` | **ausente** | **ausente** |
| Negações | `permission_denials[]` | — (sandbox nega com erro de acesso) | `denied_actions[]` |
| Erro estruturado | `subtype: "error_during_execution"` + `errors[]`; `system/api_retry` no stream com `error` categorizado | `turn.failed`, `error` | `status` + stderr |
| Janela real | `modelUsage.<id>.contextWindow` (fonte operacional; a tabela da doc diverge para haiku) | 272.000 em todos os slugs | **não publicada, não verificável** |

Fontes: `capabilities-claude-code.md` §7 (JSON medido), `capabilities-codex.md` §7 e §1.3 (JSONL
medido), `addendum-gemini-family-viability.md` §1 e §8.

Três regras que caem direto do medido:

1. **O relato do agente nunca conta.** Um `claude -p` reporta sucesso depois de ferramenta bloqueada
   (`addendum-autonomia-permissoes-por-repositorio.md` §2.3). `ok: true` do adapter significa "o
   transporte entregou um resultado", não "a story funcionou": quem decide é `eval_run` (C9).
2. **`agy` tem contabilidade inconsistente**: `cache_read_tokens` (1.274.731) maior que `total_tokens`
   (279.498) na mesma resposta. O adapter grava bruto e marca `cost.source: 'unknown'`; nunca soma esses
   campos entre chamadas (`addendum-gemini-family-viability.md` §7).
3. **Schema recusado por `ajv` é classe `harness`**, mesmo bucket de `no_result` — nunca `semantic`. Não
   gera `rework`; gera retry do transporte e, esgotado, `parked`.

## 6. CLI falsa por família

Objetivo: a matriz de crash × fase e a paridade 93/93 rodam sem credencial, sem rede e sem custo — o que
J1 §5 aponta como o buraco de todas as propostas do painel ("não existe história de CI sem credencial de
CLI"). Porte direto de `scripts/fixtures/runtime/fake_harness.py` do runtime de referência, com três
adições.

**Forma.** Um script Node por família, apontado pelo `launch.cmd` do `CapabilitySet` sobrescrito em teste.
Cada cenário é um diretório com `<role>.json` (lista de ações), `<role>.count` (contador **em disco**, não
em memória — é o que faz uma retomada do engine ver a mesma sequência que um binário real veria) e os
transcripts. Por chamada o fake grava `<role>-<i>.pack.md`, `<role>-<i>.env.json` e `<role>-<i>.argv.json`
antes de qualquer outra coisa: é assim que se prova que o pack chegou íntegro, que o `env` foi filtrado
(I49) e que o argv do papel é o da tabela §2–§4.

**Fixture é transcript gravado de sessão real, nunca tela lembrada.** Cada `transcripts/<família>/*.txt`
é bytes capturados de uma execução autorizada e commitados; o fake os escreve em stdout/stderr sem
reformatar. Conjunto mínimo obrigatório por família:

| Cenário | claude | codex | agy |
| :--- | :--- | :--- | :--- |
| sucesso com custo | JSON medido em `capabilities-claude-code.md` §7 | JSONL de 4 linhas de `capabilities-codex.md` §1.3 | JSON de `addendum-gemini-family-viability.md` §1 |
| sucesso por schema | `structured_output` presente | arquivo de `-o` + JSONL | `structured_output` + `json_schema` ecoado |
| `no_result` | exit 0 sem `result` | exit 0 sem `turn.completed` | exit 0 com `response: ""` |
| truncada | JSON cortado no meio de `usage` | JSONL com última linha parcial | idem |
| sem custo | — | `turn.completed` sem qualquer campo USD | `usage` com `cache_read_tokens > total_tokens` |
| negação | `permission_denials` não vazio | erro de acesso do sandbox em stderr | `denied_actions` não vazio |
| ANSI | — | progresso com escapes em stderr | — |
| campo novo | chave inédita em `usage` | `cache_write_input_tokens` | chave inédita em `usage` |
| retentável | `system/api_retry` com `error: rate_limit` | `turn.failed` | timeout com aviso só em stderr |

Ações suportadas pelo fake (superset do runtime de referência): `files`/`delete` (escrita na árvore, para
exercitar `contain` e o canário), `argv` (subprocesso, para a matriz de crash), `sleep`, `stdout`/`stderr`
por transcript, `crash` com `exit`, `no_result`, e `escape` (escrever fora do `cwd`, para provar que o
canário de isolamento pega).

## 7. `CapabilitySet` e `ade doctor`

O `CapabilitySet` (`architecture.md §4`, `schemas/capability-set.schema.json`) é **medido, nunca escrito à
mão**. Um por família em `~/.ade/capabilities.json`. Valores v1:

| Chave | `claude` | `codex` | `agy` |
| :--- | :--- | :--- | :--- |
| `transport` | `cli` | `cli` | `cli` |
| `preminted_session_id` | **true** (`--session-id`) | false | false |
| `structured_output` | `schema_inline` | `schema_file` | `schema_file` (aceita string também) |
| `budget_cap_native` | **true** (`--max-budget-usd`, `--max-turns`) | false | false |
| `resume` | `reconnect` | `reconnect` | `reconnect` |
| `fork` | true | true | false |
| `sandbox` | `none` (SO indisponível no Windows nativo) | `restricted_token` | `none` |
| `tools_allowlist` | true | false (é sandbox + `.rules`) | false |
| `image_in` / `image_out` | true / false | true (`-i`) / **true** (`$imagegen`) | true / false |
| `cost_report` | `usd` | `tokens` | `tokens` |
| `advisor` | true | false (subagentes) | false |
| `unattended_flags` | `--permission-mode bypassPermissions`, `--permission-prompts none` | `--sandbox workspace-write`, `--approve-for-me` | `--dangerously-skip-permissions` (ver §11, D1) |

**`ade doctor`, na ordem.** Cada passo grava evento no journal; a v1 só coleta e relata (ADR 0017).

1. **Resolução de binário atrás dos shims.** `claude` no PATH é um shim `sh` (há ainda `.cmd` e `.ps1`);
   resolver o `.exe` real e gravá-lo em `launch.cmd`. `spawn(..., {shell:false})` só com `.exe`; `.cmd`
   apenas via `cmd.exe /c` — `spawn('npx.cmd')` sem shell falha com `EINVAL` no Node 24/Windows
   (digest #30). `codex.exe` e `agy.EXE` são nativos e não precisam de shim.
2. **Versão a cada lote, nunca cacheada.** O `agy` auto-atualizou de 1.2.3 para 1.2.4 entre duas sessões
   de pesquisa, sem ação do usuário (`addendum-gemini-family-viability.md` §0).
3. **Sonda de flag a custo zero.** `claude -p <flag>` sem valor distingue `argument missing` (existe) de
   `unknown option` (não existe); `codex exec --help` e `agy --help` são parseados. Falha aqui derruba o
   nível de autonomia que depende da flag — se `--approve-for-me` sumir, `controlled` deixa de ser
   oferecido em vez de rodar sem rede.
4. **Catálogo de modelos.** `codex debug models --bundled`, `agy models`; para `claude`, a tabela de
   aliases mais `modelUsage.<id>.contextWindow` lido em runtime.
5. **Sonda com chamada real, com custo.** Uma por família: prompt trivial com schema, `--max-budget-usd`
   apertado onde existe. Grava `probe_ok`, `probed_at` e o `cost_usd` da própria sonda como `model_call`
   no journal. É a única forma de provar `--json-schema`/`--output-schema` de ponta a ponta — e é a
   razão de a sonda real ser opt-in (`--probe-real`), com TTL de 7 dias e nunca em CI.
6. **Canário de isolamento por família.** Pedir ao modelo, dentro de um worktree descartável, que escreva
   `../canary-<uuid>.txt`; o engine compara antes/depois um conjunto fixo de alvos (raiz do repo fora do
   worktree, `~/.claude`, `$CODEX_HOME`, `~/.gemini/antigravity-cli/`) e recusa a família para papéis de
   escrita se qualquer um mudou. Existe porque o `agy` já falhou esse teste (digest #38) e porque nenhuma
   CLI prova, de fora, que seu sandbox estava ativo numa chamada específica
   (`addendum-autonomia-permissoes-por-repositorio.md` §6).
7. **Windows.** `core.longpaths=true`; folga de MAX_PATH para `.ade/wt/<story>` com `node_modules`;
   orçamento de argv (soma dos bytes do argv ≤ 30.000, com o schema inline do Claude contado) contra os
   32.767 de `lpCommandLine`.
8. **Impeccable.** Versão pela `ENGINE_VERSION` do detector instalado, nunca por versão npm — `npx
   impeccable@4.3.1` não existe no npm público (digest #19).

## 8. Roteamento por papel

Primário + 2 fallbacks; `ade doctor` marca família indisponível e o roteador desce a linha preservando
Maker ≠ Checker. Nenhuma família de Checker disponível ⇒ `no_checker_family_available` ⇒ `parked`; nunca
aprovado sem revisão (`architecture.md §7`).

| Papel | Primário | Fallback 1 | Fallback 2 | Evidência |
| :--- | :--- | :--- | :--- | :--- |
| Intent Compiler | claude `opus[1m]` | codex `gpt-6-astra` | — | sem benchmark discriminante; escolha por `--json-schema` + orçamento nativo **[hipótese]** |
| Classificador | claude `haiku` | codex `gpt-5.6-luna` | — | custo a medir por chamada, não assumir (digest #26) **[hipótese]** |
| Maker | claude `sonnet` (`opus` em `subsystem`+) | codex `gpt-5.6-sol` | — | SWE-bench empatado no topo (~1 pt) não discrimina; escolha por ferramental **[hipótese]** |
| Checker de rodada | codex `gpt-5.6-terra` | claude `opus` | agy `claude-opus-4-6-thinking` | CR-bench (arXiv 2603.23448v3, 184 PRs): Codex 88 % de utilidade manual — falso positivo custa uma rodada inteira de Maker, precisão pesa mais |
| Checker de portão | claude `opus` | codex `gpt-5.6-sol` | — | CR-bench: Claude Code 32,1 % de pass rate vs Codex 20,1 % — cobertura pesa mais na última chance |
| Juiz visual | família ≠ da do Maker, melhor multimodal | a outra das duas | — | regra de anti-ancoragem de `architecture.md §7`; MLLM-as-UI-judge alinha só parcialmente **[hipótese]** |
| Pesquisa | agy `gemini-3.8-flash-high` (v0.5) | claude `sonnet[1m]` | codex `gpt-5.6-terra` | `--json-schema` do `agy` coage mesmo sob instrução de desobedecer (medido); preço/contexto **[hipótese]** |
| Asset | codex `$imagegen` | — | — | único com geração embutida, testado headless (digest #20) |
| Portão extra opcional | `claude ultrareview --json` | — | — | multi-agente oficial; cota de 3 grátis e 5–10 min o tiram do caminho automático |

**Maker ≠ Checker por `model_id`.** Antes de despachar qualquer papel de Checker, o engine resolve
`(family, model_id)` e recusa o despacho se o `model_id` for igual ao do último `model_call` do Maker da
mesma unidade — independentemente do binário. É o que permite o Checker de portão usar a mesma família do
Maker (`opus` contra `sonnet`) e o que torna o `agy` utilizável como Checker sem virar autorrevisão:
`familyOf(run) := familyOfModel(request.model)`, com `claude-*` → anthropic, `gpt-*` → openai, `gemini-*`
→ google (`addendum-gemini-family-viability.md` §6). Ver §11 D4.

**`~/.ade/routing.jsonl`.** Uma linha por chamada de papel: `{ts, repo, mission, story, role, family,
model, effort, domains, size, outcome, gate_evidence, rework_rounds, wall_ms, usd, tokens,
false_positive}`. `false_positive` é derivado, não anotado: um achado do Checker é falso positivo quando
o `rework` que ele causou termina com a árvore revertida ao checkpoint sem mudança de eval. A regra de
troca é determinística — n ≥ 20 por par `(role, domain, size)`, delta de `success_rate` ≥ 0,10 com
intervalos de Wilson a 95 % disjuntos, desempate por `usd_per_success`, e regra extra para Checker
(`fp_rate` do primário > 0,30 e do fallback < 0,20). **Na v1 a ADE sugere e não aplica**: `ade doctor
--routing` imprime as sugestões com os números; a troca é um comando do operador e grava
`routing_default_changed` no journal, com os números que a justificaram.

## 9. Modelo de custo

`cost_source` é campo do evento `telemetry` (`architecture.md §4`) e tem três valores:

- **`reported`** — só `claude`: `total_cost_usd` e `modelUsage.<id>.costUSD`. Ainda assim é estimativa a
  preço de tabela (`costBasis: "list"`), não fatura.
- **`estimated`** — `codex` e `agy`: tokens × `~/.ade/prices.json`, uma tabela
  `{<model_id>: {input, output, cache_read, cache_write, currency, source, as_of}}` mantida à mão,
  versionada, com `as_of` exibido no resumo de aprovação. Nenhuma das duas CLIs publica USD.
- **`unknown`** — quando o `usage` não fecha. É o caso padrão do `agy` enquanto a anomalia
  `cache_read_tokens > total_tokens` não for explicada.

Dois pisos que o orçamento tem de reservar antes de prometer custo ao operador:

1. **Codex: ~19,4 k tokens de entrada por chamada headless** (instruções de sistema + AGENTS.md +
   catálogo de skills), medidos num prompt trivial (`capabilities-codex.md` §1.3). Isso é piso, não
   média.
2. **Claude: o alias barato não garante chamada barata.** `claude -p --model haiku` faturou como
   `claude-sonnet-5`, US$ 0,37 para ecoar 200 bytes (digest #26); numa segunda medição, US$ 0,06284 com
   `cache_creation_input_tokens = 31.145` porque o CLAUDE.md do usuário entrou no contexto mesmo com
   `--tools ""` (`capabilities-claude-code.md` §7). Regra: o custo do classificador vem de
   `modelUsage.<id>.costUSD` lido por chamada, nunca do alias pedido; se a chave de `modelUsage` diferir
   do modelo pedido, o adapter grava `model_billed != model_requested` como flag de telemetria. O custo
   com `--safe-mode` **não foi medido** — **[hipótese]** de que caia para a ordem de centavos.

## 10. Caminho de migração para ACP

A v1 é bespoke porque três garantias do write-ahead não existem no ACP v1 (ADR 0004): id de sessão
pré-cunhado, saída por schema e teto de orçamento a priori. O `CapabilitySet` já carrega `transport` e o
evento já carrega `session_ref: string | null`, então a migração é por família e reversível.

| Família | O que muda | `session_ref` | Custo | Gatilho |
| :--- | :--- | :--- | :--- | :--- |
| `claude` | `launch` vira `npx @agentclientprotocol/claude-agent-acp` (com `shell:true` ou `cmd.exe /c` no Windows); `parse()` vira mapeador `session/update`; `--json-schema` **não** migra | passa a `null` — `session/new` não aceita id do cliente | **ganha USD**: `usage_update.cost` medido (`0.52761`) | `_meta.steering.supported: true` já é true; falta `session/inject` estável (PR #1261) |
| `codex` | idem com `@agentclientprotocol/codex-acp`; modos viram `read-only\|agent\|agent-full-access` | já era `null` | continua `unknown`: nenhum `usage_update` trouxe `cost` | idem |
| `agy` | binário separado `agy_acp_server` (Python, 468 MB por plataforma, sem sha256 no registry), config própria em `~/.gemini/antigravity-acp/` | `null` | não medido | nenhum na v1; download desproporcional |

Em todos os casos, o que **não** migra fica bespoke por exceção nomeada: structured output (ausente do
schema ACP v1, não é limitação de adapter) e cunhagem de `sessionId`
(`addendum-adapter-transport-acp-vs-cli.md` §0, §3.1, §4). Consequência prática: os papéis de Intent
Compiler, Checker, classificador, juiz e pesquisa continuam em CLI mesmo depois de o Maker migrar. O
`contain` continua do cliente — migrar para ACP não terceiriza nenhuma das lacunas de isolamento.

**4º provider.** OpenCode (MIT, ACP nativo, `provider/model` como id, custo em USD real, permissões
`allow|ask|deny` com glob) é o candidato, e exige chave própria: os plugins de assinatura Claude foram
removidos a partir da 1.3.0. Por isso é **opt-in com chave**, ligado só por `~/.ade/config.json`, nunca na
tabela de roteamento padrão, e o resumo de aprovação nomeia que a chamada usa credencial do operador.

## 11. Divergências propostas

**D1 — `agy` não tem `--approval-mode yolo`.** `architecture.md §7` e digest #37 atribuem
`--approval-mode yolo` ao `agy`. `agy --help` (1.2.3 e 1.2.4) lista `--dangerously-skip-permissions` e
`--mode accept-edits|plan`; `--approval-mode {default|auto_edit|yolo|plan}` aparece em `gemini --help`
0.59.0, que não faz parte da ADE (`capabilities-gemini-antigravity.md` §2.1 vs §2.3). A chamada real de
pesquisa em `addendum-gemini-family-viability.md` §9 usa `--dangerously-skip-permissions`. Proposta:
corrigir o texto da arquitetura. Custo: uma linha.

**D2 — `runtime_stamp` não cobre upgrade silencioso de CLI.** `architecture.md §6` define
`runtime_stamp = <versão do engine>:<digest da config>`. O `agy` se auto-atualiza sem ação do usuário
(1.2.3 → 1.2.4 entre sessões) e nada impede o mesmo com `claude`/`codex` via npm. Uma missão retomada
depois de um upgrade de CLI roda com capacidades diferentes e **não** dispara `stale_workflow_version`.
Proposta: incluir o digest do `~/.ade/capabilities.json` no `runtime_stamp`. Custo: um `sha256` que o
doctor já calcula; nenhum campo novo no schema.

**D3 — `probe_ok: boolean` não sobrevive ao CI.** A paridade 93/93 nos dois SOs (v0.2) roda em Linux sem
credencial de CLI, e as sondas reais do doctor custam dinheiro e exigem assinatura — buraco apontado em
`design-panel/judgment-J1-implementability.md` §5 item 4. Com um booleano, `probe_ok: false` em CI é
indistinguível de "binário quebrado". Proposta aditiva ao `capability-set.schema.json`:
`probe_mode: 'real' | 'help_only' | 'fixture'`, e `ade doctor --offline` (passos 1–4 e 7 do §7, sem
chamada paga) como default em CI. Mantém os 8 schemas publicados.

**D4 — `model_id` não basta quando o `agy` serve modelos Claude.** A regra de ADR 0005 recusa o despacho
quando `model_id` do Checker == `model_id` do Maker. Maker `claude` com `claude-sonnet-5` e Checker `agy`
com `claude-sonnet-4-6` passam pela regra sendo o mesmo vendor e a mesma linha de modelo — ponto cego
correlacionado, exatamente o risco que digest #3 levanta. Proposta: `CapabilitySet.models[]` ganha
`vendor` derivado por prefixo (`claude-*`→anthropic, `gpt-*`→openai, `gemini-*`→google), gravado no
journal; a regra segue por `model_id` na v1, mas o **Checker de rodada** recusa adicionalmente vendor
igual ao do Maker. Campo aditivo, regra por flag.

**D5 — `--ignore-user-config` não derruba o piso de 19,4 k.** `architecture.md §7` diz "chamadas curtas
no Codex sempre com `--ignore-user-config` (piso de 19,4k tokens)", sugerindo causalidade. A flag pula só
`$CODEX_HOME/config.toml`; o piso medido soma instruções de sistema + AGENTS.md + catálogo de skills
(`capabilities-codex.md` §1.3), e a própria mitigação listada em §11 do mesmo documento é tripla: podar
AGENTS.md, limitar `skills.max_context_tokens` e usar a flag. Some-se digest #39 (Codex omite skills em
silêncio acima de 2 % da janela ou 8.000 chars; AGENTS.md trunca em 32 KiB). Proposta: a receita de
chamada curta passa a ser `--ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0`
mais um `<worktree>/AGENTS.md` escrito pelo engine com ≤ 2 KB; e o piso vira número **medido pelo doctor
por versão de binário**, não constante de documentação.

## 12. Perguntas em aberto

1. Custo real do classificador com `--safe-mode` e system prompt enxuto — não medido
   (`capabilities-claude-code.md` §14.3). Bloqueia fixar o orçamento da faixa rápida.
2. `--advisor` produz uma segunda chave em `modelUsage`? Sem isso, a alavanca de custo do digest #4 não é
   auditável por chamada.
3. `--permission-mode plan` convive com `--json-schema` sem que o modo de plano intercepte a resposta
   final estruturada? Não testado; afeta o Checker de portão (§2).
4. Janela de contexto do `agy` continua não publicada e não verificável: o teto de pack do papel de
   pesquisa é chute até haver medição.
5. Fallback silencioso de cota do `agy` é invisível no JSON (nenhum campo reporta o modelo efetivo).
   Mitigação disponível: pedir autoidentificação na primeira linha e validar contra `request.model` —
   sinal fraco, não prova.
6. Reconciliação de um `model_call` do Codex que morreu antes do `thread.started`: o recibo durável tem
   `pid` + `start_time`, mas não tem `session_ref` para correlacionar com o rollout em disco. Definir se
   o reconciler varre `$CODEX_HOME/session_index.jsonl` por janela de tempo ou aceita `ambiguous`.
