//! Panic reports for the shell. The shell has no telemetry connection and no
//! consent setting of its own: a panic is written to the bundled host's
//! `exceptions` spool, and the host sends it only while the host's own gates
//! allow it (key, `DO_NOT_TRACK`, the Environment setting, and the notice),
//! and discards it otherwise. `DO_NOT_TRACK` and `SUPLEX_TELEMETRY=0` stop the
//! write here too. A report holds no message, payload, or path outside the
//! Suplex source tree.

use std::collections::HashMap;

use crate::paths::Paths;

/// Records this process's panics in the host's spool under the shell's data directory.
pub fn install(environment: &HashMap<String, String>) {
    if suplex_exception::opted_out(|name| environment.get(name).cloned()) {
        return;
    }
    let spool = Paths::from_environment(environment)
        .user_data
        .join("exceptions");
    suplex_exception::install_panic_hook(
        "desktop",
        Box::new(move |report| {
            let _ = suplex_exception::spool::record(&spool, &report);
        }),
    );
}
