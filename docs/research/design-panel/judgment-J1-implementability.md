# Julgamento J1 — Implementabilidade e YAGNI

Juiz da lente J1 do painel de arquiteturas. Data: 2026-09-16. Pergunta: **um dev (Erick) com agentes
entrega o slice 1 em ≤3 semanas e a v1 em ~3 meses?** Postura: adversarial — procuro o que quebra.
Toda afirmação factual cita `docs/research/*` ou o digest (`README.md`, item #N).

---

## 0. Critérios da lente (0–10 cada)

| # | Critério | O que mede |
| :-- | :--- | :--- |
| **K1** | **Tempo até o slice 1** | Quanto precisa existir antes de algo rodar ponta a ponta; o critério de aceite do slice é honesto com o escopo dele? |
| **K2** | **Superfície de dependência e complexidade escondida** | node-pty, ACP de terceiros, Impeccable, Graft, SQLite nativo, Playwright, fila de merge, ciclo de vida de processo |
| **K3** | **YAGNI para ADE local de um usuário** | O que é construído sem usuário que peça; justificativa circular conta contra |
| **K4** | **Testabilidade e paridade** | Fixtures gravadas, CLI falsa, paridade com `test_tl_runtime.py` (93 casos, 1 skip — port-map §0) |
| **K5** | **Dogfood incremental** | Cada fatia é usável pela própria ADE; risco de a ADE se autodanificar ao se construir |

---

## 1. Placar

| Critério | A (minimal) | B (durable) | C (intent) |
| :--- | :--: | :--: | :--: |
| K1 Tempo até o slice 1 | **5** | **7** | **8** |
| K2 Dependência / complexidade escondida | **9** | **4** | **6** |
| K3 YAGNI | **9** | **4** | **7** |
| K4 Testabilidade e paridade | **7** | **9** | **6** |
| K5 Dogfood incremental | **8** | **7** | **6** |
| **Total** | **38** | **31** | **33** |

Inversão que importa: **A é a proposta mais enxuta e tem o pior slice 1; B é a mais pesada e tem o
melhor slice 1.** Erro de escopo de slice se corrige em uma linha; compromisso de dependência e de
arquitetura, não. É isso que decide a base.

---

## 2. A — "Menos código, mais alavanca"

**K1 = 5.** O aceite do slice 1 exige matar o processo "antes/depois do push" e os evals do slice são
"porte de `test_tl_runtime.py` caso a caso, alvo **93/93** em Windows e Linux". Paridade total cobre
I08–I16 e I33–I40 — commit/push/PR/merge e reconciliação contra remoto —, ou seja as etapas 1 a 5 da
ordem de porte (`runtime-port-map.md` §7), enquanto o mesmo slice se anuncia como "uma story, commit
local, sem plano e sem painel". O escopo e a barra de aceite do slice se contradizem; ≤3 semanas não é
crível nessa barra.
**K2 = 9.** Melhor do painel. Slice 1 com Node 22 + `canonicalize` + `ajv` + `child_process`, nada mais.
Corta `node-pty`, xterm, WebSocket, Fastify e SQLite da v1 inteira — e o faz com evidência (#29: nunca
houve 1.2.0 estável; `kill()` pode matar PID alheio até 5 s depois).
**K3 = 9.** Tabela de 14 cortes, cada um com origem e motivo. O corte mais afiado do painel é
`ade takeover` imprimindo `claude --resume <uuid>` (~20 linhas) no lugar de PTY+painel, e honesto ao
registrar que `--resume` não restaura `--add-dir`/`--settings`. N>1 entra como **campos** (custo zero,
resolve #33) sem scheduler — a resposta certa ao dilema que B erra.
**K4 = 7.** Corrige o critério de paridade herdado errado (#1: os "10 que falham" vêm de
`test_context_ledger`/`test_resume_generate`, helpers que a ADE não porta) e exige CLI falsa com
contador durável. Perde ponto por pôr paridade total no slice errado, não por fraqueza de teste.
**K5 = 8.** "Pronto" do slice = a ADE fecha uma story dela mesma (adicionar campo ao `journal-event`) com
worktree, `contain` e checkpoint já no lugar: dogfood sem risco de perder trabalho.

**Falhas fatais**
1. Aceite do slice 1 = 93/93 + crash em push/PR num slice que só faz commit local. Insustentável em 3
   semanas; precisa virar critério de saída da v0.2.
2. "Mínima" descreve os cortes, não a v1: são **16 componentes na v1**, incluindo FQE, Skill Fabric,
   pesquisa, capability registry e harness doctor, sem nenhuma estimativa de calendário para os ~3 meses.
3. `type Eval = { strictness: { mode; must_fail: true } }` — `must_fail` é literal `true` no tipo.
   Story puramente aditiva não tem vermelho significativo (é o R2 da C) e fica bloqueada sem escapatória.
4. Derruba painel **e** PTY, que são decisões prévias do Erick (PROMPT §0). Risco de adoção, auto-declarado
   (decisão 1 da própria proposta) — exige um "sim" explícito antes de qualquer código.

---

## 3. B — "Determinismo e durabilidade primeiro"

**K1 = 7.** O melhor slice 1 do painel: uma story `trivial`, lease, `prepare` em worktree, eval vermelho,
uma chamada `claude -p` com id pré-cunhado, `contain`, eval verde, `local_commit`, **10 testes nomeados**.
Escopo e aceite batem. Crível em ~3 semanas com agentes.
**K2 = 4.** Pior do painel. v1 carrega `node-pty` + xterm + WebSocket + Fastify + índice SQLite +
`MergeQueue` + `sweep_orphan_worktrees` + dois ciclos de vida de worktree simultâneos. Mitiga o
`pty.kill()` corretamente (`taskkill /T /F /PID`), mas continua comprando a dependência que A mostrou ser
substituível por uma linha de comando.
**K3 = 4.** A justificativa de N=2 é circular e está escrita na própria proposta: *"com N=1 esse código
apodrece não executado, exatamente como `tl_supervisor.py` hoje"*. Constrói-se concorrência para exercitar
a concorrência que se decidiu construir. O motivo de `tl_supervisor.py` ter apodrecido é que nunca foi
necessário (port-map §5.1: zero ocorrências em `tl_runtime.py`). O digest manda serializar escrita na mesma
árvore e paralelizar só leitura; não há dor de wall-time medida num usuário só.
**K4 = 9.** O melhor do painel, e com folga. Dez testes nomeados, CLI falsa com contador **em disco**,
`no_result` e captura de pack+env, mais a matriz crash × fase (engine / worker / máquina / browser) que é
lista de implementação e suíte de aceite ao mesmo tempo. `canonicalize_output_byte_identical_to_python_reference_fixture`
é a melhor ideia isolada do painel: o canonicalizador errado quebra a cadeia **em silêncio** (I02), e essa é
a única forma barata de provar que não quebrou.
**K5 = 7.** Slice 1 termina em dogfood real. Perde por sequência: painel em v0.4 **antes** do Intent
Compiler em v0.5 — visor para um sistema que ainda não transforma intenção em plano — e N=2 em v0.3
aumenta o raio de explosão justo quando a ADE está se editando.

**Falhas fatais**
1. N=2 na v0.3 por justificativa circular: compra fila de merge, claim de escopo, sweep de órfãs e a
   classe inteira de corridas antes de existir demanda medida de throughput.
2. PTY/node-pty/xterm/WS/Fastify/SQLite na v1 para um usuário local, contra #29 e contra a alternativa de
   ~20 linhas demonstrada por A.
3. Curva de valor invertida no roadmap: painel antes do Intent Compiler.

---

## 4. C — "Intenção e qualidade no centro"

**K1 = 8.** Slice 1 mais rápido a algo visível: contrato + `ajv` + Intent Compiler + eval runner com
`tree_before` + journal + adapter claude/codex, **sem** painel, skills, visual, DAG, pesquisa, worktrees
e PR/merge. É a fatia que entrega o north star mais cedo.
**K2 = 6.** `better-sqlite3` aparece nas dependências de um slice que exclui o painel — módulo nativo
(node-gyp/prebuild no Windows) sem consumidor; sintoma de lista de dependência não derivada do escopo.
Mantém a terceira família (`agy`) na v1, com o defeito de isolamento medido (#38) exigindo canário por
família. Acerta ao empurrar PTY para pós-v1.
**K3 = 7.** Cortes bons (N>1, ACP, rotinas, 4º provider, MCP automático, `codex review`, avaliador barato,
banimento de fontes), mas mantém painel "v1 mínimo", 3ª família e pesquisa com 2 agentes.
**K4 = 6.** Paridade mais fraca: slice 1 cobre ~15 invariantes (I01–I05, I19–I26, I41); os 66 ficam para a
v0.2. Compensa com testes de contrato ótimos ("um caso de eval frouxo que **precisa** reprovar") e com o
único diagnóstico honesto do risco de EARS genérico.
**K5 = 6.** Dogfood desde o slice 1 e no laço mais útil — mas é o único slice que roda `implement` **sem
worktree** e com `contain` "mínimo". Na prática, a ADE edita a árvore real (a dela, em dogfood) sem ref de
checkpoint: um rework ruim ou um crash perde trabalho.

**Falhas fatais**
1. Slice 1 executa modelo contra árvore real sem worktree nem checkpoint — contradiz "durabilidade
   inegociável" logo na primeira fatia, e o alvo do dogfood é o próprio repositório.
2. `better-sqlite3` como dependência de um slice sem painel: dependência nativa sem consumidor.
3. A tese inteira repousa numa hipótese sem medição: que um modelo escrevendo EARS + evals produz eval
   **discriminativo**. C nomeia a falha ("THE SYSTEM SHALL work correctly" passa na validação de forma) mas
   mitiga com outra chamada de modelo, sem fixture nem alvo falsificável — enquanto exige
   `recall@8 ≥ 0,85` da Skill Fabric. Padrão duplo de rigor no componente mais central.
4. Terceira família na v1 por Maker ≠ Checker que duas já satisfazem (o critério é `model_id`, #3).

---

## 5. O que nenhuma resolveu

1. **Nenhuma tem calendário.** Nenhuma das três estima dias, semanas ou horas-agente para fase alguma. O
   roadmap é insustentável de auditar contra "≤3 semanas" e "~3 meses" — e o pedido era exatamente esse.
2. **Nenhuma dimensiona o volume do porte.** `tl_runtime.py` tem 2470 linhas e `tl_job.py` 2562
   (port-map, cabeçalho). Quanto disso vira TS, em quantos módulos, é o que decide se 3 semanas é real.
3. **Paridade "mesmo nome de caso" conflita com o redesenho, e ninguém resolve.** As três adotam a forma
   **rica** do `review-result` (`target_role`/`problem`) e mudam `plan`; as três mandam portar
   `test_tl_runtime.py` caso a caso com o mesmo nome. Onde o schema mudou de propósito, o teste não passa
   sem ser reescrito — e nenhuma lista quais casos mudam de nome ou de semântica.
4. **Custo e local de execução da própria suíte de paridade.** 93 casos, ~11,7 s/caso, 18 min em série
   (port-map §0). Só B menciona paralelismo por worker. Nenhuma diz onde isso roda em CI no Windows, nem o
   que acontece com as sondas de `ade doctor` que fazem **chamada real** ao `claude`/`codex` — que custam
   dinheiro e exigem assinatura. Não existe história de "CI sem credencial de CLI".
5. **Versionamento e migração do journal.** As três adicionam campos (`worktree`, `stamp`, `session_ref`,
   `receipt_path`) e mantêm `format_version: 1`. Nenhuma diz o que acontece ao retomar uma missão gravada
   por um engine anterior — que é exatamente o cenário de dogfood: a story de exemplo da A é *adicionar um
   campo ao `journal-event`*.
6. **A ADE se atualizando durante a própria missão.** Dogfood significa que o código do engine muda
   embaixo do engine em execução. Nenhuma fixa/copia o binário do engine pela duração da missão.
7. **Windows além do `lpCommandLine`.** #31 cobre os 32.767 chars. Ninguém cobre MAX_PATH em
   `.ade/wt/<...>` com `node_modules` profundo, nem handle preso por worker durante `git worktree remove`
   (B chega perto com o sweep de órfãs).
8. **Custo medido do classificador "barato".** Só C cita #26 (`--model haiku` faturado como sonnet, US$ 0,37
   para ecoar 200 bytes); A e B assumem chamada barata na classificação sem plano de medição.

---

## 6. Recomendação

**Base: A.** Ela tem os compromissos caros certos (sem painel, sem PTY, sem ACP, sem SQLite, sem N>1, duas
famílias) e um único erro grande — a barra do slice 1 — que se corrige trocando um parágrafo. B e C erram
onde é caro consertar: B compra concorrência, PTY e painel antes de haver demanda; C roda modelo contra
árvore real sem worktree na primeira fatia.

**Enxertos obrigatórios de B:** o slice 1 inteiro (10 testes nomeados, uma story trivial, commit local;
93/93 vira critério de saída da **v0.2**); `canonicalize_output_byte_identical_to_python_reference_fixture`;
a matriz crash × fase como checklist de reconciliação; a faixa rápida de `trivial` como **requisito com
eval próprio**, não propriedade emergente; `eval` como 8º schema publicado (valida `strictness` na
ingestão); `receipt_path` e `session_ref: string|null` no evento; `no_checker_family_available` → `parked`,
nunca "aprovado sem revisão"; `env` explícito no spawn.

**Enxertos obrigatórios de C:** `strictness` **por classe** — story aditiva gera aviso registrado, não
bloqueio (corrige o `must_fail: true` literal de A e B); `DesignBrief` de 4 camadas dentro do contrato (a
única alavanca visual com medição causal, 57 %); `eval_run{phase: red|green}` como classe de efeito com
`EvalRecord` no journal; canário de isolamento **por família** após cada chamada (#37, #38); regras de
recusa como validação (pergunta respondível pelo discovery é recusada; eval verde de nascença volta ao
Intent Compiler, não ao Maker); medir o custo real do classificador com fallback determinístico (#26).

**Corte adicional sobre A:** a "v1" dela (time de pesquisa, ablação Caliper, adapter Gemini, spec viva)
não cabe em 3 meses e não é pedida por ninguém — vai para futuro. v1 realista = engine + Intent Compiler +
plano + skills + Checker + FQE.

**Antes de escrever código, Erick decide:** (1) v1 sem painel e sem PTY; (2) duas famílias na v1;
(3) teto visual de 2 rodadas e corte 7,5.
