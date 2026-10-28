use serde::{Deserialize, Serialize};

/// Default page size for commit and file pages.
pub const DEFAULT_PAGE_SIZE: u32 = 500;
/// Hard ceiling for a single page. Payloads must stay below 1 MiB.
pub const MAX_PAGE_SIZE: u32 = 2000;

/// Requested page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    /// Cursor returned by the previous page. `None` starts at the beginning.
    pub after: Option<String>,
    /// Requested item count; clamped to `1..=MAX_PAGE_SIZE`.
    pub limit: Option<u32>,
}

impl PageRequest {
    pub fn first(limit: u32) -> Self {
        Self {
            after: None,
            limit: Some(limit),
        }
    }

    pub fn limit(&self) -> u32 {
        self.limit
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE)
    }
}

/// A bounded page of items with its generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    /// Cursor for the next page; absent when the end is reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    /// Repository generation this page was read at.
    pub generation: u64,
    /// True when the producer hit its hard cap or truncated an item.
    pub truncated: bool,
}

impl<T> Page<T> {
    pub fn new(items: Vec<T>, next: Option<String>, generation: u64) -> Self {
        Self {
            items,
            next,
            generation,
            truncated: false,
        }
    }

    pub fn truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }

    pub fn map<U>(self, mut f: impl FnMut(T) -> U) -> Page<U> {
        Page {
            items: self.items.into_iter().map(&mut f).collect(),
            next: self.next,
            generation: self.generation,
            truncated: self.truncated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_limits() {
        assert_eq!(
            PageRequest {
                after: None,
                limit: None
            }
            .limit(),
            DEFAULT_PAGE_SIZE
        );
        assert_eq!(
            PageRequest {
                after: None,
                limit: Some(0)
            }
            .limit(),
            1
        );
        assert_eq!(
            PageRequest {
                after: None,
                limit: Some(99_999)
            }
            .limit(),
            MAX_PAGE_SIZE
        );
    }

    #[test]
    fn page_serializes_camel_case() {
        let page = Page::new(vec![1, 2], Some("cursor".into()), 3);
        let json = serde_json::to_value(page).expect("serialize");
        assert_eq!(json["next"], "cursor");
        assert_eq!(json["generation"], 3);
        assert_eq!(json["items"], serde_json::json!([1, 2]));
    }
}
