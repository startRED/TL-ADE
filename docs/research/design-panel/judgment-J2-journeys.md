# Julgamento J2 — Jornadas e usuário preguiçoso

Juiz da lente J2. Data: 2026-09-16. Propostas lidas integralmente: `proposal-A-minimal.md`,
`proposal-B-durable.md`, `proposal-C-intent.md`. Referências factuais: `PROMPT.md` §5 e §7,
`docs/research/README.md` (digest), documentos citados nas próprias propostas.

Postura: adversarial. Procuro o que quebra a jornada, não o que a descreve bem.

---

## 0. Critérios da lente (0–10 cada)

| # | Critério | O que mede |
| :-- | :--- | :--- |
| **J2-1** | **Leveza da J1** | Perguntas, chamadas, artefatos de processo e cerimônia numa correção de 5 minutos. Processo demais aqui é bug (PROMPT §3.12). |
| **J2-2** | **Profundidade real em J5/J6** | Pesquisa, skills, evals, revisão independente e horas sem conversa gigante — executadas, não prometidas. |
| **J2-3** | **Conhecimento exigido do operador** | Superfície de conceitos, flags e arquivos que o usuário preguiçoso precisa dominar para operar e para entender uma parada. |
| **J2-4** | **Intervenção e recuperação quando o resultado é ruim** | Onde o humano entra, como assume, como descarta, como lê o motivo da parada. |
| **J2-5** | **Honestidade das jornadas declaradas** | Coerência interna entre mapa de componentes, roadmap e tabela de jornadas; números sustentáveis. |

---

## 1. Percurso das 6 jornadas

**Perguntas declaradas** (teto do PROMPT: ≤5)

| | J1 | J2 | J3 | J4 | J5 | J6 |
| :--- | :-- | :-- | :-- | :-- | :-- | :-- |
| A | 0 | 1–2 | 3–4 | **3–5** | 5 | 1 (ou 0) |
| B | 0 | 1–2 | 3–4 | 2–3 | 5 | 0 |
| C | 0 | 1 | 2–3 | 2 | 5 | 0 |

A encosta no teto já na classe `feature` (J4). C é a mais econômica em perguntas, mas paga isso
em J1 (abaixo).

**Tempo até começar e chamadas na J1**

- A: `< 30 s`, ~2 chamadas. Mas a J1 exige eval vermelho contra `tree_before` **e** não tem Checker
  LLM: em 2 chamadas (classificador + Maker), o eval só pode ter sido escrito pelo próprio Maker.
  A proposta não diz quem o escreve. O portão de estritez ainda vale, mas a única prova de "pronto"
  na J1 é um teste que o executor da mudança formulou.
- B: `~10 s`, ~2 chamadas — **o número menos crível da banca**. B define "começar" como
  "do envio à primeira escrita de arquivo", e a primeira escrita de arquivo em B é a linha do
  journal, não o código. Com a definição útil (primeira edição de fonte), B faz *mais* trabalho que
  A na J1 — lease, `prepare`, worktree, write-ahead — e ainda assim declara um terço do tempo.
  Pior: a faixa rápida de B pula a etapa 5 (plano), que é onde o eval nasceria, mas mantém a etapa
  8 (eval vermelho). A faixa rápida consome um artefato que ela mesma não produz.
