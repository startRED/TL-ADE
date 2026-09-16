# Método de desenvolvimento da própria TL-ADE

Data: 2026-09-17. Escopo: como a TL-ADE é construída — ferramental, portões, artefatos, convenções e a
escada de dogfood até a ADE construir a si mesma. Não repete a arquitetura; referencia
`architecture.md §N`. Fontes de evidência: `docs/research/landscape-dev-workflows.md`,
`docs/research/landscape-harnesses.md` §1 e §3, e o digest (`docs/research/README.md`, "digest #N").
ADR correspondente: `docs/adr/0020-metodo-de-desenvolvimento-da-propria-ade.md`.

## 1. Princípio

**O portão substitui o humano; o modelo não** (`architecture.md §1`). Orca (`stablyai/orca`) fecha
~9,9k PRs em 6 meses com zero revisão humana `APPROVED` e nenhuma branch protection — porque tem ~30
portões de CI e 8.858 arquivos de teste; Gas City, com a mesma autonomia e sem malha, publicou 22,7 %
de CI verde e 116 de 150 commits em `main` quebrados (digest #40, `landscape-dev-workflows.md` §b1 e
§b5). A malha de verificação é a variável independente; a autonomia é a dependente. Consequência
operacional deste documento: **nenhum aumento de autonomia sem portão novo primeiro**.

Segundo princípio, herdado do harness de longa duração da Anthropic: plano de controle em código,
chamadas curtas, estado durável fora do modelo (`landscape-harnesses.md` §1.3, convergência de cinco
fontes primárias). O método de construir a ADE é a mesma forma que a ADE implementa — por isso cada
estágio abaixo é dogfood, não analogia.

Terceiro: **cerimônia proporcional**. Se o diff cabe numa frase, não há plano, não há brainstorming,
não há story — vai direto ao ciclo curto. BMAD v6.12 e Agent OS v3 chegaram a essa regra recuando do
próprio processo (`landscape-dev-workflows.md` §a, linhas BMAD e Agent OS).

## 2. A escada de dogfood

| Estágio | Quem executa | Entrada | Saída | Gatilho de saída |
| :--- | :--- | :--- | :--- | :--- |
| **0 — bootstrap** | Claude Code (Maker) + Codex (Checker) dirigidos por Erick; `tl-orchestrator` v0.17.0 ou `claude -p` em loop **só** no lote de paridade (com cursor durável no formato de linha do `journal-event`, `architecture.md §11` E28) | `docs/plan/features.json` derivado do roadmap | engine núcleo, adapters, CLI falsa, slice 1 verde | slice 1 fecha uma story dela mesma ponta a ponta |
| **1 — ADE executa stories dela mesma** | `ade run --plan` com `plan.json` escrito à mão; depois `ade plan <pedido>` | stories do próprio backlog da ADE | v0.2 e v0.3 construídas majoritariamente pela ADE | `ade run "<pedido>"` ponta a ponta (v0.3) sem intervenção em ≥3 stories seguidas |
| **2 — ADE conduz fases** | `ade run <pedido>` com Intent Compiler e Skill Fabric | um pedido em linguagem natural por fase | v0.4a em diante; jornadas 2–5 | jornada 6 (desatendida) em dogfood na v1 |

O ponto de troca é verificável, não uma data (`landscape-dev-workflows.md` §c5): cada estágio começa
quando o anterior fecha um critério binário. A regra de release — antes de cada versão, a ADE constrói
uma story dela mesma — é a régua contínua.

### 2.1 Estágio 0

Duas ferramentas, dois papéis, desde o dia 1:

- **Maker**: Claude Code com as skills Superpowers já instaladas (`brainstorming → writing-plans →
  using-git-worktrees → subagent-driven-development → test-driven-development →
  requesting-code-review → finishing-a-development-branch`). Custo de adoção zero: já está na máquina
  (`landscape-dev-workflows.md` §a, linha Superpowers). `writing-plans`/`executing-plans` são o
  esqueleto de toda a infraestrutura do estágio 0. O Maker roda **sem** `--advisor` enquanto o modelo
  do advisor não for observável em `modelUsage` (sonda do doctor), e a separação Maker ≠ Checker vale
  por `model_id` e por vendor para **todo** papel da chamada — a telemetria grava `models[]`, não um
  `model` único (`architecture.md §12` E66).
