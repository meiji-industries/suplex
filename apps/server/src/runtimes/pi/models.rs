//! The models a Pi family CLI can run with its current credentials,
//! including custom providers such as a local OpenAI-compatible server.

use serde_json::Value;

use super::cli::{ModelListing, PiCli};

/// `provider/id` for each listed model. A listing without credentials lists
/// none: Pi prints "No models available", and omp prints an empty array.
pub fn parse_model_list(cli: &PiCli, output: &str) -> Vec<String> {
    match cli.model_listing {
        ModelListing::Table => parse_table(output),
        ModelListing::Json => parse_json(output).unwrap_or_default(),
    }
}

/// Whether the listing proves that no provider has credentials.
pub fn signed_out(cli: &PiCli, output: &str) -> bool {
    match cli.model_listing {
        ModelListing::Table => output.contains("No models available"),
        ModelListing::Json => parse_json(output).is_some_and(|models| models.is_empty()),
    }
}

fn parse_table(output: &str) -> Vec<String> {
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

/// `None` when the output is not a model listing.
fn parse_json(output: &str) -> Option<Vec<String>> {
    let listing = serde_json::from_str::<Value>(output.trim()).ok()?;
    Some(
        listing["models"]
            .as_array()?
            .iter()
            .filter(|model| model["kind"].as_str().is_none_or(|kind| kind == "chat"))
            .filter_map(|model| {
                model["selector"].as_str().map(str::to_owned).or_else(|| {
                    Some(format!(
                        "{}/{}",
                        model["provider"].as_str()?,
                        model["id"].as_str()?
                    ))
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtimes::pi::cli::{OMP, PI};

    #[test]
    fn rows_become_provider_qualified_models_and_other_output_lists_none() {
        let table = concat!(
            "provider   model       context  max-out  thinking  images\n",
            "anthropic  claude-sonnet-5  1M  128K  yes  yes\n",
            "localfake  fake-model  128K     16.4K    yes       no    \n",
            "\n",
        );
        assert_eq!(
            parse_model_list(&PI, table),
            ["anthropic/claude-sonnet-5", "localfake/fake-model"]
        );
        let none = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /docs/providers.md\n";
        assert!(parse_model_list(&PI, none).is_empty());
        assert!(signed_out(&PI, none));
        assert!(parse_model_list(&PI, "").is_empty());
        assert!(!signed_out(&PI, table));
    }

    #[test]
    fn omp_lists_chat_model_selectors_from_its_json_listing() {
        // `omp models --json` 18.12.3 with a models.yml provider.
        let listing = r#"{"models":[{"provider":"localfake","kind":"chat","id":"fake-model","selector":"localfake/fake-model","name":"Fake Model","contextWindow":128000},{"provider":"anthropic","id":"claude-sonnet-5"},{"provider":"openai","kind":"image","id":"gpt-image","selector":"openai/gpt-image"}]}"#;
        assert_eq!(
            parse_model_list(&OMP, listing),
            ["localfake/fake-model", "anthropic/claude-sonnet-5"]
        );
        assert!(!signed_out(&OMP, listing));
        assert!(signed_out(&OMP, "{\"models\":[]}\n"));
        assert!(parse_model_list(&OMP, "not json").is_empty());
        assert!(!signed_out(&OMP, "not json"));
        assert!(parse_model_list(&OMP, "provider model\na b\n").is_empty());
    }
}
