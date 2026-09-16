# Estado da arte: roteamento por capacidade, seleção de skills, segurança de skills e orquestração de terminais

Data: 2026-09-16. Alvo: Capability Registry, Skill Fabric e painel Agents da TL-ADE (spec v2:
`docs/specs/2026-09-16-ade-design.md`). Escopo restrito às quatro decisões abaixo; nada aqui é
levantamento geral.

Legenda de confiança: **[V]** verificado em fonte primária (doc oficial, código, paper, API do GitHub,
binário local) · **[I]** inferido de evidência parcial · **[H]** hipótese.

Verificações locais desta rodada (executadas em 2026-09-16, Windows 11 Pro 26200): `claude 2.1.271`,
`codex-cli 0.154.0`, `gemini 0.59.0`, `node v24.16.0`, `gh 2.100.0`.

---

## 0. Resumo executivo (o que muda na spec v2)

| # | Achado | Efeito |
| :--- | :--- | :--- |
| 1 | Benchmark executável de revisão (CR-bench/c-CRAB) põe **Claude Code 32.1% acima de Codex 20.1%**; Codex ganha em *precisão* (88% vs 78% de comentários úteis) | §13 precisa trocar "Codex = melhor revisor" por "Codex = portão de precisão, Claude = cobertura" |
| 2 | `gemini 0.59.0` está instalado e funcional, com `--resume`, `--session-id`, `-w/--worktree`, `--output-format stream-json` e `gemini skills` | §5 ("acesso consumidor do Gemini acabou") está desatualizada para esta máquina; o adapter `gemini` é viável hoje |
| 3 | Claude Code já traz `-w/--worktree`, `--tmux`, `--bg` + `claude agents/attach/stop/respawn/logs`, `auto-mode` (classificador) e `ultrareview` | O painel Agents deve **orquestrar** essas primitivas, não reimplementá-las; reduz superfície da v1 |
| 4 | `codex review --base/--commit/--uncommitted` é revisão não-interativa nativa | O step `review` do Checker chama o subcomando, não um prompt artesanal |
| 5 | `node-pty` nunca chegou a 1.2.0 estável (beta.15 em 2026-08-03) e tem ≥8 bugs abertos de ConPTY em 2026, incluindo `kill()` que mata **PID alheio** | Terminal da v1 precisa de contenção explícita (§4.3); a alternativa é tmux, não outra lib |
| 6 | Reranker cross-encoder **piora** retrieval de ferramentas (ToolRet: nDCG@10 33.83 → 28.92 com MonoT5); lista curta + LLM escolhendo **melhora** (87.1% → 93.1%) | O Skill Fabric usa recall barato + LLM-seletor sobre 5–8 candidatos; sem reranker treinado |
| 7 | RouteLLM está abandonado (último push 2024-08-10, verificado hoje via API) | Não é dependência; é referência conceitual |
| 8 | Skill listing do Claude Code é truncado (1.536 chars de `description`+`when_to_use`) e orçado (~1% do contexto) | Catálogo de centenas **não pode** ser exposto via listing da CLI; a ADE injeta só as 1–3 selecionadas |

---

## 1. Roteamento de modelos por capacidade (Capability Registry)

### 1.1 O que o estado da arte realmente entrega

| Sistema | O que é | Evidência | Serve à ADE? |
| :--- | :--- | :--- | :--- |
| **RouteLLM** (LMSYS) | Framework de routers treinados em preferência (SW-ranking, matrix factorization, BERT, causal LLM) | Corte >85% de custo no MT Bench a 95% do GPT-4; MF usa 26% de chamadas GPT-4 (14% com augmentation por LLM-judge) **[V, paper arXiv 2406.18665 + blog LMSYS]**. Repo: último push **2024-08-10**, 5.488 estrelas **[V, API GitHub 2026-09-16]** | **Não como dependência** — abandonado. Sim como prova de que roteamento binário forte/fraco funciona |
| **OpenRouter Auto** | Router hospedado; versão original era movida a Not Diamond | Auto original **depreciado**; Auto Beta classifica o prompt em ~30 task types e ranqueia por *spend share* da comunidade em janela de 7 dias, com dial custo-qualidade **[I, fontes secundárias; a KB oficial devolveu HTTP 403]** | Não — roteia por API, a ADE roteia por CLI |
| **Not Diamond** | Meta-modelo treinado com prompts + respostas candidatas + scores | **[I]**, sem benchmark público auditável | Não |
| **Martian** | "Model mapping" / interpretabilidade | Repositionado como lab de pesquisa em 2026 (ARES, K-Steering); roteamento é linha antiga e caixa-preta sem score público **[I]** | Não |
| **LiteLLM Router** | 5 estratégias: `simple-shuffle` (padrão), `least-busy`, `latency-based`, `usage-based`, `cost-based`; fallbacks gerais / content-policy / context-window **[V, docs.litellm.ai]** | — | **Sim como modelo de design**: estratégias declarativas + cadeia de fallback, sem ML |
| **Claude Code Router** (musistudio) | Gateway local em `127.0.0.1:3456`, regras de roteamento, retries, fallback ordenado, pools de credencial, logs com custo | 37.256 estrelas, push 2026-09-16 **[V, API GitHub]** | **Sim como prova de viabilidade** do padrão "control plane local"; a ADE faz o equivalente um nível acima (papel → família de CLI), não token a token |
| **LLMRouterBench** | Benchmark de roteamento: >400K instâncias, 21 datasets, 33 modelos **[V, arXiv 2601.07206]** | Conclui que roteamento aprendido supera qualquer modelo único **[I — extração parcial do PDF]** | Referência para medir, não para embutir |

**Conclusão de arquitetura.** Todo router aprendido resolve um problema que a ADE não tem: escolher entre
dezenas de modelos por *token de API*, minimizando custo médio. A ADE escolhe entre **três famílias de
CLI** para **papéis fixos** (Maker, Checker, tradutor, pesquisa, design, engenharia), com a restrição
dura Maker ≠ Checker. Isso é uma **tabela com fallback**, não ML. **[I, decorre das restrições da spec
§5/§13]**

### 1.2 Evidência de benchmark por papel (não blog)

Ressalva metodológica obrigatória: pontuações de *vendor scaffold* e de harness padronizado **não são
comparáveis**; a diferença relatada chega a 15–30 pontos **[I, fontes secundárias sobre vals.ai /
llm-stats]**. Use sempre a mesma coluna.

**Implementação (SWE-bench Verified)**

