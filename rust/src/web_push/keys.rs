//! The installation's VAPID key. Browsers subscribe with its public half; the host signs each push with it.

use std::error::Error;

use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use jwt_simple::prelude::*;

pub struct VapidKey(ES256KeyPair);

impl VapidKey {
    pub fn generate() -> Self {
        Self(ES256KeyPair::generate())
    }

    pub fn from_base64url(value: &str) -> Result<Self, Box<dyn Error>> {
        let bytes = decode_base64url(value).ok_or("Web push key is invalid")?;
        ES256KeyPair::from_bytes(&bytes)
            .map(Self)
            .map_err(|_| "Web push key is invalid".into())
    }

    /// The raw 32-byte secret scalar, in the form `web_push::VapidSignatureBuilder::from_base64` reads.
    pub fn to_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.to_bytes())
    }

    /// The 65-byte uncompressed point that browsers take as `applicationServerKey`.
    pub fn public_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.public_key().public_key().to_bytes_uncompressed())
    }
}

/// Browsers send base64url with or without padding.
pub fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .ok()
}

include!("../../tests/web_push/keys.rs");
