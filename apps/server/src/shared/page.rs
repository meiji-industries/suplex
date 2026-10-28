const TEMPLATE: &str = include_str!("page.html");

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