| Modelo | Vendor | Harness independente (Vals AI, mini-SWE-agent) |
| :--- | ---: | ---: |
| Claude Opus 5 (2026-07-24) | 96.0% | 97.0% |
| GPT-5.6 Sol | — | 96.2% |
| Claude Fable 5 | 95.0% | 95.0% |
| Kimi K3 | — | 93.4% |
| Claude Opus 4.8 | — | 88.6% |

**[I]** — números agregados de leaderboards (morphllm, llm-stats, benchlm); a página de lançamento da
Anthropic não foi lida diretamente nesta rodada. **O topo está empatado dentro de ~1 ponto**: para a v1,
SWE-bench **não discrimina** família. Ele só serve para excluir modelo fraco, não para eleger Maker.

**Terminal (Terminal-Bench 2.1, llm-stats, atualizado 2026-09-16)** **[V, fetch direto]**

| Rank | Modelo | Score |
| ---: | :--- | ---: |
| 1 | DeepSeek-V4.1-Flash | 0.906 |
| 2 | Gemini 3.8 Flash | 0.894 |
| 3 | GPT-5.6 Sol | 0.888 |
| 13 | Claude Fable 5 | 0.843 |

O leaderboard oficial (`tbench.ai`) já migrou para **Terminal-Bench 4.0**, onde os scores caem
drasticamente (Opus 5 reportado em 51.82% **[I]**). Ou seja: **Terminal-Bench 2.x está saturado e 4.0 é
jovem demais**; nenhum dos dois sustenta escolha de família para a v1.

**Revisão de código (CR-bench / c-CRAB, NUS + Zhejiang + SonarSource, arXiv 2603.23448v3)** **[V, fetch
direto do HTML]** — este sim discrimina.

- Construção: 184 instâncias de PR de 67 repositórios, 234 comentários humanos validados convertidos em
  **testes executáveis**.
- Pass rate: **Claude Code 32.1% > Devin 24.8% > PR-Agent 23.1% > Codex 20.1%**. Os quatro juntos
  resolvem ~41.5%.
- Utilidade dos comentários (amostra manual de 92 comentários em 6 PRs): PR-Agent 94%, **Codex 88%**,
  Devin 85%, **Claude Code 78%**; média 84%.

**Isto refuta o consenso de blog "Codex é o melhor revisor" na dimensão cobertura e o confirma na
dimensão precisão.** Leitura operacional: Codex reclama menos e erra menos quando reclama; Claude Code
encontra mais defeitos reais e produz mais ruído. Para um Checker cuja saída vira `rework` automático,
**precisão importa mais que recall** (falso positivo custa uma rodada inteira de Maker). Para o portão
final antes do merge, cobertura importa mais.

**Pesquisa / contexto longo.** Gemini 3.8 Flash (2026-09-02): 1M de contexto, 64K de saída, Terminal-Bench
2.1 **89.4%**, preço $0.75/$3.75 por 1M tokens até 2026-12-31 **[I, agregado de fontes secundárias sobre
a tabela oficial do Google]**. É a única evidência quantitativa que sustenta "Gemini para pesquisa e base
grande" — e ela é de **preço + contexto**, não de qualidade superior de pesquisa.

### 1.3 Tabela de defaults v1 (proposta)

Regras: cada linha tem primário e fallback; `ade doctor` marca família indisponível e o roteador pula
para o fallback preservando Maker ≠ Checker.

| Papel | Primário | Fallback 1 | Fallback 2 | Evidência que sustenta |
| :--- | :--- | :--- | :--- | :--- |
| Tradutor de intenção / plano | `claude` (modelo forte) | `codex` | `gemini` | Sem benchmark discriminante; escolha por integração (saída `stream-json`, `--output-schema` só no Codex) **[I]** |
| Classificador barato (tamanho, domínio, skills) | `claude -p --model haiku` | `gemini 3.8 Flash` | — | Custo; Flash a $0.75/1M é a opção mais barata com contexto grande **[I]** |
| Maker (implementação) | `claude` | `codex` | `gemini` | SWE-bench empatado no topo → decidir por ferramental, não por score **[I]**; CR-bench mostra Claude com maior cobertura em código alheio **[V]** |
| Maker — etapa de design (frontend) | `claude` | — | — | Sem benchmark; consenso de comunidade **[H]** — marcar como hipótese a ser medida pelo loop visual |
| Maker — etapa de engenharia (frontend) | `codex` | `claude` | — | **[H]** pelo mesmo motivo |
| Checker de rodada (gera `rework`) | `codex review` | `claude` | `gemini` | CR-bench: Codex 88% de utilidade, o maior entre agentes comerciais **[V]** |
| Checker de portão final (antes do merge) | `claude` | `codex` | — | CR-bench: Claude Code 32.1% de pass rate, maior cobertura **[V]** |
| Pesquisa (2–4 agentes) | `gemini` + `claude` | `codex` | — | 1M de contexto + preço **[I]** |
| Avaliador visual | família ≠ da que editou por último | — | — | Regra da spec §10, não benchmark |
| Geração de imagem | `codex` (`$imagegen`) | — | — | Único com geração embutida **[I, docs.catalog-sources]** |

**Restrição nova.** O Checker deixa de ser "prompt de revisão" e passa a ser
`codex review --base <branch>` ou `--uncommitted`, com o texto de revisão como evidência do portão
**[V, `codex review --help` local]**. Isso elimina prompt artesanal e dá saída estável.

### 1.4 Histórico de desempenho mínimo, sem ML

Objetivo: trocar um default por **evidência do próprio uso**, não por benchmark de terceiro. O journal já
grava tudo que é preciso; falta só uma projeção agregada.

**Evento (uma linha JSONL por chamada de papel, em `~/.ade/routing.jsonl`):**

```json
{"ts":"2026-09-16T12:00:00Z","repo":"tl-ade","batch":"B001","story":"S07",
 "role":"checker_round","family":"codex","model":"gpt-5.6","effort":"medium",
 "domains":["frontend","ts"],"size":"M",
 "outcome":"pass|fail|rework_caused|loop|timeout|error",
 "gate_evidence":"eval_pass|eval_fail|lint_fail",
 "rework_rounds":1,"wall_ms":184000,"usd":0.42,"tokens":{"in":91000,"out":6100},
 "false_positive":false}
```

`false_positive` é derivado, não anotado à mão: um achado do Checker é falso positivo quando o `rework`
que ele causou termina com a árvore revertida ao checkpoint anterior sem mudança de eval **[I, derivável
do modelo de Step do runtime]**.

**Agregação (view no `index.sqlite`, reconstruível):** por `(role, family, domain, size)`, com janela das
últimas N=30 execuções ou 90 dias.

