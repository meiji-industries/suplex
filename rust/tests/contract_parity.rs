//! Every request contract against the Zod fixtures under `tests/parity`.
//! An accepted input must produce Zod's output and a typed request; a rejected
//! input must produce the same set of `code`/`field` findings (order is free).

use std::collections::BTreeSet;

use serde_json::Value;
use suplex::http::contracts::typed::{
    Contract, ContractFailure, ContractResult, agent_api, auth, avatars, github_auth,
    github_triggers, oauth, projects, system, task_answers, task_templates, tasks, workflows,
};

type Schema = fn(Option<&Value>) -> ContractResult<Value>;

/// One test per contract: `name: "module.Schema" => schema`.
macro_rules! parity {
    ($($test:ident: $contract:literal => $schema:expr,)*) => {
        const CONTRACTS: &[&str] = &[$($contract),*];
        $(
            #[test]
            fn $test() {
                check($contract, $schema);
            }
        )*
    };
}

/// The schema output, after checking that serde builds the typed request from it.
macro_rules! typed {
    ($type:ty) => {
        |input: Option<&Value>| {
            let value = <$type>::schema(input)?;
            <$type>::parse(input)?;
            Ok(value)
        }
    };
}

parity! {
    agent_api_admin_agent_params: "agent-api.AgentApiAdminAgentParamsSchema" => typed!(agent_api::AgentIdParams),
    agent_api_admin_create_body: "agent-api.AgentApiAdminCreateBodySchema" => typed!(agent_api::AdminCreateBody),
    agent_api_admin_list_query: "agent-api.AgentApiAdminListQuerySchema" => typed!(agent_api::AdminListQuery),
    agent_api_admin_projects_body: "agent-api.AgentApiAdminProjectsBodySchema" => typed!(agent_api::AdminProjectsBody),
    agent_api_delivery_decision_body: "agent-api.AgentApiDeliveryDecisionBodySchema" => typed!(agent_api::DeliveryDecisionBody),
    agent_api_merge_approval_body: "agent-api.AgentApiMergeApprovalBodySchema" => typed!(agent_api::MergeApprovalBody),
    agent_api_merge_body: "agent-api.AgentApiMergeBodySchema" => typed!(agent_api::MergeBody),
    agent_api_merge_train_query: "agent-api.AgentApiMergeTrainQuerySchema" => typed!(agent_api::MergeTrainQuery),
    agent_api_pairing_exchange_body: "agent-api.AgentApiPairingExchangeBodySchema" => typed!(agent_api::PairingExchangeBody),
    agent_api_project_discovery_query: "agent-api.AgentApiProjectDiscoveryQuerySchema" => typed!(agent_api::ProjectDiscoveryQuery),
    agent_api_task_command_body: "agent-api.AgentApiTaskCommandBodySchema" => typed!(agent_api::TaskCommandBody),
    agent_api_task_command: "agent-api.AgentApiTaskCommandSchema" => agent_api::task_command,
    agent_api_task_create_body: "agent-api.AgentApiTaskCreateBodySchema" => typed!(agent_api::TaskCreateBody),
    agent_api_task_dependencies_body: "agent-api.AgentApiTaskDependenciesBodySchema" => typed!(agent_api::TaskDependenciesBody),
    agent_api_task_filter: "agent-api.AgentApiTaskFilterSchema" => agent_api::task_filter,
    agent_api_task_id_params: "agent-api.AgentApiTaskIdParamsSchema" => typed!(agent_api::TaskIdParams),
    agent_api_task_list_query: "agent-api.AgentApiTaskListQuerySchema" => typed!(agent_api::TaskListQuery),
    auth_company_issue_code_body: "auth.CompanyIssueCodeBodySchema" => typed!(auth::CompanyIssueCodeBody),
    auth_company_name_body: "auth.CompanyNameBodySchema" => typed!(auth::CompanyNameBody),
    auth_display_name_body: "auth.DisplayNameBodySchema" => typed!(auth::DisplayNameBody),
    auth_membership_body: "auth.MembershipBodySchema" => typed!(auth::MembershipBody),
    auth_profile_body: "auth.ProfileBodySchema" => typed!(auth::ProfileBody),
    avatars_avatar_image_body: "avatars.AvatarImageBodySchema" => typed!(avatars::AvatarImageBody),
    avatars_avatar_owner_params: "avatars.AvatarOwnerParamsSchema" => typed!(avatars::AvatarOwnerParams),
    avatars_avatar_shape: "avatars.AvatarShapeSchema" => avatars::shape,
    avatars_avatar_update_body: "avatars.AvatarUpdateBodySchema" => typed!(avatars::AvatarUpdateBody),
    common_authentication_verification_body: "common.AuthenticationVerificationBodySchema" => typed!(auth::AuthenticationVerificationBody),
    common_company_id_params: "common.CompanyIdParamsSchema" => typed!(auth::CompanyIdParams),
    common_company_status_params: "common.CompanyStatusParamsSchema" => typed!(auth::CompanyStatusParams),
    common_credential_id_params: "common.CredentialIdParamsSchema" => typed!(auth::CredentialIdParams),
    common_empty_body: "common.EmptyBodySchema" => typed!(auth::EmptyBody),
    common_project_id_params: "common.ProjectIdParamsSchema" => typed!(projects::ProjectIdParams),
    common_registration_verification_body: "common.RegistrationVerificationBodySchema" => typed!(auth::RegistrationVerificationBody),
    common_task_artifact_params: "common.TaskArtifactParamsSchema" => typed!(tasks::TaskArtifactParams),
    common_task_id_params: "common.TaskIdParamsSchema" => typed!(tasks::TaskIdParams),
    common_token_body: "common.TokenBodySchema" => typed!(auth::TokenBody),
    common_user_id_params: "common.UserIdParamsSchema" => typed!(auth::UserIdParams),
    github_auth_git_hub_device_poll_body: "github-auth.GitHubDevicePollBodySchema" => typed!(github_auth::DevicePollBody),
    github_triggers_github_trigger_company_params: "github-triggers.GithubTriggerCompanyParamsSchema" => typed!(github_triggers::GithubTriggerCompanyParams),
    github_triggers_github_trigger_create: "github-triggers.GithubTriggerCreateSchema" => typed!(github_triggers::GithubTriggerCreate),
    github_triggers_github_trigger_params: "github-triggers.GithubTriggerParamsSchema" => typed!(github_triggers::GithubTriggerParams),
    github_triggers_github_trigger_patch: "github-triggers.GithubTriggerPatchSchema" => typed!(github_triggers::GithubTriggerPatch),
    oauth_oauth_client_registration: "oauth.OAuthClientRegistrationSchema" => typed!(oauth::ClientRegistration),
    oauth_oauth_consent_approval: "oauth.OAuthConsentApprovalSchema" => typed!(oauth::ConsentApproval),
    oauth_oauth_consent_params: "oauth.OAuthConsentParamsSchema" => typed!(oauth::ConsentParams),
    projects_profile_body: "projects.ProfileBodySchema" => typed!(projects::ProfileBody),
    projects_profile_list_query: "projects.ProfileListQuerySchema" => typed!(projects::IncludeArchivedQuery),
    projects_profile_patch_body: "projects.ProfilePatchBodySchema" => typed!(projects::ProfilePatchBody),
    projects_project_agent_task_policy: "projects.ProjectAgentTaskPolicySchema" => typed!(projects::ProjectAgentTaskPolicy),
    projects_project_body: "projects.ProjectBodySchema" => typed!(projects::LocalProjectCreate),
    projects_project_create_body: "projects.ProjectCreateBodySchema" => typed!(projects::ProjectCreateBody),
    projects_project_execution: "projects.ProjectExecutionSchema" => typed!(projects::ProjectExecution),
    projects_project_integration: "projects.ProjectIntegrationSchema" => typed!(projects::ProjectIntegration),
    projects_project_new_repository_body: "projects.ProjectNewRepositoryBodySchema" => typed!(projects::NewRepositoryCreate),
    projects_project_patch_body: "projects.ProjectPatchBodySchema" => typed!(projects::ProjectPatch),
    projects_project_provider_policy: "projects.ProjectProviderPolicySchema" => typed!(projects::ProjectProviderPolicy),
    projects_project_repository_body: "projects.ProjectRepositoryBodySchema" => typed!(projects::ExistingRepositoryCreate),
    projects_task_source_query: "projects.TaskSourceQuerySchema" => typed!(projects::TaskSourceQuery),
    providers_provider_instance_create_body: "providers.ProviderInstanceCreateBodySchema" => typed!(projects::ProviderInstanceCreateBody),
    system_events_client_lifecycle: "system-events.ClientLifecycleSchema" => typed!(system::ClientLifecycle),
    task_templates_create_task_template_body: "task-templates.CreateTaskTemplateBodySchema" => typed!(task_templates::TemplateConfiguration),
    task_templates_project_task_templates_params: "task-templates.ProjectTaskTemplatesParamsSchema" => typed!(task_templates::ProjectTemplatesParams),
    task_templates_save_task_as_template_body: "task-templates.SaveTaskAsTemplateBodySchema" => typed!(task_templates::SaveBody),
    task_templates_update_task_template_body: "task-templates.UpdateTaskTemplateBodySchema" => typed!(task_templates::TemplatePatch),
    tasks_task_agent_selection_body: "tasks.TaskAgentSelectionBodySchema" => typed!(tasks::TaskAgentSelectionBody),
    tasks_task_agents_batch_query: "tasks.TaskAgentsBatchQuerySchema" => typed!(tasks::TaskAgentsBatchQuery),
    tasks_task_answer_body: "tasks.TaskAnswerBodySchema" => typed!(task_answers::TaskAnswerBody),
    tasks_task_archive_body: "tasks.TaskArchiveBodySchema" => typed!(tasks::TaskArchiveBody),
    tasks_task_body: "tasks.TaskBodySchema" => typed!(tasks::TaskCreateBody),
    tasks_task_continue_delivery_body: "tasks.TaskContinueDeliveryBodySchema" => typed!(tasks::TaskContinueDeliveryBody),
    tasks_task_coordinator_replacement_body: "tasks.TaskCoordinatorReplacementBodySchema" => typed!(tasks::TaskCoordinatorReplacementBody),
    tasks_task_dependencies_body: "tasks.TaskDependenciesBodySchema" => typed!(tasks::TaskDependenciesBody),
    tasks_task_details_body: "tasks.TaskDetailsBodySchema" => typed!(tasks::TaskDetailsBody),
    tasks_task_issue_body: "tasks.TaskIssueBodySchema" => typed!(tasks::TaskIssueBody),
    tasks_task_note_body: "tasks.TaskNoteBodySchema" => typed!(tasks::TaskNoteBody),
    tasks_task_rename_body: "tasks.TaskRenameBodySchema" => typed!(tasks::TaskRenameBody),
    tasks_task_session_history_params: "tasks.TaskSessionHistoryParamsSchema" => typed!(tasks::TaskSessionParams),
    tasks_task_session_history_query: "tasks.TaskSessionHistoryQuerySchema" => typed!(tasks::TaskHistoryQuery),
    tasks_task_worker_replacement_body: "tasks.TaskWorkerReplacementBodySchema" => typed!(tasks::TaskWorkerReplacementBody),
    tasks_worktree_app: "tasks.WorktreeAppSchema" => tasks::worktree_app,
    update_update_query: "update.UpdateQuerySchema" => typed!(system::UpdateQuery),
    workflows_workflow_list_query: "workflows.WorkflowListQuerySchema" => typed!(projects::IncludeArchivedQuery),
    workflows_workflow_record_input: "workflows.WorkflowRecordInputSchema" => typed!(workflows::WorkflowInput),
    workflows_workflow_record_patch: "workflows.WorkflowRecordPatchSchema" => typed!(workflows::WorkflowPatch),
}

