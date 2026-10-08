use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Contract, ContractResult, Fields, text};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePollBody {
    pub flow_id: String,
}

impl Contract for DevicePollBody {
    fn schema(input: Option<&Value>) -> ContractResult<Value> {
        Fields::new(input)?.req("flowId", text(1, 256)).strict()
    }
}
