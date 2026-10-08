//! A remotely managed Cloudflare Tunnel for a hostname in one of the account's zones: the tunnel,
//! its ingress rule to Suplex on loopback, a proxied CNAME, and a request-header transform rule.
//! The transform rule matters: Suplex trusts a proxied request as HTTPS only when `X-Forwarded-Host`
//! names the saved external origin, and cloudflared does not send that header on its own.
//! Everything is idempotent and keyed on the hostname. API calls go through `curl`.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::process::Command;

const API: &str = "https://api.cloudflare.com/client/v4";

pub struct Tunnel {
    /// The connector token `cloudflared service install` takes.
    pub token: String,
}

fn call(api_token: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
    let mut curl = Command::new("curl");
    curl.args([
        "-sS",
        "--max-time",
        "30",
        "-X",
        method,
        &format!("{API}{path}"),
    ])
    .args([
        "-H",
        &format!("Authorization: Bearer {api_token}"),
        "-H",
        "Content-Type: application/json",
    ]);
    if let Some(body) = &body {
        curl.args(["--data", &body.to_string()]);
    }
    let output = curl.output().context("curl")?;
    let value: Value = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "{method} {path}: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })?;
    if value["success"] != true {
        let errors = value["errors"].to_string();
        let hint = if errors.contains("uthentication")
            || errors.contains("uthorization")
            || errors.contains("permission")
        {
            "\nThe token needs: Account → Cloudflare Tunnel: Edit; Zone → DNS: Edit; Zone → Transform Rules: Edit, on the zone that contains the hostname."
        } else {
            ""
        };
        bail!("{method} {path}: {errors}{hint}");
    }
    Ok(value["result"].clone())
}

pub fn ensure(
    api_token: &str,
    hostname: &str,
    port: &str,
    mut step: impl FnMut(&str),
) -> Result<Tunnel> {
    // The zone is the longest suffix of the hostname that the account owns.
    let labels: Vec<&str> = hostname.split('.').collect();
    let mut zone = None;
    for start in 1..labels.len().saturating_sub(1) {
        let name = labels[start..].join(".");
        let zones = call(api_token, "GET", &format!("/zones?name={name}"), None)?;
        if let Some(found) = zones.as_array().and_then(|z| z.first()) {
            zone = Some(found.clone());
            break;
        }
    }
    let zone = zone.with_context(|| format!("no Cloudflare zone of yours contains {hostname}"))?;
    let (zone_id, account_id) = (text(&zone["id"]), text(&zone["account"]["id"]));
    step(&format!(
        "Zone {} on account {}",
        text(&zone["name"]),
        text(&zone["account"]["name"])
    ));

    // The tunnel, found by name or created.
    let name = format!("suplex-bootstrap {hostname}");
    let existing = call(
        api_token,
        "GET",
        &format!(
            "/accounts/{account_id}/cfd_tunnel?name={}&is_deleted=false",
            name.replace(' ', "%20")
        ),
        None,
    )?;
    let id = match existing.as_array().and_then(|t| t.first()) {
        Some(tunnel) => {
            step(&format!("Tunnel exists: {}", text(&tunnel["id"])));
            text(&tunnel["id"])
        }
        None => {
            let created = call(
                api_token,
                "POST",
                &format!("/accounts/{account_id}/cfd_tunnel"),
                Some(json!({"name": name, "config_src": "cloudflare"})),
            )?;
            step(&format!("Tunnel created: {}", text(&created["id"])));
            text(&created["id"])
        }
    };
    let token = text(&call(
        api_token,
        "GET",
        &format!("/accounts/{account_id}/cfd_tunnel/{id}/token"),
        None,
    )?);

    // Ingress: the hostname to Suplex on loopback, everything else 404.
    call(
        api_token,
        "PUT",
        &format!("/accounts/{account_id}/cfd_tunnel/{id}/configurations"),
        Some(json!({"config": {"ingress": [
            {"hostname": hostname, "service": format!("http://127.0.0.1:{port}")},
            {"service": "http_status:404"}
        ]}})),
    )?;
    step(&format!("Ingress: {hostname} → http://127.0.0.1:{port}"));

    // DNS: a proxied CNAME at the hostname.
    let record = json!({"type": "CNAME", "name": hostname, "content": format!("{id}.cfargotunnel.com"), "proxied": true, "ttl": 1});
    let records = call(
        api_token,
        "GET",
        &format!("/zones/{zone_id}/dns_records?name={hostname}"),
        None,
    )?;
    match records.as_array().and_then(|r| r.first()) {
        Some(current) => {
            call(
                api_token,
                "PATCH",
                &format!("/zones/{zone_id}/dns_records/{}", text(&current["id"])),
                Some(record),
            )?;
            step(&format!("DNS: {hostname} updated → {id}.cfargotunnel.com"));
        }
        None => {
            call(
                api_token,
                "POST",
                &format!("/zones/{zone_id}/dns_records"),
                Some(record),
            )?;
            step(&format!("DNS: {hostname} → {id}.cfargotunnel.com"));
        }
    }

    // Request headers Suplex needs from a proxy, set at Cloudflare's edge for this hostname only.
    let description = format!("suplex-bootstrap {hostname}");
    let rule = json!({
        "description": description,
        "expression": format!("http.host eq \"{hostname}\""),
        "action": "rewrite",
        "action_parameters": {"headers": {
            "X-Forwarded-Host": {"operation": "set", "value": hostname},
            "X-Forwarded-Proto": {"operation": "set", "value": "https"}
        }}
    });
    let phase = format!("/zones/{zone_id}/rulesets/phases/http_request_late_transform/entrypoint");
    match call(api_token, "GET", &phase, None) {
        Ok(entry) => {
            let present = entry["rules"]
                .as_array()
                .is_some_and(|rules| rules.iter().any(|r| r["description"] == description));
            if present {
                step("Header rule exists");
            } else {
                call(
                    api_token,
                    "POST",
                    &format!("/zones/{zone_id}/rulesets/{}/rules", text(&entry["id"])),
                    Some(rule),
                )?;
                step("Header rule added (X-Forwarded-Host, X-Forwarded-Proto)");
            }
        }
        Err(_) => {
            // No transform ruleset on this zone yet: this creates it with just our rule.
            call(api_token, "PUT", &phase, Some(json!({"rules": [rule]})))?;
            step("Header rule added (X-Forwarded-Host, X-Forwarded-Proto)");
        }
    }
    Ok(Tunnel { token })
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}
