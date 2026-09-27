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

#[cfg(test)]
mod tests {
    use super::*;

    fn completes_with_io_driver() {
        assert_eq!(
            block_on(|| async {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                42
            }),
            42
        );
    }

    #[test]
    fn synchronous_caller() {
        completes_with_io_driver();
    }

    #[tokio::test]
    async fn current_thread_caller() {
        completes_with_io_driver();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn multi_thread_caller() {
        completes_with_io_driver();
    }
}
