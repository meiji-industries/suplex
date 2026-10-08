use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::Value;
use tokio::sync::{Mutex, OnceCell};

use crate::runtimes::native::UsageTokens;

pub const MODELS_DEV_CATALOG_URL: &str = "https://models.dev/api.json";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelPricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl ModelPricing {
    pub fn estimate(self, tokens: UsageTokens) -> f64 {
        let values = [
            tokens.input,
            tokens.output,
            tokens.reasoning,
            tokens.cache_read,
            tokens.cache_write,
            self.input,
            self.output,
            self.cache_read,
            self.cache_write,
        ];
        if !values
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
        {
            return 0.0;
        }
        let total = tokens.input * self.input
            + (tokens.output + tokens.reasoning) * self.output
            + tokens.cache_read * self.cache_read
            + tokens.cache_write * self.cache_write;
        if total.is_finite() && total > 0.0 {
            total / 1_000_000.0
        } else {
            0.0
        }
    }
}

pub type ModelPricingCatalog = HashMap<String, ModelPricing>;

fn rate(value: Option<&Value>, default: Option<f64>) -> Option<f64> {
    match value {
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0),
        None => default,
    }
}

pub fn parse_models_dev_catalog(value: &Value) -> ModelPricingCatalog {
    let mut catalog = ModelPricingCatalog::new();
    let Some(root) = value.as_object() else {
        return catalog;
    };
    for provider in root.values() {
        let Some(provider_id) = provider
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for model in models.values() {
            let Some(model_id) = model
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let Some(cost) = model.get("cost").and_then(Value::as_object) else {
                continue;
            };
            let Some(input) = rate(cost.get("input"), None) else {
                continue;
            };
            let Some(output) = rate(cost.get("output"), None) else {
                continue;
            };
            let Some(cache_read) = rate(cost.get("cache_read"), Some(0.0)) else {
                continue;
            };
            let Some(cache_write) = rate(cost.get("cache_write"), Some(0.0)) else {
                continue;
            };
            let model_id = model_id
                .strip_prefix(&format!("{provider_id}/"))
                .unwrap_or(model_id);
            if model_id.is_empty() {
                continue;
            }
            catalog.insert(
                format!("{provider_id}/{model_id}"),
                ModelPricing {
                    input,
                    output,
                    cache_read,
                    cache_write,
                },
            );
        }
    }
    catalog
}

#[derive(Default)]
struct CacheState {
    cached: Option<Arc<ModelPricingCatalog>>,
    pending: Option<Arc<OnceCell<Option<Arc<ModelPricingCatalog>>>>>,
}

pub struct ModelsDevCatalogReader {
    client: reqwest::Client,
    url: String,
    state: Mutex<CacheState>,
}

impl ModelsDevCatalogReader {
    pub fn new() -> Result<Self, reqwest::Error> {
        Self::with_url(MODELS_DEV_CATALOG_URL)
    }

    pub fn with_url(url: &str) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self {
            client,
            url: url.to_owned(),
            state: Mutex::new(CacheState::default()),
        })
    }

    async fn load(&self) -> Option<Arc<ModelPricingCatalog>> {
        let response = self
            .client
            .get(&self.url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let value: Value = response.json().await.ok()?;
        value.as_object()?;
        Some(Arc::new(parse_models_dev_catalog(&value)))
    }

    /// A successful catalog is cached. Concurrent callers share one request;
    /// failed reads return None and a later caller may retry.
    pub async fn read(&self) -> Option<Arc<ModelPricingCatalog>> {
        let pending = {
            let mut state = self.state.lock().await;
            if let Some(cached) = &state.cached {
                return Some(cached.clone());
            }
            state
                .pending
                .get_or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let result = pending
            .get_or_init(|| async { self.load().await })
            .await
            .clone();
        let mut state = self.state.lock().await;
        if let Some(catalog) = &result {
            state.cached = Some(catalog.clone());
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &pending))
        {
            state.pending = None;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn parses_valid_prices_and_uses_source_cost_formula() {
        let catalog = parse_models_dev_catalog(&json!({
            "openai": {"id":"openai","models":{
                "one":{"id":"openai/gpt-6-sol","cost":{"input":1.0,"output":5.0,"cache_read":0.2}},
                "bad":{"id":"bad","cost":{"input":-1,"output":5}}
            }}
        }));
        assert_eq!(catalog.len(), 1);
        let pricing = catalog["openai/gpt-6-sol"];
        let cost = pricing.estimate(UsageTokens {
            input: 1_000.0,
            output: 300.0,
            reasoning: 200.0,
            cache_read: 100.0,
            cache_write: 0.0,
        });
        assert!((cost - 0.00352).abs() < 1e-12);
    }

    #[tokio::test]
    async fn catalog_read_shares_inflight_request_and_retries_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0_u8; 1024];
                let size = stream.read(&mut request).await.unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..size]).contains("accept: application/json")
                );
                let call = observed.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if call == 0 {
                    ("503 Service Unavailable", "{}")
                } else {
                    (
                        "200 OK",
                        r#"{"provider":{"id":"openai","models":{"model":{"id":"gpt-6-sol","cost":{"input":1,"output":5}}}}}"#,
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let reader =
            ModelsDevCatalogReader::with_url(&format!("http://{address}/api.json")).unwrap();
        assert!(reader.read().await.is_none());
        let (first, second) = tokio::join!(reader.read(), reader.read());
        assert_eq!(first.as_ref().unwrap()["openai/gpt-6-sol"].input, 1.0);
        assert!(Arc::ptr_eq(
            first.as_ref().unwrap(),
            second.as_ref().unwrap()
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(reader.read().await.is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
