//! `tasks/preparation.ts`: before a task's first native turn, write the
//! project context, copy skills outside Git, and run the idempotent project
//! setup command in the task worktree under the shared resource lock.

use std::{
    collections::HashMap,
    io,
    os::unix::{fs::DirBuilderExt, process::ExitStatusExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::LazyLock,
    time::Duration,
};

use regex::Regex;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    coordination::root_session_store,
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
};

const SHARED_RESOURCE_COMMAND: &str =
    include_str!("../../../scripts/shared-resource-command.py");
const SETUP_TIMEOUT: Duration = Duration::from_secs(30 * 60);

static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH)").expect("secret key pattern")
});
static PROVIDER_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:CLAUDE|ANTHROPIC|AWS|GOOGLE|AZURE|SUPLEX)_").expect("provider key pattern")
});

pub fn task_preparation_directory(database_path: &Path, task_id: &str) -> io::Result<PathBuf> {
    let valid = task_id
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(io::Error::other("Invalid task preparation identity"));
    }
    Ok(database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("runtime/task-preparation")
        .join(task_id))
}

/// Inherited tooling variables without secrets, then the project's own values.
pub fn setup_environment(
    configured: &HashMap<String, String>,
    inherited: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut environment = inherited
        .into_iter()
        .filter(|(key, _)| !SECRET_KEY.is_match(key) && !PROVIDER_KEY.is_match(key))
        .collect::<HashMap<_, _>>();
    environment.extend(configured.clone());
    environment
}

pub struct Preparation<'a> {
    pub database_path: &'a Path,
    pub task_id: &'a str,
    pub directory: &'a Path,
    /// `ProjectExecution` JSON; missing fields use the schema defaults.
    pub execution: &'a Value,
    pub setup_command: &'a str,
    pub excluded_environment_keys: &'a [String],
}

fn copy_skill(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if kind.is_symlink() {
            return Err(io::Error::other(
                "Skill directories cannot contain symbolic links",
            ));
        } else if kind.is_dir() {
            copy_skill(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn prepare_skill(source: &str, directory: &Path) -> io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(source)?;
    if !std::fs::symlink_metadata(&canonical)?.is_dir() {
        return Err(io::Error::other("Skill source must be a directory"));
    }
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let destination = directory
        .join("skills")
        .join(format!("{name}-{}", &digest[..12]));
    copy_skill(&canonical, &destination)?;
    Ok(destination)
}

struct Outcome {
    status: String,
    success: bool,
    stderr: String,
}

async fn run_setup(input: &Preparation<'_>, log: &Path) -> io::Result<Outcome> {
    let configured = input.execution["environment"]
        .as_object()
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let environment = setup_environment(&configured, std::env::vars())
        .into_iter()
        .filter(|(key, _)| !input.excluded_environment_keys.contains(key));
    let resource = std::fs::canonicalize(input.directory)?;
    let mut child = tokio::process::Command::new("python3")
        .arg("-c")
        .arg(SHARED_RESOURCE_COMMAND)
        .arg("--resource")
        .arg(resource)
        .args([
            "--",
            "/bin/sh",
            "-c",
            r#""$0" -c "$1" > "$2" 2>&1"#,
            "/bin/sh",
            input.setup_command,
        ])
        .arg(log)
        .current_dir(input.directory)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let reader = tokio::spawn(async move {
        let mut text = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut text).await;
        text
    });
    let status = match tokio::time::timeout(SETUP_TIMEOUT, child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            if let Some(pid) = child.id() {
                unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
            }
            match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(status) => status?,
                Err(_) => {
                    child.kill().await?;
                    child.wait().await?
                }
            }
        }
    };
    let status_text = match (status.code(), status.signal()) {
        (Some(code), _) => code.to_string(),
        (None, Some(signal)) => nix::sys::signal::Signal::try_from(signal)
            .map_or_else(|_| signal.to_string(), |signal| signal.as_str().to_owned()),
        (None, None) => "without a status".to_owned(),
    };
    Ok(Outcome {
        status: status_text,
        success: status.success(),
        stderr: reader.await.unwrap_or_default(),
    })
}

fn tail(text: &str, count: usize) -> String {
    let characters = text.chars().count();
    text.chars().skip(characters.saturating_sub(count)).collect()
}

