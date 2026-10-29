//! Response cache used for conditional GitLab requests.
//!
//! The trait and entry type live in `beebranch-core` so every forge client
//! shares one cache contract. This module keeps the GitLab names as
//! re-exports and provides an in-memory implementation for tests.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

pub use beebranch_core::{CachedResponse, ResponseCache};

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
