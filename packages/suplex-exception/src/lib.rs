//! Privacy-bounded exception reports for PostHog Error Tracking.
//!
//! A [`Report`] holds only what `docs/telemetry.md` lists for exceptions: a fixed
//! exception type, a fixed mechanism, Suplex-relative source locations, and
//! function symbols. It never holds a panic or error message, a payload, a
//! thread name outside a fixed list, or a path outside the Suplex source tree.
//! Callers cannot pass free text, so no message can reach a report.
//!
//! The crate has no consent model. The program that records or sends a report
//! owns its gates: the native host, the hosted service, and the desktop shell
//! each apply theirs before [`spool::record`] or a send.

mod frames;
mod hook;
mod report;
pub mod spool;

pub use frames::{capture as capture_frames, clean_function, parse_frames, relative_path};
pub use hook::{HandledScope, Sink, handled_report, install_panic_hook};
pub use report::{Frame, Report, event_uuid};

/// `DO_NOT_TRACK=1` or `SUPLEX_TELEMETRY=0|false|off` turn telemetry off.
pub fn opted_out(variable: impl Fn(&str) -> Option<String>) -> bool {
    variable("DO_NOT_TRACK").is_some_and(|value| !value.is_empty() && value != "0")
        || variable("SUPLEX_TELEMETRY").is_some_and(|value| {
            matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "off")
        })
}

/// [`opted_out`] for this process's environment.
pub fn environment_opted_out() -> bool {
    opted_out(|name| std::env::var(name).ok())
}
