# TL-ADE — Skill Fabric (spec do componente C16)

Data: 2026-09-17. Componente C16 de `architecture.md` §3; decisão em
`docs/adr/0009-skill-fabric-catalogo-curado-selecao-12-controles.md`. Detalha o que
`architecture.md` §7 declara; não repete as decisões, as implementa. Registro de fontes:
`docs/catalog-sources.md`. Entrega: **v0.4** (`docs/roadmap.md`), com `~/.ade/catalog/` e
`ade catalog sync` já existindo como diretório vazio e comando no-op desde a v0.2, para que o schema
do journal (`catalog_sync`) não mude depois.

Tese do componente: o catálogo de skills é uma **dependência de terceiro que entra no prompt de um
agente com permissão de escrita**. Tratado como supply chain, não como conteúdo.

---

## 1. Fontes e licenças

O catálogo é **allowlist fechada**: só sincroniza o que está em `catalog.sources` de
`~/.ade/config.json`, e cada entrada declara `repo`, `commit`, `paths` (glob de ingestão) e
`license_policy`. Sem descoberta automática, sem ingestão por link de lista "awesome", sem
`npx skills add`, sem ClawHub. Matriz completa por fonte em `docs/catalog-sources.md` §1; aqui só o que
muda o comportamento do `sync`:

