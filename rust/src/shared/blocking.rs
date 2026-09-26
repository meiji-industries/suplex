use std::future::Future;

/// Run one future to completion from synchronous code on any thread,
/// including inside an async context. The future is built and run on its own
/// thread with a current-thread runtime; only its output crosses back.
pub fn block_on<F, Fut>(make: F) -> Fut::Output
where
    F: FnOnce() -> Fut + Send,
    Fut: Future,
    Fut::Output: Send,
{
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("blocking runtime")
                    .block_on(make())
            })
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}
