// @ts-check

/**
 * Deduplica a seção story no Context Pack, referenciando o contrato para evitar repetições.
 *
 * @param {Object} story Objeto com id, contract, evals, spec_revision, etc.
 * @param {string} [story.id]
 * @param {any} [story.contract]
 * @param {string | null} [story.spec_revision]
 * @param {Array<{ id: string }>} [story.evals]
 * @returns {{ text: string, saved_bytes: number }}
 */
export function dedupStorySection(story) {
  const text = JSON.stringify(
    {
      spec_revision: story.spec_revision ?? null,
      eval_ids: (story.evals ?? []).map((e) => e.id),
      refs: {
        task: '/task',
        evals: '/evals',
      },
    },
    null,
    2,
  )

  const evalsVal = story.evals ?? story.contract?.evals ?? []
  const oldStoryBytes = Buffer.byteLength(JSON.stringify(story, null, 2))
  const oldEvalsBytes = Buffer.byteLength(JSON.stringify(evalsVal, null, 2))
  const oldTaskBytes = Buffer.byteLength(String(story.contract?.task ?? ''))
  const newStoryBytes = Buffer.byteLength(text)

  const saved_bytes = Math.max(0, oldStoryBytes + oldEvalsBytes + oldTaskBytes - newStoryBytes)

  return { text, saved_bytes }
}
