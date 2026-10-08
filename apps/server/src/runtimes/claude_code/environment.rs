use std::{collections::HashMap, path::Path};

/// Dedicated Claude logins must not inherit a different account or gateway.
pub fn claude_routing_variable(name: &str) -> bool {
    name.starts_with("ANTHROPIC_")
        || name == "CLAUDE_CONFIG_DIR"
        || name.strip_prefix("CLAUDE_CODE_").is_some_and(|rest| {
            [
                "USE_", "OAUTH", "API_KEY", "SKIP_", "BEDROCK", "VERTEX", "FOUNDRY",
            ]
            .iter()
            .any(|prefix| rest.starts_with(prefix))
        })
}

pub fn claude_environment(
    directory: Option<&Path>,
    inherited: &HashMap<String, String>,
) -> HashMap<String, String> {
    let Some(directory) = directory else {
        return inherited.clone();
    };
    let mut environment = inherited
        .iter()
        .filter(|(name, _)| !claude_routing_variable(name))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<HashMap<_, _>>();
    environment.insert(
        "CLAUDE_CONFIG_DIR".into(),
        directory.to_string_lossy().into_owned(),
    );
    environment.insert(
        "ANTHROPIC_CONFIG_DIR".into(),
        directory.join("anthropic").to_string_lossy().into_owned(),
    );
    environment
}

pub fn claude_settings_arguments(isolated: bool) -> Vec<String> {
    if isolated {
        vec!["--setting-sources".into(), String::new()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedicated_auth_removes_inherited_tokens_and_cloud_routing() {
        let inherited = HashMap::from(
            [
                ("PATH", "/bin"),
                ("HOME", "/home"),
                ("ANTHROPIC_API_KEY", "wrong"),
                ("ANTHROPIC_BASE_URL", "https://wrong"),
                ("ANTHROPIC_PROFILE", "wrong"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "wrong"),
                ("CLAUDE_CODE_USE_VERTEX", "1"),
                ("CLAUDE_CONFIG_DIR", "/wrong"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned())),
        );
        let expected = HashMap::from(
            [
                ("PATH", "/bin"),
                ("HOME", "/home"),
                ("CLAUDE_CONFIG_DIR", "/dedicated"),
                ("ANTHROPIC_CONFIG_DIR", "/dedicated/anthropic"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned())),
        );
        assert_eq!(
            claude_environment(Some(Path::new("/dedicated")), &inherited),
            expected
        );
        assert_eq!(claude_environment(None, &inherited), inherited);
        assert!(!claude_routing_variable("CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
        assert!(!claude_routing_variable("CLAUDE_CONFIG_DIRECTORY"));
        assert!(claude_routing_variable("CLAUDE_CODE_SKIP_BEDROCK_AUTH"));
        assert_eq!(claude_settings_arguments(true), ["--setting-sources", ""]);
        assert!(claude_settings_arguments(false).is_empty());
    }
}
