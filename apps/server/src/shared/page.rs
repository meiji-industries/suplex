use serde_json::Value;

const TEMPLATE: &str = include_str!("page.html");
const CONVERSION: &str = include_str!("conversion.js");

/// Both arguments are HTML: escape untrusted values before the call.
pub fn layout(title: &str, content: &str) -> String {
    let (head, foot) = TEMPLATE
        .split_once("{content}")
        .expect("page template has a content slot");
    format!("{}{content}{foot}", head.replace("{title}", title))
}

/// A hosted browser status page. Both arguments are HTML.
pub fn render(heading: &str, body: &str) -> String {
    layout(
        heading,
        &format!("<div class=\"stack center\"><h1>{heading}</h1>{body}</div>"),
    )
}

/// JSON that is safe inside an inline `<script>` element: no character of
/// the output can close the element, open a comment, or end a JS line.
pub fn script_json(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "null".to_owned())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// A `<script>` that pushes `event` to the GTM dataLayer once, on render.
/// `email_hash` is the SHA-256 hex of the account email; the browser adds it
/// as `user_data` only with consent and without Global Privacy Control.
/// Never pass a raw email or name in `event`.
pub fn conversion_script(event: &Value, email_hash: Option<&str>) -> String {
    let hash = email_hash.map_or(Value::Null, |hash| Value::String(hash.to_owned()));
    // The event is inserted last, so no value in it is read as a placeholder.
    let script = CONVERSION
        .replace("__SUPLEX_EMAIL_HASH__", &script_json(&hash))
        .replace("__SUPLEX_EVENT__", &script_json(event));
    format!("<script>\n{script}</script>\n")
}

/// The SHA-256 hex of the trimmed, lowercase email, for enhanced conversions.
pub fn email_hash(email: &str) -> String {
    crate::shared::hash::sha256_hex(email.trim().to_lowercase())
}
