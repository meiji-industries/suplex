//! TypeScript `task-harness-registry.ts`: one harness per supported agent CLI.
//! A new runtime adds its module and one line to `harness`.

use super::{
    claude_code::task_runtime::ClaudeCodeTaskRuntime, codex::harness::CodexTaskRuntime,
    task_harness::TaskHarness,
};

/// The harness for one harness kind, when its runtime is ported.
pub fn harness(kind: &str) -> Option<&'static dyn TaskHarness> {
    match kind {
        "codex" => Some(&CodexTaskRuntime),
        "claude-code" => Some(&ClaudeCodeTaskRuntime),
        _ => None,
    }
}

/// A profile provider is already a harness kind; a snapshot that escaped the
/// migration ran on OpenCode.
pub fn profile_harness(provider: &str) -> &str {
    match provider {
        "opencode" | "claude-code" | "devin" | "codex" => provider,
        _ => "opencode",
    }
}

/// Suplex reserves Devin and Codex identities with a prefix, because a Codex
/// thread id is itself a UUID. OpenCode uses "ses…" and Claude Code uses UUIDs.
pub fn session_harness(native_session_id: &str) -> &'static str {
    let hyphenated_uuid = native_session_id.len() == 36
        && native_session_id.char_indices().all(|(index, character)| {
            if [8, 13, 18, 23].contains(&index) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        });
    if native_session_id.starts_with("devin-") {
        "devin"
    } else if native_session_id.starts_with("codex-") {
        "codex"
    } else if hyphenated_uuid {
        "claude-code"
    } else {
        "opencode"
    }
}

/// TypeScript `HarnessRouter.forScope`.
pub fn for_profile(provider: &str) -> Option<&'static dyn TaskHarness> {
    harness(profile_harness(provider))
}

/// TypeScript `HarnessRouter.stop`: an unbound session belongs to OpenCode.
pub fn for_session(native_session_id: Option<&str>) -> Option<&'static dyn TaskHarness> {
    harness(native_session_id.map_or("opencode", session_harness))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_selection_follows_the_profile_provider_and_the_native_session_identity() {
        assert_eq!(profile_harness("claude-code"), "claude-code");
        assert_eq!(profile_harness("anthropic"), "opencode");
        for claude in [
            "71618050-0d31-428e-a547-d6c4a2eca88f",
            "71618050-0D31-428E-A547-D6C4A2ECA88F",
        ] {
            assert_eq!(session_harness(claude), "claude-code");
        }
        assert_eq!(
            session_harness("71618050d31428ea547d6c4a2eca88f0"),
            "opencode"
        );
        assert_eq!(session_harness("ses_abc"), "opencode");
        assert_eq!(
            session_harness("codex-71618050-0d31-428e-a547-d6c4a2eca88f"),
            "codex"
        );
        assert_eq!(session_harness("devin-1"), "devin");
        let codex = for_profile("codex").unwrap();
        assert!(codex.new_session_id().starts_with("codex-"));
        assert!(for_session(Some("codex-1")).is_some());
        let claude = for_profile("claude-code").unwrap();
        assert_eq!(session_harness(&claude.new_session_id()), "claude-code");
        assert!(for_session(Some("ses_abc")).is_none());
    }
}
