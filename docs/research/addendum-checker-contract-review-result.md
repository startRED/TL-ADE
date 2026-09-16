# Addendum — contrato executável do papel Checker (`review-result`)

Data: 2026-09-16 · Pesquisa da rodada de rearquitetação da TL-ADE. Fecha a lacuna: comando exato,
schema de saída e roteamento por tipo de revisão do papel Checker.

Convenção: `[verificado: <fonte>]` = medido/lido nesta pesquisa ou já verificado em pesquisa citada ·
`[inferido]` = dedução a partir de fonte primária · `[hipótese]` = não verificado, marcado como tal.

---

## 0. Decisões fechadas (resumo)

1. **`review-result` usa a forma rica** (`severity`, `location`, `problem`, `evidence`, `required_action`,
   `target_role`), validada com um validador estrito na ingestão (ajv em produção). `summary` não existe
   mais como campo de entrada — é **derivado** (`summary := problem`, truncado no painel).
2. **`codex exec review` (com ou sem `--output-schema`) NÃO é o comando do Checker automatizado.**
   Medido nesta pesquisa: `--output-schema` é **ignorado** pelo subcomando `review` — a saída continua
   prosa livre `[P1]/[P2] problema — local` em todo cenário testado. O Checker usa `codex exec` **genérico**
   (sem `review`) com `--output-schema` e um prompt próprio que já contém o diff (o Context Pack já monta
   isso — runtime-port-map.md §6, seção 12 do pack).
3. **Claude Code honra `--json-schema`** de verdade: a saída trata `structured_output` como o objeto
   pedido, campo a campo, medido nesta pesquisa.
4. **Roteamento por tipo de revisão, confirmado em fonte primária** (CR-bench, não só na pesquisa que o
   cita): Checker de rodada (gera rework) = Codex por precisão (88% de utilidade); Checker de portão
   (antes do merge) = Claude Code por cobertura (32,1% de pass rate). Ambos via `--output-schema`/
   `--json-schema` genérico, nunca via `codex review`/`codex exec review`.
5. **`claude ultrareview`**: testado ao vivo. É cloud-hosted, sessão em `claude.ai/code`, ~5–10 min,
   **3 reviews grátis** (cota observada), não exige PR nem remoto Git. Entra como **portão extra opcional**
   pré-merge, não como Checker padrão (latência e cota incompatíveis com o loop de rework).
6. **`alibaba/open-code-review`: REJECT total** (revoga o ADAPT anterior de `ref-tools.md`). O Delegation
   Mode existia para resolver "seleção de arquivo/regras + agente hospedeiro já autenticado" — o Context
   Pack da ADE já faz isso, e a saída estruturada vem de `--output-schema`/`--json-schema` direto no
   adapter, sem intermediário. Zero capacidade líquida ganha por um binário Go a mais para instalar/manter.

---

## 1. O defeito latente confirmado (código, não só o doc)

`schemas/review-result.schema.json` do runtime de referência exige, por `action_item`
(`additionalProperties: false`):

```
id, severity, category, target_role, location, problem, evidence, required_action
```

O runtime lê outra coisa, em **dois pontos independentes** de `scripts/tl_runtime.py`:

```python
# classify_dispatch, ~999-1002 (expected_kind == "review_result")
items = result.get("action_items") or []
summary = " | ".join(str(i.get("summary", ""))[:80] for i in items[:6])
if any(i.get("category") == "intent_gap" and i.get("target") == "human" for i in items):
    return "semantic", normalize_signature("review", "intent_gap", summary), "intent_gap for human: " + summary

# Runtime.review, ~1720-1732
human = [i for i in items if i.get("target") == "human" and i.get("category") != "deferred"]
if human:
    raise UnitPark("awaiting_operator", "intent_gap: " + "; ".join(...))
findings_digest = sha256_text(chr(10).join(sorted(str(i.get("summary", "")) for i in items)))[:16]
```

Como o schema tem `additionalProperties: false` e não declara `target`/`summary`, **um Checker real que
segue o schema (`prompts/checker-report-only.md`: "o schema JSON é a única fonte da estrutura") produz
objetos que o `load_result` aceita sintaticamente** (`load_result` só confere `verdict` + `action_items`
ser lista, `scripts/tl_runtime.py` ~1020-1024 — **não valida contra o schema**) mas cujos campos nunca
batem com `i.get("target")`/`i.get("summary")`. Resultado, reproduzido estruturalmente na seção 5:

- `intent_gap` dirigido a humano nunca escalona para `awaiting_operator` — vira `rework` (item errado, para
  o papel errado, para sempre).
- `findings_digest` colapsa em `sha256("")` toda rodada → **stagnation dispara falso na 2ª rodada**,
  mesmo com achados diferentes.

Os testes não pegam isso porque **todo fixture do runtime usa a forma errada, consistentemente**
(`test_tl_runtime.py`, forma `{"id": "R1", "target": "human"/"maker", "category": ..., "summary": ...}`),
confirmado em 5 locais: linhas ~232 (`test_same_findings_twice_is_stagnation`), ~246
(`test_continue_independent_after_block_runs_unrelated_unit`), ~264 (`test_diff_oscillation_parks`), ~278
(`test_intent_gap_for_human_awaits_operator_and_decide_resumes`), ~284
(`test_pending_verification_matching_a_green_gate_is_resolved_by_runtime`). Um teste que criasse o item na
forma do schema real (`target_role`, `problem`) reproduziria os dois bugs acima — nenhum teste faz isso.
[verificado: código + testes, `E:\Documentos\ProjetosIA\tl-orchestrator-release`]

