#[cfg(test)]
mod tests {
    use crate::accounts::hosted::fakes::Fixture;

    fn attempt_in(html: &str) -> String {
        let start = html.find("attempt=").unwrap() + "attempt=".len();
        html[start..].chars().take_while(|c| *c != '&').collect()
    }

    async fn confirm_page(f: &Fixture) -> (String, String) {
        let html = f.get("/account/delete", &[]).await.text().await.unwrap();
        assert!(html.contains("Continue with email"));
        let attempt = attempt_in(&html);
        let finished = f.sign_in(&attempt, "google", None).await;
        let location = finished.headers()["location"].to_str().unwrap().to_owned();
        assert_eq!(location, format!("/account/delete/confirm?attempt={attempt}"));
        (attempt, location)
    }

    #[tokio::test]
    async fn a_logged_in_person_deletes_the_account() {
        let f = Fixture::new().await;
        let token = f.login("google").await["token"].as_str().unwrap().to_owned();
        let id: String = f.accounts.hosted.query(|db| db.query_row("SELECT id FROM accounts", [], |row| row.get(0))).unwrap();
        f.accounts.hosted.query(|db| db.execute(
            "INSERT INTO company_invitations (id, owner_account_id, company_id, company_name, full_name, email, host_origin, created_at, expires_at, accepted_account_id) VALUES ('i1', ?1, 'c', 'C', 'Bo', 'bo@example.com', 'https://h', 'now', 'later', ?1)",
            [&id],
        )).unwrap();
        // A login for another purpose cannot confirm a deletion.
        let start = attempt_in(&f.get("/start?plan=pro", &[]).await.text().await.unwrap());
        f.sign_in(&start, "google", None).await;
        assert_eq!(f.get(&format!("/account/delete/confirm?attempt={start}"), &[]).await.status(), 404);

        let (attempt, location) = confirm_page(&f).await;
        let page = f.get(&location, &[]).await;
        assert_eq!(page.headers()["cache-control"], "no-store");
        let html = page.text().await.unwrap();
        assert!(html.contains("ada@example.com") && html.contains("Delete account"), "{html}");

        let deleted = f.post_form("/account/delete/confirm", &[("attempt", &attempt)]).await;
        assert_eq!(deleted.status(), 200);
        assert!(deleted.text().await.unwrap().contains("is deleted"));
        assert_eq!(f.count("SELECT COUNT(*) FROM accounts"), 0);
        assert_eq!(f.count("SELECT COUNT(*) FROM account_tokens"), 0);
        assert_eq!(f.count("SELECT COUNT(*) FROM company_invitations"), 0);
        assert_eq!(f.logout(Some(&token)).await, 204);
        // The attempt went with the account.
        assert_eq!(f.post_form("/account/delete/confirm", &[("attempt", &attempt)]).await.status(), 404);
    }

    #[tokio::test]
    async fn an_unknown_subscription_keeps_the_account() {
        let f = Fixture::new().await;
        let (attempt, location) = confirm_page(&f).await;
        let id: String = f.accounts.hosted.query(|db| db.query_row("SELECT id FROM accounts", [], |row| row.get(0))).unwrap();
        // The fixture's Stripe is not reachable, so Suplex cannot see whether it renews.
        f.accounts.hosted.billing_for_user(&id).unwrap();
        assert_eq!(f.get(&location, &[]).await.status(), 503);
        assert_eq!(f.post_form("/account/delete/confirm", &[("attempt", &attempt)]).await.status(), 503);
        assert_eq!(f.count("SELECT COUNT(*) FROM accounts"), 1);
    }
}
