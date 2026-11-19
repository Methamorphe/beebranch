//! Build status normalization.
//!
//! Azure reports a lifecycle (`status`) and, once finished, a `result`. The
//! UI only knows the shared pipeline states.

/// Map an Azure build to `success`, `failed`, `running`, `pending`, `canceled`
/// or `unknown`.
pub fn normalize_build(status: &str, result: Option<&str>) -> &'static str {
    match status {
        "notStarted" | "postponed" | "none" => "pending",
        "inProgress" | "cancelling" => "running",
        "completed" => match result.unwrap_or("") {
            "succeeded" => "success",
            "partiallySucceeded" | "failed" => "failed",
            "canceled" => "canceled",
            _ => "unknown",
        },
        _ => "unknown",
    }
}

/// Map a timeline record. `state` uses the same words as a build status.
pub fn normalize_record(state: &str, result: Option<&str>) -> &'static str {
    match state {
        "pending" | "notStarted" => "pending",
        "inProgress" => "running",
        "completed" => normalize_build("completed", result),
        _ => normalize_build(state, result),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_build_results() {
        assert_eq!(normalize_build("notStarted", None), "pending");
        assert_eq!(normalize_build("inProgress", None), "running");
        assert_eq!(normalize_build("completed", Some("succeeded")), "success");
        assert_eq!(normalize_build("completed", Some("failed")), "failed");
        assert_eq!(
            normalize_build("completed", Some("partiallySucceeded")),
            "failed"
        );
        assert_eq!(normalize_build("completed", Some("canceled")), "canceled");
        assert_eq!(normalize_build("completed", None), "unknown");
    }
}