| Métrica | Fórmula | Usada para |
| :--- | :--- | :--- |
| `success_rate` | `pass / total` | Trocar primário |
| `rework_cost` | média de `rework_rounds` | Desempatar |
| `fp_rate` | `false_positive / achados` | Escolher Checker de rodada |
| `usd_per_success` | `Σ usd / pass` | Escolher classificador e pesquisa |
| `p50_wall_ms` | mediana | Detectar degradação de CLI |

**Regra de troca (determinística, auditável, sem modelo):**

1. Só considera par (primário, fallback) com **n ≥ 20 execuções cada** no mesmo `(role, domain, size)`.
2. Troca se `success_rate(fallback) − success_rate(primário) ≥ 0.10` **e** o intervalo de Wilson a 95%
   dos dois não se sobrepõe. **[I — Wilson é o teste correto para proporção com n pequeno]**
3. Empate em `success_rate` (diferença < 0.05): vence menor `usd_per_success`.
4. Papel de Checker: troca adicionalmente se `fp_rate(primário) > 0.30` e o fallback fica abaixo de 0.20.
5. A troca **não é automática na v1**: vira um item "sugestão de roteamento" no painel com os números e
   um botão. `ade doctor --routing` imprime as sugestões. Automático fica no backlog v2, depois que a
   amostra existir.
6. Toda troca aplicada grava `routing_default_changed` no journal, com os números que a justificaram, e é
   reversível.

Isso é `ponytail`: uma tabela JSON, uma view SQL e um teste binomial. Nada de bandit, nada de embedding
de prompt, nada de treinar router. O upgrade path (multi-armed bandit por papel) fica anotado, não
construído.

---

## 2. Seleção de skills (Skill Fabric)

### 2.1 Como o Claude Code faz hoje (linha de base a bater)

**[V, platform.claude.com/docs + code.claude.com/docs, lidos 2026-09-16]**

- **Progressive disclosure em 3 níveis.** Nível 1: `name` + `description` do frontmatter de **toda** skill
  instalada, sempre no system prompt, **~100 tokens por skill**. Nível 2: corpo do `SKILL.md` (<5k tokens)
  só quando disparada. Nível 3: arquivos e scripts, só quando lidos — script executado por bash não entra
  no contexto, só a saída.
- **A seleção é o próprio modelo lendo descrições.** "The `description` is what Claude matches your
  request against when determining whether to trigger the Skill". Não há retrieval, embedding nem
  classificador.
- **Limites reais.** `name` ≤ 64 chars; `description` ≤ 1.024 chars na API. No Claude Code, o texto
  combinado `description` + `when_to_use` é **truncado em 1.536 caracteres** no listing. Precedência por
  nome: enterprise > pessoal > projeto > aninhado > plugin > claude.ai > bundled.
- **Custo é reconhecido como problema.** O Claude Code v2.1.129 introduziu um *skill listing budget*
  limitado por padrão a **1% do contexto**, truncando descrições quando há muitas skills **[I, fonte
  secundária]**; `/skill-doctor` reporta custo de contexto e frequência de uso por skill **[V, docs]**.
- **Confirmação empírica:** o system prompt desta própria sessão lista ~300 skills por nome+descrição, e
  várias descrições aparecem truncadas ou reduzidas a só o nome. **[V, observação direta]**

**Consequência direta para a ADE:** com dezenas a centenas de skills de catálogo, **o mecanismo nativo
não escala** — ou estoura o orçamento, ou trunca justamente as descrições que decidem. A ADE tem de fazer
a seleção **fora** da CLI e injetar só as vencedoras. Isso confirma a spec §9 e explica *por quê* em
números.

### 2.2 O que a literatura de tool retrieval diz

| Paper | Achado relevante | Confiança |
| :--- | :--- | :--- |
| **ToolRet** (ACL 2025, arXiv 2503.01763) | 7,6k tarefas / 43k ferramentas. nDCG@10: **NV-Embed-v1 33.83 > BM25 22.32 > ColBERT 19.46**. Todos os retrievers ficam <35% Completeness@10 e <52% recall@10. Reranking com MonoT5 **piorou** (33.83 → 28.92). Treinar no ToolRet-train dá +10–20% de pass rate ponta a ponta | **[V, fetch do HTML]** |
| **How Many Tools Should an LLM Agent See?** (arXiv 2605.24660) | Profundidade adaptativa: BFCL+BM25 K≈7.4 cobre 90.3% (equivalente a K=50 fixo); BFCL+embeddings K≈1.4 cobre 85%; ToolBench (3.251 ferramentas) K≈4.4. **Lista curta melhora a escolha do LLM: 93.1% de acerto vs 87.1% com K=5 fixo** (Claude Sonnet) | **[V, fetch do HTML]** |
| **Tools Are Under-Documented** (arXiv 2510.22670) | Expansão de documentação da ferramenta melhora retrieval | **[I, só título/abstract]** |
| **Risk-Aware Reranking for Agentic Tool Retrieval** (arXiv 2608.22751) | Retrieval que penaliza ferramenta de alto risco | **[I]** — casa com §3 (skill perigosa não deve ser candidata) |

Duas lições que contrariam o instinto: **(a)** embedding genérico bate BM25, mas não por muito, e ambos
são ruins em absoluto — a etapa de recall não vai resolver sozinha; **(b)** reranker cross-encoder
treinado para IR **atrapalha**, enquanto reduzir a lista e deixar o LLM escolher **ajuda**.

### 2.3 Pipeline recomendado para a v1

```
pedido + spec da story + domínios
        │
        ├─ (0) filtro duro: domínio, linguagem, plataforma, origem confiável   → descarta ~80%
        │
        ├─ (1) recall barato sobre ~/.ade/catalog/index.json
        │       BM25 local (nome + description + when_to_use + tags do caminho)
        │       top-8, sem rede, sem modelo                                     ~5 ms, $0
        │
        ├─ (2) seletor LLM: classificador barato recebe spec + as 8 descrições
        │       devolve JSON {skills: [≤3], motivo por skill, confiança}        ~1.5k in / 200 out
        │
        └─ (3) fecho: máx 3; skills do repo (.claude/skills) têm prioridade;
                dedup por (name, content_hash); registra escolha no journal
```

