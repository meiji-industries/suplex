#![allow(clippy::unwrap_used, reason = "integration test helpers")]

//! Proves that the shipped `suplex` binary dispatches `suplex mcp` to the
//! external-agent stdio bridge. No server and no network are involved.

use std::{
    path::PathBuf,
    process::{Command, Output, Stdio},
};

fn scratch_home(name: &str) -> PathBuf {
    let home =
        std::env::temp_dir().join(format!("suplex-native-mcp-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    home
}

fn suplex(arguments: &[&str], environment: &[(&str, &str)], home: &PathBuf) -> Output {
    Command::new(env!("CARGO_BIN_EXE_suplex"))
        .args(arguments)
        .current_dir(home)
        .env_clear()
        .env("HOME", home)
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(environment.iter().copied())
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn mcp_command_runs_the_external_agent_bridge() {
    let home = scratch_home("bridge");

    let missing_origin = suplex(&["mcp"], &[], &home);
    let stderr = String::from_utf8_lossy(&missing_origin.stderr);
    assert!(!missing_origin.status.success(), "stderr: {stderr}");
    assert!(
        stderr.contains("Set SUPLEX_BASE_URL in the MCP server environment."),
        "stderr: {stderr}"
    );
    assert!(!stderr.contains("Unknown command"), "stderr: {stderr}");
    assert!(missing_origin.stdout.is_empty());

    let missing_credential = suplex(
        &["mcp"],
        &[("SUPLEX_BASE_URL", "http://127.0.0.1:9")],
        &home,
    );
    let stderr = String::from_utf8_lossy(&missing_credential.stderr);
    assert!(!missing_credential.status.success(), "stderr: {stderr}");
    assert!(
        stderr.contains("Set SUPLEX_AGENT_CREDENTIAL in the MCP server environment."),
        "stderr: {stderr}"
    );
    assert!(missing_credential.stdout.is_empty());

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn help_lists_the_mcp_command() {
    let home = scratch_home("help");
    let help = suplex(&["help"], &[], &home);
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(help.status.success());
    let mcp = stdout
        .lines()
        .find(|line| line.trim_start().starts_with("mcp "))
        .unwrap_or_else(|| panic!("help does not list mcp:\n{stdout}"));
    assert!(mcp.contains("MCP bridge"), "{mcp}");
    assert!(stdout.contains("SUPLEX_BASE_URL"));
    assert!(stdout.contains("SUPLEX_AGENT_CREDENTIAL"));
    assert!(!stdout.contains("mcp root"));
    assert!(!stdout.contains("mcp advisor"));
    let _ = std::fs::remove_dir_all(&home);
}
