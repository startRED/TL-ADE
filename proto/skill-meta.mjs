// A descrição no frontmatter de uma skill pode ser uma linha só ou um bloco YAML (">" ou "|").
// O leitor antigo pegava apenas a primeira linha: nas skills em bloco ele devolvia ">" e elas entravam
// no catálogo sem descrição, então a IA que escolhe skills por papel nunca as escolhia (11 de 226 em 19/09).
export function skillDescription(frontmatter) {
  const raw = /description:[ \t]*(.*(?:\n[ \t]+\S.*)*)/.exec(frontmatter || '')?.[1] || ''
  return raw.replace(/^[>|][-+0-9]*/, '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '').slice(0, 220)
}