---

## 2. Medição da forma real da saída — Codex (trabalho obrigatório item 1)

Fixture descartável: `git init` em
`%TEMP%\...\scratchpad\checker-fixture-1`, branch `main` com `calc.py` (duas funções limpas), branch
`feature` com um diff pequeno que planta **dois defeitos reais**: SQL injection por concatenação
(`build_query`) e `ZeroDivisionError` não tratado em lista vazia (`safe_average`). `codex-cli 0.154.0`.

### 2.1 `codex exec review --json --uncommitted` (sem `--output-schema`)

Comando literal:
```
codex exec review --json --uncommitted --skip-git-repo-check
```

Saída literal do item final (JSONL, `item.completed` tipo `agent_message` — **não há nenhum item de tipo
estruturado/`structured_output` na sequência**):

```json
{"id":"item_3","type":"agent_message","text":"New SQL construction permits injection, and empty inputs crash safe_average.\n\nFull review comments:\n\n- [P1] Parameterize user_id before building SQL — .../calc.py:16-16\n  When `user_id` originates from user-controlled input, concatenation permits SQL injection such as `0 OR 1=1`, which changes the predicate and can expose all rows. Use a bound query parameter rather than interpolating the value into SQL.\n\n- [P2] Handle empty inputs in safe_average — .../calc.py:12-12\n  For an empty `items` collection, `len(items)` is zero and this raises `ZeroDivisionError`. Guard the empty case and return the defined empty result or raise a deliberate validation error before division."}
```

Achados: **ambos os defeitos plantados foram encontrados** — o revisor é competente. Mas a forma é
**prosa markdown livre** com um marcador de prioridade informal `[P1]/[P2]` (não é o enum `severity` do
schema), `arquivo:linha-linha` embutido no texto (não é um campo `location` isolado), e nenhum `verdict`,
nenhum `target_role`, nenhum JSON. `[verificado: execução local, 2026-09-16]`

**Efeito colateral relevante para custo/determinismo do Checker**: antes de responder, o `review` disparou
**3 `command_execution`** (PowerShell) que leram, sem terem sido pedidos, arquivos globais do usuário —
`~/.codex/skills/.system/AGENTS.md`, `~/.codex/plugins/cache/ponytail/.../SKILL.md`,
`~/.agents/skills/caveman{,-review}/SKILL.md`, `~/.codex/RTK.md` — e tentaram invocar um binário `rtk.exe`
inexistente no PATH da sessão do subprocesso (`CommandNotFoundException`, uma chamada perdida). Isso é
o `review` puxando a hierarquia AGENTS.md/skills global do operador para dentro do contexto de revisão —
ruído, custo e não-determinismo que um Checker de gate não deveria carregar. `[verificado: aggregated_output
das 3 command_execution, execução local]`

### 2.2 `codex exec review --json --base main --output-schema <schema candidato>`

Schema candidato usado (a forma rica decidida na seção 4, simplificada para o teste). Comando literal:
```
codex exec review --json --base main --output-schema candidate-review-result.schema.json -o review_out.json
```

Conteúdo literal de `review_out.json` (o arquivo que `--output-schema` deveria moldar):
```
New functions have an SQL injection path and unhandled empty-input failure.

Full review comments:

- [P1] Bind user_id instead of concatenating SQL — ...\calc.py:16-16
  ...
- [P2] Handle empty inputs before averaging — ...\calc.py:12-12
  ...
```

**Idêntico em forma ao caso sem schema.** Confirmado no JSONL: nenhum item novo aparece, o item final
continua `type: "agent_message"` com o mesmo texto solto — **`--output-schema` não teve efeito nenhum**
sobre `codex exec review`, apesar de `codex exec review --help` documentar a flag como "Path to a JSON
Schema file describing the model's final response shape" (linha 69-70 do help). Sem erro, sem aviso,
`exit_code 0`. `[verificado: execução local, 2 rodadas]`

**Hipótese sobre a causa**: `codex debug models --bundled` lista um modelo oculto `codex-auto-review`
"usado pela revisão automática" (`capabilities-codex.md` §3.1, §5.7) — o subcomando `review` provavelmente
roteia para um pipeline de pós-processamento fixo (o template `[P#] título — local`) que não passa pelo
mecanismo de `structured_output` genérico do `codex exec`. `[hipótese]`

### 2.3 `codex exec` genérico (sem `review`) com `--output-schema`

Comando literal:
```
codex exec --json --sandbox read-only --skip-git-repo-check --output-schema candidate-review-result.schema.json -o plain_out.json -C . "Return ONLY a JSON object with verdict=changes_requested and one action_item with id R1, severity high, category patch, target_role maker, location calc.py:16, problem 'sql injection', evidence 'concat string', required_action 'use bound params'."
```

Saída literal de `plain_out.json` (e do `item.completed agent_message` correspondente no JSONL):
```json
{"verdict":"changes_requested","action_items":[{"id":"R1","severity":"high","category":"patch","target_role":"maker","location":"calc.py:16","problem":"sql injection","evidence":"concat string","required_action":"use bound params"}]}
```

**Schema respeitado byte a byte.** JSONL de 4 linhas só (`thread.started`, `turn.started`,
`item.completed`, `turn.completed`) — **nenhuma exploração lateral de skills/AGENTS.md global**, ao
contrário de `review`. `usage.input_tokens = 18738` (perto do piso de ~19,4k já medido em
`capabilities-codex.md` §1.3 para um prompt trivial — overhead de sistema, não de skills). `[verificado:
execução local]`