- **Checker**: Codex, `codex exec --json --sandbox read-only --ignore-user-config --output-schema
  review-result.schema.json` — o mesmo comando que o engine vai emitir na v0.2 (`architecture.md §7`,
  digest #6). Usar o comando final desde o dia 1 é como o schema `review-result` ganha fixtures reais
  antes de existir código que o consuma. A receita completa de chamada curta é
  `--ignore-user-config --ignore-rules --ephemeral -c skills.max_context_tokens=0` mais um `AGENTS.md`
  ≤2 KB escrito no worktree (`architecture.md §11` E16): o piso de chamada do Codex headless é ~19,4k
  tokens de entrada (digest #27). Todo `review-result` carrega `sources[]` (digests das seções do pack
  usadas, E8).

O **lote de paridade** (93 testes de `test_tl_runtime.py` portados para Vitest com os mesmos nomes, mais
a `parity-name-map.json` — lista fechada dos casos que mudam de nome ou semântica, artefato de **entrada**
da v0.2, `architecture.md §11` E26; o slice 1 fecha um subconjunto nomeado de 44 casos) é o único trabalho do projeto com o perfil em que um loop
autônomo ganha: volumoso, repetitivo, critério de pronto binário (digest #1,
`landscape-dev-workflows.md` §c5). Regra de corte: se rodar `tl-orchestrator` v0.17.0 neste repositório
custar mais de meio dia de adaptação, cai para `claude -p` em loop sobre a lista de testes — mesma
ideia, sem a integração. Em qualquer dos dois casos o loop roda **em worktree descartável, em branch
próprio, nunca em `main`**: Ralph exige `--dangerously-skip-permissions` e o worktree passa a ser a
única fronteira (`landscape-dev-workflows.md` §c7).

Fora do lote de paridade, nada de loop autônomo no estágio 0. Design novo (journal, cadeia de hash,
scheduler, adapters) vai pelo ciclo completo da §5, porque parsing de saída de CLI é a superfície em
que agentes erram sistematicamente (§6 deste documento).

### 2.2 Estágio 1

A ADE recebe `plan.json` escrito à mão (slice 1) e depois planos que ela mesma gera (v0.3). O risco
próprio deste estágio é a ADE se autodanificar ao se construir. Duas defesas já estão na arquitetura e
não precisam de código novo: `contain` pós-fato com `scope_paths`/`do_not_touch`
(`architecture.md §3`, C7) e o `runtime_stamp` divergente bloqueando missão aberta
(`architecture.md §6`) — com o bloqueio restrito ao `core_version` (`architecture.md §11` E7), ver D1
na §11. A v1 assume repositório do próprio operador, que é exatamente o caso deste dogfood:
`catalog.sources` vive no `.ade/config.json` do repositório e as skills em `<repo>/.claude/skills/`
não entram no pack nem são carregadas pela chamada despachada (que roda sob `--safe-mode`); "modo
repositório de terceiros" é backlog da v0.5 (`architecture.md §12` E56).

### 2.3 Estágio 2

A ADE conduz fases inteiras a partir da v0.3/v0.4a. A entrada humana por fase cai para: o pedido, a
aprovação única (`architecture.md §5`, passo 9) e as decisões em `awaiting_operator`. O indicador de
que o estágio 2 pegou é o mesmo do North Star: intervenções humanas por story em queda com eval pass
estável.

## 3. Artefatos do dia 1

| Artefato | Conteúdo | Teto | Origem |
| :--- | :--- | :--- | :--- |
| `PROJECT_CHARTER.md` | Uma página: o que a ADE **não** é (não é CI, não é issue tracker, não é IDE, não é hospedagem). Gate de escopo | ~20 linhas | Beads (`landscape-dev-workflows.md` §b5, §c6.2) |
| `AGENTS.md` (raiz) | Como buildar/rodar/testar + **roteador de gatilhos**: cada regra termina apontando um arquivo em `docs/reference/`. Invariantes e comandos. Nunca estilo, nunca status, nunca log | **≤ 8 KB**, alvo 2,5k tokens | Orca; digest #39 (Codex trunca AGENTS.md a 32 KiB e omite skills acima de 2 % da janela, em silêncio) |
| `CLAUDE.md` | Uma linha: `@AGENTS.md` | 1 linha | Orca (`§b1`) |
| `init.sh` | `npm ci`, build, teste rápido, `ade doctor`. Toda sessão começa lendo-o | — | Anthropic long-running harness (`landscape-harnesses.md` §1.1) |
| `docs/plan/features.json` | Feature list plana, **um único campo gravável pelo agente: `passes`** | — | Anthropic harness (`landscape-harnesses.md` §3.1.1; digest #22) |
| `docs/plan/progress.md` | Notas de sessão, append-only | — | Anthropic harness |
| `scripts/record-transcript.ts` | Gravador de transcript byte a byte das CLIs; toda fixture de `parseEvents` nasce dele (§6) | ~50 linhas | `architecture.md §11` E28 |
| `docs/reference/*.md` | Vazio no dia 1. Um arquivo por cicatriz, escrito **no momento** do erro | — | Orca (`§b1`: 40 arquivos, um por cicatriz) |
| `.github/workflows/pr.yml` | Malha da §4 | — | Orca |

**O que entra no AGENTS.md**: invariantes do repositório (o engine é o único que roda `git`/`gh`; nada
de `.ade/` em commit; `{pack_path}` sempre, nunca `{pack_text}`), comandos (build, teste, paridade,
doctor) e gatilhos de leitura. **O que nunca entra**: estilo de código (é portão, não instrução),
status do projeto, histórico, e qualquer instrução que o modelo resolveria sozinho. Poda **semanal**
pelo critério da Anthropic: *"remover esta linha faria o agente errar?"* — se não, sai
(`landscape-dev-workflows.md` §c6.3). Conhecimento condicional vai para skill ou `docs/reference/`.

A feature list é JSON e não Markdown por um motivo medido: o modelo sobrescreve Markdown com mais
facilidade (`landscape-dev-workflows.md` §c1). Campo único `passes` elimina, sem vigilância, a falha de
"agente reescreve o critério até passar" (`landscape-harnesses.md` §3.1.1). Na arquitetura o campo
`passes` **saiu** do Task Contract (`architecture.md §11` E1): o contrato é imutável após aprovação e o
veredito vive no journal (`unit_state`) e no `unit-result`. O `features.json` do estágio 0 é o
equivalente pré-engine desse invariante, não o mesmo campo.

## 4. A malha de portões

Ordem de implementação, do mais barato ao mais caro. Os itens 1–4 e 8 são do dia 1; o resto entra com a
fase que os torna significativos.

| # | Portão | Comando / forma | Quando entra | Bloqueia merge |
| :-- | :--- | :--- | :--- | :--- |
| G1 | Tipos | `tsc --noEmit` (strict, ESM) | dia 1 | sim |
| G2 | Lint anti-slop | `oxlint` + `dmmulroy/anti-slop` **pinado por SHA** (`no-unknown-parameters`, `no-unknown-returns`, `no-chained-type-assertions`, `no-widen-then-assert`, `require-safety-comment-for-type-assertion`), **vendorizado** | dia 1 | sim |
| G3 | Testes + cobertura | `vitest run --coverage --reporter=json`: reporter estruturado é obrigatório e `numTotalTests ≥ 1` — zero teste executado é falha (`missing_target`), nunca verde (`architecture.md §12` E58); limiar só no núcleo durável — ≥85 % de linhas em `journal, step, lease, git, runner, contain` `[hipótese]`; no resto, razão teste:produção visível no PR (G14), sem portão (`architecture.md §11` E27) | dia 1 | sim (só no núcleo) |
| G4 | Root directory guard | ~20 linhas de CI: arquivo novo na raiz é rejeitado, salvo o que estiver na **allowlist** — escrita no mesmo commit que cria o portão, senão o primeiro PR do projeto é bloqueado pelo portão que ele introduz. Allowlist inicial: `package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `.oxlintrc.json`, `AGENTS.md`, `CLAUDE.md`, `PROJECT_CHARTER.md`, `init.sh`. Ampliar a lista é decisão humana, um item por PR | dia 1 | sim |
| G5 | Ratchets | `max-lines`, `ts-nocheck`, `any` — a métrica só melhora; suprimir a regra é **proibido por escrito** no AGENTS.md | dia 1 | sim |
| G6 | Paridade | 93/93 do `test_tl_runtime.py` nos dois SOs com a `parity-name-map.json` (digest #1); dois alvos normativos: `parity` (zero credencial, CI Windows + Linux) e `probes` (chamadas reais, local, opt-in) — E26 | subconjunto de 44 casos no slice 1; 93/93 na v0.2 | sim |
| G7 | Fixtures de transcript | todo `parseEvents` de adapter roda contra transcript gravado; fixture ausente = falha | com o primeiro adapter | sim |
| G8 | Schema validation | todo JSON de exemplo em `docs/` e `fixtures/` validado por ajv contra os 8 schemas publicados (`architecture.md §4`; `visual-eval` vira o 9º na v0.4b, E9); `docs/plan/**` fica **fora** do portão — o `features.json` do estágio 0 é pré-engine (`id`, `description`, `steps`, `eval`, `passes`) e não tem schema entre os 8 publicados; `schemas/ade-config.schema.json` é a única fonte das chaves de configuração e as tabelas de chaves em prosa nos specs são derivadas, não normativas (`architecture.md §12` E55) | dia 1 | sim |
| G9 | Lint de docs e links | links relativos existem; ADRs referenciados existem; tabelas fecham | dia 1 | sim |
| G10 | Supply chain | `npm audit` + `osv-scanner` + **verificação de que todo import novo existe no registry**; lockfile commitado; **dependência nova é decisão humana** | dia 1 | sim |
| G11 | CI Windows + Linux | matriz nos dois SOs para toda a suíte; Windows é a máquina alvo, Linux é o CI | dia 1 | sim |
| G12 | `code-quality:changed` | lint pesado só nas linhas alteradas | quando o CI virar gargalo | sim |
| G13 | Revisão por outra família | Codex (`codex exec --output-schema`) sobre o diff + a story; `changes_requested` bloqueia | dia 1 | sim (passo do ciclo, não job de CI) |
| G14 | Razão teste:produção | tabela automática no corpo do PR, não threshold global. Referência: Cloudflare em 1,9:1 | v0.2 | não (visível) |

Não fazer na v1: mutation testing (caro, retorno baixo com G6 cobrindo o núcleo) e merge queue com
bisecting (só se paga com N agentes concorrentes; a arquitetura fixou N=1 —
`landscape-dev-workflows.md` §c3).

**Meta de zero revisão humana, com a malha como condição.** A meta só vale onde a malha cobre. Ela
**não** vale em três superfícies, onde revisão humana é obrigatória sem exceção: `contain` e o
isolamento por worktree, o servidor local do painel (v0.4b, só `127.0.0.1`, token aleatório por sessão
do `ade serve` e checagem de `Origin`, E34), e a ingestão do catálogo de skills de terceiros
(`docs/security/README.md`). A exceção é canônica: `architecture.md §11` E30. Motivo na §7. Na
ingestão, cada injeção deixa evidência própria no evento de telemetria: `skills_injected[]` carrega o
`sha256` do conteúdo injetado e o `source` (`catalog@<commit>` ou `local`), o que torna a revisão
humana auditável depois (`architecture.md §12` E59).

## 5. O ciclo por story no estágio 0

```
1. brainstorming           (Superpowers)   → design curto        [HUMANO aprova]
2. writing-plans           (Superpowers)   → tarefas de 2–5 min, caminhos exatos
3. using-git-worktrees                     → worktree + branch, baseline limpa; `node_modules` por
                                             junction (Windows) do checkout base quando o lockfile
                                             bate, instalador só se o lockfile divergir (E49)
4. subagent-driven-development + TDD       → implementer fresco por tarefa, eval antes do código,
                                             teto de 5 rounds de fix
5. portões locais G1–G5, G8–G10 antes de qualquer commit
6. Checker Codex (G13), contexto mínimo: diff + a story
7. PR pequeno, corpo-relatório (§5.1) → CI (G11) → merge commit (`--merge`, nunca squash)
8. finishing-a-development-branch → limpa worktree               [HUMANO decide merge]
```

Dois pontos de humano por story, e só dois. Entre eles o agente não pergunta, exceto operação
irreversível, ação de segurança ou efeito fora do worktree (`landscape-dev-workflows.md` §c2). Regra de
cerimônia proporcional: **se o diff cabe numa frase, pula 1–2**.

### 5.1 Corpo de PR como relatório de evidência

Quatro seções obrigatórias (Orca, `§b1` e `§c4`):

1. **O que mudou** e por quê — um parágrafo.
2. **Eval executado** — comando e saída; o eval falharia sem a mudança? (é o mesmo
   `must_fail_before` de `architecture.md §7`, aqui na forma manual).
3. **Controle negativo** quando a verificação é de parsing ou detecção: a flag inexistente retorna 0, a
   real retorna 1.
4. **O que NÃO foi verificado** — lista explícita. *"Não consegui determinar X e não vou chutar"* é
   conclusão aceitável e preferível a um chute. É a forma manual de `TaskContract.unknowns[]`, com
   `kind ∈ {product_choice, external_fact, repo_fact}`: a incógnita é do contrato, não do plano
   (`architecture.md §12` E48).

PR pequeno é regra, não estilo: PR grande derrota G12 e derrota o Checker, que perde precisão com
contexto grande.

## 6. Fixtures são gravações, nunca telas lembradas

Toda regra que lê saída de CLI de agente — os `parseEvents` dos adapters `claude`, `codex`, `agy` — é
escrita contra um transcript capturado byte a byte e commitado como fixture. Texto escrito à mão não
conta; a CLI falsa por família (`architecture.md §3`, C12) replica o transcript, não uma idealização
dele.

Evidência: o Orca documentou um detector de saída de CLI **escrito cinco vezes**; três das quatro
primeiras eram piores que o bug que substituíam, a quinta foi revertida, e nenhuma das cinco percebeu
que a condição comum a todas nunca casava com uma tela real. A correção institucional não foi prompt
melhor — foi um gravador de PTY commitado + fixtures + a regra escrita
(`landscape-dev-workflows.md` §b1, §c6.1). Custo na ADE: um script de gravação (~50 linhas). Retorno:
uma classe inteira de bug que já queimou cinco tentativas em outro projeto.

Corolário: quando uma CLI muda o formato de saída (o `gemini` → `agy` de 2026-06-18 é o precedente,
digest #2), a resposta é regravar a fixture e ver G7 falhar — não ajustar o parser contra memória.

## 7. Riscos e os portões que os cobrem

| Risco | Evidência | Portão |
| :--- | :--- | :--- |
| **Segurança plana em 45 %** de amostras de código gerado reprovadas em teste de segurança desde 2023, enquanto a corretude sintática subiu de ~50 % para ~95 % (Veracode, 150+ modelos, 80 tarefas) | `landscape-dev-workflows.md` §b7 | G10 + **revisão humana obrigatória** nas três superfícies da §4. O portão de que a ADE mais precisa é justamente aquele em que o modelo menos ajuda |
| **Pacotes alucinados**: 5,2 % (comercial) / 21,7 % (OSS), **repetíveis** → sequestráveis (USENIX Security 2025, 2,23M amostras) | idem | G10: import novo verificado no registry; **allowlist** de pacotes no `AGENTS.md` (a lista de deps da v1 é fechada: `canonicalize`, `ajv`, `playwright`, `better-sqlite3` na v0.4b); lockfile commitado; dependência fora da allowlist é decisão humana |
| Escalação de privilégio e falhas de design subindo (Apiiro, ~62k repos, 10× vs dez/2024) | idem | G13 com `category: 'bad_spec' \| 'intent_gap'` no `review-result`; `target_role: 'human'` escala |
| Erosão de manutenibilidade: duplicação +81 %, refatoração −70 % (GitClear, 623M mudanças) | idem | G5 (ratchets) + G12 + o princípio da Anthropic: "a cada modelo novo, deletamos código" |
| Adapter quebra quando a CLI muda a saída | Orca; digest #2 | G7 + `ade doctor` com chamada real (`architecture.md §3`, C13) |
| Over-processo para um operador só | Agent OS v3; BMAD v6.12 | cerimônia proporcional (§5) |
| Métrica auto-reportada virando meta | 810× do gstack, US$297/US$50k do Ralph, METR autodesqualificado, 8× da Anthropic com caveat do próprio autor | medir localmente só: PRs com CI verde na primeira tentativa, razão teste:produção, intervenções por story. Nenhum número de terceiro vira meta |

## 8. Beads como três primitivas, não como ferramenta

O backlog da ADE precisa de exatamente três coisas de `gastownhall/beads`, e todas já cabem no engine
(`landscape-dev-workflows.md` §a, linha Beads — **REFERENCE**, não instalar):

| Primitiva | Forma na ADE | Onde |
| :--- | :--- | :--- |
| `ready` | `Scheduler.next_ready()` devolve o conjunto de stories sem `depends_on` aberto | `architecture.md §3`, C14 |
| claim atômico | `lease` por `mkdir` + heartbeat + fingerprint; exit 5 em conflito, da tabela única de exit codes (master-spec §4: 0, 2, 3, 4, 5; não existem 1 nem 6 — `architecture.md §12` E47) | C3 |
| id por hash | id de story/step derivado de hash (`bd-a1b2`), zero conflito de merge entre lotes | C1/C14 |

Nada de `bd` no `PATH`, nada de MCP, nada de grafo separado do `plan.json`. O DAG é adição da ADE sobre
a lista plana do harness da Anthropic (digest #22) e só se paga quando há dependência real — num lote
sem dependências o scheduler degenera em "próxima não bloqueada", e está certo assim
(`landscape-harnesses.md` §1.3, ressalva 2).

## 9. Convenções

**Commits.** Conventional commits em português: `feat(engine): journal com cadeia de hash`,
`fix(adapters): resolver .exe real atrás dos shims npm`, `docs(adr): 0021 versionamento do journal`.
Escopos: `engine`, `adapters`, `intent`, `skills`, `fqe`, `cli`, `docs`, `ci`, `fixtures`.
Saída de agente termina com `Co-Authored-By:`; correção feita à mão pelo humano diz isso na mensagem
(`Corrige à mão o bug que o agente errou 3×`). Isso torna a razão IA/humano mensurável por `git log` e
é a única convenção de autoria com precedente auditável (`landscape-dev-workflows.md` §b3: Cloudflare;
§b5: Beads). O commit mais valioso do histórico do `workers-oauth-provider` é um que declara
*"THIS CODE HAS A BUG"* — registrar fracasso é parte da convenção, não exceção a ela.

**Branches.** `slice/<n>-<slug>` no estágio 0, `story/<id>` no estágio 1+ (é o mesmo nome do worktree em
`.ade/wt/<story>`, `architecture.md §2`). O loop autônomo do lote de paridade vive em
`batch/parity-<n>` e nunca toca `main`.

**Releases.** Tag por marco do roadmap (`v0.2`, `v0.3`, …). Condição de release, além da malha verde:
**a ADE constrói uma story dela mesma** naquela versão, com o journal da missão anexado à release.
`ENGINE_VERSION` é o que pina Impeccable (nunca versão npm, digest #19) e a fonte do `core_version`, a
primeira das três partes do `runtime_stamp` (`<core_version>:<config_digest>:<capabilities_digest>`,
`architecture.md §6` e §11 E7). `ENGINE_VERSION` divergente do pin do Impeccable é **falha do
doctor**, fail-closed, nunca aviso: o FQE entra em modo degradado e stories com UI param em
`awaiting_operator{reason:'fqe_unavailable'}`, enquanto stories sem UI seguem
(`architecture.md §12` E45).

**Layout.** Pacote único na raiz na v1; `npm workspaces` só no commit que cria `packages/web` (v0.4b),
`architecture.md §11` E29. G4 (root guard) e G12 valem sobre esse layout.

**Merge.** Merge commit, nunca squash — a arquitetura depende de reconciliação contra o remoto por
classe de efeito (`architecture.md §3`, C22) e squash apaga a correspondência entre step e commit. A
regra vale para os PRs deste repositório; dentro do engine o verbo é outro: `local_merge` fast-forward
da branch da story na base entra em `safe` quando a base não mudou desde o `prepare` (ff-only, ref de
origem preservada em `refs/ade/`), e se a base mudou o commit fica na branch da story e o `report.md`
imprime o comando de merge (`architecture.md §12` E64).

## 10. Métricas do método

Coletadas do próprio repositório, semanalmente, sem ferramenta nova:

| Métrica | Fonte | Alvo |
| :--- | :--- | :--- |
| PRs merged com CI verde na primeira tentativa | `gh api` | ≥ 80 % `[hipótese]` |
| Razão teste:produção | G14 | ≥ 1,5:1 `[hipótese]`; referência Cloudflare 1,9:1 |
| Intervenções humanas por story | journal (estágio 1+) / contagem manual (estágio 0) | queda monotônica entre versões |
| Stories que fecham com zero `eval_run` vermelho | journal | ≈ 0; qualquer ocorrência é suspeita de eval frouxo (`landscape-harnesses.md` §3.1.5), salvo a exceção contável de `trivial` fechada por `ade decide --option accept_unproven` depois de `awaiting_operator{reason:'red_unproven'}`, que deixa um `decision` no journal (`architecture.md §12` E51) |
| Tamanho do `AGENTS.md` | `wc -c` | ≤ 8 KB, tendência de queda após cada poda |
| Arquivos em `docs/reference/` | `ls` | cresce; cada um é uma cicatriz que não se repete |

Nenhuma métrica de LOC por dia. A própria Anthropic ressalva que LOC é métrica imperfeita e que o "8×"
"é quase certamente exagero" (`landscape-dev-workflows.md` §b2).

## 11. Divergências resolvidas

**D1 — `runtime_stamp` estrito torna o estágio 1 impraticável → aceita com forma própria,
`architecture.md §11` E7.** A arbitragem não separou o carimbo em dois campos: fixou três partes,
`runtime_stamp = <core_version>:<config_digest>:<capabilities_digest>`. Só `core_version` — constante do
núcleo durável (C1–C5, C7) — bloqueia com `stale_workflow_version`; mudança em `fqe`, `skills`, `cli` ou
config não invalida intenção aberta, e `capabilities_digest` **registra** — nunca bloqueia — o upgrade
silencioso de CLI (`agy` 1.2.3 → 1.2.4 sem ação): a divergência vai ao relatório do `ade doctor` e ao
`mission_summary`, seus dois leitores nomeados, e não barra `--unattended` (`architecture.md §12` E68 e
E67). O aceite continua sendo `ade run --accept-stale-version`, agora gravado como
evento `decision`. Resolve o reflexo de aprovação sem abrir o portão onde ele importa.

**D2 — `npm workspaces` com um único pacote na v1 → aceita, `architecture.md §11` E29.** Pacote único na
raiz na v1; workspaces entram no commit que cria `packages/web` (v0.4b). Refletido na §9, "Layout".

**D3 — exceção de segurança escrita ao lado da meta → aceita, `architecture.md §11` E30.** A meta é
"zero revisão humana **fora das três superfícies de segurança**" (`contain`/isolamento, servidor local do
painel, ingestão do catálogo), declarada assim aqui na §4, no roadmap e no ADR 0020.

**D4 — gravador de transcript como artefato do dia 1 → aceita, `architecture.md §11` E28.**
`scripts/record-transcript.ts` está na tabela da §3. No mesmo item, o fallback do estágio 0
(`claude -p` em loop) grava cursor durável no formato de linha do `journal-event`.

## 12. Perguntas em aberto

1. Custo de adaptação do `tl-orchestrator` v0.17.0 para rodar o lote de paridade neste repositório: a
   regra de corte é meio dia, mas o número não foi medido. `[hipótese]`
2. Calibração do ≥85 % do núcleo durável em G3 (`architecture.md §11` E27): o número é `[hipótese]` e
   só o slice 1 diz se ele é alcançável sem teste de cerimônia.
3. Qual família revisa o quê no estágio 0. CR-bench dá a Claude 32,1 % de pass rate contra 20,1 % do
   Codex, e ao Codex 88 % de precisão contra 78 % (digest #5). O ciclo da §5 usa Codex em G13 por
   precisão; se o estágio 0 sofrer mais de defeito escapado que de ruído, o papel inverte. Medir por
   defeitos escapados nas primeiras 20 stories. `[hipótese]`
4. Frequência real da poda do AGENTS.md: semanal é o alvo herdado do time do Claude Code; se o arquivo
   não crescer, a poda vira ritual vazio. `[hipótese]`
5. Se o estágio 1 deve exigir que a ADE rode em worktree de si mesma (auto-hospedagem estrita) ou se
   pode operar sobre o checkout principal com `contain` como única defesa. A resposta muda o risco de
   auto-dano da §2.2.
