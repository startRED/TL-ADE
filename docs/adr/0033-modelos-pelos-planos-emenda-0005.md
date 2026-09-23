# ADR 0033 — Modelos escolhidos pelos planos, escada por inteligência e reserva de outra empresa (emenda o ADR 0005)

**Status:** Aceito (decisão do plano da v3 aprovado por Erick, 2026-09-23)

## Contexto

O [ADR 0005](0005-duas-familias-v1-agy-v0x-maker-checker-por-model-id.md) fixou escritor e revisor de famílias
diferentes e uma escada entre famílias escolhida no contrato. O usuário assina planos (Claude, ChatGPT, Google) com cotas
semanais diferentes, e a demo (proto/models.mjs) mostrou que a escolha de modelo precisa olhar a cota, a inteligência
medida pela Artificial Analysis e a qualidade observada no próprio histórico. ADR aceito não se edita; este emenda o 0005.

## Decisão

1. **Catálogo, planos e papéis** moram em `src/models/catalog.ts` (dados de 22/09/2026, reescritos da demo sem
   importá-la). Cada papel tem mínimo de inteligência, peso do tempo e peso da cota.
2. **Dois sinais separados.** Capacidade (`capacityPressure`): cota semanal projetada até a renovação; sem leitura, pelo
   tamanho do plano; API sem pressão, o dólar só entra na nota e no porquê (ADR 0032). Qualidade (`measureQuality`):
   aprovação do revisor e chamadas sem mudar arquivo, só nos papéis de quem escreve, com no mínimo 5 revisões.
3. **Filas por papel** (`buildChains`): até 3 modelos distintos; um esforço por modelo, menos na escada `fix`, que pode
   repetir o modelo em esforços crescentes. Quem atinge o mínimo do papel vem antes. As duas primeiras posições de quem
   revisa são de empresas diferentes da que encabeça o código comum.
4. **Escada.** Começa no titular do código difícil; a nota só escolhe os candidatos, a ordem dos degraus é a inteligência
   do catálogo; a reserva de outra empresa entra por último, uma vez, e não conta como subida (v03-s6f). Rodadas por
   degrau: leve 1, comum 2, sensível 3.
5. **Escolhas do usuário.** Planos, bloqueios e esforço por papel na chave `models` de `.ade/config.json`; a cota
   informada à mão em `.ade/quota-manual.json` (fora do carimbo da missão) e vencida na hora de renovação informada.
   Modelo bloqueado nunca é despachado, com ou sem planos. Esforço fixado vale nos modelos que o oferecem e o tempo
   desse esforço deixa de pesar na nota, porque foi escolha do usuário.
6. **Automático contra portão.** Refazer as filas não altera plano nem contrato aprovados; sem `models.plans`, valem os
   papéis do contrato como antes.

## Evidência

- `tests/model_chains.test.ts`: catálogo, capacidade, qualidade medida, filas, escada, bloqueio, esforço fixado e cota.
- `tests/cli_models.test.ts`: `ade models` e seus subcomandos gravando sem apagar outras chaves e recusando com código 2.

## Trade-offs

- Os números do catálogo envelhecem; atualizar pela internet fica fora do recorte.
- Uma nota medida com poucas amostras é ignorada; o custo é demorar a reagir a um modelo que piorou.

## Como reverter

Sem `models.plans` o motor volta aos papéis do contrato; remover a chave `models` desfaz a escolha pelos planos.
