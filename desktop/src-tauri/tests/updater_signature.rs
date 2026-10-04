//! Run by `desktop/scripts/dist.sh`: the updater archive must verify against the public key the
//! build embeds, exactly as tauri-plugin-updater's `verify_signature` checks it in an installed app.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn variable(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

fn base64_to_string(name: &str, value: &str) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .unwrap_or_else(|error| panic!("{name} is not base64: {error}"));
    String::from_utf8(bytes).unwrap_or_else(|_| panic!("{name} does not decode to UTF-8 text"))
}

#[test]
#[ignore = "needs a built updater archive; desktop/scripts/dist.sh runs it"]
fn the_updater_archive_verifies_against_the_embedded_public_key() {
    let archive_path = variable("SUPLEX_UPDATER_ARCHIVE");
    let signature_path = variable("SUPLEX_UPDATER_SIGNATURE");
    let public_key = variable("SUPLEX_DESKTOP_UPDATER_PUBKEY");

    let public_key = PublicKey::decode(&base64_to_string(
        "SUPLEX_DESKTOP_UPDATER_PUBKEY",
        &public_key,
    ))
    .unwrap_or_else(|error| {
        panic!("SUPLEX_DESKTOP_UPDATER_PUBKEY is not a minisign public key: {error}")
    });
    let signature_file = std::fs::read_to_string(&signature_path)
        .unwrap_or_else(|error| panic!("cannot read {signature_path}: {error}"));
    let signature = Signature::decode(&base64_to_string(&signature_path, signature_file.trim()))
        .unwrap_or_else(|error| panic!("{signature_path} is not a minisign signature: {error}"));
    let archive_bytes = std::fs::read(&archive_path)
        .unwrap_or_else(|error| panic!("cannot read {archive_path}: {error}"));

    public_key.verify(&archive_bytes, &signature, true).unwrap_or_else(|error| {
        panic!("{archive_path} does not verify against SUPLEX_DESKTOP_UPDATER_PUBKEY: {error}. Installed apps would reject this update.")
    });
}