pub async fn prepare_project_workspace(input: Preparation<'_>) -> io::Result<()> {
    let directory = task_preparation_directory(input.database_path, input.task_id)?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)?;
    let mut context = vec![
        "Project instructions".to_owned(),
        input.execution["instructions"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ];
    let generated = input
        .database_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("runtime/task-evidence")
        .join(input.task_id)
        .join("generated");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&generated)?;
    context.push(format!("Worker: capture real Before command output before edits, then After output against the reviewed commit. Preserve passing evidence; do not invent output or repeat checks just to make a receipt. Write {} with {{\"headSha\":\"40-character reviewed Git SHA\",\"summary\":\"What changed\",\"before\":[{{\"command\":\"exact command\",\"output\":\"full output\"}}],\"after\":[{{\"command\":\"exact command\",\"output\":\"full output\"}}],\"howToVerify\":[\"steps\"],\"screenshots\":[{{\"filename\":\"basename.png\",\"phase\":\"before or after\"}}]}}. Screenshots are optional unless this task requires them. Put any screenshots beside the manifest. Keep these artifacts outside delivered commits. Coordinator: read the manifest and source, assess the actual evidence independently, and request repairs for gaps. Suplex owns remote publication.", generated.join("delivery-evidence.json").display()));
    for source in input.execution["skillDirectories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        match prepare_skill(source, &directory) {
            Ok(destination) => context.push(format!("Read the SKILL.md files and their referenced resources under {} before using these skills. These files are local task context, not delivered source.", destination.display())),
            Err(error) => context.push(format!("Skill preparation needs repair for {source}: {error}. Resolve the source path or ask for the specific missing access.")),
        }
    }
    if !input.setup_command.trim().is_empty() {
        let log = directory.join("setup.log");
        match run_setup(&input, &log).await {
            Ok(outcome) => {
                context.push(format!(
                    "Configured setup exited {}. Full output: {}.",
                    outcome.status,
                    log.display()
                ));
                if !outcome.success {
                    let output = std::fs::read_to_string(&log).unwrap_or(outcome.stderr);
                    context.push(format!("Preparation failed. Delegate a bounded repair and rerun the idempotent setup before implementation. Output tail (up to 8000 characters):\n{}", tail(&output, 8_000)));
                }
            }
            Err(error) => context.push(format!("Preparation could not finish: {error}. Inspect {}, repair the cause, and rerun the idempotent setup before implementation.", log.display())),
        }
    }
    let path = directory.join("context.md");
    std::fs::write(&path, context.join("\n\n"))?;
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(())
}