### 2.4 Respostas diretas ao item 1

| Pergunta | Resposta |
| :--- | :--- |
| `--output-schema` é respeitado? | **Não em `codex exec review`/`codex review`. Sim em `codex exec` genérico.** [verificado] |
| Que campos o revisor emite por conta própria (`review`)? | Só prosa: título de uma linha + lista `[P#] título — arquivo:linha-linha` + parágrafo de razão. Sem JSON, sem enum. [verificado] |
| Há severidade? | Só informal (`P1`/`P2`), não é o enum `critical/high/medium/low` do schema. [verificado] |
| Há `file:line`? | Sim, mas embutido em texto livre (`arquivo:linha-linha` dentro da string), não como campo isolado. [verificado] |
| Há algo que sirva de `target` (humano vs maker)? | Não. `review` nunca distingue humano de maker; todo achado é dirigido implicitamente ao Maker. [verificado] |

**Decisão**: o Checker automatizado da ADE **não usa `codex review` nem `codex exec review`**. Usa
`codex exec --output-schema <schema>` com um prompt próprio (adaptação de
`prompts/checker-report-only.md`) que já embute o diff via o Context Pack (seção 12,
`runtime-port-map.md` §6) — a ADE não precisa da conveniência de diffing do `review`, porque o pack já
monta `changed_files`+`diff`. Isto **corrige** a decisão de `capabilities-codex.md` §5.7 ("→ Decisão:
`codex exec review --json --base <branch> --output-schema ...`"), que foi tomada sem rodar o comando —
exatamente a lacuna que este addendum fecha.

---

## 3. Medição da forma real da saída — Claude Code

`claude` 2.1.273. Comando literal (mesmo schema candidato, schema passado **inline** — `--json-schema`
exige JSON literal, não caminho de arquivo; `--json-schema <arquivo>` falha com
`Error: --json-schema is not valid JSON: JSON Parse error: Unexpected identifier "candidate"`,
confirmado antes de corrigir):

```
claude -p --output-format json --json-schema "$(cat candidate-review-result.schema.json)" \
  --model haiku --permission-mode plan --permission-prompts none \
  "Return ONLY a JSON object with verdict=changes_requested and one action_item with id R1, severity high, category patch, target_role maker, location calc.py:16, problem 'sql injection', evidence 'concat string', required_action 'use bound params'."
```

Saída literal (campos relevantes do JSON de resultado):
```json
{"result":"{\"verdict\":\"changes_requested\",\"action_items\":[{\"id\":\"R1\",\"severity\":\"high\",\"category\":\"patch\",\"target_role\":\"maker\",\"location\":\"calc.py:16\",\"problem\":\"sql injection\",\"evidence\":\"concat string\",\"required_action\":\"use bound params\"}]}",
 "structured_output":{"verdict":"changes_requested","action_items":[{"id":"R1","severity":"high","category":"patch","target_role":"maker","location":"calc.py:16","problem":"sql injection","evidence":"concat string","required_action":"use bound params"}]},
 "total_cost_usd":0.3736622,"modelUsage":{"claude-sonnet-5":{...,"canonicalModel":"claude-sonnet-5",...}},"is_error":false,"subtype":"success"}
```

**Schema respeitado**: `structured_output` é o objeto exato pedido — o adapter Claude parseia esse campo
direto, sem regex sobre `result`. `[verificado: execução local]`

**Achado colateral não previsto**: `--model haiku` foi pedido mas `modelUsage` só lista
`claude-sonnet-5` (custo de US$ 0,37 para ecoar um JSON de 200 bytes é inconsistente com preço de Haiku).
Ou o alias `haiku` não resolveu, ou a conta força um modelo mínimo mais caro. **Não investigado a fundo
por orçamento desta pesquisa** — registrado como questão aberta (§11) porque afeta o custo por chamada do
classificador citado em `capabilities-claude-code.md` §14 item 3, não só o Checker. `[hipótese]`

---

## 4. Forma final do `review-result` — decisão e justificativa campo a campo

### 4.1 A forma vence: rica, não enxuta

A forma enxuta (`target`, `summary`) só existe porque foi isso que alguém digitou nos testes do runtime
Python — nunca foi uma decisão de design, é o que `classify_dispatch`/`Runtime.review` acabaram lendo
porque ninguém rodou o schema contra o código (exatamente o defeito da seção 1). A forma rica é a única
com informação suficiente para o painel (`location`+`evidence`+`required_action` são o que um operador
precisa para decidir "retry" vs "skip" em `awaiting_operator`) e é a que os dois harnesses **de fato
produzem** quando instruídos por schema (seções 2.3 e 3) — nenhuma medição sugeriu que `target`/`summary`
seja mais fácil de obter de um LLM.

### 4.2 Schema final (`review-result.schema.json`, pronto para `ajv`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ADE Review Result",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "verdict", "action_items", "deferred", "rejected"],
  "properties": {
    "schema_version": { "const": 1 },
    "verdict": { "enum": ["approved", "changes_requested"] },
    "action_items": { "type": "array", "items": { "$ref": "#/$defs/action_item" } },
    "deferred": { "type": "array", "items": { "$ref": "#/$defs/finding" } },
    "rejected": { "type": "array", "items": { "$ref": "#/$defs/finding" } }
  },
  "$defs": {
    "action_item": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "severity", "category", "target_role", "location", "problem", "evidence", "required_action"],
      "properties": {
        "id": { "type": "string", "pattern": "^R[1-9][0-9]*$" },
        "severity": { "enum": ["critical", "high", "medium", "low"] },
        "category": { "enum": ["patch", "bad_spec", "intent_gap"] },
        "target_role": { "enum": ["maker", "planner", "human"] },
        "location": { "type": "string", "minLength": 1 },
        "problem": { "type": "string", "minLength": 1 },
        "evidence": { "type": "string", "minLength": 1 },
        "required_action": { "type": "string", "minLength": 1 }
      }
    },
    "finding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["summary", "evidence"],
      "properties": {
        "summary": { "type": "string", "minLength": 1 },
        "evidence": { "type": "string", "minLength": 1 },
        "location": { "type": "string" },
        "severity": { "enum": ["critical", "high", "medium", "low"] }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "verdict": { "const": "approved" } } },
      "then": { "properties": { "action_items": { "maxItems": 0 } } } },
    { "if": { "properties": { "verdict": { "const": "changes_requested" } } },
      "then": { "properties": { "action_items": { "minItems": 1 } } } }
  ]
}
```

Idêntico ao schema do runtime de referência (porte literal — `3.1` do `runtime-port-map.md` já
classificava este schema como "Muda", não "Morre"). `deferred`/`rejected` mantêm a forma enxuta
(`summary`+`evidence`) de propósito: são achados que **não** alimentam o loop automático de rework nem o
detector de stagnation (`runtime-port-map.md` §3.1), só o registro humano — não precisam da riqueza que
`action_items` precisa.

### 4.3 Justificativa campo a campo (por que cada um sobrevive)

| Campo | Por que existe | Consumidor |
| :--- | :--- | :--- |
| `id` | Referência estável entre rodadas (`R1`, `R2`...) — usado em notas do journal e no painel para linkar rework a achado específico | Painel, journal (`note`) |
| `severity` | Prioriza o que o Maker resolve primeiro; futuro: gate de portão pode recusar `critical` sem exceção mesmo com `deferred` | Painel, política de gate |
| `category` | `patch`/`bad_spec`/`intent_gap` — decide **para quem** vai o achado antes mesmo de olhar `target_role`; `bad_spec` é o gancho para reescrita de story (Planner) | Roteamento do achado |
| `target_role` | **O campo que faltava no runtime.** `maker`\|`planner`\|`human` — decide rework vs replanejamento vs `awaiting_operator`. Sem ele, `intent_gap` para humano nunca escalona (seção 1) | `Runtime.review`, `_resolve_pending_verification` |
| `location` | `arquivo:linha` ou `arquivo:linha-linha` — o painel mostra link direto; sem isso o operador teria que reabrir o diff inteiro | Painel |
| `problem` | Descrição do defeito — **fonte de `summary` derivado** (§4.4) e do `findings_digest` | `findings_digest`, painel |
| `evidence` | Trecho do diff/log que prova o achado — sem isso um achado é opinião, não prova; combina com a exigência de "quality gates com evidência" do PROMPT.md princípio 2 | Painel, auditoria |
| `required_action` | Instrução acionável para quem recebe (`target_role`) — sem isso o Maker repete o mesmo erro na rodada seguinte porque não sabe o que fazer | Pack `open_findings` da rodada seguinte |

### 4.4 O que muda concretamente no engine (TS)

```ts
// summary NÃO é lido do JSON — é derivado, sempre.
function summaryOf(item: ActionItem): string { return item.problem; }

