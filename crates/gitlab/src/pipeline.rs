//! Unambiguous mapping of GitLab pipeline statuses to UI states.

use serde::{Deserialize, Serialize};

/// Aggregated CI state displayed by the application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PipelineState {
    Pending,
    Running,
    Success,
    Failed,
    Canceled,
    Neutral,
    Unknown,
}

impl PipelineState {
    /// Map a raw GitLab status. Unknown values stay `Unknown`; they are never
    /// silently coerced to success or neutral.
    pub fn from_status(status: &str) -> Self {
        match status.trim().to_ascii_lowercase().as_str() {
            "created" | "waiting_for_resource" | "preparing" | "pending" => Self::Pending,
            "running" => Self::Running,
            "success" => Self::Success,
            "failed" => Self::Failed,
            "canceled" | "cancelled" => Self::Canceled,
            "skipped" | "manual" | "scheduled" => Self::Neutral,
            _ => Self::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_documented_status() {
        assert_eq!(
            PipelineState::from_status("pending"),
            PipelineState::Pending
        );
        assert_eq!(
            PipelineState::from_status("running"),
            PipelineState::Running
        );
        assert_eq!(
            PipelineState::from_status("success"),
            PipelineState::Success
        );
        assert_eq!(PipelineState::from_status("failed"), PipelineState::Failed);
        assert_eq!(
            PipelineState::from_status("canceled"),
            PipelineState::Canceled
        );
        assert_eq!(
            PipelineState::from_status("skipped"),
            PipelineState::Neutral
        );
        assert_eq!(PipelineState::from_status("manual"), PipelineState::Neutral);
        assert_eq!(
            PipelineState::from_status("invented"),
            PipelineState::Unknown
        );
    }
}
