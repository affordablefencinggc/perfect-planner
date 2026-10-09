// Reviewed native surface. New commands require an explicit contract review;
// this static inventory is not proof of their runtime consent or containment.
export const nativeCapabilities = Object.freeze([
  'main-read-only', 'main-collision-authority', 'main-bundled-mcp',
  'main-git-inventory', 'main-native-drafts', 'main-agent-observation',
  'main-check-setup', 'main-task-results', 'main-core-launch',
]);
export const nativeInvokeHandlers = Object.freeze([
  'runtime_snapshot',
  'native_agent_commands::inspect_agent_sessions',
  'native_agent_commands::read_agent_exchange_notes',
  'native_agent_commands::prepare_agent_pairing',
  'native_agent_commands::prepare_agent_plan_pairing',
  'native_agent_commands::prepare_agent_proposal_pairing',
  'native_agent_commands::stop_project_agent_broker',
  'native_draft_commands::inspect_native_draft_proposal',
  'native_draft_commands::read_native_draft_snapshot',
  'native_draft_commands::submit_native_draft_proposal',
  'native_draft_commands::choose_native_check_setup',
  'native_draft_commands::prepare_native_checks',
  'native_draft_commands::inspect_native_checks',
  'native_draft_commands::review_native_checks',
  'native_draft_commands::recover_native_check_review',
  'native_draft_commands::execute_native_check',
  'native_draft_commands::recover_native_check_execution',
  'native_draft_commands::execute_native_task',
  'native_draft_commands::recover_native_task_execution',
  'native_draft_commands::inspect_native_task_result',
  'native_draft_commands::list_native_task_results',
  'native_draft_commands::read_native_task_result_page',
  'native_mcp::check_bundled_mcp_connection',
  'native_git::inspect_registered_git_inventory',
  'workspace_picker::select_workspace_folder',
  'workspace_census::register_workspace_read_only',
  'workspace_census::census_registered_workspace',
  'workspace_census::preview_registered_workspace',
  'collision_authority::collision_authority_inspect',
  'collision_authority::collision_authority_approve',
  'collision_authority::collision_authority_commit',
  'core_launch::take_core_launch',
]);
export const nativeCommands = Object.freeze(nativeInvokeHandlers.map(value => value.split('::').at(-1)));
export function declaredNativeCommands(source) {
  const matches = [...source.matchAll(/\.commands\(\s*&\[([^\]]*)\]\s*\)/g)];
  if (matches.length !== 1) return null;
  const body = matches[0][1];
  if (!/^\s*(?:"[a-z_]+"\s*,\s*)*"?[a-z_]*"?\s*,?\s*$/.test(body)) return null;
  return [...body.matchAll(/"([a-z_]+)"/g)].map(match => match[1]);
}
export function declaredNativeHandlers(source) {
  const matches = [...source.matchAll(/tauri::generate_handler!\[([^\]]*)\]/g)];
  if (matches.length !== 1) return null;
  const body = matches[0][1];
  if (!/^[a-z_:\s,]+$/.test(body)) return null;
  return body.split(',').map(value => value.trim()).filter(Boolean);
}


