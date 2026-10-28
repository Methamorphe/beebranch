//! Lane computation for the history graph.
//!
//! Lanes are computed in Rust from parent lists so the frontend only draws
//! segments. State is incremental: appending a page never recomputes the
//! previous pages.

use serde::{Deserialize, Serialize};

use crate::log::CommitSummary;

/// Hard ceiling on simultaneous lanes, protecting memory against pathological
/// histories. Beyond it, extra parents visually collapse on the last lane.
pub const MAX_LANES: usize = 16_384;

/// One row of the graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Lane occupied by the commit node.
    pub node_lane: u16,
    /// Number of lanes used by this row (`max index + 1`).
    pub lane_count: u16,
    /// Inclusive ranges of lanes continuing through this row.
    pub active_ranges: Vec<[u16; 2]>,
    /// Lanes reached by parent edges (including the first parent).
    pub parent_lanes: Vec<u16>,
    /// True when the lane ceiling collapsed one or more edges.
    pub overflow: bool,
}

/// Incremental lane state.
#[derive(Debug, Clone, Default)]
pub struct LaneLayout {
    lanes: Vec<Option<String>>,
}

impl LaneLayout {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.lanes.clear();
    }

    pub fn active_lane_count(&self) -> usize {
        self.lanes
            .iter()
            .rposition(Option::is_some)
            .map_or(0, |index| index + 1)
    }

    /// Compute the row for one commit, given its parents.
    pub fn row(&mut self, sha: &str, parents: &[String]) -> GraphRow {
        let node_lane = self
            .lanes
            .iter()
            .position(|lane| lane.as_deref() == Some(sha))
            .or_else(|| self.try_allocate())
            .unwrap_or(MAX_LANES - 1);
        if node_lane >= self.lanes.len() {
            self.lanes.resize(node_lane + 1, None);
        }
        self.lanes[node_lane] = None;

        // Other lanes expecting this commit converge into the node lane.
        for (index, lane) in self.lanes.iter_mut().enumerate() {
            if index != node_lane && lane.as_deref() == Some(sha) {
                *lane = None;
            }
        }

        let mut overflow = false;
        let mut parent_lanes = Vec::with_capacity(parents.len());
        let mut seen: Vec<&str> = Vec::with_capacity(parents.len());

        for (position, parent) in parents.iter().enumerate() {
            if seen.contains(&parent.as_str()) {
                continue;
            }
            seen.push(parent.as_str());

            let destination = if position == 0 {
                if let Some(existing) = self
                    .lanes
                    .iter()
                    .position(|lane| lane.as_deref() == Some(parent.as_str()))
                {
                    self.lanes[node_lane] = None;
                    existing
                } else {
                    self.lanes[node_lane] = Some(parent.clone());
                    node_lane
                }
            } else if let Some(existing) = self
                .lanes
                .iter()
                .position(|lane| lane.as_deref() == Some(parent.as_str()))
            {
                existing
            } else if let Some(lane) = self.try_allocate() {
                self.lanes[lane] = Some(parent.clone());
                lane
            } else {
                overflow = true;
                node_lane
            };
            parent_lanes.push(destination as u16);
        }

        if parents.is_empty() {
            // Root commit: its lane closes here.
            self.lanes[node_lane] = None;
        }

        self.trim();
        let lane_count = self.active_lane_count().max(node_lane + 1);
        GraphRow {
            node_lane: node_lane as u16,
            lane_count: lane_count as u16,
            active_ranges: self.active_ranges(),
            parent_lanes,
            overflow,
        }
    }

    fn try_allocate(&mut self) -> Option<usize> {
        if let Some(index) = self.lanes.iter().position(Option::is_none) {
            return Some(index);
        }
        if self.lanes.len() < MAX_LANES {
            self.lanes.push(None);
            return Some(self.lanes.len() - 1);
        }
        None
    }

    fn trim(&mut self) {
        while self.lanes.last().is_some_and(Option::is_none) {
            self.lanes.pop();
        }
    }

    fn active_ranges(&self) -> Vec<[u16; 2]> {
        let mut ranges: Vec<[u16; 2]> = Vec::new();
        let mut start: Option<u16> = None;
        let mut last: u16 = 0;

        for (index, lane) in self.lanes.iter().enumerate() {
            if lane.is_some() {
                let index = index as u16;
                if start.is_none() {
                    start = Some(index);
                }
                last = index;
            } else if let Some(start) = start.take() {
                ranges.push([start, last]);
            }
        }
        if let Some(start) = start {
            ranges.push([start, last]);
        }
        ranges
    }
}