**Por que BM25 e não embeddings na v1.** A diferença medida no ToolRet é ~11 pontos de nDCG@10 a favor de
embeddings, mas embeddings exigem um modelo de embedding local ou uma chave de API — e a spec §2 fixa
"todas as chamadas pelos adapters de CLI, sem chave de API obrigatória". BM25 puro em TypeScript sobre um
índice de centenas de linhas cabe em ~80 linhas, roda em milissegundos e não adiciona dependência. **A
etapa (2) absorve o déficit de recall**, porque é exatamente o regime em que o paper 2605.24660 mede
ganho (lista curta → 93.1%). Upgrade path anotado: trocar (1) por híbrido BM25+embedding quando o
catálogo passar de ~500 skills ou quando `precision@3` medida cair abaixo de 0.7. **[I]**

**Por que não reranker.** ToolRet mostra reranker cross-encoder degradando o resultado, e um reranker
treinado seria uma dependência de ML que a ADE não quer. O "reranker" é o classificador da etapa (2).
**[V + I]**

**Custo esperado por story** (Haiku via `claude -p`, ordem de grandeza): entrada ~1.5–2k tokens (spec
resumida + 8 descrições de ≤1.536 chars), saída ~200 tokens. **[I]** É uma chamada por story no step
`prepare`, mais uma por lote no tradutor. Comparado a injetar 300 descrições × 100 tokens = ~30k tokens
**por turno** no modelo forte, a economia é de ordem de magnitude.

**Precisão esperada.** Ancoragem honesta: nenhum número publicado mede exatamente "escolher 1–3 skills
entre centenas para uma story de engenharia". O que existe: retrievers puros <52% recall@10 em ToolRet
**[V]**; lista curta + LLM em 93.1% de acerto de escolha em BFCL **[V]**. Alvo de v1, a ser medido e não
prometido: **recall@8 ≥ 0.85** na etapa (1) e **precision@3 ≥ 0.75** na saída, em fixtures próprias.
**[H]**

### 2.4 Medir precision/recall com fixtures

Sem isso, o pipeline é fé. O formato mais barato que funciona:

`tests/fixtures/skill-selection/<caso>.json`

```json
{
  "request": "quero melhorar o design do site",
  "story": {"id":"S01","spec":"Refazer a landing page com direção estética própria",
            "domains":["frontend","ui"],"files":["src/app/page.tsx"]},
  "catalog_snapshot": "fixtures/catalog/index-2026-09.json",
  "must_include": ["frontend-design"],
  "should_include": ["tl-impeccable-design", "ui-skills/typography"],
  "must_not_include": ["springboot-security", "proxmox-readonly-audit"]
}
```

Três níveis porque a verdade absoluta não existe: `must_include` é falha dura, `should_include` conta
para recall graduado, `must_not_include` é o que mede contaminação (o risco real de um catálogo grande:
skill parecida que sequestra a seleção).

Métricas por rodada de teste:

| Métrica | Definição | Portão sugerido v1 |
| :--- | :--- | :--- |
| `recall@8` (etapa 1) | fração de `must_include ∪ should_include` presente no top-8 do BM25 | ≥ 0.85 |
| `precision@3` (etapa 2) | fração das ≤3 escolhidas que estão em `must ∪ should` | ≥ 0.75 |
| `hard_miss` | qualquer `must_include` ausente da saída final | = 0 |
| `contamination` | qualquer `must_not_include` na saída final | = 0 |
| `cost_usd` | custo médio da etapa (2) | orçamento do lote |

A etapa (1) é determinística → testável com Vitest puro, sem rede, em CI. A etapa (2) chama modelo →
roda com CLI falsa em `fixtures/` (o padrão já previsto na spec §5) para o teste determinístico, e uma
vez por release contra o modelo real, como *dogfood*, com tolerância a ±1 skill. **[I]**

Dedup e versionamento: chave `(source_repo, path, name)`; conteúdo por `sha256(SKILL.md)`. Duas skills com
mesmo `name` de fontes diferentes → vence a precedência da spec §9 (repo > catálogo) e, dentro do
catálogo, a ordem declarada em `catalog.sources`; a perdedora fica no índice com `shadowed_by` para o
painel mostrar. Mudança de `content_hash` numa skill já aprovada no projeto **reabre a aprovação**
(defesa contra rug pull — §3). **[I]**

---

## 3. Segurança de skills: controles mínimos obrigatórios da v1

### 3.1 A base de incidentes (o que de fato aconteceu)

| Evidência | Números | Confiança |
| :--- | :--- | :--- |
| **Snyk ToxicSkills** — primeira auditoria ampla do ecossistema, 3.984 skills de ClawHub e skills.sh, corte em 2026-02-05 | **1.467 skills (36,82%) com alguma falha**; **534 (13,4%) críticas**; **76 payloads maliciosos confirmados** por revisão humana, **91% deles usando prompt injection**; 2,6% de todas as skills do ClawHub com injection; **17,7% com fetch de terceiros não confiável**; 10,9% com segredo hardcoded; 2,9% carregando instrução remota; **8 skills maliciosas ainda no ar** na publicação. Técnicas vistas: `curl \| bash` com ZIP protegido por senha, comandos base64 exfiltrando credenciais AWS, desativação de serviços de segurança, Unicode smuggling | **[V, blog Snyk]** |
| **Campanha coordenada no ClawHub** (OpenSourceMalware.com, fev/2026): 30+ skills maliciosas contra usuários de Claude Code e OpenClaw. Barreira de publicação: um `SKILL.md` e uma conta GitHub de uma semana; sem assinatura, sem revisão, sem sandbox | — | **[I, fonte secundária]** |
| **Skill injection em agentes de terminal** (arXiv 2606.01567v2) — mede ASR real | Baseline: **Claude Sonnet 4.5 + Claude Code = 36,0% de ASR**; DeepSeek-V4 + OpenCode 52,5%; Nemotron3 + OpenCode 12,2%. Defesa **só por system prompt**: 36,0% → 26,6% (e 23,0% mesmo com aviso-oráculo perfeito). **Static guardian** (reescrita da skill em build time): 36,0% → **7,2%**. **Dynamic guardian** (interceptação em runtime): 36,0% → 12,9%; contra ataques reformulados, 81,4% → 18,6%. Task success preservado (66–87%) | **[V, fetch do HTML]** |
| **MCP Tool Poisoning** (Invariant Labs, 2025-04-01): instrução maliciosa na *descrição* da ferramenta, invisível na UI e visível ao modelo; variantes **shadowing** (servidor malicioso altera o comportamento do agente frente a servidor confiável) e **rug pull** (descrição muda depois da aprovação). PoC reproduzível; caso WhatsApp exfiltrou histórico inteiro | — | **[V, blog Invariant]** |
| **Lethal trifecta** (Simon Willison, 2025-06-16): dado privado + conteúdo não confiável + canal de saída externo = exfiltração inevitável | — | **[V]** |
| **OWASP LLM Top 10 2025**: LLM01 Prompt Injection (nº 1 pela segunda edição), LLM03 Supply Chain — pede SBOM de IA, verificação de integridade por hash, auditoria de fornecedor | — | **[V]** |
| **MalSkillBench** (arXiv 2606.07131): scanners estáticos detectam substancialmente menos que verificação em runtime | **[I, extração parcial]** |