| Fonte | Licença | Decisão | `paths` de ingestão | Regra específica do ingest |
| :--- | :--- | :--- | :--- | :--- |
| `anthropics/skills` | **por skill**: 15 Apache-2.0, 4 Proprietary | ADOPT parcial | `skills/**` | **Denylist `docx`/`pdf`/`pptx`/`xlsx`** — o texto proíbe "retain copies outside the Services" (digest #12). Sem LICENSE de repo: licença lida por skill, no frontmatter |
| `affaan-m/ECC` | MIT | ADAPT | `skills/**` | 292 skills reais, não 903 (digest #12). Nunca `install.sh`, `hooks/` nem instaladores por CLI. 124 scripts dentro de `skills/` → quarentena |
| `addyosmani/agent-skills` | MIT, raiz | ADAPT | `skills/**` | **Nunca `hooks/`**: `SessionStart` injeta um `SKILL.md` inteiro em toda sessão e `simplify-ignore.sh` reescreve arquivos do usuário no disco durante `Read`/`Edit`. O valor principal é o framework de evals (§9) |
| `ibelick/ui-skills` | MIT | ADOPT | `skills/**` | Zero scripts no escopo de skill |
| `ayghri/i-have-adhd` | MIT | ADOPT | `skills/**` | Precedente de `metadata: {tags, category}` + `disable-model-invocation: true`, campos que o `SkillIndexEntry` lê |
| `UditAkhourii/adhd` | MIT | ADOPT (a skill) | `skills/**` | Descrição com **gate negativo explícito** — o modelo de descrição que o detector de colisão (§9) premia |
| `img2threejs/img2threejs` | Apache-2.0 | ADAPT, dormente | `skills/**` | Corpo de 8,2k tokens estoura o teto por skill (§7): fora do índice até haver domínio 3D |
| `FloWritesCode/fwc-swiftui-skills` | MIT | ADOPT, dormente | `skills/**` | Zero scripts, a fonte mais limpa medida. Fora do índice até existir projeto Apple |
| `agentskills/agentskills` | Apache-2.0 | ADOPT como **ferramenta** | — | Fornece `skills-ref validate` (controle 4). Não vira skill do catálogo |
| `superpowers` + skills locais de Erick | local | **trust: local** | — | Lidas in-place em `~/.claude/skills/**` e `<repo>/.claude/skills/**`; não sincronizam, não têm sha256 de pin. Precedência acima do catálogo (§6) |
| `openai/skills` | **ausente** | REFERENCE | — | Sem licença declarada = mesmo bloqueio legal do Composio (digest #12). **Não sincroniza até resolver** |
| `ComposioHQ/awesome-claude-skills` | **ausente** | REJECT | — | 864 `SKILL.md` vendorizados, 832 wrappers do Rube MCP, e `document-skills/` redistribui as 4 proprietárias num repo sem LICENSE. ADR 0019 |
| `vercel-labs/skills` | MIT | REFERENCE | — | Instalador de registry aberto: proibido pelo controle 1 |

**Contradição aparente que não é.** O FQE usa `$imagegen`, que vem de `openai/skills` em
`~/.codex/skills/.system/` (digest #20). A ADE não **copia** a skill para `~/.ade/catalog/`: invoca
`codex exec` num ambiente onde o fornecedor já a instalou. A denylist é sobre redistribuição, não sobre
uso in-place da instalação oficial.

**Alvo do catálogo**: 60–80 skills relevantes para a stack, de ~320 nomes de qualidade em ~1.188
`SKILL.md` brutos (digest #13). ~75 % do volume bruto é ruído: espelho, template e cópia.

---

## 2. Estrutura de `~/.ade/catalog`

```
~/.ade/catalog/
  sources/<nome>@<commit>/      # árvore byte-idêntica ao upstream, só os paths da allowlist
    skills/<id>/SKILL.md
    skills/<id>/references/...
  index.json                    # { format_version, built_at, engine_stamp, entries: SkillIndexEntry[] }
  quarantine/<nome>@<commit>/   # skill que falhou controle 5 ou 6; fica fora do índice de seleção
  .lock/                        # lease de sync (mesmo mecanismo do C3)
```

`SKILL.md` no catálogo é **byte-idêntico ao upstream** — condição para o sha256 do pin significar algo
e para `skills-ref validate` continuar passando. A extensão da ADE mora em `index.json`
(`SkillIndexEntry`, `architecture.md` §4), nunca dentro do arquivo de terceiro. `<commit>` no caminho
torna duas versões coexistentes um fato de disco: rollback é apontar `catalog.sources` para o commit
anterior, sem re-fetch. `index.json` é derivado e reconstruível (`ade catalog sync --rebuild-index`) —
não é fonte de verdade de nada.

---

## 3. `ade catalog sync`

Um step com `effect_class: 'catalog_sync'` (`architecture.md` §6), write-ahead: `step_intent` com o
conjunto de `(source, commit_alvo)` e o digest da política antes de tocar a rede. Retomada de sync
interrompido é `released` — a árvore é endereçada por commit, refazer é idempotente.

| Fase | O que faz | Falha |
| :--- | :--- | :--- |
| 0 `resolve` | Lê `catalog.sources`; recusa fonte fora da allowlist e fonte sem `commit` pinado | `catalog_source_not_allowlisted` |
| 1 `fetch` | `git fetch --depth 1 origin <commit>` em cache bare por fonte. **Nunca `pull`, nunca `main`** | rede indisponível → `awaiting_operator`, nunca retry (mesma regra de push, §6 da arquitetura) |
| 2 `checkout` | Materializa em `sources/<nome>@<commit>/` **só os `paths` declarados**; `install.sh`, `hooks/`, `scripts/` de contribuinte e `.github/` nunca chegam ao disco | `catalog_path_outside_allowlist` |
| 3 `hash` | sha256 por arquivo; comparação contra o índice anterior | hash mudou em skill já aprovada → reabre aprovação (controle 2) |
| 4 `license` | `license` do frontmatter; ausente ou não-permissiva → não entra | `skill_license_blocked` |
| 5 `validate` | `skills-ref validate <dir>` (commit pinado de `agentskills/agentskills`) | `skill_invalid_structure` |
| 6 `scan` (SkillGuard) | Sanitização estática, controle 5 | achado → `quarantine/` |
| 7 `classify` | Domínios/linguagens/famílias/tags por regra determinística sobre caminho + frontmatter; chamada barata só para skill nova sem domínio inferível | custo medido, nunca assumido (digest #26) |
| 8 `index` | Escreve `index.json` com `engine_stamp`; `body_tokens` medido | — |

Sync nunca roda automático: é comando do operador ou resultado explícito de `ade doctor --fix`. Missão
em andamento com `runtime_stamp` divergente do índice é `stale_workflow_version` (ADR 0021).

---

## 4. `ade catalog list|inspect`

`list` filtra por `--domain/--trust/--source` e imprime `id`, fonte, commit curto, licença, `trust`,
`body_tokens`, `has_scripts`. `inspect <id>` imprime frontmatter, caminho, sha256, achados do
SkillGuard e motivo da quarentena — **não** o corpo, salvo `--body`: o corpo de uma skill em quarentena
é exatamente o que não se quer colar num terminal onde outro agente possa lê-lo.

---

## 5. Os 12 controles de supply chain

Evidência de base: Snyk **ToxicSkills** (2026-02-05): 3.984 skills de ClawHub e skills.sh, **36,82 %
com ao menos uma falha**, 13,4 % críticas, **76 payloads maliciosos confirmados**, **91 % via prompt
injection** (`ref-skill-sources.md` §6; `landscape-routing-skills-terminal.md` §3). Categorias
nomeadas: malware, exfiltração em base64, desativação de gates por jailbreak, roubo de credencial AWS,
**comprometimento persistente por manipulação da memória do agente**.
`judgment-J3-durability-security-cost.md` §4 registrou que cinco destes (2 por commit, 3, 4, 8, 12)
não apareciam em nenhuma das três propostas do painel.

| # | Controle | Ataque documentado que bloqueia | Onde é implementado |
| :-- | :--- | :--- | :--- |
| 1 | **Allowlist de fontes**; nunca ClawHub, nunca registry aberto, nunca seguir link de lista "awesome" | Campanha coordenada no ClawHub (30+ skills maliciosas, conta GitHub de uma semana, sem assinatura nem revisão); 8 payloads ainda no ar na publicação da Snyk | `sync` fase 0; `catalog.sources` no `ade-config.schema.json`. Nenhum caminho de código escreve em `sources/` fora do `sync` |
| 2 | **Pin por commit + sha256 por arquivo**; fetch + checkout do SHA, nunca `pull` | **Rug pull**: repositório legítimo comprometido ou reescrito depois do consentimento. O ECC empurrou commits em 2026-09-12 e 09-15, dentro da janela da própria pesquisa | `sync` fases 1–3; campos `commit`/`sha256` do índice. Hash novo em skill aprovada reabre a aprovação do controle 10 |
| 3 | **Licença por skill, não por repositório**; sem licença ou proprietária não entra | `anthropics/skills` sem LICENSE de repo com 4 skills proprietárias; Composio sem licença nenhuma redistribuindo essas 4; `openai/skills` sem licença (digest #12) | `sync` fase 4. Gate legal: falha dura, sem override por flag |
| 4 | **Validação estrutural** (`skills-ref validate`, Apache-2.0, pinado) | Campo de topo inventado (`requires:` do Composio) quebra validador estrito e vira canal de metadado não previsto; `name` divergente do diretório é vetor de typosquat | `sync` fase 5, subprocesso pelo Runner sob o mesmo firewall de saída (C11) |
| 5 | **Sanitização estática (SkillGuard)**: NFKC, rejeita invisíveis e tags Unicode, decodifica e sinaliza base64, marca `curl\|bash`/`Invoke-WebRequest`, URL fora da allowlist, referência a `~/.ssh`, `~/.aws`, `.env`, `credentials`, `keychain`, e instrução para desabilitar gate | **A defesa com melhor número medido**: ASR 36,0 % → **7,2 %** em build time, contra 12,9 % de interceptação em runtime e 26,6 % de defesa só por system prompt (arXiv 2606.01567v2; digest #34). Cobre Unicode smuggling e base64-exfil da Snyk | `sync` fase 6; `packages/core/src/skills/skillguard.ts` (~200 linhas de regex + normalização). Achado → `quarantine/` |
| 6 | **Quarentena por padrão para skill com `scripts/`**; `trust` sobe só por revisão humana | 124 scripts dentro de `skills/` no ECC; 13,4 % de skills com issue crítica; MalSkillBench mostra que scanner estático não pega tudo | `has_scripts` + `trust` no índice; `ade catalog inspect` é a tela de revisão; a promoção é um evento `decision` no journal |
| 7 | **Engine nunca executa script de catálogo** | `curl\|bash` com ZIP protegido por senha (Snyk). Não executar é o único controle com 100 % de eficácia | Estrutural: o Runner (C5) só conhece os argv das famílias e do gate runner; nenhuma função faz spawn a partir de `~/.ade/catalog/`. O agente pode, sob `contain` e portões |
| 8 | **`allowed-tools` sempre ignorado; frontmatter inteiro removido antes da injeção** | Doc da Claude Code: "A skill can grant itself broad tool access". Como a ADE injeta o corpo no pack, `allowed-tools` viajaria como texto para dentro do prompt — o buraco que J3 §4 apontou nas três propostas | Pack compiler (C10): a seção recebe o corpo pós-`---`, nunca o bloco YAML |
| 9 | **`contain` inviolável** mesmo contra instrução explícita da skill | "Scope escalation": skill que manda editar `~/.claude/settings.json`, `.git/hooks`, memória do agente ou outro repositório | C7, pós-fato sobre a árvore, com canário por família: verificação de efeito, imune ao texto que o causou |
| 10 | **Primeira aparição no projeto exige aprovação** com nome, fonte, commit, licença, `trust`, `has_scripts` e achados do SkillGuard | OWASP LLM03; typosquat por nome parecido; consentimento explícito é o que Gemini CLI (`--consent`) e Claude Code fazem | Resumo de aprovação única do Intent Compiler (§5.9 da arquitetura). Em lote desatendido: `awaiting_operator` |
| 11 | **Memória e config do agente no escopo do scan**, não só o `SKILL.md` | "Comprometimento persistente por manipulação da memória do agente" é categoria nomeada da Snyk; a auto memory do Claude Code vem **ligada** e quebra determinismo (digest #9) | Prevenção: `--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Detecção: `ade doctor --skills` reporta delta em `~/.claude`, `.claude/`, `~/.codex/`, `.agents/` — **coleta, não bloqueio, na v1** (ADR 0017) |
| 12 | **Nunca ingerir `install.sh`, `hooks/` ou `scripts/` de contribuinte** | ECC traz `install.sh` + instaladores por CLI; `addyosmani` registra `SessionStart` que injeta contexto e um hook que **reescreve arquivos do usuário no disco** durante `Read`/`Edit` | `sync` fase 2: allowlist de caminho na materialização. Path fora de `paths` nunca chega ao disco — não é filtrado depois |

Três controles herdados de outros componentes, citados porque a literatura de skill injection os trata
como um só conjunto: corte da **lethal trifecta** por papel (skill de catálogo em contexto nunca
coexiste com segredos e efeito de rede na mesma chamada; push/PR/merge são do engine, C22); **conteúdo
de skill é dado, nunca instrução** (cerca inbound do Firewall, C11); **teto de 3 skills gravado no
journal** (`skills_injected[]`), o rastro da auditoria pós-incidente.

---

## 6. Dedup e precedência

Chave de identidade: `(source, path, name)`. Chave de conteúdo: `sha256(SKILL.md)`.

Precedência por `name`, do mais forte para o mais fraco:

| Ordem | Origem | `trust` | Pin |
| :-- | :--- | :--- | :--- |
| 1 | `<repo>/.claude/skills/` (skill do projeto, versionada em git) | `local` | o próprio git do repo |
| 2 | `~/.claude/skills/` + plugins locais de Erick (`superpowers`, `impeccable`, `tl-*`) | `local` | nenhum |
| 3 | `~/.ade/catalog/` | `allowlisted` | commit + sha256 |
| — | `quarantine/` | `quarantine` | nunca candidata |

Isto **inverte deliberadamente** a precedência nativa do Claude Code, que é pessoal > projeto (digest
#15): a skill versionada no repo é a que o time revisou e a que viaja com o código; a pessoal é
preferência de máquina. Dentro do catálogo, desempate é a ordem em `catalog.sources`; a perdedora fica
no índice com `shadowed_by: <id vencedor>`, nunca silenciosamente ausente. Duplicata exata entre fontes
(mesmo `sha256`, nomes diferentes) é reportada por `ade doctor` e não bloqueia: 5 skills byte-idênticas
entre Composio e Anthropic foram medidas, e o padrão é comum.

---

## 7. Seleção

Roda no step `prepare` da story, antes do pack. Entrada: `task`, `domains`/`languages` do Task
Contract, caminhos de `scope_paths`, família do Maker.

```
(0) filtro duro          domains ∩ / languages ∩ / families ∋ maker / trust ≠ quarantine
                         / body_tokens ≤ 2500 / license ok            → descarta ~80 %
(1) BM25 local           top-8, ~80 linhas TS, sem rede, sem modelo   ~5 ms, $0
(2) seletor barato       spec + 8 descrições → --json-schema, ≤3      ~1,5–2k in / ~200 out
(3) fecho                precedência §6, dedup, teto 3, journal
```

**Campos e pesos do BM25** (k1 = 1,2; b = 0,75; tokenização por `\W+` com case-folding, sem stemming —
o índice é bilíngue e stemizador de português seria dependência nova):

| Campo | Peso | Razão |
| :--- | ---: | :--- |
| `name` | 3,0 | Sinal mais curto e mais discriminante; casamento exato de `id` deve vencer |
| `tags` | 2,0 | Derivados de caminho + frontmatter, já curados no `classify` |
| `when_to_use` | 2,0 | Quando existe, é o campo escrito para responder exatamente esta pergunta |
| `description` | 1,0 | Mais longo e diluído; peso 1 evita que verbosidade vença por comprimento |
| corpo | 0 | Não indexado: dobra o custo de build e mede prosa, não intenção |

`domains` e `languages` não pontuam — são o filtro duro (0). Pontuar o que já foi filtrado distorce o
ranking.

**Por que BM25 e não embeddings.** ToolRet (arXiv 2503.01763): NV-Embed-v1 33,83 vs BM25 22,32 de
nDCG@10 — ~11 pontos a favor de embeddings, ambos ruins em absoluto (<52 % recall@10), e embedding
exige modelo local ou chave de API, que a ADE não tem. **Por que não reranker**: o mesmo paper mede
MonoT5 **piorando** o resultado (33,83 → 28,92). O ganho medido vem da forma oposta — lista curta + LLM
escolhendo sobe de 87,1 % para 93,1 % (arXiv 2605.24660), que é a etapa (2). Upgrade anotado: híbrido
quando o catálogo passar de ~500 skills ou `precision@3` cair abaixo de 0,70
(`landscape-routing-skills-terminal.md` §2.3).

**Tetos**: ≤3 skills por story; **2,5k tokens por skill**; **7,5k somados** na seção do pack
(`architecture.md` §7). Skill fora do teto individual não é candidata — fica `oversized` no índice e
aparece em `ade doctor`. Quatro das 25 de `addyosmani` e `claude-api` (21,7k tok) caem aqui.

Custo da etapa (2) é **medido, não assumido**: `claude -p --model haiku` faturou como claude-sonnet-5
(US$ 0,37 para ecoar 200 bytes, digest #26). A telemetria carrega o custo real com `cost_source`; o
fallback determinístico (top-3 do BM25 puro) cobre o caso de orçamento esgotado.

---

## 8. Injeção no pack

A skill selecionada **nunca é instalada**: não há cópia para `.claude/skills/`, `.agents/skills/` nem
`~/.claude/skills/`. O corpo entra como bloco fixo da seção `skills` do Context Pack (C10), ordenado
por `id` estável para o cache de prompt funcionar, com frontmatter removido (controle 8) e delimitado
como dado de terceiro, não como instrução do operador.

Motivo técnico, não só de segurança: **não existe diretório de skills comum às CLIs**. Codex e Gemini
leem `.agents/skills/`; a Claude Code documenta explicitamente que **não** o suporta (digest #14).
Instalar exigiria materializar por família, e cada família aplicaria o próprio orçamento de listing —
Claude Code trunca `description`+`when_to_use` em 1.536 chars e limita a listagem a ~1 % do contexto
(digest #13); Codex **omite skills silenciosamente** acima de 2 % da janela ou 8.000 chars (digest
#39). Instalar é entregar a seleção a um mecanismo que perde capacidade sem avisar.

Aritmética que justifica o componente: o índice completo de 1.188 descrições custa **~60k tokens por
turno**; três corpos injetados custam **~6–7k** (digest #13). O gargalo nunca foi o corpo.
`disable-model-invocation: true` no frontmatter upstream é respeitado: a skill sai do conjunto de
candidatas e só entra quando o Task Contract a nomeia em `skills[]`.

---

## 9. Fixtures e evals de seleção

Método portado de `addyosmani/agent-skills` (`evals/`), o achado real daquele repositório
(`ref-addyosmani-agent-skills.md` §4). Três camadas, adotadas como **método**, nunca como dependência:

| Camada | O que testa | Onde roda | Custo |
| :--- | :--- | :--- | ---: |
| **T1 estrutural** | Frontmatter válido, `name` == diretório, `description` ≤1024, campos de topo dentro do spec, `body_tokens` dentro do teto | CI, sobre `index.json` e sobre snapshot de fixture | $0 |
| **T2 roteamento** | `recall@8`, `precision@3`, `hard_miss = 0`, `contamination = 0`, e **detector de colisão**: similaridade par-a-par entre descrições — erro em ≥75 %, aviso em ≥50 % | Vitest puro na etapa (1); CLI falsa na etapa (2) | $0 |
| **T3 comportamental** | A skill injetada muda o comportamento? Casos de pressão (prazo, custo afundado, autoridade) para skill de disciplina: o workflow segura quando o prompt argumenta para pular a etapa | Sob demanda, `claude -p` em repo git descartável | tokens |

Formato da fixture (`tests/fixtures/skill-selection/<caso>.json`), três níveis porque verdade absoluta
não existe:

```json
{
  "request": "quero melhorar o design do site",
  "story": { "id": "S01", "domains": ["frontend", "ui"], "files": ["src/app/page.tsx"] },
  "catalog_snapshot": "fixtures/catalog/index-2026-09.json",
  "must_include": ["frontend-design"],
  "should_include": ["tl-impeccable-design", "ui-skills/typography"],
  "must_not_include": ["springboot-security", "proxmox-readonly-audit"]
}
```

`must_not_include` mede o risco real de um catálogo grande: a skill parecida que sequestra a seleção.
Alvos da v1, **[hipotese]** até o dogfood medir: `recall@8 ≥ 0,85`, `precision@3 ≥ 0,75`,
`hard_miss = 0`, `contamination = 0`. Nenhum número publicado mede "escolher 1–3 skills entre centenas
para uma story de engenharia"; a ancoragem honesta é <52 % recall@10 em ToolRet e 93,1 % de acerto em
lista curta no BFCL.

O **detector de colisão** roda no `sync`, não só no CI: colisão ≥75 % entre skill nova e skill já
indexada é motivo de `awaiting_operator` no lote desatendido.

---

## 10. Ledger `skill-impact` e telemetria

**Ledger** (`~/.ade/catalog/skill-impact.md`, append-only), governança portada do mesmo repositório:
toda mudança de política **rejeitada por evidência de eval** vira uma linha com data, proposta, métrica
que caiu e commit do run. Custo: uma linha. Retorno: ninguém re-propõe a mesma ideia a cada dogfood.
Entradas de abertura: "ingerir `hooks/` de `addyosmani`" (rejeitado por execução automática), "subir o
teto por skill para 5k" (pendente de medição), "usar `npx skills add`" (rejeitado pelo controle 1).

**Telemetria.** Cada `model_call` grava `skills_injected: [{ name, bytes, cited }]`
(`architecture.md` §4). `cited` é a única métrica que responde "a skill fez diferença ou só custou
tokens": `true` quando o output referencia o conteúdo de forma detectável (nome, termo exclusivo do
corpo, caminho que só ela menciona) — heurística, marcada como tal. J3 §4 registrou que sem este campo
"metade da coleta da v1 não coleta". Dele `ade report` deriva a tabela de poda: skill × stories
injetada × stories citada × tokens. Injeção alta com citação zero é candidata a sair do índice —
decisão humana na v1.

---

## 11. `ade doctor` sobre skills

`ade doctor --skills` na v1 **coleta e relata**, não conserta (ADR 0017):

| Verificação | Saída |
| :--- | :--- |
| Drift de pin | sha256 divergente entre `sources/` e `index.json` |
| Fontes atrás do upstream | commit pinado vs `HEAD` remoto, sem sincronizar |
| Quarentena | quantas, por qual controle, há quanto tempo |
| `oversized` | skills fora do teto de 2,5k, com o tamanho |
| Colisão de descrição | pares ≥50 % |
| Controle 11 | delta em `~/.claude/`, `.claude/`, `~/.codex/`, `.agents/` desde o último run; `CLAUDE.md`/`AGENTS.md` acima de 8 KB (Codex trunca AGENTS.md a 32 KiB — digest #39) |
| Citação | top-10 e bottom-10 por `cited` nas últimas N missões |

---

## 12. Fatiamento

| Versão | Entrega |
| :--- | :--- |
| v0.2 | `~/.ade/catalog/` vazio; `catalog_sync` no schema do journal; `ade catalog sync` no-op que só grava o evento. Custo ~zero, evita migração de schema depois |
| **v0.4** | Completo: sync com os 12 controles, SkillGuard, índice, BM25, seletor, injeção no pack, T1+T2 |
| v0.5 | T3 comportamental; ledger com entradas reais do dogfood; `cited` na coleta do harness doctor |
| pós-v1 | Híbrido BM25+embedding acima de ~500 skills; promoção de `quarantine` por assinatura upstream |

---

## 13. Divergências propostas

**D1 — O teto de 2,5k tokens por skill exclui a maior parte do catálogo medido.**
`architecture.md` §7 fixa ≤7,5k para a seção de skills; com teto de 3 skills isso dá 2,5k por skill.
Medido: mediana do ECC 1.890 tok (p90 4.461), mediana da Anthropic 2.136 (p90 8.247), **média de
`addyosmani` 3.535** com 4 de 25 acima de 5k (`ref-skill-sources.md` §5;
`ref-addyosmani-agent-skills.md` §3). 2,5k derruba o p90 de todas as fontes e a média inteira de uma
fonte ADAPT — o filtro duro (0) eliminaria skills boas antes do BM25 ver, e o próprio spec do Agent
Skills recomenda <5k. **Proposta**: manter 7,5k como teto da seção e trocar "2,5k fixo por skill" por
"≤5k por skill, soma das selecionadas ≤7,5k, resolvido por poda gulosa pelo score do BM25". Efeito: 1
de 5k + 1 de 2,5k é legal; 3 de 3,5k não. Sem isso, o catálogo de 60–80 vira um catálogo de ~35.

**D2 — Nada na arquitetura suprime o mecanismo nativo de skills da CLI durante uma chamada da ADE.**
A ADE seleciona fora e injeta o corpo no pack, mas o processo `claude` despachado continua carregando o
próprio listing de `~/.claude/skills/` + plugins — nesta máquina, ~300 skills por nome+descrição, várias
truncadas (`landscape-routing-skills-terminal.md` §2.1, observação direta). Três consequências: (a) o
custo de índice que a ADE acha que eliminou continua sendo pago a cada chamada; (b) uma skill **não
selecionada** pode disparar sozinha, o que quebra a premissa de que `skills_injected[]` descreve o que
estava em contexto; (c) `cited` mede o bloco do pack e ignora a skill nativa que de fato agiu.
`--safe-mode` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` cobre memória, não skills. **Proposta**: medir no
doctor da v0.2 se existe flag ou setting que zere o listing nativo por chamada (um `settings.json`
efêmero por worktree via `--settings` é o candidato **[hipotese]**) e, se não existir, escrever na
arquitetura que a injeção é **aditiva**, não substitutiva — hoje o documento permite a segunda leitura.

**D3 — O controle 11 não tem enforcement na v1 e a arquitetura não diz isso.**
`architecture.md` §7 o lista entre os obrigatórios; ADR 0017 fixa doctor como coleta-primeiro. A
categoria que ele cobre — "comprometimento persistente por manipulação da memória do agente" — é
nomeada pela Snyk. Detectar sem bloquear é defensável, mas precisa estar escrito onde o controle é
prometido. **Proposta**: marcar o 11 como **detect-only na v1** na §7, com o bloqueio (recusar despacho
quando `~/.claude/CLAUDE.md` mudou desde a aprovação) agendado para v0.5.

**D4 — `--ignore-user-config` no Codex pode derrubar `$imagegen`.**
`architecture.md` §7 manda `--ignore-user-config` em chamada curta do Codex (piso de 19,4k tokens,
digest #27) e, na mesma seção, manda usar `$imagegen` via `codex exec`. `$imagegen` vive em
`~/.codex/skills/.system/`, que é config de usuário: se a flag suprime a descoberta de skills do
`CODEX_HOME`, as duas instruções são incompatíveis na mesma chamada. Não medi. **Proposta**: caso no
harness `ade doctor` que rode `codex exec --ignore-user-config` pedindo `$imagegen` e grave o resultado
no CapabilitySet como campo medido. **[hipotese]**

---

## 14. Perguntas em aberto

1. `openai/skills` sem licença mantém fora do catálogo a fonte oficial de uma das duas famílias v1.
   Abrir issue pedindo LICENSE é o caminho mais barato para desbloquear 39 skills curadas.
2. A spec do Agent Skills não é versionada (sem releases): "conforme ao spec" é uma data (commit de
   `agentskills/agentskills` + `skills-ref`), não uma versão.
3. O SkillGuard não foi validado contra amostras maliciosas reais. `snyk-labs/toxicskills-goof` existe
   desde 2026-02-07 e nunca foi executado: o 7,2 % de ASR é do paper, não da implementação.
   **[hipotese]**
4. `allowed-tools` é Experimental no spec. Ignorá-lo é seguro hoje; se virar normativo e as CLIs
   passarem a exigi-lo, o controle 8 precisa de reavaliação.
