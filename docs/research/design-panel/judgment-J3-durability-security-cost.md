# Julgamento J3 — Durabilidade, segurança e custo

Juiz adversarial do painel de arquiteturas. 2026-09-16. Lente: o que quebra sob crash, o que passa
pela contenção no Windows, o que a supply chain deixa entrar e quanto a arquitetura desperdiça por
story. Toda afirmação factual cita `docs/research/`. Procurei falha, não mérito.

---

## 1. Critérios (definidos para esta lente)

| # | Critério | O que mede |
| :-- | :--- | :--- |
| **D1** | Reconciliação e recuperação | Crash de engine/CLI/máquina/browser: o que se perde, o que reconcilia, o que fica ambíguo — e se a chamada é cobrada duas vezes |
| **D2** | Contenção no Windows sem sandbox de SO | `contain`, árvore de processos, isolamento por família verificado, takeover |
| **D3** | Supply chain de skills e injeção em conteúdo observado | Os 12 controles de `ref-skill-sources.md` §6; achado e saída de ferramenta como dado, nunca instrução |
| **D4** | Permissões e efeito externo por nível | safe/controlled/restricted, env filtrado (I49), efeito externo só do engine, poder do Checker |
| **D5** | Custo estrutural por story e suficiência da telemetria | Tokens por story, missão de 20 stories, desperdício estrutural, e se firewall+telemetria bastam ao harness doctor |

---

## 2. Simulação de crash

