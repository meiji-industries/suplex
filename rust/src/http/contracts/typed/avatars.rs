//! Avatar request contracts (`src/http/contracts/avatars.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Contract, ContractResult, Fields, nullable, one_of, params, present_nullable, text};
use crate::identity::avatars::MAX_AVATAR_IMAGE_BASE64_LENGTH;

const SHAPES: &[&str] = &["square", "circle"];
const MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarImageBody {
    pub mime_type: String,
    pub base64: String,
}

/// `None` is an absent field; `Some(None)` is an explicit `null`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AvatarUpdateBody {
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub shape: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    pub image: Option<Option<AvatarImageBody>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarOwnerParams {
    pub owner_id: String,
}

pub fn shape(input: Option<&Value>) -> ContractResult<Value> {
    one_of(SHAPES)(input)
}

fn image(input: Option<&Value>) -> ContractResult<Value> {
    Fields::new(input)?
        .req("mimeType", one_of(MIME_TYPES))
        .req("base64", text(1, MAX_AVATAR_IMAGE_BASE64_LENGTH))
        .strict()
}

impl Contract for AvatarImageBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        image(input)
    }
}

impl Contract for AvatarUpdateBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?
            .opt("shape", nullable(shape))
            .opt("image", nullable(image))
            .strict()
    }
}

impl Contract for AvatarOwnerParams {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        params(input, &["ownerId"], (1, 256))
    }
}