Leitura crua: **prompt injection não tem defesa confiável** — "quase todas as defesas existentes ou não
são seguras o bastante ou sofrem de over-defense" **[I, literatura de 2026]**. Logo, a v1 não aposta em
detecção; aposta em **contenção e em reduzir a superfície**.

### 3.2 Lista mínima obrigatória na v1

Cada linha existe porque bloqueia um ataque **documentado**, não por higiene genérica.

| # | Controle | O ataque real que ele bloqueia | Custo de implementação |
| :--- | :--- | :--- | :--- |
| **C1** | **Allowlist de fontes**: só repositórios declarados em `catalog.sources` sincronizam; `awesome-*` entra como lista de links, cada link vira fonte declarada explicitamente | Campanha do ClawHub (30+ skills maliciosas publicadas por contas novas) e os 8 payloads ainda vivos na auditoria Snyk | Baixo — já na spec §9 |
| **C2** | **Pin por hash + reaprovação na mudança**: `sha256(SKILL.md)` e de todo arquivo do bundle no índice; mudança de hash de skill já aprovada no projeto volta ao resumo de aprovação | **Rug pull** (Invariant): descrição/corpo alterados depois do consentimento | Baixo — um campo e uma comparação |
| **C3** | **Sanitização estática em tempo de sincronização** (*static guardian*): normalizar Unicode (NFKC), rejeitar caracteres invisíveis/tags, decodificar e sinalizar base64, marcar `curl\|bash`, `Invoke-WebRequest`, URLs externas, referência a `~/.aws`, `~/.ssh`, `.env`, `credentials`, `keychain`. Skill sinalizada entra **em quarentena**: fica no índice, não é candidata até aprovação explícita | É a defesa **com melhor número medido**: ASR 36,0% → **7,2%** (arXiv 2606.01567). Cobre Unicode smuggling e base64-exfil da Snyk | Médio — regex + normalização; ~200 linhas |
| **C4** | **Skill de catálogo é leitura, nunca execução**: o engine nunca roda script do catálogo; `scripts/` do bundle não é exposto ao agente na v1 | 13,4% de skills com issue crítica, `curl\|bash` com ZIP protegido por senha (Snyk); MalSkillBench mostra que estático não pega tudo → não executar é o único controle com 100% de eficácia | Baixo — já na spec §9, item (3) |
| **C5** | **`contain` inviolável**: escrita restrita a `scope_paths` da story, mesmo que a skill instrua o contrário; worktree isolado | Skill que manda editar `~/.claude/settings.json`, `.git/hooks`, memória do agente ou outro repo (padrão "scope escalation") | Baixo — já é comportamento do runtime |
| **C6** | **Corte da lethal trifecta por papel**: agente com skill de catálogo no contexto **não** recebe, na mesma chamada, (a) segredos/`.env` do repo e (b) efeito de rede/push. Push, PR e merge são executados pelo **engine**, nunca pelo worker — regra já existente no runtime | Trifecta de Willison; exfiltração do caso WhatsApp; exfil de credencial AWS via base64 (Snyk) | Baixo — o runtime já proíbe worker rodar `git`/`gh` |
| **C7** | **Primeira aparição exige aprovação**: skill nova no projeto aparece no resumo de aprovação, com fonte, hash e flags do C3 | Supply chain LLM03 do OWASP; "typosquat" de nome parecido | Baixo — já na spec §9 |
| **C8** | **Achado de pesquisa e conteúdo de skill são dados, nunca instruções**: delimitação explícita no prompt + regra de que URL/ação sugerida por conteúdo de terceiro não vira efeito sem passar por portão | LLM01; tool poisoning por descrição (Invariant) | Baixo — contrato de prompt |
| **C9** | **Teto de 3 skills por story e log da escolha no journal** | Reduz superfície e dá rastro para auditoria pós-incidente (qual skill estava em contexto quando a árvore ficou estranha) | Trivial |

**Deixado de fora da v1, deliberadamente:**

- *Dynamic guardian* (interceptação em runtime). Mede 12,9% de ASR — pior que o estático (7,2%) em
  ataque direto, melhor em ataque reformulado — e exige um proxy MCP. Entra no backlog v2 se o C3
  mostrar furo. **[V + I]**
- Sandbox de FS do worker: já está no backlog v2 da spec; o `contain` + worktree cobre o caso comum.
- Scanner terceirizado (`mcp-scan` da Invariant, 3.053 estrelas, ativo em 2026-09-15 **[V, API GitHub]**):
  candidato para o passo de sincronização em v2; na v1 o C3 caseiro é mais barato do que integrar e
  manter uma dependência Python.

Nenhum desses controles promete parar prompt injection. Eles garantem que uma injeção bem-sucedida não
tenha o que roubar nem para onde mandar.

---

## 4. Terminais: node-pty, ConPTY e "assumir o terminal"

### 4.1 node-pty no Windows 11 em 2026 — os fatos

**[V, API do GitHub em 2026-09-16]**

- `microsoft/node-pty`: 2.027 estrelas, push em 2026-09-14, **62 issues abertas**, e a última release é
  **`v1.2.0-beta.15` (2026-08-03)**. A série 1.2.0 está em beta desde pelo menos beta.8 — **não há 1.2.0
  estável**.
- Bugs abertos de ConPTY no Windows, por número (todos de 2026 salvo indicado):

| Issue | Data | Efeito |
| :--- | :--- | :--- |
| **#967** | 2026-09-12 | `kill()` pode **matar um processo alheio** até 5 s depois, via fallback de PID puro no timeout de `_getConsoleProcessList` |
| **#965** | 2026-09-08 | O pseudoconsole nunca é fechado na saída natural do shell → **vaza um `conhost.exe` por PTY** |
| **#960** | 2026-08-25 | Evento `error` não tratado em `conout`/`conin` + re-throw **derruba o processo hospedeiro** |
| **#955** | 2026-08-18 | beta.15: o processo do terminal sai **antes do primeiro write** (beta.14 está bom) |
| **#952** | 2026-08-16 | Corrida entre o agente de console-list e o teardown do pseudoconsole; a varredura de processos órfãos não roda |
| **#951** | 2026-08-16 | Callback de saída ConPTY/TSFN aborta o processo no teardown do ambiente |
| **#947** | 2026-08-07 | Vaza um handle de socket `conin` por PTY no caminho de `kill()` |
| **#894** | 2026-03-11 | Atraso de saída de **~3,5 s** com `useConptyDll: true` + PowerShell 7 |
| **#887** | 2026-02-09 | Thread worker `ConoutConnection` impede o Node de sair depois de `kill()` |
| **#904** | 2026-03-27 | SIGABRT no encerramento (corrida de cleanup de ThreadSafeFunction) |
| **#827** | 2025-12-05 | Crash no Node 22: "Cannot resize a pty that has already exited" |

