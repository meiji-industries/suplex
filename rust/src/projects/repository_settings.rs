use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::service::Project;

pub const PATH: &str = ".suplex/settings.toml";

crate::shared::wire_enum! {
    pub enum RepositorySettingsField {
        SetupCommand = "setup_command",
        VerificationCommand = "verification_command",
        TaskConcurrency = "task_concurrency",
        Instructions = "instructions",
    }
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct RepositorySettings {
    pub path: String,
    pub fields: Vec<RepositorySettingsField>,
    pub error: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Settings {
    scripts: Scripts,
    tasks: Tasks,
    agent: Agent,
}

#[derive(Default, Deserialize)]
struct Scripts {
    setup: Option<String>,
    verify: Option<String>,
}

#[derive(Default, Deserialize)]
struct Tasks {
    concurrency: Option<i64>,
}

#[derive(Default, Deserialize)]
struct Agent {
    instructions: Option<String>,
}

fn parse(text: &str) -> Result<Settings, String> {
    let settings: Settings = toml::from_str(text).map_err(|error| error.to_string())?;
    if settings.tasks.concurrency.is_some_and(|limit| limit < 1) {
        return Err("Task concurrency must be a whole number of 1 or more.".into());
    }
    Ok(settings)
}

pub(super) fn read(repository_path: &str) -> Option<(RepositorySettings, Option<Settings>)> {
    let result = match std::fs::read_to_string(Path::new(repository_path).join(PATH)) {
        Ok(text) => parse(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => Err(error.to_string()),
    };
    let mut metadata = RepositorySettings {
        path: PATH.into(),
        fields: vec![],
        error: None,
    };
    match result {
        Ok(settings) => {
            use RepositorySettingsField::*;
            metadata.fields = [
                (SetupCommand, settings.scripts.setup.is_some()),
                (VerificationCommand, settings.scripts.verify.is_some()),
                (TaskConcurrency, settings.tasks.concurrency.is_some()),
                (Instructions, settings.agent.instructions.is_some()),
            ]
            .into_iter()
            .filter_map(|(field, present)| present.then_some(field))
            .collect();
            Some((metadata, Some(settings)))
        }
        Err(error) => {
            metadata.error = Some(error);
            Some((metadata, None))
        }
    }
}

pub(super) fn overlay(project: &mut Project) {
    let Some((metadata, settings)) = read(&project.repository_path) else {
        return;
    };
    project.repository_settings = Some(metadata);
    let Some(settings) = settings else {
        return;
    };
    if let Some(setup) = settings.scripts.setup {
        project.setup_command = setup;
    }
    if let Some(verify) = settings.scripts.verify {
        project.verification_command = verify;
    }
    if let Some(limit) = settings.tasks.concurrency {
        project.task_concurrency = Some(limit);
    }
    if let Some(instructions) = settings.agent.instructions {
        project
            .execution
            .get_or_insert_with(Default::default)
            .instructions = instructions;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_optional_sections_and_ignores_unknown_keys() {
        let settings = parse("unknown = true\n[scripts]\nsetup = 'install'\nverify = 'check'\nextra = false\n[tasks]\nconcurrency = 1\n[agent]\ninstructions = '''First line\nSecond line'''\n").unwrap();
        assert_eq!(settings.scripts.setup.as_deref(), Some("install"));
        assert_eq!(settings.scripts.verify.as_deref(), Some("check"));
        assert_eq!(settings.tasks.concurrency, Some(1));
        assert_eq!(
            settings.agent.instructions.as_deref(),
            Some("First line\nSecond line")
        );
        let partial = parse("[scripts]\nsetup = ''").unwrap();
        assert_eq!(partial.scripts.setup.as_deref(), Some(""));
        assert!(partial.scripts.verify.is_none());
        assert!(partial.tasks.concurrency.is_none());
        assert!(partial.agent.instructions.is_none());
        assert!(parse("").is_ok());
    }

    #[test]
    fn rejects_invalid_documents_and_limits_without_applying_partial_values() {
        for text in [
            "[",
            "[scripts]\nsetup = 42",
            "[tasks]\nconcurrency = 0",
            "[tasks]\nconcurrency = -1",
            "[tasks]\nconcurrency = 1.5",
            "[tasks]\nconcurrency = '1'",
            "[tasks]\nconcurrency = 9223372036854775808",
        ] {
            assert!(parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn reads_missing_partial_and_invalid_files() {
        let root = std::env::temp_dir()
            .join(crate::shared::ids::random_hex_id("repository_settings").unwrap());
        assert!(read(root.to_str().unwrap()).is_none());
        std::fs::create_dir_all(root.join(".suplex")).unwrap();
        std::fs::write(root.join(PATH), "[scripts]\nsetup = ''").unwrap();
        let (metadata, _) = read(root.to_str().unwrap()).unwrap();
        assert_eq!(metadata.path, PATH);
        assert_eq!(metadata.fields, vec![RepositorySettingsField::SetupCommand]);
        assert!(metadata.error.is_none());
        std::fs::write(
            root.join(PATH),
            "[scripts]\nsetup = 'install'\n[tasks]\nconcurrency = 0",
        )
        .unwrap();
        let (metadata, settings) = read(root.to_str().unwrap()).unwrap();
        assert!(metadata.error.is_some());
        assert!(metadata.fields.is_empty());
        assert!(settings.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
