use std::sync::Arc;

use beebranch_core::{CachedResponse, ResponseCache};
use beebranch_store::{CacheEntry, Store};

/// SQLite-backed response cache for forge ETag revalidation (GitLab and GitHub).
pub struct SqliteCache {
    store: Arc<Store>,
}

impl SqliteCache {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }
}

impl ResponseCache for SqliteCache {
    fn get(&self, key: &str) -> Option<CachedResponse> {
        let entry = self.store.get_cache(key).ok().flatten()?;
        Some(CachedResponse {
            etag: entry.etag,
            body: entry.body,
            fetched_at: entry.fetched_at,
            expires_at: entry.expires_at,
        })
    }

    fn put(&self, key: &str, entry: CachedResponse) {
        let stored = CacheEntry {
            etag: entry.etag,
            body: entry.body,
            fetched_at: entry.fetched_at,
            expires_at: entry.expires_at,
        };
        if let Err(error) = self.store.put_cache(key, &stored) {
            tracing::warn!(%error, "forge cache write failed");
        }
    }

    fn remove_prefix(&self, prefix: &str) {
        if let Err(error) = self.store.delete_cache_prefix(prefix) {
            tracing::warn!(%error, "forge cache invalidation failed");
        }
    }
}
