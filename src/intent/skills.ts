import { selectStorySkills } from '../skills/select.ts'

/**
 * Seleciona identificadores de skills elegíveis correspondendo deterministamente por domínio e linguagem.
 * Nunca retorna skill fora do conjunto elegível.
 */
export function selectEligibleSkills({ story = {}, eligibleSkills = [] }: { story?: { domains?: string[]; domain?: string; languages?: string[]; language?: string; task?: string }; eligibleSkills?: any[] }): string[] {
  if (!Array.isArray(eligibleSkills) || eligibleSkills.length === 0) {
    return []
  }

  // Quando houver skills estruturadas, utiliza o seletor Skill Fabric com BM25
  const hasStructured = eligibleSkills.some((s) => s && typeof s === 'object' && s.id)
  if (hasStructured) {
    const candidates = eligibleSkills
      .filter((s) => s && typeof s === 'object' && s.id)
      .map((s) => ({
        ...s,
        id: s.id,
        name: s.name || s.id,
        domains: s.domains || (s.domain ? [s.domain] : []),
        languages: s.languages || (s.language ? [s.language] : []),
      }))

    const selected = selectStorySkills({
      story: {
        ...story,
        domains: story.domains || (story.domain ? [story.domain] : []),
        languages: story.languages || (story.language ? [story.language] : []),
      },
      candidates,
    })

    if (selected.length > 0) {
      return selected.map((s) => s.id)
    }
  }

  const storyDomains = (story.domains || []).map((d: string) => d.toLowerCase())
  const storyLanguages = (story.languages || []).map((l: string) => l.toLowerCase())
  const selected = []

  for (const skill of eligibleSkills) {
    if (typeof skill === 'string') {
      const lower = skill.toLowerCase()
      if (storyDomains.some((d: string) => lower.includes(d)) || (story.task && story.task.toLowerCase().includes(lower))) {
        selected.push(skill)
      }
      continue
    }

    if (!skill || typeof skill !== 'object' || !skill.id) {
      continue
    }

    const skillDomains = (skill.domains || []).map((d: string) => d.toLowerCase())
    const skillLanguages = (skill.languages || []).map((l: string) => l.toLowerCase())

    // Verificar se há interseção de domínio
    const domainMatch = skillDomains.some((d: string) => storyDomains.includes(d))
    if (!domainMatch) {
      continue
    }

    // Se a skill especificar linguagens e a story tiver linguagens, verificar interseção de linguagem
    let languageMatch = true
    if (skillLanguages.length > 0 && storyLanguages.length > 0) {
      languageMatch = skillLanguages.some((l: string) => storyLanguages.includes(l))
    }

    if (languageMatch) {
      selected.push(skill.id)
    }
  }

  return selected
}
