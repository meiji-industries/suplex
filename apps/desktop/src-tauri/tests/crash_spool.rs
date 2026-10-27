//! A shell panic lands in the host's spool without its message or any path, and
//! `DO_NOT_TRACK` writes nothing. The hook is process-wide, so this file has one test.

use std::collections::HashMap;

#[test]
fn a_shell_panic_is_spooled_for_the_host_and_respects_the_opt_out() {
    let opted_out = tempfile::tempdir().unwrap();
    suplex_desktop::install_crash_reporting(&HashMap::from([
        (
            "SUPLEX_DESKTOP_USER_DATA".to_owned(),
            opted_out.path().display().to_string(),
        ),
        ("DO_NOT_TRACK".to_owned(), "1".to_owned()),
    ]));
    let _ = std::panic::catch_unwind(|| panic!("opted out /home/ada"));
    assert!(!opted_out.path().join("exceptions").exists());

    let user_data = tempfile::tempdir().unwrap();
    suplex_desktop::install_crash_reporting(&HashMap::from([(
        "SUPLEX_DESKTOP_USER_DATA".to_owned(),
        user_data.path().display().to_string(),
    )]));
    let _ =
        std::panic::catch_unwind(|| panic!("/home/ada/secret-repo token=sk-live ada@example.com"));
    let spool = user_data.path().join("exceptions");
    let files: Vec<_> = std::fs::read_dir(&spool)
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(files.len(), 1);
    let report = std::fs::read_to_string(files[0].path()).unwrap();
    for leak in ["ada", "secret-repo", "sk-live", "/home", "example.com"] {
        assert!(!report.contains(leak), "{leak} in {report}");
    }
    assert!(report.contains("\"source\":\"desktop\"") && report.contains("\"handled\":false"));
    // The host reads this directory.
    assert_eq!(
        suplex_exception::spool::pending(&spool, 0, 10)[0].mechanism,
        "panic"
    );
}