**(a) Engine morre no meio de um `model_call`.** I09 tem duas saídas: `starting/running` → **anexa** ao
processo e espera; terminal sem resultado → `ambiguous` + checkpoint. Anexar exige recibo em disco
legível por processo frio (I65).
**A** grava recibo antes do spawn e pré-cunha `--session-id` (write-ahead real, digest #11), mas o
evento de journal não tem `receipt_path` e a proposta não trata reuso de PID. **B** é a única com
matriz de crash por fase × ator, `receipt_path` no evento e `fingerprint` anti-reuso de PID — e com
teste novo `receipt_running_state_is_readable_mid_flight_by_a_cold_process`. **C** não menciona recibo
durável em lugar nenhum: sem ele a branch "anexa" não existe, e todo crash de engine no meio do Maker
vira `ambiguous` + re-despacho pago.

**(b) CLI morre no meio de um commit.** Categoria impossível nas três: commit/push/PR são sempre do
engine, nunca do worker (I55; A §4, B linha 14, C etapa 19). O caso real é a CLI morrer no
`implement` deixando árvore suja. O que separa é I07: `ENOENT`/`start_failed`/`invalid_input` provam
que nada rodou e **não** são cobrados; o resto é ambíguo. **B** explicita isso na matriz; **A** porta
I01–I66 literal mas não nomeia I07 entre os pontos de risco; **C** não distingue `released` de
`ambiguous` em texto nenhum — o que, na prática, cobra chamadas que não rodaram.

**(c) Máquina morre no meio de um push.** I11 compara `git ls-remote` contra `remote_before` gravado
em `intent_context`, que é gravado com a intenção e **fora** do `input_digest` (I17). **A** e **B**
carregam `intent_context` e `input_digest` no `JournalEvent`. **O `JournalEvent` de C não tem
nenhum dos dois** (§3): sem `intent_context` não há `remote_before`/`base_before`, logo I11 e I14 são
inexequíveis como escritas; sem `input_digest` I05 não tem onde morar. É o defeito mais grave do
painel, numa proposta que abre a §6 com "os 66 invariantes são portados, não reinventados".

**(d) Browser fechado.** **B** é explícita e testável: painel é projeção, índice reconstruível, ação
do operador vira step antes de virar efeito (aceite da v0.4). **A** não tem painel na v1 — imune por
ausência, ao custo de visibilidade. **C** tem painel na v1 e **não declara a regra de projeção** em
lugar nenhum; ainda lista `better-sqlite3` como dependência da slice 1, cujo escopo exclui o painel.

**O que fica ambíguo nas três.** No Windows, o Job Object com `KILL_ON_JOB_CLOSE` que a libuv já cria
vale só para filhos **não-detached** (digest #30). Ou o worker é não-detached — e então morre junto
com o engine, e a branch "anexa" de I09 nunca roda —, ou é `detached` — e a contenção da árvore de
processos deixa de vir de graça. **B escolhe `detached` (§5) e ao mesmo tempo afirma que o Job Object
da libuv cobre o caso comum**: as duas coisas não podem ser verdade na mesma chamada. A e C não
percebem a escolha.

---

## 3. Contenção sem sandbox de SO (Windows)

Nenhuma família tem sandbox de SO utilizável para as três ao mesmo tempo
(`addendum-autonomia...` §6.1): Claude zero em Windows nativo, Gemini/Antigravity zero, Codex não
zero-config. `contain` pós-fato + worktree é a única fronteira universal — e ela **só enxerga dentro
do worktree**. O `agy` escreveu fora do `--add-dir` sem avisar (#38) e um `claude -p` pode relatar
sucesso depois de ferramenta bloqueada (#37): nada prova que claude/codex não escrevem fora.

- **`maxBuffer`**: o default de 1 MiB do `execFile` **trunca a varredura de segredo em silêncio**
  (port map §1.2, I24). **A** nomeia e vira risco de slice com teste (diff > 1 MiB, segredo no fim);
  **B** nomeia na tabela de durabilidade; **C não menciona em lugar nenhum**.
- **Precedência segurança > escopo (I23)**: aceite explícito em **A** (segredo + violação de escopo
  simultâneos) e **B** (segredo para o lote antes do commit). **C** tem `contain mínimo` na slice 1 e
  **nenhum aceite de segredo** — só escopo (aceite 5).
- **Isolamento por família**: **C** é a única com canário escrito fora do worktree que precisa falhar,
  e a única que o roda **por chamada**, não só no doctor. **B** testa isolamento no `ade doctor` e tem
  `doctor_containment_selftest_per_adapter`. **A** não tem canário nenhum — corta `agy` da v1, o que
  reduz a exposição, mas não a fecha.
- **Takeover**: apaga `auto-mode`, `execpolicy`, sandbox e `--disallowedTools` (§6.5). **A** elimina
  PTY/xterm/WS/Fastify da v1 (menor superfície de ataque e de crash); **C** adia; **B** entrega PTY na
  v0.4 com `node-pty` (11 bugs de ConPTY; `kill()` que mata PID alheio — #29).

---

## 4. Supply chain de skills (12 controles) e injeção

| Controle | A | B | C |
| :--- | :-: | :-: | :-: |
| 1 allowlist de fontes | ✔ | ✔ | ✔ |
| 2 pin por **commit** + hash por arquivo | parcial (só hash) | parcial | parcial |
| 3 licença por skill | ✖ | ✖ | ✖ |
| 4 validação estrutural (`skills-ref validate`) | ✖ | ✖ | ✖ |
| 5 inspeção estática no ingest | ✔ (padrões nomeados) | ✔ | ✔ |
| 6 quarentena para skill com `scripts/` | parcial (sem `has_scripts`) | parcial | parcial |
| 7 engine nunca executa script | ✔ | ✔ | ✔ |
| 8 `allowed-tools` sempre ignorado | ✖ | ✖ | ✖ |
| 9 `contain` inviolável | ✔ | ✔ | ✔ |
| 10 primeira aparição exige aprovação | ✔ **+ lote noturno parka** | ✔ | ✔ |
| 11 memória/config do agente no escopo | parcial (`DISABLE_AUTO_MEMORY`) | **✖ nem desliga** | parcial |
| 12 nunca ingerir `install.sh`/`hooks/` | ✖ | ✖ | ✖ |

Cinco controles (2-commit, 3, 4, 8, 12) não aparecem em nenhuma proposta. O 3 é bloqueio **legal**
conhecido: `anthropics/skills` não tem licença de repo e docx/pdf/pptx/xlsx são proprietárias;
`openai/skills` não declara licença (digest #12). O 8 importa mais em A e C, que injetam o corpo do
`SKILL.md` no pack: nenhuma das três diz que o frontmatter é removido antes da injeção, então
`allowed-tools` viaja como texto para dentro do prompt.

**C** afirma "Segurança C1–C9 é v1 inteira" e nomeia três (C3, C4, C8): uma lista de 9 não pode ser o
conjunto de 12, e a proposta que mais promete cobertura é a que menos enumera. **B** é a única que não
desliga a auto memory do Claude Code nas sessões despachadas — ela vem ligada por padrão, quebra
determinismo (#9) e "comprometimento persistente por manipulação da memória do agente" é categoria
nomeada do incidente ToxicSkills (3 984 skills, 36,8 % com falha, 91 % via prompt injection).

**Injeção por conteúdo observado.** As três repetem "achado é dado, nunca instrução" para pesquisa. O
canal maior fica aberto nas três: a regra de *losslessness* ("sucesso é resumível, **falha nunca é
resumida**", `landscape-context-observability.md` §2.1) entrega o log de falha **íntegro** ao Maker.
Um teste que falha imprimindo instrução é o vetor mais barato que existe, e o `redact_secrets` do pack
(I59) é outbound, não inbound. Nenhuma proposta cerca a saída de ferramenta como dado não confiável.

---

## 5. Permissões por nível

Fixo nos três níveis (§5.1): segurança > escopo, efeito externo sempre do engine, env do worker
filtrado (I49). `restricted` não deve ser desatendido — `ask_operator: "*"` — e **nenhuma das três põe
`ask_operator` em contrato**.

- **A**: `autonomy` por story, `--disallowedTools "Bash(git push*),Bash(gh pr*)"`, `--permission-prompts none`, I49 portado. Checker sem restrição de escrita.
- **B**: melhor desenho do painel — Checker de rodada `codex exec --sandbox read-only` e Checker de portão `--permission-mode plan`. Isso transforma I28 ("Checker que edita a árvore") de detecção em impossibilidade. `no_checker_family_available` → `parked`, nunca "aprovado sem revisão". Mas `autonomy_level` é do plano, não da story.
- **C**: `autonomy` por story e `restricted` para segredos, mas o Checker herda `--sandbox workspace-write` da linha de família (§5): **um revisor com permissão de escrita**, contra I28.

Em todas: `--disallowedTools "Bash(git push*)"` é glob de string — `git -C <dir> push`, um alias ou um
script de repo passam. A rede real é o env filtrado; nenhuma proposta escreve que a glob é
best-effort.

---

## 6. Custo

Âncoras medidas: piso de entrada do Codex headless ~19,4k tokens (#27; 18 738 medido no addendum do
Checker); `max_diff_bytes` herdado = 200 000 **chars** (~50k tokens) na seção de diff do Checker (port
map §6); teto de pack 40k; 3 corpos de skill ~6–7k; juiz visual ~6,1k in / 1,2k out
(US$ 0,04–0,18/rodada); rework multi-arquivo 30–150k; Codex nunca reporta USD (#28).

**Por story `feature`, 1 rodada de rework, sem UI** (entrada):

| Fatia | A | B | C |
| :--- | ---: | ---: | ---: |
| Pack do Maker | 25–40k | 25–40k | 25–40k |
| Checker (piso + contrato + diff) | 27–60k (`--ignore-user-config`) | 27–60k (`--ignore-user-config`) | **35–77k** (sem `--ignore-user-config`) |
| Rework | 30–45k | 30–45k | 30–45k |
| **Total in / chamadas** | **~85–145k / 3–4** | **~85–145k / 3–4** | **~95–165k / 3–5** |

Story de UI acrescenta 2 × 7,3k (juiz); D1–D7 são determinísticos e custam zero tokens nas três.

**Missão de 20 stories** (⅓ com UI, 30 % com 2ª rodada de rework):

| | A | B | C |
| :--- | ---: | ---: | ---: |
| Planejamento | 1–2 chamadas | 3 chamadas (etapas 2/4/5) + time de pesquisa | 2 chamadas fortes + até 3 consultas × 2–4 agentes |
| Chamadas totais | ~70–85 | ~85–100 | ~100–130 |
| Entrada total | **~2,3–2,6 M** | ~2,5–3,0 M | **~3,0–4,0 M** |

**Desperdício estrutural, em ordem de tamanho:**
1. **Piso do Codex** (19,4k × toda chamada de Checker ≈ 390k tokens por missão de 20): A e B podam com `--ignore-user-config`; **C não**.
2. **`max_diff_bytes` de 200 000 chars** herdado sem revisão nas **três**: uma story grande paga ~50k de entrada só de diff, por rodada, por Checker.
3. **Time de pesquisa** (~15× tokens, só se paga em recall): A usa 1 chamada condicional; B e C ligam 2–4 agentes na v1.
4. **N=2 na B**: não muda tokens, mas materializa duas worktrees — e nenhuma proposta custeia `node_modules` por worktree num repo JS (ou compartilha e quebra o isolamento, ou instala duas vezes).
5. **`better-sqlite3` na slice 1 de C** sem leitor (o painel está fora do escopo da slice).

---

## 7. Firewall e telemetria bastam para o harness doctor?

O doctor precisa de: taxa de injeção, custo de injeção com cache write/read separados, **taxa de
citação** (digest do bloco aparece em `sources` do resultado), correlação com `eval_pass`/`rework`, e
os dois candidatos estáticos (redundância, obsolescência) — §5.1.

- Firewall: as três o põem no executor da ADE, que é o veredito correto (§2.2 — os hooks são só do Claude Code). A o reduz a uma assinatura de função (`run(argv) → {rawPath, extract}`); B o põe no contrato via `max_output_bytes` do `Eval`; C idem. TDR (≤0,2 verde, 1,0 falha) está nas três. **Suficiente nas três.**
- Telemetria: **só B carrega a citação em contrato** (`skills_injected[{name, bytes, cited}]`). **A promete a métrica de citação em §7 e não tem campo `sources` em contrato nenhum** — metade da coleta da v1 não coleta. **C** não promete citação e também não a tem.
- Cego nas três: custo do braço Codex é sempre `unknown`, e `claude plugin eval` (a ablação que as três terceirizam) só roda no braço Claude. O A/B do doctor é estruturalmente cego em metade do harness, e nenhuma proposta nota isso.

---

## 8. Placar

| Critério | A | B | C |
| :--- | :-: | :-: | :-: |
| D1 Reconciliação e recuperação | 8 | **10** | 4 |
| D2 Contenção no Windows | **8** | 7 | 5 |
| D3 Supply chain e injeção | **7** | 5 | 6 |
| D4 Permissões e efeito externo | 7 | **8** | 6 |
| D5 Custo e telemetria | **9** | 6 | 5 |
| **Total** | **39** | 36 | 26 |

---

## 9. Falhas fatais

**A** — (1) `contain` só enxerga a árvore do worktree e A não tem canário de isolamento por família:
com `bypassPermissions`, escrita fora do worktree não é detectada por nada (#38 prova que acontece;
nada prova que claude/codex não fazem). (2) A citação (`sources`) é a métrica central do doctor v1 e
não existe em contrato nenhum.

**B** — (1) `detached` (que B exige para I09) e o Job Object kill-on-close da libuv (que B cita como
contenção grátis) são mutuamente exclusivos no Windows; a proposta afirma os dois e não escolhe. (2)
Não desliga `CLAUDE_CODE_DISABLE_AUTO_MEMORY` nas sessões despachadas: quebra determinismo (#9) e
mantém aberto o vetor de persistência nomeado pela Snyk. (3) N=2 + painel + PTY + time de pesquisa na
v1 custam superfície e tokens antes de a v1 existir.

**C** — (1) `JournalEvent` sem `input_digest` e sem `intent_context`: I05, I11, I14 e I17 não têm onde
existir e a reconciliação de `push`/`local_merge` é inexequível como especificada. (2) Recibo durável
(I65) ausente do desenho: I09 perde a branch "anexa" e todo crash de engine no Maker vira ambíguo
re-pago. (3) Checker com `--sandbox workspace-write` e sem `--ignore-user-config`: revisor que pode
escrever (contra I28) e piso de 19,4k pago 20 vezes por missão. (4) `contain mínimo` na slice 1 sem
aceite de segredo, e `maxBuffer` nunca mencionado.

---

## 10. Buracos que nenhuma proposta cobre

1. Job Object kill-on-close × recibo/attach no Windows: qual vence, e o que isso faz com I09.
2. Controles 2 (pin por commit), 3 (licença por skill — bloqueio legal conhecido), 4, 8 (`allowed-tools`/frontmatter removido antes da injeção) e 12 (`install.sh`/`hooks/`).
3. Saída de ferramenta como superfície de injeção: "falha nunca é resumida" entrega log hostil íntegro; nada a cerca como dado.
4. Lease após reboot com PID reciclado (B trata reuso de PID só no recibo).
5. `max_diff_bytes` de 200 000 chars herdado sem revisão.
6. Custo `unknown` no braço Codex + `claude plugin eval` só no braço Claude = ablação cega em metade do harness.
7. `--disallowedTools` é glob de string, contornável; a rede real é o env filtrado (I49) e ninguém o diz.
8. `node_modules` por worktree: custo e isolamento em N>1.
9. `ask_operator: "*"` para `restricted` não está em contrato nenhum.
10. Rede indisponível na retomada quebra a reconciliação de `push`/`pull_request` (exige `ls-remote`/`gh`); comportamento não definido (deve ser `awaiting_operator`, nunca retry).

---

## 11. Recomendação

Base **A**. Ela ganha nos dois critérios que não se consertam depois — custo estrutural e superfície
de ataque — e perde em D1/D4 por itens que são **campos e testes**, não arquitetura. B perde por
escopo: N=2, PTY, painel e time de pesquisa na v1 são superfície comprada antes de existir v1, e o par
`detached`/Job Object está por resolver. C não é adotável como base: o contrato de journal que ela
escreve não reconcilia push nem merge.

Enxertar em A, nesta ordem: (1) de B, `receipt_path` + fingerprint anti-reuso de PID, a matriz de
crash por fase como critério de aceite da slice 1, `skills_injected[].cited`, `session_ref: null`, e
sobretudo **Checker `--sandbox read-only` / portão `--permission-mode plan`** (I28 vira impossível em
vez de detectável) e `no_checker_family_available → parked`; (2) de C, o **canário de isolamento por
família verificado a cada chamada** e `eval_run{phase}` como classe de efeito; (3) dos buracos, no
mínimo: controle 3 (licença) e 8 (frontmatter removido antes da injeção), cerco da saída de falha como
dado não confiável, e `max_diff_bytes` reduzido com ponteiro.
