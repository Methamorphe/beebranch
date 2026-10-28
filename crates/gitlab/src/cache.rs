//! Response cache used for conditional GitLab requests.
//!
//! The client only depends on this trait; the application can back it with
//! SQLite. Bodies are stored verbatim so a `304 Not Modified` can be replayed
//! without hitting the network payload again.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// A cached HTTP response body with its validators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedResponse {
    /// `ETag` returned by GitLab, sent back as `If-None-Match`.
    pub etag: Option<String>,
    /// Raw JSON body.
    pub body: Vec<u8>,
    /// Unix timestamp (seconds) of the fetch.
    pub fetched_at: i64,
    /// Unix timestamp (seconds) after which the entry must be refreshed.
    pub expires_at: Option<i64>,
}

/// Cache contract shared by the client and the storage layer.
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

/// In-memory cache, useful for tests and single-session usage.
#[derive(Debug, Default)]
pub struct MemoryResponseCache {
    entries: Mutex<HashMap<String, CachedResponse>>,
}

impl MemoryResponseCache {
    /// Create an empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of stored entries.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// True when no entry is stored.
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Remove every entry.
    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, CachedResponse>> {
        // A poisoned lock only means a previous caller panicked; the map
        // remains internally consistent, so recover instead of panicking.
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ResponseCache for MemoryResponseCache {
    fn get(&self, key: &str) -> Option<CachedResponse> {
        self.lock().get(key).cloned()
    }

    fn put(&self, key: &str, entry: CachedResponse) {
        self.lock().insert(key.to_owned(), entry);
    }

    fn remove_prefix(&self, prefix: &str) {
        self.lock().retain(|key, _| !key.starts_with(prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(etag: &str) -> CachedResponse {
        CachedResponse {
            etag: Some(etag.to_owned()),
            body: b"{}".to_vec(),
            fetched_at: 10,
            expires_at: Some(20),
        }
    }

    #[test]
    fn stores_and_replaces_entries() {
        let cache = MemoryResponseCache::new();
        assert!(cache.is_empty());

        cache.put("key", entry("\"a\""));
        assert_eq!(cache.len(), 1);
        assert_eq!(
            cache.get("key").and_then(|entry| entry.etag),
            Some("\"a\"".to_owned())
        );

        cache.put("key", entry("\"b\""));
        assert_eq!(
            cache.get("key").and_then(|entry| entry.etag),
            Some("\"b\"".to_owned())
        );

        cache.clear();
        assert!(cache.is_empty());
        assert!(cache.get("key").is_none());
    }
}
