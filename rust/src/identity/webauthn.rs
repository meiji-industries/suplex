//! WebAuthn passkey ceremonies delegated to the high-level library.
//! Ceremony state and passkeys are stored in existing SQLite columns as JSON.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use webauthn_rs::prelude::{
    Credential, CredentialID, Passkey, PasskeyAuthentication, PasskeyRegistration,
    PublicKeyCredential, RegisterPublicKeyCredential, Url, Uuid, Webauthn, WebauthnBuilder,
};

#[derive(Clone, Debug)]
pub struct StoredCredential {
    pub id: String,
    pub public_key: Vec<u8>,
    pub counter: u32,
    pub transports: Vec<String>,
}

#[derive(Debug)]
pub struct StartedCeremony {
    pub options: Value,
    pub state: String,
}

fn verifier(origin: &str, rp_id: &str) -> Result<Webauthn, String> {
    let origin = Url::parse(origin).map_err(|error| error.to_string())?;
    WebauthnBuilder::new(rp_id, &origin)
        .map_err(|error| format!("{error:?}"))?
        .rp_name("Suplex")
        .build()
        .map_err(|error| format!("{error:?}"))
}

pub fn start_registration(
    origin: &str,
    rp_id: &str,
    username: &str,
    display_name: &str,
    excluded_ids: &[String],
) -> Result<StartedCeremony, String> {
    let excluded = excluded_ids
        .iter()
        .filter_map(|id| URL_SAFE_NO_PAD.decode(id).ok())
        .map(CredentialID::from)
        .collect();
    let (challenge, state) = verifier(origin, rp_id)?
        .start_passkey_registration(Uuid::new_v4(), username, display_name, Some(excluded))
        .map_err(|error| format!("{error:?}"))?;
    let options = serde_json::to_value(challenge).map_err(|error| error.to_string())?;
    Ok(StartedCeremony {
        options: options["publicKey"].clone(),
        state: serde_json::to_string(&state).map_err(|error| error.to_string())?,
    })
}

pub fn finish_registration(
    response: &Value,
    state: &str,
    origin: &str,
    rp_id: &str,
) -> Result<StoredCredential, String> {
    let state: PasskeyRegistration =
        serde_json::from_str(state).map_err(|error| error.to_string())?;
    let response: RegisterPublicKeyCredential =
        serde_json::from_value(response.clone()).map_err(|error| error.to_string())?;
    let passkey = verifier(origin, rp_id)?
        .finish_passkey_registration(&response, &state)
        .map_err(|error| format!("{error:?}"))?;
    let id = URL_SAFE_NO_PAD.encode(passkey.cred_id().as_slice());
    let credential: Credential = passkey.clone().into();
    let bytes = serde_json::to_vec(&passkey).map_err(|error| error.to_string())?;
    Ok(StoredCredential {
        id,
        public_key: bytes,
        counter: credential.counter,
        transports: response
            .response
            .transports
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .map(|item| format!("{item:?}").to_lowercase())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn start_authentication(
    origin: &str,
    rp_id: &str,
    stored: &[StoredCredential],
) -> Result<StartedCeremony, String> {
    let passkeys = stored
        .iter()
        .filter_map(|item| {
            let passkey: Passkey = serde_json::from_slice(&item.public_key).ok()?;
            (URL_SAFE_NO_PAD.encode(passkey.cred_id().as_slice()) == item.id).then_some(passkey)
        })
        .collect::<Vec<_>>();
    if passkeys.is_empty() {
        return Err("No passkey is enrolled".into());
    }
    let (challenge, state) = verifier(origin, rp_id)?
        .start_passkey_authentication(&passkeys)
        .map_err(|error| format!("{error:?}"))?;
    let options = serde_json::to_value(challenge).map_err(|error| error.to_string())?;
    Ok(StartedCeremony {
        options: options["publicKey"].clone(),
        state: serde_json::to_string(&state).map_err(|error| error.to_string())?,
    })
}

pub fn finish_authentication(
    response: &Value,
    state: &str,
    origin: &str,
    rp_id: &str,
    stored: &StoredCredential,
) -> Result<StoredCredential, String> {
    let state: PasskeyAuthentication =
        serde_json::from_str(state).map_err(|error| error.to_string())?;
    let response: PublicKeyCredential =
        serde_json::from_value(response.clone()).map_err(|error| error.to_string())?;
    let mut passkey: Passkey =
        serde_json::from_slice(&stored.public_key).map_err(|error| error.to_string())?;
    if URL_SAFE_NO_PAD.encode(passkey.cred_id().as_slice()) != stored.id {
        return Err("stored credential ID mismatch".into());
    }
    let result = verifier(origin, rp_id)?
        .finish_passkey_authentication(&response, &state)
        .map_err(|error| format!("{error:?}"))?;
    if result.cred_id() != passkey.cred_id() {
        return Err("authenticated credential ID mismatch".into());
    }
    passkey
        .update_credential(&result)
        .ok_or("authenticated credential ID mismatch")?;
    Ok(StoredCredential {
        id: stored.id.clone(),
        public_key: serde_json::to_vec(&passkey).map_err(|error| error.to_string())?,
        counter: result.counter(),
        transports: stored.transports.clone(),
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    use serde_json::Value;

    pub fn synthetic(input: &Value) -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let mut child = Command::new("node")
            .current_dir(root)
            .arg("tests/support/webauthn-synthetic.mjs")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start synthetic authenticator");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(serde_json::to_string(input).unwrap().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
