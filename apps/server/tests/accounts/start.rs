#[cfg(test)]
mod tests {
    use crate::accounts::hosted::fakes::{Fixture, ORIGIN, query};

    /// What a getsuplex.ai link brings: Conversion Linker, click ids, UTM,
    /// the PostHog visitor, and the consent choice.
    const ATTRIBUTION: &str = "_gl=1*abc12*_ga*MTIz&gclid=Cj0K-abc_1&fbclid=IwAR-x.y&utm_source=getsuplex&utm_campaign=launch%20week&visitor=0190a1b2-c3d4-7e5f&consent=granted";
    const KEPT: [(&str, &str); 7] = [
        ("_gl", "1*abc12*_ga*MTIz"),
        ("gclid", "Cj0K-abc_1"),
        ("fbclid", "IwAR-x.y"),
        ("utm_source", "getsuplex"),
        ("utm_campaign", "launch week"),
        ("visitor", "0190a1b2-c3d4-7e5f"),
        ("consent", "granted"),
    ];

    /// Every `href` and form `action` in the document, HTML-unescaped.
    fn links(html: &str) -> Vec<url::Url> {
        let mut links = Vec::new();
        for attribute in [" href=\"", " action=\""] {
            for rest in html.split(attribute).skip(1) {
                let value = &rest[..rest.find('"').unwrap()];
                assert!(!value.contains(['<', '>', '\'']), "{value}");
                let value = value
                    .replace("&quot;", "\"")
                    .replace("&#39;", "'")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&amp;", "&");
                assert!(value.starts_with('/'), "an internal link: {value}");
                links.push(url::Url::parse(&format!("{ORIGIN}{value}")).unwrap());
            }
        }
        links
    }

    fn values(link: &url::Url, key: &str) -> Vec<String> {
        link.query_pairs()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
            .collect()
    }

    /// Each link keeps every attribution pair once, and its own keys.
    fn assert_kept(html: &str, paths: &[&str]) -> Vec<url::Url> {
        let links = links(html);
        let mut found: Vec<&str> = links.iter().map(url::Url::path).collect();
        found.sort_unstable();
        let mut expected = paths.to_vec();
        expected.sort_unstable();
        assert_eq!(found, expected, "{html}");
        for link in &links {
            for (key, value) in KEPT {
                assert_eq!(values(link, key), [value], "{link}");
            }
            let owned = match link.path() {
                "/start" => vec!["plan"],
                "/auth/start" => vec!["attempt", "provider"],
                "/download" => vec!["platform"],
                _ => vec![],
            };
            for key in owned {
                assert_eq!(values(link, key).len(), 1, "{link}");
            }
            if link.path() == "/start" {
                assert_eq!(values(link, "plan"), ["pro"], "{link}");
            }
        }
        links
    }

    fn set_cookies(response: &reqwest::Response) -> Vec<String> {
        response
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect()
    }

    /// The `name=value` pair of a `Set-Cookie`, for a later request.
    fn cookie(response: &reqwest::Response, name: &str) -> String {
        set_cookies(response)
            .into_iter()
            .find(|cookie| cookie.starts_with(&format!("{name}=")))
            .and_then(|cookie| cookie.split(';').next().map(str::to_owned))
            .unwrap()
    }

    const DOWNLOADS: [&str; 4] = ["/download"; 4];

