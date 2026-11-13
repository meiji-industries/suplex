#[cfg(test)]
mod tests {
    use crate::accounts::hosted::fakes::{Fixture, ORIGIN};

    async fn location(f: &Fixture, path: &str, headers: &[(&str, &str)]) -> (u16, String) {
        let response = f.get(path, headers).await;
        let location = response
            .headers()
            .get("location")
            .map(|value| value.to_str().unwrap().to_owned());
        (response.status().as_u16(), location.unwrap_or_default())
    }

    #[tokio::test]
    async fn download_redirects_to_the_file_in_the_live_manifest() {
        let f = Fixture::new().await;
        let feed = format!("{}/stable/mac/arm64/", f.stub);
        assert_eq!(
            location(&f, "/download", &[]).await,
            (302, format!("{feed}Suplex-1.2.3-arm64.dmg"))
        );
        assert_eq!(
            location(&f, "/download?platform=macos-arm64&format=zip", &[]).await,
            (302, format!("{feed}Suplex-1.2.3-arm64-mac.zip"))
        );
        f.answer(
            "GET /stable/linux/x64/latest-linux.yml",
            200,
            "files:\n  - url: suplex-1.2.3-x64.tar.gz\n",
        );
        assert_eq!(
            location(&f, "/download?platform=linux-x64", &[]).await,
            (
                302,
                format!("{}/stable/linux/x64/suplex-1.2.3-x64.tar.gz", f.stub)
            )
        );
        // The development channel reads its own folder, and a suffixed file name passes.
        f.answer(
            "GET /dev/linux/x64/latest-linux.yml",
            200,
            "version: 1.2.4-dev.202611131540\nfiles:\n  - url: suplex-1.2.4-dev.202611131540-linux-x64.tar.gz\n",
        );
        assert_eq!(
            location(&f, "/download?platform=linux-x64&channel=dev", &[]).await,
            (
                302,
                format!(
                    "{}/dev/linux/x64/suplex-1.2.4-dev.202611131540-linux-x64.tar.gz",
                    f.stub
                )
            )
        );
        assert_eq!(
            location(&f, "/download?platform=linux-x64&channel=stable", &[]).await,
            (
                302,
                format!("{}/stable/linux/x64/suplex-1.2.3-x64.tar.gz", f.stub)
            )
        );
        let channel = f.get("/download?platform=linux-x64&channel=beta", &[]).await;
        assert_eq!(channel.status(), 404);
        assert_eq!(channel.text().await.unwrap(), "Unknown channel.");
        f.answer(
            "GET /stable/bootstrap/macos-arm64/latest.yml",
            200,
            "version: 0.1.0\nfiles:\n  - url: suplex-bootstrap-0.1.0-macos-arm64.tar.gz\n",
        );
        assert_eq!(
            location(&f, "/download?platform=bootstrap-macos-arm64", &[]).await,
            (
                302,
                format!(
                    "{}/stable/bootstrap/macos-arm64/suplex-bootstrap-0.1.0-macos-arm64.tar.gz",
                    f.stub
                )
            )
        );
        f.answer(
            "GET /stable/linux/x64/latest-linux-desktop.yml",
            200,
            "version: 1.2.3\nfiles:\n  - url: Suplex-1.2.3-linux-x64.deb\n  - url: Suplex-1.2.3-linux-x64.rpm\n",
        );
        assert_eq!(
            location(&f, "/download?platform=linux-desktop-x64", &[]).await,
            (
                302,
                format!("{}/stable/linux/x64/Suplex-1.2.3-linux-x64.deb", f.stub)
            )
        );
        assert_eq!(
            location(&f, "/download?platform=linux-desktop-x64&format=rpm", &[]).await,
            (
                302,
                format!("{}/stable/linux/x64/Suplex-1.2.3-linux-x64.rpm", f.stub)
            )
        );
        f.answer(
            "GET /stable/windows/arm64/latest-windows.yml",
            200,
            "version: 1.2.3\nfiles:\n  - url: Suplex-1.2.3-windows-arm64-setup.exe\n",
        );
        assert_eq!(
            location(&f, "/download?platform=windows-arm64", &[]).await,
            (
                302,
                format!(
                    "{}/stable/windows/arm64/Suplex-1.2.3-windows-arm64-setup.exe",
                    f.stub
                )
            )
        );

        let unknown = f.get("/download?platform=windows", &[]).await;
        assert_eq!(unknown.status(), 404);
        assert_eq!(unknown.text().await.unwrap(), "Unknown platform.");
        assert_eq!(
            f.get("/download?platform=linux-x64&format=dmg", &[]).await.status(),
            404
        );
        let missing = f.get("/download?platform=macos-x64", &[]).await;
        assert_eq!(missing.status(), 502);
        assert_eq!(missing.text().await.unwrap(), "No release is published.");
        f.answer(
            "GET /stable/linux/arm64/latest-linux.yml",
            200,
            "files:\n  - url: ../escape.tar.gz\n",
        );
        assert_eq!(
            f.get("/download?platform=linux-arm64", &[]).await.status(),
            502
        );
    }