fn findings(error: &Value) -> BTreeSet<(String, String)> {
    error
        .as_array()
        .into_iter()
        .flatten()
        .map(|finding| {
            (
                finding["code"].as_str().unwrap_or_default().to_owned(),
                finding["field"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

/// Every mismatch of one schema's fixtures, as readable lines.
fn verify(directory: &std::path::Path, schema: Schema, failures: &mut Vec<String>) -> usize {
    let mut cases = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let expected = &fixture["expected"];
        let actual = match schema(fixture.get("input")) {
            Ok(value) => serde_json::json!({"accepted": true, "value": value}),
            Err(ContractFailure::Issues(error)) => {
                let error = Value::Array(error);
                if expected["error"].is_array() && findings(&error) == findings(&expected["error"])
                {
                    expected.clone()
                } else {
                    serde_json::json!({"accepted": false, "error": error})
                }
            }
            Err(ContractFailure::Unhandled) => {
                serde_json::json!({"accepted": false, "error": {"kind": "thrown"}})
            }
            Err(ContractFailure::Internal(error)) => serde_json::json!({"internal": error}),
        };
        if &actual != expected {
            failures.push(format!(
                "{}\n  expected {expected}\n  actual   {actual}",
                path.display()
            ));
        }
        cases += 1;
    }
    cases
}

/// Verify one contract's fixture directory; every mismatch is reported.
fn check(contract: &str, schema: Schema) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/parity");
    let directory = root.join(contract);
    assert!(directory.is_dir(), "{contract}");
    let mut failures = Vec::new();
    let count = verify(&directory, schema, &mut failures);
    assert!(count >= 5, "{contract} has only {count} cases");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_request_contract_has_a_fixture_test() {
    assert_eq!(CONTRACTS.len(), 84);
}