    #[tokio::test]
    async fn start_pages_keep_the_incoming_query_in_every_link() {
        let f = Fixture::new().await;
        let free = f.get(&format!("/start?{ATTRIBUTION}"), &[]).await;
        assert_eq!(free.status(), 200);
        assert!(free.headers().get("location").is_none());
        assert!(
            set_cookies(&free)
                .iter()
                .any(|cookie| cookie.starts_with("suplex_visitor=0190a1b2-c3d4-7e5f;"))
        );
        let html = free.text().await.unwrap();
        assert_kept(&html, &[DOWNLOADS.as_slice(), &["/start"]].concat());

        let pro = f.get(&format!("/start?plan=pro&{ATTRIBUTION}"), &[]).await;
        assert_eq!(pro.status(), 200);
        assert!(pro.headers().get("location").is_none());
        let kept = cookie(&pro, "suplex_start_query");
        assert!(
            set_cookies(&pro)
                .iter()
                .any(|cookie| cookie.starts_with("suplex_start_query=")
                    && cookie
                        .ends_with("; Max-Age=3600; Path=/start; HttpOnly; SameSite=Lax; Secure"))
        );
        let html = pro.text().await.unwrap();
        let trial = assert_kept(
            &html,
            &["/auth/start", "/auth/start", "/start", "/terms", "/privacy"],
        );
        let attempt = values(&trial[0], "attempt").remove(0);
        let providers: Vec<_> = trial
            .iter()
            .filter(|link| link.path() == "/auth/start")
            .map(|link| values(link, "provider").remove(0))
            .collect();
        assert_eq!(providers, ["google", "github"]);
        assert!(
            trial
                .iter()
                .any(|link| link.path() == "/start" && values(link, "with") == ["email"])
        );

        let form = f
            .get(&format!("/start?plan=pro&with=email&{ATTRIBUTION}"), &[])
            .await;
        assert_eq!(form.status(), 200);
        let html = form.text().await.unwrap();
        let email = assert_kept(&html, &["/start/email", "/start"]);
        assert!(html.contains(" method=\"post\" action=\"/start/email?"));
        let cancel = email.iter().find(|link| link.path() == "/start").unwrap();
        assert!(values(cancel, "with").is_empty());

        // The extra keys do not change the login.
        let authorize = f
            .get(
                &format!("/auth/start?attempt={attempt}&provider=google&{ATTRIBUTION}"),
                &[],
            )
            .await;
        assert_eq!(authorize.status(), 303);

        // The login leaves suplex.sh. `/start/done` gets the query from the cookie.
        let finished = f.sign_in(&attempt, "google", None).await;
        let location = finished.headers()["location"].to_str().unwrap().to_owned();
        assert_eq!(location, format!("/start/done?attempt={attempt}"));
        let done = f.get(&location, &[("cookie", &kept)]).await;
        assert_eq!(done.status(), 200);
        let html = done.text().await.unwrap();
        assert!(html.contains("ada@example.com"), "{html}");
        assert_kept(&html, &DOWNLOADS);
        // A query on `/start/done` itself is kept too.
        let html = f
            .get(&format!("{location}&{ATTRIBUTION}"), &[])
            .await
            .text()
            .await
            .unwrap();
        assert_kept(&html, &DOWNLOADS);

        let expired = f
            .get("/start/done?attempt=attempt_missing", &[("cookie", &kept)])
            .await;
        assert_eq!(expired.status(), 404);
        assert_kept(&expired.text().await.unwrap(), &["/start"]);

        // Without a kept query the links are as before.
        let plain = f.get(&location, &[]).await.text().await.unwrap();
        for link in links(&plain) {
            assert_eq!(link.query_pairs().count(), 1, "{link}");
        }
    }

    #[tokio::test]
    async fn start_email_pages_keep_the_incoming_query_through_the_magic_link() {
        let f = Fixture::new().await;
        let pro = f
            .get(&format!("/start?plan=pro&with=email&{ATTRIBUTION}"), &[])
            .await;
        let kept = cookie(&pro, "suplex_start_query");
        let html = pro.text().await.unwrap();
        let action = links(&html)
            .into_iter()
            .find(|link| link.path() == "/start/email")
            .unwrap();
        let attempt = {
            let field = "name=\"attempt\" value=\"";
            let start = html.find(field).unwrap() + field.len();
            html[start..start + html[start..].find('"').unwrap()].to_owned()
        };
        let path = &action.as_str()[ORIGIN.len()..];
        let sent = f
            .post_form(path, &[("attempt", &attempt), ("email", "ada@example.com")])
            .await;
        assert_eq!(sent.status(), 200);
        let html = sent.text().await.unwrap();
        assert!(html.contains("Check your email"), "{html}");
        assert_kept(&html, &["/start"]);

        let refused = f
            .post_form(
                path,
                &[("attempt", "attempt_missing"), ("email", "ada@example.com")],
            )
            .await;
        let html = refused.text().await.unwrap();
        assert!(html.contains("Suplex did not send the link"), "{html}");
        assert_kept(&html, &["/start"]);

        let link = f.calls("/emails")[0].json()["template"]["variables"]["ACTION_URL"]
            .as_str()
            .unwrap()
            .to_owned();
        let token = link
            .strip_prefix(&format!("{ORIGIN}/auth/email/verify?token="))
            .unwrap();
        let verified = f.post_form("/auth/email/verify", &[("token", token)]).await;
        let location = verified.headers()["location"].to_str().unwrap().to_owned();
        assert_eq!(location, format!("/start/done?attempt={attempt}"));
        let done = f.get(&location, &[("cookie", &kept)]).await;
        assert_kept(&done.text().await.unwrap(), &DOWNLOADS);
    }

    #[tokio::test]
    async fn start_escapes_a_hostile_query_and_keeps_its_own_keys() {
        let f = Fixture::new().await;
        let hostile = "\"><script>alert(1)</script>&plan=free";
        let path = format!(
            "/start?plan=pro&utm_source={}&attempt=evil&provider=evil&platform=windows&with=nothing&%22%3E%3Cb%3E=1&long={}",
            url::form_urlencoded::byte_serialize(hostile.as_bytes()).collect::<String>(),
            "x".repeat(600),
        );
        let html = f.get(&path, &[]).await.text().await.unwrap();
        assert!(!html.contains("<script>alert"));
        assert!(!html.contains("<b>"));
        let links = links(&html);
        assert_eq!(links.len(), 5);
        for link in &links {
            assert_eq!(values(link, "utm_source"), [hostile], "{link}");
            assert_eq!(values(link, "\"><b>"), ["1"], "{link}");
            assert!(values(link, "long").is_empty(), "{link}");
            assert!(values(link, "platform").is_empty(), "{link}");
            assert_ne!(values(link, "attempt"), ["evil"], "{link}");
            assert_ne!(values(link, "provider"), ["evil"], "{link}");
            if link.path() == "/start" {
                assert_eq!(values(link, "plan"), ["pro"]);
                assert_eq!(values(link, "with"), ["email"]);
            } else {
                assert!(values(link, "plan").is_empty(), "{link}");
            }
        }
        // `DNT: 1` keeps neither the visitor nor the query.
        let dnt = f
            .get(&format!("/start?plan=pro&{ATTRIBUTION}"), &[("dnt", "1")])
            .await;
        assert!(set_cookies(&dnt).is_empty());
        assert_kept(
            &dnt.text().await.unwrap(),
            &["/auth/start", "/auth/start", "/start", "/terms", "/privacy"],
        );
        // A trial login without a query clears an older one.
        let cleared = f.get("/start?plan=pro", &[]).await;
        assert!(
            set_cookies(&cleared)
                .iter()
                .any(|cookie| cookie.starts_with("suplex_start_query=; Max-Age=0;"))
        );
    }

