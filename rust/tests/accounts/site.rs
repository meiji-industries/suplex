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

        let invalid = f.get("/download?visitor=short", &[]).await;
        assert!(invalid.headers().get("set-cookie").is_none());
        assert_eq!(f.events()[1].2["source"], "browser");

        let dnt = f
            .get("/download?visitor=0190a1b2-c3d4-7e5f", &[("dnt", "1")])
            .await;
        assert_eq!(dnt.status(), 302);
        assert!(dnt.headers().get("set-cookie").is_none());
        assert_eq!(f.events().len(), 2);
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
        let windows = f.get("/install.ps1", &[]).await;
        assert_eq!(windows.status(), 200);
        assert_eq!(
            windows.headers()["content-type"],
            "text/plain; charset=utf-8"
        );
        assert!(windows.text().await.unwrap().contains("function Install-Suplex"));
        assert_eq!(
            location(&f, "/", &[]).await,
            (302, "https://getsuplex.ai/".to_owned())
        );
        assert_eq!(
            location(&f, "/pricing", &[]).await,
            (302, "https://getsuplex.ai/".to_owned())
        );
        for (path, title, policy) in [
            ("/terms", "Suplex terms of service", "14-day first-purchase guarantee"),
            ("/privacy", "Suplex privacy policy", "separately and explicitly opt in"),
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
        }
    }
}