    #[tokio::test]
    async fn download_sets_the_visitor_cookie_and_counts_the_download_unless_dnt() {
        let f = Fixture::new().await;
        let response = f
            .get(
                "/download?visitor=0190a1b2-c3d4-7e5f",
                &[("user-agent", "curl/8.7.1")],
            )
            .await;
        assert_eq!(response.status(), 302);
        assert_eq!(
            response.headers()["set-cookie"],
            "suplex_visitor=0190a1b2-c3d4-7e5f; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure"
        );
        let events = f.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "download_started");
        assert!(uuid::Uuid::parse_str(&events[0].1).is_ok());
        assert_eq!(
            events[0].2,
            serde_json::json!({
                "$lib": "suplex-web",
                "$process_person_profile": false,
                "$geoip_disable": true,
                "platform": "macos-arm64",
                "source": "install_script",
            })
        );

        // A link from `/start` brings its whole attribution query.
        let linked = f
            .get(
                "/download?platform=macos-arm64&_gl=1*abc&gclid=Cj0K&utm_source=getsuplex&consent=granted&visitor=0190a1b2-c3d4-7e5f",
                &[],
            )
            .await;
        assert_eq!(linked.status(), 302);
        assert!(
            linked.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .starts_with("suplex_visitor=0190a1b2-c3d4-7e5f;")
        );
        assert_eq!(f.events().len(), 2);

        let invalid = f.get("/download?visitor=short", &[]).await;
        assert!(invalid.headers().get("set-cookie").is_none());
        assert_eq!(f.events()[2].2["source"], "browser");

        let dnt = f
            .get("/download?visitor=0190a1b2-c3d4-7e5f", &[("dnt", "1")])
            .await;
        assert_eq!(dnt.status(), 302);
        assert!(dnt.headers().get("set-cookie").is_none());
        assert_eq!(f.events().len(), 3);

