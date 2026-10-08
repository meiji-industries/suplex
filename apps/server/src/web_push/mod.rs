//! Web Push: a notification to the creator and admins when a task enters `waiting_human`.
//! Push is best effort. Nothing waits for it, and a failed send never changes task state.

mod keys;
mod store;

use std::{error::Error, path::PathBuf, time::Duration};

use chrono::Utc;
use tokio::sync::watch;
use web_push::{
    ContentEncoding, SubscriptionInfo, Urgency, VapidSignatureBuilder, WebPushMessage,
    WebPushMessageBuilder,
};

use crate::{
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    shared::PublicFailure,
};

pub use keys::VapidKey;
pub use store::{Subscription, delete_subscription, save_subscription, vapid_key};

const PUSH_SERVICES: [&str; 2] = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_SERVICE_SUFFIXES: [&str; 2] = [".push.apple.com", ".notify.windows.com"];
const TTL_SECONDS: u32 = 86_400;

/// Validates a browser subscription at the trust boundary: the host sends requests to its endpoint.
pub fn validate_subscription(subscription: &Subscription) -> Result<(), PublicFailure> {
    let invalid = || PublicFailure::new(400, "Push subscription is invalid");
    if subscription.endpoint.len() > 2048 {
        return Err(invalid());
    }
    let endpoint = url::Url::parse(&subscription.endpoint).map_err(|_| invalid())?;
    let host = endpoint.host_str().unwrap_or_default();
    let known = PUSH_SERVICES.contains(&host)
        || PUSH_SERVICE_SUFFIXES
            .iter()
            .any(|suffix| host.ends_with(suffix));
    let key = keys::decode_base64url(&subscription.p256dh);
    let auth = keys::decode_base64url(&subscription.auth);
    if endpoint.scheme() != "https"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.port().is_some_and(|port| port != 443)
        || !known
        || key.is_none_or(|key| key.len() != 65 || key[0] != 0x04)
        || auth.is_none_or(|auth| auth.len() != 16)
    {
        return Err(invalid());
    }
    Ok(())
}

/// Starts the loop that sends a push when a task needs someone. Runs every 5 seconds until shutdown.
pub fn spawn(database_path: PathBuf, shutdown: watch::Receiver<bool>) {
    tokio::spawn(crate::tasks::host::poll_periodically(
        Duration::from_secs(5),
        shutdown,
        "Web push",
        move || send_due(database_path.clone()),
    ));
}

async fn send_due(database_path: PathBuf) -> DatabaseResult<()> {
    let now = Utc::now();
    let (due, key) = {
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite)?;
        let due = store::claim_due(&database, now - chrono::Duration::minutes(10), now)?;
        if due.is_empty() {
            return Ok(());
        }
        (due, vapid_key(&database)?.to_base64url())
    };
    let key = key.as_str();
    let messages = due
        .iter()
        .flat_map(|due| {
            let payload = payload(due);
            due.recipients.iter().map(move |recipient| {
                (
                    recipient.endpoint.clone(),
                    message(key, recipient, &payload),
                )
            })
        })
        .collect::<Vec<_>>();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let mut gone = Vec::new();
    for (endpoint, message) in messages {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                eprintln!("Suplex could not send a web push: {error}");
                continue;
            }
        };
        match send(&client, message).await {
            Ok(status) if status == 404 || status == 410 => gone.push(endpoint),
            Ok(status) if !(200..300).contains(&status) => {
                eprintln!("Suplex could not send a web push: status {status}");
            }
            Ok(_) => {}
            Err(error) => eprintln!("Suplex could not send a web push: {error}"),
        }
    }
    if !gone.is_empty() {
        let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite)?;
        for endpoint in gone {
            store::delete_endpoint(&database, &endpoint)?;
        }
    }
    Ok(())
}

fn payload(due: &store::Due) -> String {
    let url = format!(
        "/tasks/{}?{}",
        url::form_urlencoded::byte_serialize(due.task_id.as_bytes()).collect::<String>(),
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("company", &due.company_id)
            .finish()
    );
    serde_json::json!({
        "title": due.title.chars().take(120).collect::<String>(),
        "body": "This task needs your input.",
        "url": url,
        "tag": format!("task-{}", due.task_id),
    })
    .to_string()
}

