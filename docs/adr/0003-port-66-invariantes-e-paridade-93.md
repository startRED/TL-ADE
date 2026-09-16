# ADR 0003 — Porte literal dos 66 invariantes e paridade 93/93 como critério de saída da v0.2

**Status:** aceito 2026-09-17

## Contexto

A durabilidade do runtime de referência v0.17.0 existe em 66 invariantes já testados; reimplementá-los
"melhor" é o caminho mais rápido para perder trabalho em crash. O critério de paridade herdado do
PROMPT.md ("os 10 casos que falham no Windows devem passar") estava errado na origem, e o painel
colocou paridade total dentro de um slice 1 que só faz commit local.

## Decisão

Porte literal de I01–I66 (`runtime-port-map.md` §1), incluindo classes de efeito novas com regra de
reconciliação própria (`eval_run`, `visual_eval`, `research`, `human_takeover`, `human_release`,
`catalog_sync`, mais `gate` e `prepare`, E6). Critério de paridade: **93/93 de `test_tl_runtime.py` em
Windows e Linux, incluindo o caso hoje skipado**, acompanhado da **tabela de mapeamento de nomes**
`parity-name-map.json` — lista fechada dos casos que mudam de nome ou semântica por `review-result`
rico e por `plan` — que é artefato de **entrada** da v0.2, escrito antes dos testes (E26). Paridade
completa é critério de saída da **v0.2**, não do slice 1; o slice 1 leva um **subconjunto nomeado de 44
casos** e a **matriz de crash × fase** (engine, worker, máquina, browser) como critério de aceite, mais
cobertura ≥85 % de linhas apenas em `journal, step, lease, git, runner, contain` **[hipótese]** (E27).
A suíte Vitest roda com paralelismo por caso e separa dois alvos normativos: `parity` (zero credencial,
CI Windows + Linux, CLI falsa por família) e `probes` (chamadas reais, local, opt-in). I15 (`ci_rerun`)
e I40 (merge remoto exige CI verde) são **portados desligados**, com teste do caminho inerte e
`ci.enabled: false` por default (E25).

## Evidência

- Digest #1 / `runtime-port-map.md` §0: execução local 2026-09-16 — `Ran 93 tests in 1092.872s / OK
  (skipped=1)`, 0 falhas. Os "10" do PROMPT.md vêm de `test_context_ledger` e `test_resume_generate`
  (CHANGELOG v0.15.0 231-232), helpers que a ADE **não** porta.
- `runtime-port-map.md` §0: o único skip, `test_push_that_errors_after_landing_is_not_repeated`
  (687, skip em 700-701), é limitação do fixture (`shim .cmd` não repassa mensagem multi-linha) e
  desaparece no porte TS, onde o shim vira `node shim.js`.
- `runtime-port-map.md` §0: ~11,7 s/caso, 18 min em série — paralelismo é requisito de porte.
- `judgment-J1-implementability.md` §2, falha fatal 1: aceite de 93/93 + crash em push/PR num slice que
  só faz commit local é insustentável em 3 semanas → vira critério de saída da v0.2.
- `judgment-J1-implementability.md` §5.3: nenhuma proposta listou quais casos mudam de nome ou semântica
  — daí a tabela de mapeamento ser obrigatória, não opcional.
- Digest #32: `review-result.schema.json` diverge do runtime em dois pontos (`classify_dispatch`,
  `Runtime.review`); é o caso exemplar de teste que precisa ser renomeado, não relaxado.

## Trade-offs

Porte literal importa decisões do Python que ninguém revisaria hoje (o `max_diff_bytes` de 200 000
chars é uma delas — reduzido a 60 000 chars em ADR 0011) e bloqueia refactor oportunista durante o
porte. A tabela de mapeamento é trabalho manual e precisa de disciplina: cada linha nela é uma renúncia
consciente à paridade de nome, e escrevê-la antes dos testes (artefato de entrada) antecipa esse
trabalho para o início da v0.2. O portão de cobertura em seis módulos deixa o resto da base sem barra
numérica: a razão teste:produção vai no corpo do PR, sem portão. Rodar a suíte em CI Windows continua
caro em tempo de parede.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Reimplementar a durabilidade do zero | os invariantes já são o resultado de crashes reais; a economia é ilusória |
| Portar só o subconjunto "necessário" | a proposta que fez isso cobre ~15 invariantes no slice 1 e leva K4 = 6 (J1 §4) |
| Manter o critério "10 falham no Windows" | número herdado do helper errado (digest #1) |
| Paridade total no slice 1 | escopo e barra se contradizem (J1, falha fatal 1); slice 1 leva 44 casos nomeados (E26) |
| Tabela de mapeamento escrita depois dos testes | vira racionalização de falha; é artefato de entrada da v0.2 (E26) |

## Como reverter

Gatilho: caso de teste que perde sentido no novo schema. Custo: baixo — entra na tabela de mapeamento
com justificativa, nunca vira exceção silenciosa nem `skip`. Reverter o porte literal em si (reescrever
um invariante) exige ADR próprio.

## Consequências para outros documentos

`docs/roadmap.md` (aceite do slice 1 e da v0.2), `parity-name-map.json`, `docs/specs/` (durabilidade e
reconciliação), ADR 0002, ADR 0006 (forma rica do `review-result` e os nomes que mudam), ADR 0021, ADR 0022.

## Emendas (2026-09-17)

- E42: `takeover_open` acrescenta um teste próprio fora do lote portado — `dispatch_into_open_takeover_is_refused`, cobrindo a recusa de despacho em worktree com `takeover.json` presente (`prepare` recusa, a story para em `awaiting_operator{reason:'takeover_open'}`); não altera a paridade 93/93 nem o subconjunto de 44 casos nomeados do slice 1.