/// The `tasks/host.ts` call site: prepare the project workspace while no
/// native work has started, for tasks with execution, integration or issue
/// context. It reruns after a restart until the first native turn.
pub async fn prepare_before_native_work(database_path: &Path, task_id: &str) -> DatabaseResult<()> {
    let (configuration, issue_context, worktree, started) = {
        let database = SuplexDatabase::open(database_path, OpenMode::ReadOnly)?;
        let rows = root_session_store::root_observation_rows(&database, task_id)?;
        let started = database
            .connection()
            .query_row(
                "SELECT 1 FROM suplex_task_sessions WHERE task_id = ?1 AND native_session_id IS NOT NULL UNION ALL SELECT 1 FROM suplex_task_turns WHERE task_id = ?1 AND status IN ('prompted', 'unknown', 'completed') LIMIT 1",
                [task_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        (
            rows.context["configuration"].clone(),
            rows.context["issueContext"].clone(),
            rows.control["worktree"]["path"].as_str().map(PathBuf::from),
            started,
        )
    };
    let scope = super::host::project_launch_scope(&configuration, &issue_context, database_path, task_id);
    let Some(worktree) = worktree.filter(|_| !started && scope.context_path.is_some()) else {
        return Ok(());
    };
    let defaults = json!({});
    prepare_project_workspace(Preparation {
        database_path,
        task_id,
        directory: &worktree,
        execution: configuration
            .get("execution")
            .filter(|value| !value.is_null())
            .unwrap_or(&defaults),
        setup_command: configuration["setupCommand"].as_str().unwrap_or_default(),
        excluded_environment_keys: &scope.excluded_keys,
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::{
        identity::auth,
        tasks::repository::{self, PreparedTask, TaskCreator},
    };

    #[tokio::test]
    async fn project_setup_runs_once_in_the_prepared_worktree_before_the_root_starts() {
        let root = std::env::temp_dir().join(format!("suplex-host-preparation-{}", uuid::Uuid::new_v4()));
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let database_path = root.join("data/suplex.sqlite");
        std::fs::create_dir_all(root.join("data")).unwrap();
        let now = Utc::now();
        let task_id = {
            let mut database = SuplexDatabase::open(&database_path, OpenMode::Migrate).unwrap();
            let user = auth::development_sign_in(&mut database, now).unwrap().user;
            let time = now.to_rfc3339();
            database.connection().execute("INSERT INTO suplex_companies (id,name,status,created_at) VALUES ('prep_company','Prep','active',?1)", [&time]).unwrap();
            database.connection().execute("INSERT INTO suplex_projects (id,company_id,name,repository_path,worktree_root,repository_identity,base_branch,setup_command,verification_command,root_profile_id,worker_profile_id,agent_task_policy_json,created_at,updated_at) VALUES ('prep_project','prep_company','Project','/tmp/repo','/tmp/worktrees',NULL,'main','printf x >> setup-runs','','root_profile','worker_profile','{}',?1,?1)", [&time]).unwrap();
            let prepared = PreparedTask {
                id: repository::new_task_id(),
                company_id: "prep_company".into(),
                project_id: "prep_project".into(),
                title: "Prepared task".into(),
                description: "Run setup".into(),
                configuration: json!({"repository":"owner/repo","branch":"task-prep","baseBranch":"main","baselineSha":"head","setupCommand":"printf x >> setup-runs","execution":{"instructions":"Use the fixture","skillDirectories":[],"environment":{}}}),
                idempotency_key: "prep-key".into(),
                request_hash: "prep-request".into(),
                creator: TaskCreator::User(user.id),
                delivery_target: "local_worktree".into(),
                delivery_intent: json!({"repository":"owner/repo","headBranch":"task-prep","baseBranch":"main","baselineSha":"head","pullRequestNumber":null}),
                root_profile: json!({"profileId":"root_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                worker_profile: json!({"profileId":"worker_profile","provider":"codex","model":"gpt-6-sol","reasoningLevel":"medium","serviceTier":"default"}),
                advisor_profiles: json!({}),
                issue: None,
                start_queued: true,
                copied_from_task_id: None,
                depends_on: vec![],
            };
            let task = repository::create(&mut database, &prepared, now).unwrap().task;
            database.connection().execute("UPDATE suplex_task_controls SET worktree_json = ?1 WHERE task_id = ?2", rusqlite::params![json!({"path":worktree,"branch":"task-prep","baseSha":"head","headSha":"head","dirty":false}).to_string(), task.id]).unwrap();
            task.id
        };
        prepare_before_native_work(&database_path, &task_id).await.unwrap();
        assert_eq!(std::fs::read_to_string(worktree.join("setup-runs")).unwrap(), "x");
        let context = std::fs::read_to_string(task_preparation_directory(&database_path, &task_id).unwrap().join("context.md")).unwrap();
        assert!(context.contains("Use the fixture"));
        assert!(context.contains("Configured setup exited 0"));
        // Once the Root has a native session, recovery does not rerun setup.
        crate::coordination::root_controller::prepare_root(&database_path, &task_id).unwrap();
        SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap().connection().execute("UPDATE suplex_task_sessions SET native_session_id = 'native-root' WHERE task_id = ?1", [&task_id]).unwrap();
        prepare_before_native_work(&database_path, &task_id).await.unwrap();
        assert_eq!(std::fs::read_to_string(worktree.join("setup-runs")).unwrap(), "x");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn preparation_preserves_worktree_files_copies_skills_and_reruns_idempotent_setup() {
        let root = std::env::temp_dir().join(format!("suplex-preparation-{}", uuid::Uuid::new_v4()));
        let worktree = root.join("worktree");
        let skills = root.join("skills");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(worktree.join("CLAUDE.md"), "user-owned").unwrap();
        std::fs::write(skills.join("SKILL.md"), "Use this skill").unwrap();
        let database_path = root.join("suplex.sqlite");
        let execution = json!({"instructions":"Keep draft delivery","skillDirectories":[skills],"environment":{"PREPARATION_SENTINEL":"ok"}});
        let input = |setup_command| Preparation {
            database_path: &database_path,
            task_id: "task",
            directory: &worktree,
            execution: &execution,
            setup_command,
            excluded_environment_keys: &[],
        };
        let setup = r#"test "$PREPARATION_SENTINEL" = ok && (test -f prepared || printf ready > prepared)"#;
        prepare_project_workspace(input(setup)).await.unwrap();
        let context_path = task_preparation_directory(&database_path, "task").unwrap().join("context.md");
        assert!(std::fs::read_to_string(&context_path).unwrap().contains("Configured setup exited 0"));
        std::fs::remove_file(&context_path).unwrap();
        prepare_project_workspace(input(setup)).await.unwrap();
        let context = std::fs::read_to_string(&context_path).unwrap();
        assert!(context.contains("Keep draft delivery"));
        assert!(context.contains("delivery-evidence.json"));
        assert!(context.contains("/runtime/task-preparation/task/skills/"));
        assert_eq!(std::fs::read_to_string(worktree.join("CLAUDE.md")).unwrap(), "user-owned");
        assert_eq!(std::fs::read_to_string(worktree.join("prepared")).unwrap(), "ready");
        prepare_project_workspace(input("printf fixture-failure; exit 7")).await.unwrap();
        let context = std::fs::read_to_string(&context_path).unwrap();
        assert!(context.contains("Configured setup exited 7"));
        assert!(context.contains("Delegate a bounded repair"));
        assert!(context.contains("fixture-failure"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn setup_only_inherits_non_secret_tooling_environment() {
        let inherited = [
            ("HOME", "/home"),
            ("PATH", "/bin"),
            ("GH_TOKEN", "secret"),
            ("ANTHROPIC_BASE_URL", "wrong"),
            ("AWS_PROFILE", "private"),
            ("SUPLEX_ROOT_TOKEN", "secret"),
            ("PASSWORD", "secret"),
        ]
        .map(|(key, value)| (key.to_owned(), value.to_owned()));
        let configured = HashMap::from([("PROJECT_MODE".to_owned(), "test".to_owned())]);
        assert_eq!(
            setup_environment(&configured, inherited),
            HashMap::from([
                ("HOME".to_owned(), "/home".to_owned()),
                ("PATH".to_owned(), "/bin".to_owned()),
                ("PROJECT_MODE".to_owned(), "test".to_owned()),
            ])
        );
    }
}