Padrão claro: **o caminho quente é o ciclo de vida (kill/exit/teardown), não o I/O**. Um painel que abre e
fecha PTYs o dia inteiro — exatamente o caso da ADE — bate em #965, #947, #952 e #967.

### 4.2 Alternativas avaliadas

| Opção | Estado | Veredito |
| :--- | :--- | :--- |
| **`@lydell/node-pty`** | 32 estrelas, 1 issue aberta, push 2026-08-08, acompanha as mesmas tags beta **[V, API GitHub]**. O próprio README diz que é fork de **empacotamento** (só binários da plataforma atual, sem node-gyp), e que perde razão de existir quando o upstream fizer o mesmo **[V, README]** | **Não resolve nada.** Mesmos bugs de ConPTY, herdados. Vale só pelo tamanho do pacote |
| **`bun-pty` / `portable-pty` (Rust)** | `bun-pty` é para runtime **Bun**, via FFI sobre a crate `portable-pty`; existem 4+ forks concorrentes em npm, sinal de imaturidade; `Bun.Terminal` nativo **não suporta Windows** (oven-sh/bun#25565) **[I/V]** | **Fora.** A spec §3 fixa Node 22 LTS; trocar runtime para ganhar PTY é o oposto de preguiçoso |
| **`portable-pty` via napi-rs** (binding próprio) | Crate madura, usada pelo WezTerm | Custo alto (toolchain Rust, build matrix, manutenção de binding). **Backlog**, se a v1 sangrar |
| **tmux como backend** (padrão do Claude Squad: "tmux para sessões isoladas + git worktrees para isolar código" **[V, README]**) | No Windows exige WSL ou MSYS2 | **Fora da v1 no Windows**, mas é a rota de escape se node-pty inviabilizar |
| **`claude --tmux` / `--worktree`** | Nativo na CLI: `-w/--worktree [name]` cria worktree para a sessão; `--tmux` cria sessão tmux para o worktree (panes nativos do iTerm2 quando disponível) **[V, `claude --help` local]** | Existe, mas é caminho específico de uma família |

**Veredito da decisão 4.** `node-pty` **é viável na v1** — é o que o VS Code e praticamente todo o
ecossistema usam, e o I/O funciona. **Não é robusto**, e a fragilidade é no encerramento. Mitigações
obrigatórias, todas baratas:

1. **Pinar `v1.2.0-beta.14`**, não beta.15 (#955 é regressão de saída antes do primeiro write). **[V]**
2. `process.on('error')` explícito em `conin`/`conout` e um `try/catch` no handler — cobre #960 e #942.
3. **Nunca depender do `kill()` para matar a árvore.** O engine mata pelo PID da CLI que ele mesmo criou
   (`taskkill /T /F /PID` no Windows), e `pty.kill()` é só best-effort. Cobre #967, o pior bug (mata PID
   alheio).
4. **Varredura de órfãos no `ade doctor` e no shutdown**: contar `conhost.exe` cujo pai morreu (#965) e
   reportar. Não corrigir automaticamente na v1 — reportar.
5. **Teto de PTYs simultâneos** (concorrência 1 na v1 já ajuda) e reciclagem do processo `ade serve` como
   último recurso documentado.
6. `useConptyDll` **desligado por padrão** (#894: 3,5 s de atraso com PowerShell 7); flag de config para
   quem quiser.
7. `@xterm/xterm` está em **6.0.0** **[V, tags do repo]** — validar que o par node-pty 1.2.0-beta ↔
   xterm 6 é o que o VS Code usa antes de fixar.

Marcar no código: `// ponytail: node-pty beta pinado; kill por taskkill /T porque pty.kill() pode acertar PID alheio (microsoft/node-pty#967). Upgrade: portable-pty via napi se vazar conhost em produção.`

### 4.3 O que "assumir o terminal" exige de cada CLI (verificado no binário local)

| Capacidade | `claude` 2.1.271 | `codex-cli` 0.154.0 | `gemini` 0.59.0 |
| :--- | :--- | :--- | :--- |
| Headless com JSON | `-p --output-format json\|stream-json` **[V]** | `codex exec --json` (JSONL) + `--output-schema <FILE>` **[V]** | `-p --output-format text\|json\|stream-json` **[V]** |
| **Retomar por id** | `--resume <session-id>` + `--session-id <uuid>` para fixar o id na criação **[V]** | `codex resume <SESSION_ID>` (UUID ou nome) ou `--last` **[V]** | **`--resume` aceita só `"latest"` ou índice numérico**; `--session-id <uuid>` só cria sessão nova **[V]** |
| Forkar em vez de continuar | `--fork-session` **[V]** | `codex fork` **[V]** | ausente **[V]** |
| Worktree nativo | `-w/--worktree [name]` **[V]** | ausente (usa cwd) | `-w/--worktree [name]` **[V]** |
| Sessão em background gerenciada | `--bg`, `claude agents --json`, `attach <id>`, `logs <id>`, `stop <id>`, `respawn`, `rm <id>` **[V]** | `codex agents`, `app-server`, `remote-control`, `codex queue` **[V]** | ausente **[V]** |
| Revisão não-interativa nativa | `claude ultrareview [target]` (multi-agente, na nuvem) **[V]** | `codex review --base <branch> \| --commit <sha> \| --uncommitted` **[V]** | ausente |
| Escopo de ferramentas | `--allowedTools`, `--tools`, `--restricted`, `--permission-mode` **[V]** | `--sandbox <mode>`, `codex sandbox`, `--full-auto` **[V]** | `--approval-mode`, `--policy/--admin-policy` (Policy Engine; `--allowed-tools` **deprecado**) **[V]** |
| Skills | `~/.claude/skills`, `.claude/skills`, plugins **[V]** | plugins **[V]** | **`gemini skills`** (subcomando de gestão) **[V]** |

**O contrato mínimo de "assumir o terminal"** (pausar headless → relançar interativo no mesmo worktree
com o mesmo histórico → devolver ao engine):

1. **Checkpoint antes de soltar.** `git` grava `tree_before` (já é o modelo do runtime). O que o operador
   digitar não é interpretado; só a árvore resultante conta. **[V, spec §5 + RUNTIME.md]**
2. **Id de sessão estável, criado pela ADE.** Em `claude` e `codex` isso é limpo: a ADE gera o UUID
   (`--session-id`) ou lê o id do primeiro evento JSON. Em `gemini`, **não existe resume por id** — só
   índice relativo ao projeto, que muda quando outra sessão é criada. **Fragilidade real.**
3. **Mesmo cwd.** Todos aceitam. `codex` não tem `--worktree`, mas a ADE já cria o worktree e passa o cwd.
4. **Transição de modo no mesmo processo é impossível**: as três CLIs exigem **relançar** o binário em
   modo interativo. Ou seja, "assumir" é sempre `kill headless → spawn interativo com resume` — o que
   torna o item 1 obrigatório e explica por que a regra "só o resultado na árvore conta" é a única
   robusta.

**Onde é frágil, em ordem de risco:**

| Risco | Evidência | Degradação |
| :--- | :--- | :--- |
| **Gemini não retoma por id** | `gemini --help`: `--resume` = `"latest"` ou índice **[V]** | Adapter `gemini` degrada para "sessão nova no worktree + prompt 'continue do checkpoint'"; journal grava `resume_mode: "fresh"`. Já previsto em §16, agora com causa concreta |
| **Fidelidade do resume não é verificável** | Nenhuma CLI expõe hash do histórico restaurado **[V, ausência nos `--help`]** | Regra: nunca confiar no contexto retomado para decidir portão; o portão relê a árvore |
| **Saída ANSI do modelo é vetor de ataque** | `gemini --raw-output`: "WARNING: This can be a security risk if the model output is untrusted" **[V]** | Nunca usar `--raw-output`; o xterm.js do painel renderiza só o que o PTY entregou com sanitização padrão |
| **Ciclo de vida do PTY no Windows** | §4.1 | §4.2, itens 1–6 |
| **Formato de saída muda entre versões** | `codex exec --json` é JSONL; `claude` tem `--include-partial-messages` **[V]** | CLIs falsas em `fixtures/` cobrindo saída normal, truncada, sem custo e com ANSI — já na spec §15 |
| **PATH no Windows** | `claude` resolve para `claude.cmd` **[V, contexto do projeto]** | `ade doctor` resolve e grava o caminho absoluto |

### 4.4 Como os concorrentes fazem (e o que copiar)

| Ferramenta | Arquitetura | O que aproveitar |
| :--- | :--- | :--- |
| **Claude Squad** (8.483 ★, Go, push 2026-08-20 **[V]**) | "**tmux** para criar sessões de terminal isoladas por agente" + "**git worktrees** para isolar bases de código, cada sessão na própria branch"; tecla `r` = resume de sessão pausada **[V, README]** | O par tmux+worktree é o design de referência. No Windows, tmux é o custo; node-pty é o substituto |
| **Vibe Kanban** (28.092 ★, **Rust**, push 2026-09-15 **[V]**) | Worktree por task, limpeza de worktrees órfãos configurável (`DISABLE_WORKTREE_CLEANUP`) **[V, README]**. Bloop anunciou encerramento em 2026-04-10; segue comunitário **[I]** | **Limpeza de worktree órfão é problema real o bastante para virar env var.** A ADE precisa do equivalente no `ade doctor` |
| **Conductor** (app Mac) | Worktree por workspace, diff viewer, fluxo de PR **[I]** | Confirma que o diff/PR é a unidade de revisão, não o terminal |
| **Claude Code nativo** | `--bg` + `claude agents --json` + `attach`/`logs`/`stop`/`respawn`/`rm` + `--teleport` + `--worktree` + `--tmux` **[V, help local]** | **Maior achado prático desta seção**: a ADE pode delegar ciclo de vida de sessão Claude à própria CLI e usar PTY só para espelhar/assumir, reduzindo o número de PTYs vivos — e com isso a exposição aos bugs de §4.1 |

---

## 5. Contradições com a spec v2 e com o prompt

1. **"Codex é o melhor revisor" (§13) não sobrevive ao único benchmark executável de revisão.** CR-bench:
   Claude Code 32.1% vs Codex 20.1% de pass rate. O que sobrevive é "Codex é o mais **preciso**" (88% vs
   78% de comentários úteis). A matriz de capacidades deve passar a distinguir **Checker de rodada**
   (precisão) de **Checker de portão** (cobertura). **[V]**
2. **"Claude implementação / Gemini contexto" não tem benchmark que discrimine.** SWE-bench Verified tem o
   topo empatado em ~1 ponto e Terminal-Bench 2.x está saturado. Manter a tabela de §13 é legítimo, mas
   ela é **decisão de produto justificada por ferramental**, não por evidência de benchmark — e o
   documento precisa dizer isso. **[V/I]**
3. **§5 afirma que o acesso consumidor do Gemini CLI acabou em 2026-06-18.** Nesta máquina, `gemini
   0.59.0` responde a `--help` com um conjunto de flags novo (Policy Engine, `gemini skills`, `gemini
   gemma`, `--acp`). O `ade doctor` deve **testar uma chamada real**, não inferir da data. **[V]**
4. **§11 (painel Agents) sobrepõe funcionalidade que o Claude Code já entrega** (`--bg`, `agents`,
   `attach`, `respawn`, `--worktree`, `--tmux`). Construir tudo do zero é trabalho que a CLI já fez.
5. **§9 assume implicitamente que o listing de skills da CLI aguenta o catálogo.** Não aguenta: o Claude
   Code trunca em 1.536 chars e orça ~1% do contexto. A seleção **precisa** ser externa — o que a spec já
   diz, mas por outro motivo (economia); o motivo mais forte é que o mecanismo nativo **falha em escala**.
   **[V]**
6. **O prompt pede "embeddings vs BM25 vs LLM classifier".** A literatura diz que a pergunta está mal
   posta: ambos os retrievers são ruins (<52% recall@10) e o reranker clássico piora. O ganho está em
   **encurtar a lista** antes do LLM. **[V]**
7. **Claude Code tem um roteador próprio** (`claude auto-mode`, com `config`/`defaults`/`critique`/
   `reset` e regras allow/soft_deny/hard_deny em linguagem natural, ~57 KB de política padrão nesta
   instalação **[V, execução local]**). Ele roteia **permissões**, não modelos — mas é precedente direto
   de "classificador de política declarativo dentro da CLI", e o Capability Registry não deve duplicá-lo.

---

## 6. Fontes

**Roteamento**
- RouteLLM (paper): https://arxiv.org/pdf/2406.18665
- RouteLLM (blog LMSYS, 2024-07-01): https://www.lmsys.org/blog/2024-07-01-routellm/
- RouteLLM (repo): https://github.com/lm-sys/RouteLLM
- LiteLLM — Routing & Load Balancing: https://docs.litellm.ai/docs/routing-load-balancing
- LiteLLM — Router: https://docs.litellm.ai/docs/routing
- OpenRouter — como funciona o roteamento: https://openrouter.ai/blog/insights/model-routing/
- OpenRouter Auto Router (KB, 403 na coleta): https://openrouter.zendesk.com/hc/en-us/articles/47463293706395-What-is-the-Auto-Router-and-how-does-it-choose-a-model
- Claude Code Router: https://github.com/musistudio/claude-code-router
- Not Diamond — awesome-ai-model-routing: https://github.com/Not-Diamond/awesome-ai-model-routing
- LLMRouterBench: https://arxiv.org/pdf/2601.07206
- Dynamic Model Routing and Cascading (survey): https://arxiv.org/pdf/2603.04445
- Rerouting LLM Routers (ataques a routers): https://arxiv.org/pdf/2501.01818

**Benchmarks de capacidade**
- Code Review Agent Benchmark (CR-bench / c-CRAB): https://arxiv.org/abs/2603.23448 · https://arxiv.org/html/2603.23448v3
- Terminal-Bench 2.1 (llm-stats): https://llm-stats.com/benchmarks/terminal-bench-2.1
- Terminal-Bench 2.0 (llm-stats): https://llm-stats.com/benchmarks/terminal-bench-2
- Terminal-Bench oficial (hoje na 4.0): https://www.tbench.ai/leaderboard
- SWE-bench Verified (llm-stats): https://llm-stats.com/benchmarks/swe-bench-verified
- Vals AI: https://www.vals.ai/home
- Stop Comparing LLM Agents Without Disclosing the Harness: https://arxiv.org/pdf/2605.23950
- GPT-5.6 (OpenAI): https://openai.com/index/gpt-5-6/
- GPT-5.5 (OpenAI): https://openai.com/index/introducing-gpt-5-5/
- GPT-5.3-Codex (OpenAI): https://openai.com/index/introducing-gpt-5-3-codex/

**Skills: descoberta e seleção**
- Agent Skills — overview (Anthropic): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Skill authoring best practices: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Skills no Claude Code: https://code.claude.com/docs/en/skills
- Skills for enterprise (content scanning): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise
- Vercel skills (CLI/registry): https://github.com/vercel-labs/skills · https://www.skills.sh/docs · https://vercel.com/docs/agent-resources/skills
- ToolRet — Retrieval Models Aren't Tool-Savvy (ACL 2025): https://arxiv.org/html/2503.01763 · https://github.com/mangopy/benchmarking-tool-retrieval
- How Many Tools Should an LLM Agent See? A Chance-Corrected Answer: https://arxiv.org/html/2605.24660v1
- Tools Are Under-Documented: https://arxiv.org/pdf/2510.22670
- Risk-Aware Reranking for Agentic Tool Retrieval: https://arxiv.org/html/2608.22751v1
- Tool-Adaptive LLM Reranker: https://arxiv.org/abs/2607.10555
- The 99% Success Paradox: https://arxiv.org/pdf/2605.18857

**Segurança de skills e prompt injection**
- Snyk ToxicSkills: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/
- Defenses & Enablers For Skill Injection Attacks on Terminal Based Agents: https://arxiv.org/html/2606.01567v2
- MalSkillBench: https://arxiv.org/pdf/2606.07131
- Skill-Inject: https://arxiv.org/pdf/2602.20156
- Behavioral Integrity Verification for AI Agent Skills: https://arxiv.org/pdf/2605.11770
- Invariant Labs — MCP Tool Poisoning: https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- Invariant Labs — PoCs: https://github.com/invariantlabs-ai/mcp-injection-experiments
- mcp-scan: https://github.com/invariantlabs-ai/mcp-scan
- Simon Willison — The lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Simon Willison — MCP prompt injection: https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/
- OWASP Top 10 for LLM Applications 2025: https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/
- OWASP LLM01 Prompt Injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- OWASP LLM03 Supply Chain: https://genai.owasp.org/llmrisk/llm032025-supply-chain/
- MCPTox: https://arxiv.org/pdf/2508.14925
- AgentDyn: https://arxiv.org/html/2602.03117v1
- Adaptive Evaluation of Out-of-Band Defenses Against Prompt Injection: https://arxiv.org/pdf/2606.26479

**Terminais**
- microsoft/node-pty: https://github.com/microsoft/node-pty
- node-pty #967 (kill acerta PID alheio): https://github.com/microsoft/node-pty/issues/967
- node-pty #965 (vaza conhost.exe): https://github.com/microsoft/node-pty/issues/965
- node-pty #960 (erro não tratado derruba o host): https://github.com/microsoft/node-pty/issues/960
- node-pty #955 (regressão beta.15): https://github.com/microsoft/node-pty/issues/955
- node-pty #894 (atraso com useConptyDll + PowerShell 7): https://github.com/microsoft/node-pty/issues/894
- @lydell/node-pty: https://github.com/lydell/node-pty · https://www.npmjs.com/package/@lydell/node-pty
- xterm.js: https://github.com/xtermjs/xterm.js
- portable-pty (Rust): https://docs.rs/portable-pty
- bun-pty: https://github.com/sursaone/bun-pty · https://www.npmjs.com/package/bun-pty
- Bun.Terminal no Windows (não suportado): https://github.com/oven-sh/bun/issues/25565
- Claude Squad: https://github.com/smtg-ai/claude-squad
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban

**Verificações locais (sem URL)**
- `claude --help`, `claude auto-mode config|defaults`, `claude agents --help` — Claude Code 2.1.271
- `codex --help`, `codex exec --help`, `codex resume --help`, `codex review --help` — codex-cli 0.154.0
- `gemini --help` — Gemini CLI 0.59.0
- `gh api` sobre `microsoft/node-pty`, `lydell/node-pty`, `xtermjs/xterm.js`, `lm-sys/RouteLLM`,
  `musistudio/claude-code-router`, `vercel-labs/skills`, `invariantlabs-ai/mcp-scan`,
  `smtg-ai/claude-squad`, `BloopAI/vibe-kanban` — 2026-09-16