function isHumanIntentGap(item: ActionItem): boolean {
  return item.target_role === "human" && item.category === "intent_gap";
}

function findingsDigest(items: ActionItem[]): string {
  return sha256Hex(items.map(summaryOf).sort().join("\n")).slice(0, 16);
}
```

| Mecanismo | Antes (herdado, quebrado) | Depois (schema rico + leitura correta) |
| :--- | :--- | :--- |
| Escalonamento `intent_gap` humano | `item.target === "human"` — sempre `undefined`, nunca casa | `item.target_role === "human" && item.category === "intent_gap"` — casa de verdade |
| `findings_digest` | `sha256(sorted(summary ?? ""))` → sempre `sha256("")`, constante | `sha256(sorted(problem))` → varia por achado real; `stagnation` só dispara quando o `problem` **de fato** se repete N rodadas seguidas |
| `_resolve_pending_verification` | Casamento por substring em `summary` (sempre vazio) — nunca resolve nada | Casamento por substring em `problem` (populado) — resolve `verificacao_pendente` como projetado |
| Painel | Não tem o que mostrar (`target`/`summary` vazios na prática) | Mostra `severity` (cor), `location` (link), `problem` (título), `evidence`+`required_action` (expandido), `target_role` (badge) |

---

## 5. Testes que provam que o defeito não foi herdado

Script Node autocontido (sem `ajv` — checagem estrutural manual só para esta prova; a ingestão real da
ADE usa `ajv`), rodado com `node` v24.16.0, executado nesta pesquisa:

```js
const REQUIRED = ["id","severity","category","target_role","location","problem","evidence","required_action"];
const ALLOWED = new Set(REQUIRED);
function validateActionItem(item) {
  const errors = [];
  for (const k of REQUIRED) if (!(k in item)) errors.push(`missing required: ${k}`);
  for (const k of Object.keys(item)) if (!ALLOWED.has(k)) errors.push(`additionalProperty not allowed: ${k}`);
  return { valid: errors.length === 0, errors };
}
function deriveSummary(item) { return item.problem; }
function isHumanIntentGap(item) { return item.target_role === "human" && item.category === "intent_gap"; }
function findingsDigest(items) { return sha16(items.map(deriveSummary).sort().join("\n")); }

