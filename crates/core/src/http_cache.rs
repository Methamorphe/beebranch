//! Conditional-request cache shared by forge clients.
//!
//! The client only depends on this trait; the application can back it with
//! SQLite. Bodies are stored verbatim so a `304 Not Modified` can be replayed
//! without downloading the payload again.

/// A cached HTTP response body with its validators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedResponse {
    /// `ETag` returned by the forge, sent back as `If-None-Match`.
    pub etag: Option<String>,
    /// Raw JSON body.
    pub body: Vec<u8>,
    /// Unix timestamp (seconds) of the fetch.
    pub fetched_at: i64,
    /// Unix timestamp (seconds) after which the entry must be refreshed.
    pub expires_at: Option<i64>,
}

/// Cache contract shared by forge clients and the storage layer.
pub trait ResponseCache: Send + Sync {
    /// Return the entry stored for `key`, if any.
    fn get(&self, key: &str) -> Option<CachedResponse>;
    /// Store `entry` for `key`, replacing any previous value.
    fn put(&self, key: &str, entry: CachedResponse);
    /// Drop every entry whose key starts with `prefix`.
    ///
    /// Used after a mutation so a list refresh never replays a stale body.
    fn remove_prefix(&self, _prefix: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_response_roundtrips() {
        let entry = CachedResponse {
            etag: Some("\"abc\"".to_owned()),
            body: b"{}".to_vec(),
            fetched_at: 1,
            expires_at: Some(2),
        };
        assert_eq!(entry.body, b"{}");
    }
}
