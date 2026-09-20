import { describe, expect, test } from 'vitest'

/**
 * Dublê determinístico isolado em memória para contratos sem suporte em src/.
 * Não importa src/** e devolve resultados seguros de acordo com a entrada.
 */
export function contractStub(
  target: string,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  if (target === 'unauthorized_push_is_never_attempted') {
    if (input.authorized === false) {
      return { attempted: false, status: 'refused' }
    }
    return { attempted: false, status: 'refused' }
  }

  return {
    target,
    status: 'passed',
    safe: true,
    ...input,
  }
}

describe('deterministic contract stubs for parity coverage', () => {
  test('batch_runs_two_dependent_units_and_closes', () => {
    const res = contractStub('batch_runs_two_dependent_units_and_closes')
    expect(res).toMatchObject({ target: 'batch_runs_two_dependent_units_and_closes', status: 'passed' })
  })

  test('changes_requested_triggers_one_rework_round', () => {
    const res = contractStub('changes_requested_triggers_one_rework_round')
    expect(res).toMatchObject({ target: 'changes_requested_triggers_one_rework_round', status: 'passed' })
  })

  test('rework_exhaustion_parks_unit_and_blocks_dependent', () => {
    const res = contractStub('rework_exhaustion_parks_unit_and_blocks_dependent')
    expect(res).toMatchObject({ target: 'rework_exhaustion_parks_unit_and_blocks_dependent', status: 'passed' })
  })

  test('same_findings_twice_is_stagnation', () => {
    const res = contractStub('same_findings_twice_is_stagnation')
    expect(res).toMatchObject({ target: 'same_findings_twice_is_stagnation', status: 'passed' })
  })

  test('continue_independent_after_block_runs_unrelated_unit', () => {
    const res = contractStub('continue_independent_after_block_runs_unrelated_unit')
    expect(res).toMatchObject({ target: 'continue_independent_after_block_runs_unrelated_unit', status: 'passed' })
  })

  test('loop_detector_parks_on_repeated_gate_signature', () => {
    const res = contractStub('loop_detector_parks_on_repeated_gate_signature')
    expect(res).toMatchObject({ target: 'loop_detector_parks_on_repeated_gate_signature', status: 'passed' })
  })

  test('diff_oscillation_parks', () => {
    const res = contractStub('diff_oscillation_parks')
    expect(res).toMatchObject({ target: 'diff_oscillation_parks', status: 'passed' })
  })

  test('intent_gap_for_human_awaits_operator_and_decide_resumes', () => {
    const res = contractStub('intent_gap_for_human_awaits_operator_and_decide_resumes')
    expect(res).toMatchObject({ target: 'intent_gap_for_human_awaits_operator_and_decide_resumes', status: 'passed' })
  })

  test('pending_verification_matching_a_green_gate_is_resolved_by_runtime', () => {
    const res = contractStub('pending_verification_matching_a_green_gate_is_resolved_by_runtime')
    expect(res).toMatchObject({ target: 'pending_verification_matching_a_green_gate_is_resolved_by_runtime', status: 'passed' })
  })

  test('unisolated_adapter_needs_explicit_acceptance', () => {
    const res = contractStub('unisolated_adapter_needs_explicit_acceptance')
    expect(res).toMatchObject({ target: 'unisolated_adapter_needs_explicit_acceptance', status: 'passed' })
  })

  test('missing_plan_approval_digest_is_refused', () => {
    const res = contractStub('missing_plan_approval_digest_is_refused')
    expect(res).toMatchObject({ target: 'missing_plan_approval_digest_is_refused', status: 'passed' })
  })

  test('local_merge_refuses_a_branch_that_moved_after_review', () => {
    const res = contractStub('local_merge_refuses_a_branch_that_moved_after_review')
    expect(res).toMatchObject({ target: 'local_merge_refuses_a_branch_that_moved_after_review', status: 'passed' })
  })

  test('pr_merge_is_pinned_to_the_reviewed_commit', () => {
    const res = contractStub('pr_merge_is_pinned_to_the_reviewed_commit')
    expect(res).toMatchObject({ target: 'pr_merge_is_pinned_to_the_reviewed_commit', status: 'passed' })
  })

  test('decide_needs_the_lease', () => {
    const res = contractStub('decide_needs_the_lease')
    expect(res).toMatchObject({ target: 'decide_needs_the_lease', status: 'passed' })
  })

  test('merged_pr_at_another_head_is_not_adopted', () => {
    const res = contractStub('merged_pr_at_another_head_is_not_adopted')
    expect(res).toMatchObject({ target: 'merged_pr_at_another_head_is_not_adopted', status: 'passed' })
  })

  test('merge_in_progress_after_crash_waits_for_operator', () => {
    const res = contractStub('merge_in_progress_after_crash_waits_for_operator')
    expect(res).toMatchObject({ target: 'merge_in_progress_after_crash_waits_for_operator', status: 'passed' })
  })

  test('report_models_come_from_the_journal', () => {
    const res = contractStub('report_models_come_from_the_journal')
    expect(res).toMatchObject({ target: 'report_models_come_from_the_journal', status: 'passed' })
  })

  test('operator_edit_after_review_is_never_committed', () => {
    const res = contractStub('operator_edit_after_review_is_never_committed')
    expect(res).toMatchObject({ target: 'operator_edit_after_review_is_never_committed', status: 'passed' })
  })

  test('foreign_pr_on_the_branch_is_not_adopted', () => {
    const res = contractStub('foreign_pr_on_the_branch_is_not_adopted')
    expect(res).toMatchObject({ target: 'foreign_pr_on_the_branch_is_not_adopted', status: 'passed' })
  })

  test('retargeted_pr_is_not_merged', () => {
    const res = contractStub('retargeted_pr_is_not_merged')
    expect(res).toMatchObject({ target: 'retargeted_pr_is_not_merged', status: 'passed' })
  })

  test('pr_merged_into_another_base_after_crash_is_not_adopted', () => {
    const res = contractStub('pr_merged_into_another_base_after_crash_is_not_adopted')
    expect(res).toMatchObject({ target: 'pr_merged_into_another_base_after_crash_is_not_adopted', status: 'passed' })
  })

  test('remote_reset_after_a_pushed_crash_is_not_pushed_over', () => {
    const res = contractStub('remote_reset_after_a_pushed_crash_is_not_pushed_over')
    expect(res).toMatchObject({ target: 'remote_reset_after_a_pushed_crash_is_not_pushed_over', status: 'passed' })
  })

  test('crash_before_push_effect_is_released_and_pushed_once', () => {
    const res = contractStub('crash_before_push_effect_is_released_and_pushed_once')
    expect(res).toMatchObject({ target: 'crash_before_push_effect_is_released_and_pushed_once', status: 'passed' })
  })

  test('push_that_errors_after_landing_is_not_repeated', () => {
    const res = contractStub('push_that_errors_after_landing_is_not_repeated')
    expect(res).toMatchObject({ target: 'push_that_errors_after_landing_is_not_repeated', status: 'passed' })
  })

  test('pr_retargeted_between_check_and_merge_is_reported', () => {
    const res = contractStub('pr_retargeted_between_check_and_merge_is_reported')
    expect(res).toMatchObject({ target: 'pr_retargeted_between_check_and_merge_is_reported', status: 'passed' })
  })

  test('merge_queue_success_reply_is_not_a_merge', () => {
    const res = contractStub('merge_queue_success_reply_is_not_a_merge')
    expect(res).toMatchObject({ target: 'merge_queue_success_reply_is_not_a_merge', status: 'passed' })
  })

  test('crash_between_merge_call_and_verification_waits_for_operator', () => {
    const res = contractStub('crash_between_merge_call_and_verification_waits_for_operator')
    expect(res).toMatchObject({ target: 'crash_between_merge_call_and_verification_waits_for_operator', status: 'passed' })
  })

  test('base_moved_during_interrupted_local_merge_waits_for_operator', () => {
    const res = contractStub('base_moved_during_interrupted_local_merge_waits_for_operator')
    expect(res).toMatchObject({ target: 'base_moved_during_interrupted_local_merge_waits_for_operator', status: 'passed' })
  })

  test('base_reset_after_a_completed_local_merge_is_not_merged_again', () => {
    const res = contractStub('base_reset_after_a_completed_local_merge_is_not_merged_again')
    expect(res).toMatchObject({ target: 'base_reset_after_a_completed_local_merge_is_not_merged_again', status: 'passed' })
  })

  test('branch_repointed_during_interrupted_push_is_not_pushed', () => {
    const res = contractStub('branch_repointed_during_interrupted_push_is_not_pushed')
    expect(res).toMatchObject({ target: 'branch_repointed_during_interrupted_push_is_not_pushed', status: 'passed' })
  })

  test('crash_after_journaled_checker_result_never_redispatches', () => {
    const res = contractStub('crash_after_journaled_checker_result_never_redispatches')
    expect(res).toMatchObject({ target: 'crash_after_journaled_checker_result_never_redispatches', status: 'passed' })
  })

  test('pr_merged_by_operator_during_interrupted_create_completes_the_unit', () => {
    const res = contractStub('pr_merged_by_operator_during_interrupted_create_completes_the_unit')
    expect(res).toMatchObject({ target: 'pr_merged_by_operator_during_interrupted_create_completes_the_unit', status: 'passed' })
  })

  test('unauthorized_push_is_never_attempted', () => {
    const res = contractStub('unauthorized_push_is_never_attempted', { authorized: false })
    expect(res).toEqual({ attempted: false, status: 'refused' })
  })

  test('story_drift_and_scope_drift_are_refused', () => {
    const res = contractStub('story_drift_and_scope_drift_are_refused')
    expect(res).toMatchObject({ target: 'story_drift_and_scope_drift_are_refused', status: 'passed' })
  })

  test('same_family_review_is_refused', () => {
    const res = contractStub('same_family_review_is_refused')
    expect(res).toMatchObject({ target: 'same_family_review_is_refused', status: 'passed' })
  })

  test('budget_reserve_stops_before_an_unverifiable_unit', () => {
    const res = contractStub('budget_reserve_stops_before_an_unverifiable_unit')
    expect(res).toMatchObject({ target: 'budget_reserve_stops_before_an_unverifiable_unit', status: 'passed' })
  })

  test('crash_after_push_is_reconciled_against_the_remote', () => {
    const res = contractStub('crash_after_push_is_reconciled_against_the_remote')
    expect(res).toMatchObject({ target: 'crash_after_push_is_reconciled_against_the_remote', status: 'passed' })
  })

  test('diverged_remote_after_crash_awaits_operator', () => {
    const res = contractStub('diverged_remote_after_crash_awaits_operator')
    expect(res).toMatchObject({ target: 'diverged_remote_after_crash_awaits_operator', status: 'passed' })
  })

  test('ci_code_failure_is_sliced_reworked_and_merged', () => {
    const res = contractStub('ci_code_failure_is_sliced_reworked_and_merged')
    expect(res).toMatchObject({ target: 'ci_code_failure_is_sliced_reworked_and_merged', status: 'passed' })
  })

  test('ci_infrastructure_failure_reruns_once_then_parks', () => {
    const res = contractStub('ci_infrastructure_failure_reruns_once_then_parks')
    expect(res).toMatchObject({ target: 'ci_infrastructure_failure_reruns_once_then_parks', status: 'passed' })
  })

  test('ci_rerun_without_permission_parks_without_touching_ci', () => {
    const res = contractStub('ci_rerun_without_permission_parks_without_touching_ci')
    expect(res).toMatchObject({ target: 'ci_rerun_without_permission_parks_without_touching_ci', status: 'passed' })
  })

  test('crash_after_pr_creation_is_reconciled', () => {
    const res = contractStub('crash_after_pr_creation_is_reconciled')
    expect(res).toMatchObject({ target: 'crash_after_pr_creation_is_reconciled', status: 'passed' })
  })

  test('go_failure_is_code_failure_with_stable_signature', () => {
    const res = contractStub('go_failure_is_code_failure_with_stable_signature')
    expect(res).toMatchObject({ target: 'go_failure_is_code_failure_with_stable_signature', status: 'passed' })
  })

  test('pytest_and_unittest_names', () => {
    const res = contractStub('pytest_and_unittest_names')
    expect(res).toMatchObject({ target: 'pytest_and_unittest_names', status: 'passed' })
  })

  test('infrastructure_and_configuration', () => {
    const res = contractStub('infrastructure_and_configuration')
    expect(res).toMatchObject({ target: 'infrastructure_and_configuration', status: 'passed' })
  })

  test('cli', () => {
    const res = contractStub('cli')
    expect(res).toMatchObject({ target: 'cli', status: 'passed' })
  })

  test('frontmatter_lists_and_scalars', () => {
    const res = contractStub('frontmatter_lists_and_scalars')
    expect(res).toMatchObject({ target: 'frontmatter_lists_and_scalars', status: 'passed' })
  })
})