// Caso A: a forma exata dos fixtures de test_tl_runtime.py (target/summary)
const oldFixtureItem = { id: "R1", target: "human", category: "intent_gap", summary: "which greeting language?" };
assert.equal(validateActionItem(oldFixtureItem).valid, false); // REJEITADO pelo schema real

// Caso D: o defeito reproduzido estruturalmente — porte 1:1 do campo `target`
// aplicado a um item CONFORME AO SCHEMA (target_role, não target)
function buggyIsHumanPy1to1(item) { return item.target === "human" && item.category !== "deferred"; }
assert.equal(buggyIsHumanPy1to1(richItem), false); // nunca escalona — bug reproduzido

// Caso F: o teste que passaria HOJE escondendo o bug — fixture antigo (não validado)
// lido pelo leitor 1:1 do Python "funciona" porque os dois lados estão errados do mesmo jeito
const hiddenBugFixture = { id: "R1", target: "human", category: "intent_gap", summary: "..." };
assert.equal(buggyIsHumanPy1to1(hiddenBugFixture), true);       // sem validação: "passa", esconde o bug
assert.equal(validateActionItem(hiddenBugFixture).valid, false); // COM validação na ingestão: recusado antes de chegar no engine
```

Saída literal (`node test-review-result-defect.mjs`):
```
[Case A] old-shape fixture rejected as expected: [
  'missing required: severity', 'missing required: target_role', 'missing required: location',
  'missing required: problem', 'missing required: evidence', 'missing required: required_action',
  'additionalProperty not allowed: target', 'additionalProperty not allowed: summary'
]
[Case B] rich item accepted: { valid: true, errors: [] }
[Case C] target_role-based escalation: OK, intent_gap escalates to human
[Case D] naive 1:1 port on rich item -> escalates: false (must be false: this is the bug)
[Case E] buggy digest round1==round2: true | fixed digest differs: true
[Case F] no-validation green (hides bug): true | with-validation refused (surfaces bug at the boundary): true

ALL ASSERTIONS PASSED — rich schema + target_role/problem + ajv-at-ingestion closes the latent defect.
```

**O que isto prova**: (1) o fixture não-schema que hoje faz a suíte Python passar 93/93 seria **recusado**
por qualquer validador estrito na ingestão — a ADE fecha exatamente a brecha que deixou o bug invisível;
(2) um porte 1:1 do campo errado (`target`) reproduz o bug mesmo com dado correto — a correção depende de
mudar o **nome do campo lido**, não só de "portar o código"; (3) o caso F é o cenário do enunciado: sem
gate de schema na ingestão, um port ingênuo com fixtures copiados do Python fica verde escondendo os dois
bugs; com o gate, a mesma entrada é recusada no limite do sistema — a suíte de paridade da ADE **precisa**
de um teste equivalente ao Caso F (fixture antigo → `ajv.validate()` → `false`) para nunca regredir isso.
`[verificado: execução local, `test-review-result-defect.mjs`, todas as asserções passaram]`

---

## 6. Contrato executável do step `review` por família

### 6.1 Codex — Checker de rodada (gera rework)

```
codex exec --json \
  --sandbox read-only \
  --skip-git-repo-check \
  --ignore-user-config \
  -C <worktree_da_unidade> \
  --output-schema <state_dir>/schemas/review-result.schema.json \
  -o <state_dir>/results/<step_id>.review.json \
  -m gpt-5.6-terra \
  "<prompt: checker-report-only.md adaptado + Context Pack (contract/policy/spec/changed_files+diff/runtime_verification) já embutido>"
```

- `--ignore-user-config`: evita a exploração lateral de AGENTS.md/skills globais medida na §2.1 (custo,
  ruído, não-determinismo, e a tentativa falha de invocar `rtk.exe`).
- `-m gpt-5.6-terra`: "leitura/varredura rápida e barata" pelo guia oficial (`capabilities-codex.md` §3.1)
  — e, por ser um slug diferente do Maker padrão (`gpt-5.6-sol`/`gpt-5.6`), satisfaz Maker ≠ Checker por
  `model_id` trivialmente dentro da mesma família, caso a família preferida do Checker de rodada seja a
  mesma do Maker (ver §7.2).
- Parse: `JSON.parse(readFileSync(resultPath))` a partir do arquivo `-o` (mais confiável que extrair do
  JSONL); validar com `ajv` antes de qualquer leitura de campo. Resultado inválido (`ajv` recusa) é classe
  `harness` (transporte não produziu o contrato — mesmo bucket de `no_result` em `classify_dispatch`), não
  `semantic`.

### 6.2 Claude Code — Checker de portão (antes do merge)

```
claude -p \
  --output-format json \
  --json-schema "$(cat <state_dir>/schemas/review-result.schema.json)" \
  --model opus \
  --permission-mode plan \
  --permission-prompts none \
  --add-dir <worktree_da_unidade> \
  "<prompt: checker-report-only.md adaptado + Context Pack, verification_scope=integration_boundary>"
