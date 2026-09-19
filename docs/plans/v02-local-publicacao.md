# Registro de Publicação e Preservação dos ADRs Aceitos

Este documento registra a integridade documental dos ADRs 0012 e 0013 para a compilação local da v0.2, estabelecendo a referência inspecionada e o limite do contrato em relação às decisões já aceitas.

## Referência

Os identificadores abaixo representam a leitura local desta compilação a partir do commit de referência:

- **Commit de referência:** `90d6ae5faf9b72cbf5e4d0632ec8612bd6d5fa91`
- **ADR 0012:** `docs/adr/0012-engine-dono-de-worktree-e-processo.md`
  - Blob git: `ee36558062e07bc5e45cd59ae362d9005e2a4a0f`
- **ADR 0013:** `docs/adr/0013-painel-projecao-takeover-por-comando-pty-depois.md`
  - Blob git: `d4c6fcfd017f72acb1ab32275a75602e2fb4c489`

Esses valores identificam a referência de preservação inspecionada diretamente no repositório local nesta compilação.

## Integridade

A conferência de integridade aceita diretamente os hashes SHA-256 observados para as terminações LF e CRLF em cada plataforma, sem normalização interna durante a checagem.

- **ADR 0012:**
  - LF: `486835fb73467394cb21737dfd8130cb3e50ce4aa62bfe0827cdf20f593bd754`
  - CRLF: `45d05f4dfe4b4df519c8c3f31e27bf2de089dc213c8fdf0da26cc1c3fb1f9835`
  - CRLF integral derivado: `f6e497a7a8792c87c4df43d29fb22d5930a08e90e98b1689eb5939586b02be7f`
- **ADR 0013:**
  - LF: `5fa1ea54f9674a75cd2ba02863c3666eaf5163ce96476cf30a9f9aa828e33ffd`
  - CRLF: `203e92cb9315355de822bf5e6466db4b69724d035b161647639c1ce96e738892`
  - CRLF integral derivado: `63b906efd82a8b717ada6871ba17d23d40491db36e30c61319cf8fa7b6046357`

Diagnóstico para bytes ou hashes fora da lista permitida:
`Integridade divergente; restauração não autorizada`

## Limite do contrato

- O estado 'preservação verificada' descreve apenas a referência identificada e inspecionada neste repositório.
- A menção a 'restauração não executada' descreve a exigência anterior contraditória; não houve nem há autorização para restaurar ou modificar arquivos aceitos.
- Qualquer divergência futura bloqueia alterações dependentes e não autoriza restaurar arquivos nem enfraquecer provas existentes.
