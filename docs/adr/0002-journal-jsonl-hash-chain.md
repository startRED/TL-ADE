# ADR 0002 — Journal JSONL append-only com cadeia de hash sobre JSON canônico

**Status:** aceito 2026-09-17

## Contexto

O journal é uma das três coisas que a ADE não pode terceirizar (`architecture.md` §1): é a única fonte
de verdade sobre o que foi tentado, o que teve efeito e o que ficou ambíguo depois de um crash. O
runtime de referência resolve isso com JSONL, write-ahead e encadeamento por hash (I01–I06), e o porte
precisa preservar o comportamento **byte a byte**, não só a intenção.

## Decisão

`journal.jsonl` append-only por missão, um evento por linha. `prev` = 16 hex do SHA-256 da linha
anterior calculado sobre a serialização **canônica** (RFC 8785 / JCS, via `canonicalize`). `fsync` por
linha. Escritor único serializado por fila assíncrona: dois `step()` concorrentes na mesma unidade são
proibidos por construção. `format_version: 1` no evento, com `runtime_stamp` (`<versão do
engine>:<digest da config>`). Um teste de paridade compara a saída do canonicalizador TS com fixture
byte-idêntica gerada pelo Python de referência.

## Evidência

- `runtime-port-map.md` §1.1, I01–I06: `Runtime.step` 1285-1324 (intent 1298-1300, efeito 1302, result
  1310-1312), provado por `test_crash_before_maker_effect_releases_the_call` (1086) e pares.
- `runtime-port-map.md` §1.1, I01, risco médio: em Node o `await` entre intent e efeito abre janela de
  reentrância — daí a fila serializada.
- Digest #30: `canonicalize` é Apache-2.0 com zero dependências.
- `judgment-J1-implementability.md` §3 (K4): `canonicalize_output_byte_identical_to_python_reference_fixture`
  é "a melhor ideia isolada do painel" porque um canonicalizador errado quebra a cadeia **em silêncio**
  (I02) e nenhuma outra checagem barata detecta isso.

## Trade-offs

`fsync` por linha limita a taxa de eventos a centenas por segundo — irrelevante com N=1 (ADR 0014),
revisível se a concorrência subir. `prev` de 16 hex (64 bits) é truncamento: suficiente contra
corrupção acidental e reordenação, insuficiente contra adversário com escrita no arquivo — ameaça que
não existe num arquivo local do próprio usuário. A fila serializada torna o journal um ponto de
serialização global por missão; é o preço da ordem total que a reconciliação assume.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| SQLite como store primário | perde diffabilidade, inspeção com `tail`/`rg` e o porte literal dos testes; SQLite entra só como projeção reconstruível (ADR 0013) |
| `JSON.stringify` sem JCS | ordem de chaves não é garantida entre engines/versões; a cadeia quebraria sem aviso |
| Assinatura criptográfica dos eventos | não há ameaça correspondente; custo de chave sem ganho |
| Hash completo (64 hex) | 4× de bytes por linha sem ganho prático na única ameaça real |
| Log estruturado de terceiros (pino etc.) | não dá controle sobre `fsync` por linha nem sobre serialização canônica |

## Como reverter

Gatilho para hash completo ou algoritmo diferente: colisão observada ou requisito de auditoria externa.
Custo: `format_version: 2` mais migração explícita (ADR 0021); journals antigos continuam legíveis
porque o campo é versionado. Gatilho para relaxar o `fsync`: medição de throughput com N>1.

## Consequências para outros documentos

`schemas/journal-event.schema.json`, `docs/specs/` (engine, reconciliação), ADR 0003 (paridade dos
testes que provam I01–I06), ADR 0013 (painel lê projeção, nunca o arquivo direto), ADR 0021
(`format_version` e `runtime_stamp`).
