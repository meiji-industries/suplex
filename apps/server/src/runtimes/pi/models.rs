//! `pi --list-models`: the models Pi can run with its current credentials,
//! including `models.json` providers such as a local OpenAI-compatible server.

/// `--offline` skips the catalog refresh, so the listing is local and fast.
pub const LIST_MODELS_ARGS: &[&str] = &["--offline", "--list-models"];

/// `provider/id` for each row of the listing table. A listing without
/// credentials prints "No models available" and no rows.
pub fn parse_model_list(output: &str) -> Vec<String> {
    let mut lines = output.lines().map(str::split_whitespace);
    let Some(header) = lines.next() else {
        return Vec::new();
    };
    if !header.take(2).eq(["provider", "model"]) {
        return Vec::new();
    }
    lines
        .filter_map(|mut columns| Some(format!("{}/{}", columns.next()?, columns.next()?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_become_provider_qualified_models_and_other_output_lists_none() {
        assert_eq!(
            parse_model_list(concat!(
                "provider   model       context  max-out  thinking  images\n",
                "anthropic  claude-sonnet-5  1M  128K  yes  yes\n",
                "localfake  fake-model  128K     16.4K    yes       no    \n",
                "\n",
            )),
            ["anthropic/claude-sonnet-5", "localfake/fake-model"]
        );
        assert!(
            parse_model_list(
                "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md\n"
            )
            .is_empty()
        );
        assert!(parse_model_list("").is_empty());
    }
}