- C: `< 30 s`, 2–3 chamadas, mas o fluxo §4 roda discovery + classificação + **interpretação com
  schema em modelo forte** antes do Maker. A própria R1 de C admite o risco ("tempo até começar
  > 60 s em `trivial`") e a correção — caminho curto determinístico por template — **não está no
  desenho, só na seção de reversão**. A proposta que centra a arquitetura na compilação de intenção
  é a que mais paga na jornada onde compilar intenção não agrega.

**J5/J6 — profundidade**

- A corta o **time de pesquisa** (1 chamada com schema) justamente onde o digest tem evidência a
  favor do paralelismo: leitura independente e comprimível rende +90 % por ~15× tokens. J5 é o caso
  canônico de "não tenho evidência para planejar" e A o atende com uma consulta.
  Contradição adicional: A corta Gemini/`agy` da v1 (duas famílias), mas a J3 promete "juiz
  alternando família" e a J5 promete "juiz alternado". Com Maker sempre `claude`, sobra uma única
  família de juiz: a rotação prometida é impossível no escopo que a própria proposta define.
- B é a única que entrega J5/J6 com largura real: time de pesquisa 2–4, N=2 exercitada com fila de
  merge e sweep de órfãs, painel-projeção, takeover PTY, `continue_independent_after_block`,
  `max_parked_units` e `max_wall_clock_seconds`. J6 retoma sem nova entrevista e escala por fila.
  O preço está no R3 da própria proposta: duas worktrees numa noite desatendida multiplicam órfãs e
  conflito de lockfile — risco assumido com mitigação nomeada.
- C tem o melhor insumo de qualidade para J5 (brief em 4 camadas, com a única medição causal
  publicada da banca) e o melhor gatilho de escalação (`target_role: "human"`), mas a J6 declara
  "lê spec viva + backlog" enquanto a tabela de componentes marca `.ade/spec/` como **pós-v1**. A
  jornada 6 de C, como escrita, não roda na v1. E o mecanismo central de C — prova vermelha contra
  `tree_before` — degrada exatamente no trabalho aditivo que domina um SaaS novo; a reversão da
  própria C é rebaixar a prova a aviso, ou seja, a garantia de qualidade da J5 é mais fraca do que
  o texto anuncia.

**Quando o resultado é ruim**

- A: rework do checkpoint, teto por story, detector de loop — e depois `ade report` sobre um JSONL.
  Sem painel na v1, ler *por que* parou é trabalho de operador. O `ade takeover` imprime uma linha
  de comando para o humano colar no próprio terminal, e a proposta admite que `--resume` não
  restaura `--add-dir`/`--settings`: o operador precisa lembrar deles. É o oposto de preguiçoso.
- B: matriz de crash por fase cobrindo engine, worker, máquina e browser; escalação vira fila no
  painel; checkpoint e descarte em refs; takeover PTY no mesmo worktree com regra inviolável ("só a
  árvore conta"). Melhor da banca — a partir da v0.4.
- C: escalação só por `target_role: "human"`, orçamento estourado ou empate de pesquisa — a regra
  mais limpa das três. Mas o §5 descreve takeover com CLI interativa relançada enquanto o mapa de
  componentes adia PTY para pós-v1: na v1 não há onde o operador digitar, e a proposta não diz que
  imprime um comando (como A faz explicitamente).

---

## 2. Pontuação

| Critério | A | B | C |
| :--- | :-- | :-- | :-- |
| J2-1 Leveza da J1 | 9 | 7 | 6 |
| J2-2 Profundidade J5/J6 | 5 | 9 | 6 |
| J2-3 Conhecimento do operador | 6 | 5 | 7 |
| J2-4 Intervenção e recuperação | 5 | 9 | 6 |
| J2-5 Honestidade das jornadas | 7 | 7 | 6 |
| **Total** | **32** | **37** | **31** |

Justificativas de uma frase em `scores[].criteria[].why` do objeto estruturado.

---

## 3. Falhas fatais (bloqueiam adoção como base)

**A** — (1) a J1 declara 2 chamadas e um eval vermelho obrigatório sem dizer quem escreve o eval:
como não há Checker LLM na classe `trivial`, a única prova de "pronto" é um teste escrito pelo autor
da mudança; (2) o corte para duas famílias torna impossível a rotação de juiz visual que as J3/J5 da
própria proposta prometem; (3) sem painel na v1, a J6 termina com o operador lendo JSONL de manhã e
o takeover exige recompor flags à mão.

**B** — (1) a faixa rápida da J1 pula a etapa que produz o eval e mantém o portão que o consome;
(2) o "~10 s" da J1 mede até a primeira escrita de arquivo, que é a linha do journal, tornando o
número da métrica de UX do PROMPT §7 não comparável com as outras propostas; (3) N=2 ligado por
padrão nas duas classes maiores é o modo de falha mais caro justamente na J6 desatendida.

**C** — (1) a J6 depende de `.ade/spec/`, marcado pós-v1 na própria tabela de componentes;
(2) a J1 leve só existe na seção de reversão (caminho curto por template), não no fluxo desenhado;
(3) o takeover da v1 descreve CLI interativa sem o PTY que a tabela adia, e a J3 é classificada como
`feature` (4–8 stories) quando A e B a tratam como `subsystem` (9–20) — subdimensiona a jornada
adjacente à 5.

---

## 4. Melhores ideias a enxertar na vencedora

**De A** — a tabela de cortes YAGNI nominal, com "pedido por" e motivo (é o instrumento que impede a
v1 de afundar); `ade takeover` **por linha de comando impressa** como fallback da v1, antes do PTY,
incluindo a reimpressão de `--add-dir`/`--settings` que o `--resume` não restaura; a formulação
correta da J6 — **não é classe de complexidade**, é lote com `autonomy` e orçamento de parede;
"skill nova de madrugada → `awaiting_operator`".

**De C** — `DesignBrief` em 4 camadas como campo obrigatório do contrato quando há UI;
`target_role: "human"` como **único** gatilho de escalação semântica; recusa na validação de
pergunta cuja resposta está no discovery; empate de pesquisa vira pergunta, nunca desempate oculto;
vigilância do custo real do classificador barato com queda para regra determinística.

**Enxerto que nenhuma tem pronto** — na faixa rápida, o eval da J1 é escrito na mesma chamada do
Maker e declarado como tal no journal, com o portão `tree_before` mantido; e a classe `trivial`
grava `eval_author: "maker"` para que a telemetria mostre se essa concessão custa defeitos escapados.

---

## 5. O que nenhuma proposta resolve

1. **Nenhuma métrica de UX do PROMPT §7 tem eval.** "Tempo até começar", "número de perguntas" e
   "conhecimento exigido" aparecem como números assertivos nas tabelas de jornada e em nenhum
   critério de aceite de slice. As três definem "começar" de formas diferentes e incomparáveis.
2. **"Não sei" não é resposta prevista.** As três desenham entrevista de ≤5 perguntas de múltipla
   escolha, e nenhuma diz o que acontece com a resposta mais provável do usuário preguiçoso — nem
   default assumido e registrado, nem incógnita promovida a pesquisa.
3. **Voltar de manhã e odiar o resultado não é jornada.** Há checkpoint por story em todas, mas
   nenhuma oferece descarte do **lote inteiro** em um comando, nem um resumo legível por humano do
   que a noite mudou (as três entregam fila de PRs e journal).
4. **Aprovação visual sem abrir navegador.** J2/J3 produzem screenshots como artefato e nota de
   juiz; nenhuma entrega ao usuário um caminho de "veja estas duas imagens e escolha", que é a forma
   preguiçosa de aprovar direção estética.
5. **Mudar de ideia no meio não é fluxo de primeira classe.** As três adiam steering para o ACP
   pós-v1; até lá, "na verdade, faz diferente" custa esperar o turno fechar ou assumir o terminal.

---

## 6. Recomendação

Base **B**. É a única cuja J5/J6 é executável como descrita e a única com faixa rápida explícita
para a J1 protegida por eval de slice — a forma certa de tratar o problema, mesmo com o número mal
medido. Enxertar: a disciplina de cortes e o takeover por linha de comando de A (adiando o PTY para
v0.4 sem deixar a v1 sem saída de emergência); o `DesignBrief` de 4 camadas, o `target_role: human`
e a recusa de pergunta respondível pelo repo, de C. Corrigir antes de implementar: definir quem
escreve o eval na faixa rápida; redefinir "tempo até começar" como "até a primeira edição de arquivo
de fonte" e transformá-lo em critério de aceite do slice 1 (J1 ≤ 30 s, 0 perguntas, ≤2 chamadas);
rebaixar N=2 de default para opt-in por lote, deixando o código N-capaz — o argumento de B para não
deixar apodrecer é bom, mas a noite desatendida da J6 não é o lugar de exercitá-lo.