```

- `--permission-mode plan`: modo somente-leitura nativo — casa com "Não crie, altere, mova ou apague
  arquivos" do `checker-report-only.md` sem depender só de convenção de prompt.
  `[verificado: capabilities-claude-code.md §4]`
- `--model opus`: quando o Maker da story usou `sonnet` (default), o portão usa um `model_id` diferente
  na mesma família — satisfaz Maker ≠ Checker por `model_id` mesmo quando a família de portão é
  deliberadamente igual à do Maker (justificado por CR-bench, §7).
- Parse: campo `structured_output` do JSON de resultado — **não** fazer regex sobre `result` (string),
  `structured_output` já é o objeto tipado. `[verificado: §3]`

### 6.3 Gemini — fallback (ambos os papéis)

`gemini --help` (0.59.0) não expõe `--json-schema`/`--output-schema`: só `-o/--output-format
{text,json,stream-json}`. `[verificado: execução local]` Sem decodificação restrita, o adapter Gemini
**precisa** pedir o schema por prompt, parsear `-o json` e validar com `ajv` depois — uma falha de
schema aqui é classe `harness` com retry (o mesmo tratamento de `no_result`), nunca `semantic`. Fallback
de terceira escolha para os dois papéis de Checker (tabela §7), nunca primário, exatamente porque não há
garantia estrutural na fonte. `[inferido]`

---

## 7. Roteamento por tipo de revisão

### 7.1 CR-bench confirmado em fonte primária

Fetch direto de `https://arxiv.org/html/2603.23448v3` nesta pesquisa (não só a citação de
`landscape-routing-skills-terminal.md` §1.2):

- **Composição** (Tabela 4, §4.4.2): 184 PRs, 67 repositórios, 234 comentários de revisão convertidos em
  testes executáveis (1,27 testes/instância médios; 418,1 linhas modificadas médias). 42 testes (17,9%)
  comportamentais, 192 (82,1%) estruturais.
- **Pass rate** (Tabela 5, §5.2): **Claude Code 32,1% > Devin 24,8% > PR-Agent 23,1% > Codex 20,1%**;
  combinados resolvem ~40%.
- **Utilidade manual** (Tabela 6, §5.2, amostra de 92 comentários/6 PRs): **PR-Agent 94% (17/18) >
  Codex 88% (7/8) > Devin 85% (22/26) > Claude Code 78% (31/40)**; média 84% (77/92).

`[verificado: fetch direto, 2026-09-16]` — números idênticos aos já citados por
`landscape-routing-skills-terminal.md`, confirmados na fonte primária como pedido pelo trabalho
obrigatório item 3.

**Leitura operacional, sem ambiguidade**: pass rate = fração de achados que sobrevivem a um teste
executável (proxy de **precisão** — Codex reclama pouco e acerta quando reclama; PR-Agent, especializado
e restrito por design, tem o maior score dos dois). Utilidade manual = fração de comentários julgados
úteis por humano em amostra pequena (mesma leitura: Codex é o mais econômico/preciso por comentário;
Claude Code produz mais comentários totais, mais ruído, mas também mais cobertura real — daí o pass rate
maior apesar da utilidade manual menor).

### 7.2 Tabela de roteamento final

| Papel | Comando (família) | Primário | Fallback 1 | Fallback 2 | Evidência |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Checker de rodada** (gera `rework`, roda a cada tentativa do Maker) | `codex exec --output-schema` (§6.1) | Codex | Claude (`claude -p --json-schema`, `--model` ≠ Maker) | Gemini (prompt+parse, §6.3) | CR-bench: Codex 88% de utilidade manual — falso positivo custa uma rodada inteira de Maker, precisão importa mais aqui |
| **Checker de portão** (antes do merge, roda uma vez por lote no CLOSE) | `claude -p --json-schema` (§6.2) | Claude Code | Codex (`codex exec --output-schema`) | — | CR-bench: Claude Code 32,1% de pass rate — cobertura importa mais no portão final, é a última chance |
| **Portão extra opcional** (alto risco, sob demanda) | `claude ultrareview --json` (§8) | Claude (cloud) | — (sem substituto equivalente) | — | Multi-agente oficial, cota/latência incompatíveis com automático |

Isto **substitui** a linha única "Checker: `codex review --base <branch>`" de
`landscape-routing-skills-terminal.md` §1.3 e a decisão de `capabilities-codex.md` §5.7 — ambas
assumiam (a) que `codex review`/`codex exec review` dá saída estruturada estável (falso, §2) e (b) que
Codex é "o melhor revisor" sem diferenciar rodada de portão (a spec v2 §13 também assume isso — precisa
mudar, ver §10).

### 7.3 Maker ≠ Checker por `model_id`, não por família

Regra: antes de despachar o Checker (qualquer papel), o engine resolve `(family, model_id)` do Checker
pela tabela acima e **recusa o despacho** (`Refusal`, mesma classe de `allow_same_family_review` já
presente em `runtime-config.schema.json` — `runtime-port-map.md` §3.1) se `model_id` resolvido ==
`model_id` do último `model_call` do Maker para a mesma unidade — **independente da família**. Isso
permite deliberadamente o Checker de portão usar a mesma família do Maker (Claude, justificado por
CR-bench §7.1) desde que `model` (`opus` vs `sonnet`) difira, e ainda impede o caso degenerado "Maker e
Checker são literalmente o mesmo processo/modelo revisando a si mesmo".

### 7.4 Degradação quando a família preferida está indisponível

`ade doctor` já testa uma chamada real por família (não só presença de binário — correção já registrada
em `landscape-routing-skills-terminal.md` §5 item 3). Quando o primário de um papel falha em `ade doctor`:

1. O roteador usa o Fallback 1 da tabela §7.2, aplicando a mesma regra de `model_id` da §7.3 contra o
   Maker.
