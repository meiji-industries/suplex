const TEMPLATE: &str = include_str!("page.html");

/// A hosted browser page. Both arguments are HTML: escape untrusted values before the call.
pub fn render(heading: &str, body: &str) -> String {
    let (head, foot) = TEMPLATE
        .split_once("{body}")
        .expect("page template has a body slot");
    format!("{}{body}{foot}", head.replace("{heading}", heading))
}