    /// The visitor, first-touch attribution, and forwarded query cookies are
    /// separate `Set-Cookie` headers on one response; none replaces another.
    #[tokio::test]
    async fn a_trial_login_sets_every_cookie_on_one_response() {
        let f = Fixture::new().await;
        let page = f
            .get(
                "/start?plan=pro&visitor=0190a1b2-c3d4-7e5f&utm_source=newsletter&_gl=1*abc",
                &[],
            )
            .await;
        assert_eq!(page.status(), 200);
        let mut names: Vec<String> = set_cookies(&page)
            .iter()
            .map(|cookie| cookie.split_once('=').unwrap().0.to_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["suplex_attribution", "suplex_start_query", "suplex_visitor"]
        );
        assert_eq!(
            cookie(&page, "suplex_start_query"),
            "suplex_start_query=visitor=0190a1b2-c3d4-7e5f&utm_source=newsletter&_gl=1*abc"
        );
        assert_eq!(
            cookie(&page, "suplex_attribution"),
            "suplex_attribution=utm_source=newsletter"
        );
    }

    /// The production Google Tag Manager snippet, byte for byte.
    const GTM_HEAD: &str = r#"<!-- Suplex: consent defaults + Google Tag Manager (managed by Ads bot) -->
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {ad_storage:'denied', ad_user_data:'denied', ad_personalization:'denied', analytics_storage:'denied', wait_for_update: 500});
(function(){
  var KEY = 'suplex.analytics.consent.v1', last;
  function check(){
    var v = null;
    try { v = window.localStorage.getItem(KEY); } catch (e) {}
    if (navigator.globalPrivacyControl === true) v = 'denied';
    if (v === last) return;
    last = v;
    if (v === 'granted') {
      gtag('consent', 'update', {ad_storage:'granted', ad_user_data:'granted', ad_personalization:'granted'});
      dataLayer.push({event:'suplex_consent_granted'});
    }
  }
  check();
  setInterval(check, 1000);
})();
</script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-N739QG5C');</script>
<!-- End Google Tag Manager -->
"#;
    const GTM_BODY: &str = r#"<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-N739QG5C"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
"#;

    #[tokio::test]
    async fn hosted_pages_install_google_tag_manager_and_the_shared_consent_banner() {
        let f = Fixture::new().await;
        for (path, status) in [
            ("/start", 200),
            ("/start?plan=pro", 200),
            ("/start/done?attempt=attempt_missing", 404),
            // `page::render`, outside `/start`.
            ("/auth/start", 400),
        ] {
            let page = f.get(path, &[]).await;
            assert_eq!(page.status(), status, "{path}");
            let html = page.text().await.unwrap();
            let charset = "<head>\n    <meta charset=\"utf-8\">\n";
            let head = html.find(charset).unwrap() + charset.len();
            assert_eq!(&html[head..head + GTM_HEAD.len()], GTM_HEAD, "{path}");
            assert_eq!(html.matches("GTM-N739QG5C").count(), 2, "{path}");
            assert!(
                html[head + GTM_HEAD.len()..]
                    .starts_with("    <script src=\"/consent.js\" defer></script>\n"),
                "{path}"
            );
            let body = html.find("<body>\n").unwrap() + "<body>\n".len();
            assert_eq!(&html[body..body + GTM_BODY.len()], GTM_BODY, "{path}");
            assert!(head + GTM_HEAD.len() < html.find("<title>").unwrap());
        }
    }

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
            assert_eq!(
                (
                    asset.status().as_u16(),
                    asset.headers()["content-type"].to_str().unwrap()
                ),
                (200, kind)
            );
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
        let email_form = f
            .get("/start?plan=pro&with=email", &[])
            .await
            .text()
            .await
            .unwrap();
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

        assert_eq!(
            f.get("/start/done?attempt=attempt_missing", &[])
                .await
                .status(),
            404
        );
        let authorize = f
            .start(
                &attempt_in(&f.get("/start?plan=pro", &[]).await.text().await.unwrap()),
                "github",
            )
            .await;
        assert!(query(&authorize, "state").is_some());
    }
}