fn message(key: &str, recipient: &Subscription, payload: &str) -> Result<WebPushMessage, String> {
    let info = SubscriptionInfo::new(
        recipient.endpoint.as_str(),
        recipient.p256dh.as_str(),
        recipient.auth.as_str(),
    );
    let mut signature =
        VapidSignatureBuilder::from_base64(key, &info).map_err(|error| error.to_string())?;
    signature.add_claim("sub", "https://suplex.sh");
    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_vapid_signature(signature.build().map_err(|error| error.to_string())?);
    builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
    builder.set_ttl(TTL_SECONDS);
    builder.set_urgency(Urgency::High);
    builder.build().map_err(|error| error.to_string())
}

/// Sends the headers that `web_push::request_builder::build_request` sets. reqwest sets `Content-Length`.
async fn send(
    client: &reqwest::Client,
    message: WebPushMessage,
) -> Result<u16, Box<dyn Error + Send + Sync>> {
    let mut request = client
        .post(message.endpoint.to_string())
        .header("TTL", message.ttl.to_string());
    if let Some(urgency) = message.urgency {
        request = request.header("Urgency", urgency.to_string());
    }
    if let Some(payload) = message.payload {
        request = request
            .header("Content-Encoding", payload.content_encoding.to_str())
            .header("Content-Type", "application/octet-stream");
        for (name, value) in payload.crypto_headers {
            request = request.header(name, value);
        }
        request = request.body(payload.content);
    }
    Ok(request.send().await?.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscription(endpoint: &str) -> Subscription {
        Subscription {
            endpoint: endpoint.into(),
            p256dh: VapidKey::generate().public_base64url(),
            auth: "BTBZMqHH6r4Tts7J_aSIgg".into(),
        }
    }

    #[test]
    fn accepts_known_push_services_only() {
        for endpoint in [
            "https://fcm.googleapis.com/fcm/send/dSvH6hS3:APA91bH",
            "https://web.push.apple.com/QOkf8wZf7aTJ2X",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm",
            "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD",
            "https://fcm.googleapis.com:443/fcm/send/x",
        ] {
            assert!(
                validate_subscription(&subscription(endpoint)).is_ok(),
                "{endpoint}"
            );
        }
        for endpoint in [
            "http://fcm.googleapis.com/fcm/send/x",
            "https://127.0.0.1/",
            "https://evil.example/",
            "https://fcm.googleapis.com.evil.example/",
            "https://fcm.googleapis.com:8443/fcm/send/x",
            "https://user:pass@fcm.googleapis.com/fcm/send/x",
            "not a url",
        ] {
            assert!(
                validate_subscription(&subscription(endpoint)).is_err(),
                "{endpoint}"
            );
        }
        let long = format!("https://fcm.googleapis.com/{}", "a".repeat(2048));
        assert!(validate_subscription(&subscription(&long)).is_err());
        let mut short_key = subscription("https://fcm.googleapis.com/fcm/send/x");
        short_key.p256dh = "BTBZMqHH6r4Tts7J_aSIgg".into();
        assert!(validate_subscription(&short_key).is_err());
        let mut short_auth = subscription("https://fcm.googleapis.com/fcm/send/x");
        short_auth.auth = "AAAA".into();
        assert!(validate_subscription(&short_auth).is_err());
        let padded = Subscription {
            auth: "BTBZMqHH6r4Tts7J_aSIgg==".into(),
            ..subscription("https://fcm.googleapis.com/fcm/send/x")
        };
        assert!(validate_subscription(&padded).is_ok());
    }

    #[test]
    fn payload_opens_the_task_in_its_company() {
        let due = store::Due {
            task_id: "task 1".into(),
            company_id: "c&1".into(),
            title: "x".repeat(200),
            recipients: Vec::new(),
        };
        let payload: serde_json::Value = serde_json::from_str(&payload(&due)).unwrap();
        assert_eq!(payload["url"], "/tasks/task+1?company=c%261");
        assert_eq!(payload["title"].as_str().unwrap().chars().count(), 120);
        assert_eq!(payload["body"], "This task needs your input.");
        assert_eq!(payload["tag"], "task-task 1");
    }

    #[test]
    fn message_is_encrypted_and_signed_for_the_endpoint() {
        let key = VapidKey::generate();
        let recipient = subscription("https://web.push.apple.com/QOkf8");
        let message = message(&key.to_base64url(), &recipient, "{}").unwrap();
        let payload = message.payload.unwrap();
        assert_eq!(payload.content_encoding.to_str(), "aes128gcm");
        let authorization = payload
            .crypto_headers
            .iter()
            .find(|(name, _)| *name == "Authorization")
            .unwrap();
        assert!(
            authorization.1.starts_with("vapid t=")
                && authorization
                    .1
                    .ends_with(&format!("k={}", key.public_base64url()))
        );
    }
}
