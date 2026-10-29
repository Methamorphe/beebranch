//! Mapping of GitHub check-run and Actions job states to the shared CI states.

/// Normalize a GitHub status/conclusion pair.
///
/// Unknown values stay `unknown`; they are never silently coerced to success
/// or neutral. The returned strings match the GitLab status vocabulary used by
/// the frontend.
pub fn normalize_status(status: &str, conclusion: Option<&str>) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "queued" | "requested" | "waiting" | "pending" | "action_required" => "pending",
        "in_progress" => "running",
        "completed" => match conclusion
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "success" => "success",
            "failure" | "timed_out" | "startup_failure" => "failed",
            "cancelled" | "canceled" => "canceled",
            "skipped" | "neutral" => "neutral",
            "action_required" => "pending",
            "stale" => "unknown",
            _ => "unknown",
        },
        // Some Actions payloads use the conclusion directly.
        "success" => "success",
        "failure" | "timed_out" => "failed",
        "cancelled" | "canceled" => "canceled",
        "skipped" | "neutral" => "neutral",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_check_run_states() {
        assert_eq!(normalize_status("queued", None), "pending");
        assert_eq!(normalize_status("in_progress", None), "running");
        assert_eq!(normalize_status("completed", Some("success")), "success");
        assert_eq!(normalize_status("completed", Some("failure")), "failed");
        assert_eq!(normalize_status("completed", Some("timed_out")), "failed");
        assert_eq!(normalize_status("completed", Some("cancelled")), "canceled");
        assert_eq!(normalize_status("completed", Some("skipped")), "neutral");
        assert_eq!(normalize_status("completed", Some("stale")), "unknown");
        assert_eq!(normalize_status("completed", None), "unknown");
        assert_eq!(normalize_status("invented", None), "unknown");
    }
}