        // The processor pass sends the queued downloads.
        f.answer("POST /batch/", 200, "{}");
        f.accounts.hosted.run_processor_pass().await.unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(&f.calls("/batch/")[0].body).unwrap();
        let sent = body["batch"].as_array().unwrap();
        assert_eq!(sent.len(), 3);
        assert!(sent.iter().all(|event| event["event"] == "download_started"));
    }

    #[tokio::test]
    async fn www_redirects_to_the_origin_and_compiled_pages_are_served() {
        let f = Fixture::new().await;
        assert_eq!(
            location(&f, "/download?platform=linux-x64", &[("host", "www.suplex.sh")]).await,
            (301, format!("{ORIGIN}/download?platform=linux-x64"))
        );
        let script = f.get("/install.sh", &[]).await;
        assert_eq!(script.status(), 200);
        assert_eq!(script.headers()["cache-control"], "public, max-age=300");
        assert_eq!(
            script.headers()["content-type"],
            "text/plain; charset=utf-8"
        );
        assert!(script.text().await.unwrap().starts_with("#!/bin/sh"));
        let bootstrap = f.get("/bootstrap.sh", &[]).await;
        assert_eq!(bootstrap.status(), 200);
        assert!(
            bootstrap
                .text()
                .await
                .unwrap()
                .contains("platform=bootstrap-$OS-$ARCH")
        );
        let windows = f.get("/install.ps1", &[]).await;
        assert_eq!(windows.status(), 200);
        assert_eq!(
            windows.headers()["content-type"],
            "text/plain; charset=utf-8"
        );
        assert!(windows.text().await.unwrap().contains("function Install-Suplex"));
        // Every other path goes to the website root with the query unchanged.
        // The website shows a consent choice made here. GPC never carries `granted`.
        for (path, headers, website) in [
            ("/", &[][..], "https://getsuplex.ai/"),
            ("/?", &[][..], "https://getsuplex.ai/"),
            ("/pricing", &[][..], "https://getsuplex.ai/"),
            ("/pricing?", &[][..], "https://getsuplex.ai/"),
            (
                "/?gclid=abc&utm_source=google&_gl=xyz",
                &[][..],
                "https://getsuplex.ai/?gclid=abc&utm_source=google&_gl=xyz",
            ),
            (
                "/pricing?wbraid=w1&gbraid=g1&fbclid=f1&msclkid=m1&visitor=0190a1b2-c3d4-7e5f",
                &[][..],
                "https://getsuplex.ai/?wbraid=w1&gbraid=g1&fbclid=f1&msclkid=m1&visitor=0190a1b2-c3d4-7e5f",
            ),
            (
                "/?utm_campaign=a%20b%26c&utm_term=x+y&utm_source=b&utm_source=a",
                &[][..],
                "https://getsuplex.ai/?utm_campaign=a%20b%26c&utm_term=x+y&utm_source=b&utm_source=a",
            ),
            (
                "/?consent=granted",
                &[][..],
                "https://getsuplex.ai/?consent=granted",
            ),
            (
                "/pricing?_gl=1*abc&consent=denied",
                &[][..],
                "https://getsuplex.ai/?_gl=1*abc&consent=denied",
            ),
            ("/?consent=granted%22%3E", &[][..], "https://getsuplex.ai/"),
            (
                "/?gclid=abc&consent=granted%22%3E&utm_source=google",
                &[][..],
                "https://getsuplex.ai/?gclid=abc&utm_source=google",
            ),
            (
                "/?consent=maybe&gclid=abc",
                &[][..],
                "https://getsuplex.ai/?gclid=abc",
            ),
            (
                "/?gclid=abc&consent=granted",
                &[("sec-gpc", "1")][..],
                "https://getsuplex.ai/?gclid=abc",
            ),
            (
                "/?consent=granted",
                &[("sec-gpc", "1")][..],
                "https://getsuplex.ai/",
            ),
            (
                "/?consent=denied",
                &[("sec-gpc", "1")][..],
                "https://getsuplex.ai/?consent=denied",
            ),
        ] {
            assert_eq!(
                location(&f, path, headers).await,
                (302, website.to_owned()),
                "{path}"
            );
        }
        let consent = f.get("/consent.js", &[]).await;
        assert_eq!(consent.status(), 200);
        assert_eq!(
            consent.headers()["content-type"],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(consent.headers()["cache-control"], "public, max-age=300");
        let consent = consent.text().await.unwrap();
        assert!(consent.contains("suplex.analytics.consent.v1"));
        assert!(consent.contains("Suplex collects usage data to improve the product."));
        for (path, title, policy) in [
            ("/terms", "Suplex terms of service", "14-day first-purchase guarantee"),
            ("/privacy", "Suplex privacy policy", "separately and explicitly opt in"),
            ("/support", "Suplex support", "support@getsuplex.ai"),
        ] {
            let page = f.get(path, &[]).await;
            assert_eq!(page.status(), 200);
            assert_eq!(page.headers()["content-type"], "text/html; charset=utf-8");
            let html = page.text().await.unwrap();
            assert!(html.contains(&format!("<h1>{title}</h1>")));
            assert!(html.contains(policy));
            assert!(html.contains("Meiji Heavy Industries, Inc."));
            assert!(!html.contains("not yet published"));
            assert!(!html.contains("[CONFIRM"));
            // The banner, and the `consent` choice on the link to getsuplex.ai.
            assert!(html.contains("<script src=\"/consent.js\" defer></script>"));
        }
    }
}
