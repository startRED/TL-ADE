
/**
 * Deduplica a seção story no Context Pack, referenciando o contrato para evitar repetições.
 *
 * @param story Objeto com id, contract, evals, spec_revision, etc.
 */
export function dedupStorySection(story: { id?: string; contract?: any; spec_revision?: string|null; evals?: Array<{ id: string }> }): { text: string; saved_bytes: number } {
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
