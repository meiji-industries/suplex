use crate::tasks::control::HarnessKind;
use ts_rs::TS;
pub mod connection;
pub mod git;
pub mod provisioning;
pub mod service;

use crate::shared::PublicFailure;
use git::Finding;

/// Project command refusals.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    /// TypeScript `ProjectFailure`.
    #[error("{message}")]
    Rejected {
        status: u16,
        message: &'static str,
        findings: Vec<Finding>,
    },
}

impl ProjectError {
    pub fn new(message: &'static str, status: u16, findings: Vec<Finding>) -> Self {
        Self::Rejected {
            status,
            message,
            findings,
        }
    }

    pub fn status(&self) -> u16 {
        let Self::Rejected { status, .. } = self;
        *status
    }

    pub fn findings(&self) -> &[Finding] {
        let Self::Rejected { findings, .. } = self;
        findings
    }
}

impl From<ProjectError> for PublicFailure {
    fn from(error: ProjectError) -> Self {
        PublicFailure::new(error.status(), error.to_string())
            .with_findings(serde_json::json!(error.findings()))
    }
}

use garde::Validate;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, Validate, TS)]
#[garde(allow_unvalidated)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectProviderPolicy {
    pub allowed_providers: Vec<HarnessKind>,
    #[garde(inner(length(min = 1)))]
    pub allowed_instance_ids: Vec<String>,
}
