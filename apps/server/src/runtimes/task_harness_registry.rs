//! TypeScript `task-harness-registry.ts`: one harness per supported agent CLI.
//! A new runtime adds its module and one line to `harness`.

use std::path::Path;

use super::pi::cli;
use super::{
    claude_code::task_runtime::ClaudeCodeTaskRuntime,
    codex::harness::CodexTaskRuntime,
    opencode::task_runtime::OpenCodeTaskRuntime,
    pi::harness::{OMP_TASK_RUNTIME, PI_TASK_RUNTIME},
    task_harness::TaskHarness,
};
use crate::tasks::control::HarnessKind;

/// The harness for one harness kind, when its runtime is ported.
pub fn harness(kind: &str) -> Option<&'static dyn TaskHarness> {
    match kind {
        "codex" => Some(&CodexTaskRuntime),
        "claude-code" => Some(&ClaudeCodeTaskRuntime),
        "devin" => Some(&super::devin::harness::DevinTaskRuntime),
        "opencode" => Some(&OpenCodeTaskRuntime),
        "pi" => Some(&PI_TASK_RUNTIME),
        "omp" => Some(&OMP_TASK_RUNTIME),
        _ => None,
    }
}

/// A profile provider is already a harness kind; a snapshot that escaped the
/// migration ran on OpenCode.
pub fn profile_harness(provider: &str) -> &str {
    match provider {
        "opencode" | "claude-code" | "devin" | "codex" | "pi" | "omp" => provider,
        _ => "opencode",
    }
}

/// Suplex reserves Devin, Codex, Pi, and omp identities with a prefix, because
/// a Codex thread id is itself a UUID. OpenCode uses "ses…" and Claude Code uses UUIDs.
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
    } else if native_session_id.starts_with(cli::PI.session_prefix) {
        "pi"
    } else if native_session_id.starts_with(cli::OMP.session_prefix) {
        "omp"
    } else if hyphenated_uuid {
        "claude-code"
    } else {
        "opencode"
    }
}

/// The passive display command for a session runtime directory. OpenCode
/// has none.
pub fn display_command(provider: HarnessKind, runtime_directory: &Path) -> Option<String> {
    match provider {
        HarnessKind::ClaudeCode => {
            super::claude_code::display::claude_display_command(runtime_directory)
                .ok()
                .map(|display| display.command)
        }
        HarnessKind::Codex => super::codex::display::display_command(runtime_directory)
            .ok()
            .map(|display| display.command),
        HarnessKind::Devin => super::devin::display::display_command(runtime_directory)
            .ok()
            .map(|display| display.command),
        HarnessKind::Pi => super::pi::display::display_command(&cli::PI, runtime_directory)
            .ok()
            .map(|display| display.command),
        HarnessKind::Omp => super::pi::display::display_command(&cli::OMP, runtime_directory)
            .ok()
            .map(|display| display.command),
        HarnessKind::Opencode => None,
    }
}

/// TypeScript `HarnessRouter.forScope`.
pub fn for_profile(provider: &str) -> Option<&'static dyn TaskHarness> {
    harness(profile_harness(provider))
}

/// TypeScript `nativeSessionReader`: the runtime that owns a native session.
pub fn native_session_reader(native_session_id: &str) -> Option<&'static dyn TaskHarness> {
    harness(session_harness(native_session_id))
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
        assert_eq!(profile_harness("pi"), "pi");
        assert_eq!(
            session_harness("pi-71618050-0d31-428e-a547-d6c4a2eca88f"),
            "pi"
        );
        let pi = for_profile("pi").unwrap();
        let pi_session = pi.new_session_id();
        assert!(pi_session.starts_with("pi-"));
        assert_eq!(session_harness(&pi_session), "pi");
        assert!(native_session_reader(&pi_session).is_some());
        assert!(for_session(Some(&pi_session)).is_some());
        assert_eq!(profile_harness("omp"), "omp");
        assert_eq!(
            session_harness("omp-71618050-0d31-428e-a547-d6c4a2eca88f"),
            "omp"
        );
        let omp = for_profile("omp").unwrap();
        let omp_session = omp.new_session_id();
        assert!(omp_session.starts_with("omp-"));
        assert_eq!(session_harness(&omp_session), "omp");
        assert!(std::ptr::addr_eq(
            native_session_reader(&omp_session).unwrap(),
            omp
        ));
        assert!(!std::ptr::addr_eq(pi, omp));
        assert!(for_session(Some(&omp_session)).is_some());
        let codex = for_profile("codex").unwrap();
        assert!(codex.new_session_id().starts_with("codex-"));
        assert!(for_session(Some("codex-1")).is_some());
        let claude = for_profile("claude-code").unwrap();
        assert_eq!(session_harness(&claude.new_session_id()), "claude-code");
        assert!(for_session(Some("ses_abc")).is_some());
        assert!(for_session(None).is_some());
    }

    #[test]
    fn every_provider_but_opencode_has_a_display_command_for_its_directory() {
        let directory = Path::new("/tmp/suplex-display");
        assert_eq!(display_command(HarnessKind::Opencode, directory), None);
        for provider in [
            HarnessKind::ClaudeCode,
            HarnessKind::Codex,
            HarnessKind::Devin,
            HarnessKind::Pi,
            HarnessKind::Omp,
        ] {
            assert!(
                display_command(provider, directory)
                    .unwrap()
                    .contains("'/tmp/suplex-display'")
            );
        }
    }
}