/// Per-session pager that keeps lane state aligned with the requested cursor.
#[derive(Debug, Default)]
pub struct GraphPager {
    layout: LaneLayout,
    cursor: Option<String>,
    generation: Option<u64>,
}

impl GraphPager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Compute rows for a page. Resets the lane state when the cursor or the
    /// generation does not match the previous page.
    pub fn rows(
        &mut self,
        requested_after: Option<&str>,
        generation: u64,
        commits: &[CommitSummary],
        next_cursor: Option<&str>,
    ) -> Vec<GraphRow> {
        if requested_after.is_none()
            || self.generation != Some(generation)
            || self.cursor.as_deref() != requested_after
        {
            self.layout.reset();
        }

        let rows = commits
            .iter()
            .map(|commit| self.layout.row(&commit.sha, &commit.parents))
            .collect();

        self.cursor = next_cursor.map(str::to_owned);
        self.generation = Some(generation);
        rows
    }

    pub fn reset(&mut self) {
        self.layout.reset();
        self.cursor = None;
        self.generation = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, parents: &[&str]) -> CommitSummary {
        crate::log::CommitSummary {
            sha: sha.to_owned(),
            parents: parents.iter().map(|value| (*value).to_owned()).collect(),
            author: crate::log::CommitIdentity {
                name: "A".into(),
                email: "a@b.c".into(),
                timestamp: 0,
            },
            committer: crate::log::CommitIdentity {
                name: "A".into(),
                email: "a@b.c".into(),
                timestamp: 0,
            },
            refs: Vec::new(),
            subject: sha.to_owned(),
        }
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let mut layout = LaneLayout::new();
        let first = layout.row("c3", &["c2".into()]);
        let second = layout.row("c2", &["c1".into()]);
        let root = layout.row("c1", &[]);

        assert_eq!(first.node_lane, 0);
        assert_eq!(first.active_ranges, vec![[0, 0]]);
        assert_eq!(second.node_lane, 0);
        assert_eq!(root.active_ranges, Vec::<[u16; 2]>::new());
    }

    #[test]
    fn merge_opens_and_closes_lanes() {
        let mut layout = LaneLayout::new();
        let merge = layout.row("m", &["a".into(), "b".into()]);
        assert_eq!(merge.node_lane, 0);
        assert_eq!(merge.parent_lanes, vec![0, 1]);

        let a = layout.row("a", &["c".into()]);
        assert_eq!(a.node_lane, 0);
        assert_eq!(a.parent_lanes, vec![0]);

        let b = layout.row("b", &["c".into()]);
        assert_eq!(b.node_lane, 1);
        assert_eq!(b.parent_lanes, vec![0]);

        let c = layout.row("c", &[]);
        assert_eq!(c.node_lane, 0);
        assert_eq!(c.lane_count, 1);
    }

    #[test]
    fn octopus_creates_one_lane_per_parent() {
        let mut layout = LaneLayout::new();
        let parents: Vec<String> = (0..8).map(|index| format!("p{index}")).collect();
        let row = layout.row("m", &parents);
        assert_eq!(row.parent_lanes.len(), 8);
        assert_eq!(row.lane_count, 8);
        assert_eq!(row.active_ranges, vec![[0, 7]]);
        assert_eq!(row.parent_lanes, (0..8).collect::<Vec<u16>>());
    }

    #[test]
    fn dead_branch_keeps_its_lane_until_its_commit() {
        let mut layout = LaneLayout::new();
        layout.row("tip", &["base".into()]);
        layout.row("main", &["base".into()]);
        let row = layout.row("tip2", &[]);
        assert_eq!(row.node_lane, 1);
        assert!(row.active_ranges.iter().any(|[start, _]| *start == 0));
    }

    #[test]
    fn pager_resets_on_cursor_change() {
        let mut pager = GraphPager::new();
        let page = vec![commit("c2", &["c1"]), commit("c1", &[])];
        let first = pager.rows(None, 1, &page, Some("2"));
        assert_eq!(first[0].node_lane, 0);

        // Same cursor: state is kept, which is what incremental append needs.
        let second = pager.rows(Some("2"), 1, &[commit("c0", &[])], None);
        assert_eq!(second[0].node_lane, 0);

        // Different cursor: state is rebuilt from scratch.
        let reset = pager.rows(Some("99"), 1, &[commit("x", &[])], None);
        assert_eq!(reset[0].node_lane, 0);
    }
}
