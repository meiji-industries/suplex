use std::{
    cell::Cell,
    panic::{self, AssertUnwindSafe},
};

use crate::{frames, report::Report};

pub type Sink = Box<dyn Fn(Report) + Send + Sync + 'static>;

thread_local! {
    static HANDLED: Cell<u32> = const { Cell::new(0) };
    static REPORTING: Cell<bool> = const { Cell::new(false) };
}

/// While alive, a panic on this thread is reported as handled: the code that
/// entered the scope catches it. Enter it around each poll of a future whose
/// panic a caller turns into an error response.
pub struct HandledScope(());

impl HandledScope {
    pub fn enter() -> Self {
        HANDLED.with(|depth| depth.set(depth.get() + 1));
        Self(())
    }
}

impl Drop for HandledScope {
    fn drop(&mut self) {
        HANDLED.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Reports every panic in this process to `sink`, then runs the previous hook.
/// Reading the panic never touches its message or payload. A failure inside the
/// sink, or a panic while reporting, is swallowed.
pub fn install_panic_hook(source: &'static str, sink: Sink) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        previous(info);
        if REPORTING.with(|reporting| reporting.replace(true)) {
            return;
        }
        let _ = panic::catch_unwind(AssertUnwindSafe(|| {
            let handled = HANDLED.with(|depth| depth.get() > 0);
            let location = info
                .location()
                .map(|location| (location.file(), location.line(), location.column()));
            let thread = std::thread::current();
            let backtrace = format!("{:#}", std::backtrace::Backtrace::force_capture());
            sink(Report::panic(
                source,
                handled,
                location,
                thread.name(),
                &backtrace,
            ));
        }));
        REPORTING.with(|reporting| reporting.set(false));
    }));
}

/// A handled report with the current frames, for a failure that is not a panic.
pub fn handled_report(source: &'static str, kind: &'static str, mechanism: &'static str) -> Report {
    Report::new(source, kind, mechanism, true, frames::capture())
}
