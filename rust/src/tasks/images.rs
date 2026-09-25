//! Decode task image inputs before external source capture or task persistence.

use std::sync::OnceLock;

use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;

use crate::{http::contracts::typed::tasks::TaskImage, platform::artifacts::ArtifactFailure};

pub const MAX_TASK_IMAGES: usize = 8;
pub const MAX_TASK_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TASK_IMAGE_BASE64_LENGTH: usize = MAX_TASK_IMAGE_BYTES.div_ceil(3) * 4;
pub const MAX_TASK_REQUEST_BYTES: usize =
    MAX_TASK_IMAGES * MAX_TASK_IMAGE_BASE64_LENGTH + 1024 * 1024;

#[derive(Clone, Debug)]
pub struct DecodedTaskImage {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

fn data_uri() -> &'static Regex {
    static DATA_URI: OnceLock<Regex> = OnceLock::new();
    DATA_URI.get_or_init(|| Regex::new(r"^data:([^;,]+);base64,(.+)$").unwrap())
}

pub fn decode_task_image(image: &TaskImage) -> Result<DecodedTaskImage, ArtifactFailure> {
    let invalid = ArtifactFailure::invalid_image_data;
    let encoded = match data_uri().captures(&image.base64) {
        Some(captures) => {
            if captures[1] != image.mime_type {
                return Err(invalid());
            }
            captures
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or_default()
        }
        None => image.base64.as_str(),
    };
    if encoded.is_empty() || encoded.len() % 4 != 0 {
        return Err(invalid());
    }
    let padding = if encoded.ends_with("==") {
        2
    } else if encoded.ends_with('=') {
        1
    } else {
        0
    };
    if !encoded.as_bytes()[..encoded.len() - padding]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        || encoded.len() / 4 * 3 - padding > MAX_TASK_IMAGE_BYTES
    {
        return Err(invalid());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if bytes.is_empty() || bytes.len() > MAX_TASK_IMAGE_BYTES || STANDARD.encode(&bytes) != encoded
    {
        return Err(invalid());
    }
    let magic = match image.mime_type.as_str() {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
    };
    if !magic {
        return Err(invalid());
    }
    Ok(DecodedTaskImage {
        filename: image.filename.clone(),
        mime_type: image.mime_type.clone(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(mime_type: &str, base64: &str) -> TaskImage {
        TaskImage {
            filename: "proof.png".to_owned(),
            mime_type: mime_type.to_owned(),
            base64: base64.to_owned(),
        }
    }

    #[test]
    fn decoder_accepts_canonical_image_bytes_and_matching_data_uri() {
        let png = image("image/png", "iVBORw0KGgo=");
        assert_eq!(decode_task_image(&png).unwrap().bytes.len(), 8);
        assert_eq!(
            decode_task_image(&image("image/png", "data:image/png;base64,iVBORw0KGgo="))
                .unwrap()
                .bytes,
            decode_task_image(&png).unwrap().bytes
        );
        assert!(decode_task_image(&image("image/jpeg", "/9j/AA==")).is_ok());
        assert!(decode_task_image(&image("image/gif", "R0lGODdh")).is_ok());
        assert!(decode_task_image(&image("image/webp", "UklGRgAAAABXRUJQ")).is_ok());
    }

    #[test]
    fn decoder_rejects_noncanonical_padding_wrong_type_magic_and_decoded_oversize() {
        for value in [
            image("image/png", ""),
            image("image/png", "iVBORw0KGgo"),
            image("image/png", "iVBORw0KGgo=="),
            image("image/png", "iV=ORw0KGgo="),
            image("image/png", "data:image/jpeg;base64,iVBORw0KGgo="),
            image("image/png", "bm90IHBuZw=="),
        ] {
            assert!(decode_task_image(&value).is_err(), "{}", value.base64);
        }
        let mut bytes = vec![0_u8; MAX_TASK_IMAGE_BYTES + 1];
        bytes[..8].copy_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert!(decode_task_image(&image("image/png", &STANDARD.encode(bytes))).is_err());
    }
}
