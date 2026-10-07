#[cfg(test)]
mod tests {
    use crate::accounts::hosted::fakes::{Fixture, query};

    fn attempt_in(html: &str) -> String {
        let start = html.find("attempt=").unwrap() + "attempt=".len();
        html[start..].chars().take_while(|c| *c != '&').collect()
    }

    #[tokio::test]
    async fn start_free_shows_the_downloads() {
        let f = Fixture::new().await;
        let page = f.get("/start?visitor=visitor-12345", &[]).await;
        assert_eq!(page.status(), 200);
        assert!(
            page.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .starts_with("suplex_visitor=visitor-12345;")
        );
        let html = page.text().await.unwrap();
        assert!(html.contains("/download?platform=macos-arm64"));
        assert!(html.contains("50 tasks each month"));
        // The page reuses the app login view's wordmark, art, and font.
        for (path, kind) in [
            ("/start/wordmark.svg", "image/svg+xml"),
            ("/start/background.png", "image/png"),
            ("/start/inter-tight.woff2", "font/woff2"),
        ] {
            let asset = f.get(path, &[]).await;
            assert_eq!((asset.status().as_u16(), asset.headers()["content-type"].to_str().unwrap()), (200, kind));
        }
    }

    #[tokio::test]
    async fn start_pro_logs_in_then_starts_the_trial_for_that_account() {
        let f = Fixture::new().await;
        let page = f.get("/start?plan=pro", &[]).await;
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()["cache-control"], "no-store");
        let html = page.text().await.unwrap();
        assert!(html.contains("Continue with email"));
        let attempt = attempt_in(&html);
        let email_form = f.get("/start?plan=pro&with=email", &[]).await.text().await.unwrap();
        assert!(email_form.contains("action=\"/start/email\""));

        let finished = f.sign_in(&attempt, "google", None).await;
        assert_eq!(finished.status(), 303);
        let location = finished.headers()["location"].to_str().unwrap().to_owned();
        assert_eq!(location, format!("/start/done?attempt={attempt}"));

        // The fixture's Stripe is not reachable: the page still names the
        // account and offers the downloads.
        let done = f.get(&location, &[]).await;
        assert_eq!(done.status(), 200);
        let html = done.text().await.unwrap();
        assert!(html.contains("Suplex cannot start the trial now"), "{html}");
        assert!(html.contains("ada@example.com"));
        assert!(html.contains("/download?platform=macos-arm64"));
        // The trial belongs to the Suplex account that logged in.
        assert_eq!(
            f.count("SELECT COUNT(*) FROM billing_accounts b JOIN accounts a ON a.id = b.registration_id"),
            1
        );
        // A start attempt never mints an account token.
        assert_eq!(f.count("SELECT COUNT(*) FROM account_tokens"), 0);

        assert_eq!(f.get("/start/done?attempt=attempt_missing", &[]).await.status(), 404);
        let authorize = f.start(&attempt_in(&f.get("/start?plan=pro", &[]).await.text().await.unwrap()), "github").await;
        assert!(query(&authorize, "state").is_some());
    }
}