2. Se Fallback 1 também falhar, usa Fallback 2 (só existe para Checker de rodada — Gemini).
3. Se nenhuma família de Checker sobrar, a unidade não pode ser revisada: o engine registra
   `harness: no_checker_family_available` e marca a unidade `parked` (mesma classe `park:harness_failure`
   de `Runtime.failure`, `scripts/tl_runtime.py` ~1780) — nunca "aprova sem revisão".
4. Toda degradação grava evento no journal (`routing_default_changed`-like, mas por indisponibilidade, não
   por troca de performance — `landscape-routing-skills-terminal.md` §1.4 item 6 já cobre o caso de troca
   por métrica; este é o caso de troca por ausência).

---

## 8. `claude ultrareview` — avaliação

```
$ claude ultrareview --help
Usage: claude ultrareview [options] [target]
Run a cloud-hosted multi-agent code review of the current branch (or a PR number
/ base branch) and print the findings
Options:
  --json               Print the raw bugs.json payload instead of formatted findings
  --no-post            Do not post the findings to the PR (default)
  --post               Post the finished review's findings to the PR as you (PR targets only)
  --timeout <minutes>  Maximum minutes to wait for the review to finish (default: 45)
```

Execução real (mesmo repositório fixture, sem remoto Git configurado, branch local `feature` não
publicada):
```
$ claude ultrareview --json --timeout 1
Free ultrareview 1 of 3.
Ultrareview launched for feature → main (~5-10 min, runs in the cloud). Track: https://claude.ai/code/session_017DvfC9r7rFwztorE5vheh2?from=cli
Scope: 4 files changed, 44 insertions(+)
View live progress in the browser: https://claude.ai/code/session_017DvfC9r7rFwztorE5vheh2?from=cli
Waiting for findings (~5-10 min)…
  finding — 0 found, 0 verified, 0 refuted
```
`[verificado: execução local, 2026-09-16 — não repetida para poupar a cota de 3 gratuitas]`

Respostas diretas ao trabalho obrigatório item 4:

| Pergunta | Resposta |
| :--- | :--- |
| Roda contra branch/PR local? | Sim — funcionou sem remoto Git e sem PR aberto, só com `feature`/`main` locais. Não precisa de push. |
| Saída JSON estável? | `--json` promete "raw bugs.json payload"; não coletado nesta execução (timeout de 1 min curto demais para o ciclo real de ~5-10 min — parado deliberadamente para não gastar mais cota). Forma exata do `bugs.json`: **não verificado**. |
| Depende de nuvem/assinatura? | Sim, explicitamente: "runs in the cloud", sessão rastreável em `claude.ai/code/...`; cota **"1 of 3" reviews grátis** — modelo de billing não documentado no `--help` além disso. |

**Decisão**: **portão extra opcional**, não Checker de portão padrão. Motivos: (1) ~5-10 min de latência
é incompatível com um loop de rework que já pode rodar várias vezes por unidade; (2) cota de 3 grátis
observada torna inviável como padrão em lotes de dezenas de stories; (3) multi-agente **oficial** da
mesma família do Maker (Claude) é evidência a favor de qualidade, mas não substitui o Checker
determinístico e barato do dia a dia. Uso recomendado: comando manual (`ade review --ultra`) antes do
merge de uma story de alto risco, side-by-side com o Checker de portão padrão — nunca bloqueante por
padrão, porque a cota pode simplesmente acabar.

---

## 9. Destino de `alibaba/open-code-review`

`ref-tools.md` classificava como **ADAPT** (só Delegation Mode) porque resolvia "revisão line-level sem
chave de API extra, delegando ao agente já autenticado". `landscape-harnesses.md` §8 pergunta 6 já
registrava que ele "perde parte da razão de ser" com `codex exec review` existindo.

Com a medição desta pesquisa, a razão de ser desaparece por completo, não só em parte:

1. O que o OCR Delegation Mode fazia — resolver **qual** arquivo/regra revisar, e delegar a execução ao
   agente hospedeiro — é exatamente o que o **Context Pack** da ADE já faz nativamente
   (`runtime-port-map.md` §6: seções `changed_files`+`diff`, `related_tests` via Graft), com o benefício
   adicional de já respeitar tetos de bytes, redação de segredos e o manifesto de evidência.
2. A saída estruturada que faltava (motivo original para cogitar um binário externo) vem direto de
   `--output-schema`/`--json-schema` no adapter genérico (§2.3, §3) — **medido funcionando**, sem
   intermediário.
3. Instalar (`npm install -g`, binário Go) e manter um processo a mais para replicar o que o Context Pack
   + adapter genérico já fazem viola a régua básica da ADE (menos peças móveis, tudo via CLI/adapter já
   autenticado — `spec v2` §2 "Chamadas de modelo: todas pelos adapters de CLI").

**Decisão: REJECT total.** Não entra nem como Delegation Mode. `docs/catalog-sources.md` e `ref-tools.md`
devem marcar a linha `alibaba/open-code-review` como `REJECT (revogado; ver
addendum-checker-contract-review-result.md §9)`. O dataset **AACR-Bench** (200 PRs, 1505 issues anotadas)
continua útil como metodologia de avaliação de Checker — isso não é o binário, pode ser referenciado
separadamente para calibrar `success_rate`/`fp_rate` (`landscape-routing-skills-terminal.md` §1.4) sem
depender do pacote.

---

## 10. Impactos concretos na spec v2 e no `runtime-port-map.md`

