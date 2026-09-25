# ADR 0043 — Esforço máximo fora da escolha automática (emenda o ADR 0033)

**Status:** Aceito (escolha de Erick na entrevista, 2026-09-25: esforço conforme a dificuldade, máximo nunca na escolha
automática, menos cota quando a qualidade é parecida)

## Contexto

O [ADR 0033](0033-modelos-pelos-planos-emenda-0005.md) monta as filas de cada papel pela nota e deixa a escada `fix`
subir o esforço do mesmo modelo. Com Max 20x e Pro 20x a escada chegava sozinha ao esforço `max` do Opus 5.5 (high →
xhigh → max, duas rodadas cada no risco comum) antes da reserva de outra empresa. O `max` é o esforço mais caro e lento
e gasta a cota que as outras partes precisam. ADR aceito não se edita; este emenda o 0033.

## Decisão

1. **`buildChains` nunca escolhe o `max` sozinho**, em fila nenhuma nem na escada `fix`: as entradas de esforço `max`
   saem dos candidatos antes da nota. A escada sobe de esforço sem chegar ao máximo e termina na reserva de outra
   empresa, como no 0033.
2. **O `max` só entra no papel em que o usuário o fixou** (`models.effort.<papel> = "max"`); ali vale nos modelos que o
   oferecem, como qualquer esforço fixado (0033, item 5), e o porquê diz "esforço fixado pelo usuário".
3. **O porquê avisa.** Quando algum modelo disponível oferece o máximo e o papel não o fixou, a primeira linha do porquê
   da fila ganha "esforço máximo fora da escolha automática". A quantidade e a ordem das linhas não mudam: cada posição
   segue com a sua explicação no `ade models` e no painel.

## Evidência

- `tests/model_chains.test.ts`: C1.1 (nenhuma fila com `max`), C1.3 (`max` fixado no código comum), C1.4 (aviso no
  porquê) e CA5 (escada high → xhigh → reserva).
- `tests/model_routing.test.ts`: C1.2 e CA5 (o motor esgota os degraus sem despachar `max` e termina na reserva).

## Trade-offs

- Uma parte difícil que só o `max` resolveria vai para a reserva ou estaciona; o operador fixa o `max` no papel quando
  quiser pagar por ele.
- A escada fica mais curta (menos rodadas por parte no risco comum e sensível).

## Alternativas rejeitadas

- **`max` só no último degrau da escada**: segue gastando a cota mais cara sem pedido do usuário.
- **`max` quando a cota sobra**: a entrevista escolheu "nunca usar" na escolha automática.

## Como reverter

Retirar o filtro do `max` em `buildChains` (`src/models/chains.ts`) volta ao comportamento do 0033; enquanto isso, fixar
`max` no papel já o reativa só ali.

## Consequências para outros documentos

Nenhuma: o 0033 continua valendo no resto e não foi editado.
