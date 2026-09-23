# Noite desatendida — como rodar e como ler

Guia de operação da v1 (ADR 0029). O modo desatendido (`ade run --unattended`) é opt-in: `ade run` sem a flag mantém o
comportamento de sempre (`tests/unattended-v1.test.ts`, critério 9).

## 1. Antes de dormir

1. Aprove o plano: `ade approve`. Durante a noite o motor só avança unidades já aprovadas no plano
   congelado; ele não replaneja nem aprova contrato novo.
2. Declare no plano o orçamento da noite em `mission_budget`:
   - `max_wall_clock_seconds`: orçamento de parede do lote;
   - `max_parked_units`: teto de unidades estacionadas antes de o lote parar;
   - `max_usd`: teto de custo.
3. Rode:

```bash
ade run --plan <plano.json> --repo <repositório> --unattended
```

## 2. Precondições duras

Antes de qualquer despacho (e portanto antes de qualquer chamada paga) o motor confere, nesta ordem
(`src/engine/preflight.js`, `HARD_PRECONDITION_ORDER`):

| id | o que exige |
| --- | --- |
| `approval_frozen` | plano igual ao aprovado |
| `gates_active` | portões ativos |
| `eval_baseline_green` | baseline de eval verde |
| `rollback_point` | ponto de rollback registrado |
| `worktree_isolation` | worktree isolado por unidade |
| `permitted_effects` | efeitos externos só os de `authorization.permitted_effects` |

Qualquer falha grava `unattended_refused` no journal com a lista de falhas e sai com **exit 2**; nada
roda. As portas das precondições são montadas em `src/cli/run.js`.

## 3. Durante a noite

- Unidade bloqueada estaciona em `awaiting_operator` (evento `unit_parked` com `reason` e
  `evidence_path` absoluto); unidades independentes seguem, dependentes não rodam.
- Orçamento de parede esgotado ou teto de estacionadas atingido grava `batch_stopped` com o motivo
  (`wall_clock_exhausted`, `max_parked_units`); a story em curso chega ao checkpoint, não é
  abortada no meio de um efeito (`src/engine/budget.js`, `src/engine/loop.js`).
- Se `taskkill /T /F /PID` for recusado pelo sistema, o motor usa um encerramento de fallback
  limitado e grava `terminated_by`; nenhuma decisão depende desse resultado.

Códigos de saída: **0** noite sem paradas, **3** noite com paradas, **2** noite recusada por
precondição.

## 4. De manhã: o relatório matinal

```bash
ade report --mission .ade/missions/<id>
```

O relatório (`src/cli/report.js`) traz:

- a tabela de unidades com estado, motivo e commit;
- **Próximos passos**: o `git merge --ff-only` de cada unidade comitada e o motivo de cada unidade
  aguardando operador;
- **Unidades paradas**: uma linha por parada com o motivo e o caminho absoluto da evidência;
- custo por papel e, com `--quota`, cota por dia;
- **Calibração pendente**, quando existe proposta registrada que a configuração ainda não adotou.

Leia na ordem: primeiro se a noite parou (`batch_stopped`), depois cada unidade parada pela
evidência apontada, depois os merges.

## 5. Calibração dos cortes

```bash
ade report --calibrate --mission .ade/missions/<id>
```

Calcula, só sobre a telemetria já gravada no journal (`src/telemetry/harness.ts`, `calibrate`):

- `max_pack_bytes` e `review_max_diff_bytes`: p90 observado de `pack_bytes` e da seção `diff` do
  pack, com no mínimo 20 chamadas;
- `visual_cut`, pelo critério publicado sobre as 20 últimas stories com UI: mais de 10 % de
  `visual_defect_escaped` puxa o corte para 8,0; trabalho parado por `visual_cut_not_met` e aceito
  pelo operador à primeira vista puxa para 7,0; os dois gatilhos juntos mantêm o corte.

A proposta é impressa com os números que a originaram e registrada como `calibration_proposed`
(`status: pending`, com os limites em vigor). **Nunca é aplicada**: os limites só mudam quando o
operador edita e aprova `.ade/config.json` (`limits.max_pack_bytes`, `limits.review.max_diff_bytes`,
`visual.cut`). Enquanto a configuração não absorve a proposta, o relatório matinal mostra
"Calibração pendente". Sem amostra suficiente a saída é `sem proposta` com o motivo, e nada é
registrado. Configuração ilegível é erro, nunca limite padrão calado.

Provas: `tests/unattended-v1.test.ts`, `tests/calibration-v1.test.ts`.
