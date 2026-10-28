//! The hook is process-global, so this file holds the only test that installs it.

use std::sync::{Arc, Mutex};

use suplex_exception::{HandledScope, Report, install_panic_hook};

#[test]
fn a_real_panic_is_reported_without_its_message() {
    let seen = Arc::new(Mutex::new(Vec::<Report>::new()));
    let sink = seen.clone();
    install_panic_hook(
        "host",
        Box::new(move |report| sink.lock().unwrap().push(report)),
    );
    let secret = "/home/ada/private repo token=sk-live-9 ada@example.com";
    let _ = std::panic::catch_unwind(|| panic!("{secret}"));
    {
        let _scope = HandledScope::enter();
        let _ = std::panic::catch_unwind(|| panic!("{secret}"));
    }
    let _ = std::panic::catch_unwind(|| std::hint::black_box(None::<u8>).expect("private repo"));
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert!(!seen[0].handled && seen[0].mechanism == "panic");
    assert!(seen[1].handled && seen[1].mechanism == "caught_panic");
    assert_ne!(seen[0].fingerprint, seen[1].fingerprint);
    assert!(!seen[0].frames.is_empty());
    for report in seen.iter() {
        let sent = serde_json::to_string(&report.properties()).unwrap();
        for leak in ["ada", "private", "sk-live", "/home", "example.com"] {
            assert!(!sent.contains(leak), "{leak} in {sent}");
        }
    }
}