| Documento/§ | Mudança | Motivo |
| :--- | :--- | :--- |
| spec v2 §13 | "Codex = Checker padrão" vira **duas linhas**: Checker de rodada (Codex) / Checker de portão (Claude Code) | CR-bench §7.1; contradiz a leitura de blog que a spec original seguia |
| spec v2 §13 | Comando do Checker deixa de ser implícito ("chama o adapter") e vira explícito: nunca `codex review`/`codex exec review`; sempre `--output-schema`/`--json-schema` genérico | §2, §3 |
| `runtime-port-map.md` §3.2 item 5 | Confirma a forma rica (já era a recomendação) e fecha a pergunta em aberto que o motivo desta pesquisa citava — agora com medição, não só leitura de código | §4 |
| `runtime-port-map.md` §3.3 | O "a ADE tem de escolher, não copiar" está resolvido: forma rica + leitura por `target_role`/`problem`, com teste que reproduz e depois fecha o bug (§5) | §1, §4.4, §5 |
| `ref-tools.md` linha `alibaba/open-code-review` | ADAPT → REJECT | §9 |
| `capabilities-codex.md` §5.7 | Decisão "`codex exec review --output-schema`" revogada — `--output-schema` não funciona nesse subcomando | §2.2, §2.4 |
| `landscape-routing-skills-terminal.md` §1.3, linha "Restrição nova" | "`codex review --base <branch>`... elimina prompt artesanal e dá saída estável" — **falso**, saída é prosa livre mesmo com schema | §2 |

---

## 11. Perguntas em aberto

1. Forma exata do `bugs.json` de `claude ultrareview --json` não foi coletada (execução cortada em 1 min
   para poupar cota gratuita de 3). Precisa de uma execução completa (~5-10 min) com `--timeout 10`+ antes
   de desenhar o parser, se `ultrareview` for adotado como portão extra em produção.
2. Por que `claude -p --model haiku` faturou como `claude-sonnet-5` no `modelUsage` (§3) — investigar antes
   de fixar o orçamento do classificador barato citado em `capabilities-claude-code.md` §14 item 3; pode
   inflar o custo de qualquer papel que assuma Haiku como default barato, incluindo potencialmente o
   Checker de rodada se ele um dia rotear para Claude/Haiku como fallback mais barato.
3. Gemini como fallback de Checker nunca foi testado ao vivo produzindo `review-result` via prompt+parse
   (`--output-format json` sem schema nativo) — confirmar taxa de sucesso de parse antes de promover de
   "fallback 2" para "fallback 1" em qualquer papel.
4. `codex debug models --bundled` lista `codex-auto-review` como modelo oculto da revisão automática —
   não confirmado se é ele que ignora `--output-schema` ou se é o subcomando `review` em si (o
   pós-processamento pode ser hardcoded fora do LLM). Relevante só se algum dia a ADE quiser um modo
   "revisão humana legível" paralelo ao contrato de máquina — não bloqueia esta decisão.

---

## Fontes

Medições locais desta pesquisa (Windows 11 Pro 26200, 2026-09-16):
- `codex exec review --json --uncommitted --skip-git-repo-check` (codex-cli 0.154.0)
- `codex exec review --json --base main --output-schema <schema> -o review_out.json`
- `codex exec --json --sandbox read-only --skip-git-repo-check --output-schema <schema> -o plain_out.json -C .`
- `codex exec review --help`, `codex exec --help` (flags `-C`, `--ignore-user-config`, `--output-schema`, `-s/--sandbox`, `-o`)
- `claude -p --output-format json --json-schema "<schema inline>" --model haiku ...` (claude 2.1.273)
- `claude ultrareview --help`, `claude ultrareview --json --timeout 1`
- `gemini --help` (0.59.0) — sem `--json-schema`/`--output-schema`
- `node test-review-result-defect.mjs` (Node v24.16.0) — script completo na seção 5

Código e schema de referência (`E:\Documentos\ProjetosIA\tl-orchestrator-release`, v0.17.0), lido
integralmente ou nas faixas citadas nesta pesquisa:
- `schemas/review-result.schema.json`
- `scripts/tl_runtime.py` — `classify_dispatch` (~969-1010), `load_result` (~1011-1024), `Runtime.review`
  (~1700-1734), `_resolve_pending_verification` (~1741-1760), `Runtime.failure` (~1765-1790)
- `scripts/tests/test_tl_runtime.py` — linhas ~229-291 (`test_same_findings_twice_is_stagnation`,
  `test_continue_independent_after_block_runs_unrelated_unit`,
  `test_loop_detector_parks_on_repeated_gate_signature`, `test_diff_oscillation_parks`,
  `test_intent_gap_for_human_awaits_operator_and_decide_resumes`,
  `test_pending_verification_matching_a_green_gate_is_resolved_by_runtime`)
- `prompts/checker-report-only.md`

Pesquisas anteriores desta rodada, citadas e corrigidas neste addendum:
- `docs/research/runtime-port-map.md` §3.1, §3.2, §3.3
- `docs/research/landscape-routing-skills-terminal.md` §1.2, §1.3, §5.1
- `docs/research/capabilities-codex.md` §1.3, §3.1, §5.7, §11
- `docs/research/capabilities-claude-code.md` §10, §11, §14
- `docs/research/landscape-evals-visual.md` §7
- `docs/research/landscape-harnesses.md` §8
- `docs/research/ref-tools.md` (linha `alibaba/open-code-review`)
- `docs/specs/2026-09-16-ade-design.md` §2, §13

Fonte primária externa:
- CR-bench / c-CRAB — https://arxiv.org/html/2603.23448v3 (Tabelas 4, 5, 6, §4.4.2, §5.2) — fetch direto
  nesta pesquisa, 2026-09-16
