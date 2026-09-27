//! `src/tasks/duplicate-title.ts`: the next free `Title (n)` copy name.

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;

static NUMBERED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.*?)(?: \((\d+)\))?$").expect("valid regex"));

pub fn duplicate_title(title: &str, used_titles: &HashSet<String>) -> String {
    let captures = NUMBERED.captures(title);
    let base = captures
        .as_ref()
        .and_then(|captures| captures.get(1))
        .map(|base| base.as_str().trim_end())
        .filter(|base| !base.is_empty())
        .unwrap_or(title);
    let mut copy = captures
        .as_ref()
        .and_then(|captures| captures.get(2))
        .and_then(|number| number.as_str().parse::<u64>().ok())
        .map_or(2, |number| number + 1);
    while used_titles.contains(&format!("{base} ({copy})")) {
        copy += 1;
    }
    format!("{base} ({copy})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicates_increment_the_copy_number_past_used_titles() {
        let used = HashSet::from(["Fix login (2)".to_owned(), "Fix login (3)".to_owned()]);
        assert_eq!(
            duplicate_title("Fix login", &HashSet::new()),
            "Fix login (2)"
        );
        assert_eq!(duplicate_title("Fix login", &used), "Fix login (4)");
        assert_eq!(
            duplicate_title("Fix login (7)", &HashSet::new()),
            "Fix login (8)"
        );
        assert_eq!(duplicate_title(" (2)", &HashSet::new()), " (2) (3)");
    }
}
