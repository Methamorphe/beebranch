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

/// One vertical lane segment inside a row.
///
/// Extents are what makes an elbow-based renderer possible: a segment that
/// starts below the top edge opens on a parent edge, and one that stops before
/// the bottom edge is a branch converging into the row's commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSpan {
    pub lane: u16,
    /// The segment starts at the top edge of the row.
    pub from_top: bool,
    /// The segment reaches the bottom edge of the row.
    pub to_bottom: bool,
}

/// One row of the graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Lane occupied by the commit node.
    pub node_lane: u16,
    /// Number of lanes used by this row (`max index + 1`).
    pub lane_count: u16,
    /// Vertical segments crossing this row, ordered by lane.
    pub rails: Vec<LaneSpan>,
    /// Lanes reached by a parent edge, in parent order and deduplicated.
    pub parents: Vec<u16>,
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
        let existing = self
            .lanes
            .iter()
            .position(|lane| lane.as_deref() == Some(sha));
        let node_lane = existing
            .or_else(|| self.try_allocate())
            .unwrap_or(MAX_LANES - 1);
        if node_lane >= self.lanes.len() {
            self.lanes.resize(node_lane + 1, None);
        }
        let node_fresh = existing.is_none();
        self.lanes[node_lane] = None;

        // Other lanes expecting this commit converge into the node lane.
        // The lane state never duplicates a commit (each parent is looked up
        // before a lane is opened), so this only heals a resumed pager.
        for (index, lane) in self.lanes.iter_mut().enumerate() {
            if index != node_lane && lane.as_deref() == Some(sha) {
                *lane = None;
            }
        }

        let mut overflow = false;
        let mut destinations = Vec::with_capacity(parents.len());
        let mut opened: Vec<u16> = Vec::with_capacity(parents.len());
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
                opened.push(lane as u16);
                lane
            } else {
                overflow = true;
                node_lane
            };
            destinations.push(destination as u16);
        }

        if parents.is_empty() {
            // Root commit: its lane closes here.
            self.lanes[node_lane] = None;
        }

        // Lanes the row leaves open. Their top edge depends on why the lane
        // exists: an inherited lane is crossed from edge to edge, a lane opened
        // by a second parent starts on the elbow drawn at the node.
        let mut rails: Vec<LaneSpan> = self
            .lanes
            .iter()
            .enumerate()
            .filter_map(|(index, lane)| {
                lane.as_ref()?;
                let lane = index as u16;
                Some(LaneSpan {
                    lane,
                    from_top: !(node_fresh && lane == node_lane as u16) && !opened.contains(&lane),
                    to_bottom: true,
                })
            })
            .collect();
        if !node_fresh && self.lanes[node_lane].is_none() {
            rails.push(LaneSpan {
                lane: node_lane as u16,
                from_top: true,
                to_bottom: false,
            });
        }
        rails.sort_unstable();

        self.trim();
        let lane_count = self.active_lane_count().max(node_lane + 1).max(
            rails
                .iter()
                .map(|span| span.lane as usize + 1)
                .max()
                .unwrap_or(0),
        );
        GraphRow {
            node_lane: node_lane as u16,
            lane_count: lane_count as u16,
            rails,
            parents: destinations,
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

    fn span(lane: u16, from_top: bool, to_bottom: bool) -> LaneSpan {
        LaneSpan {
            lane,
            from_top,
            to_bottom,
        }
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        let mut layout = LaneLayout::new();
        let first = layout.row("c3", &["c2".into()]);
        let second = layout.row("c2", &["c1".into()]);
        let root = layout.row("c1", &[]);

        assert_eq!(first.node_lane, 0);
        // The lane opens on this commit: nothing is drawn above the node.
        assert_eq!(first.rails, vec![span(0, false, true)]);
        assert_eq!(second.node_lane, 0);
        assert_eq!(second.rails, vec![span(0, true, true)]);
        // The root closes the lane: the rail stops at the node.
        assert_eq!(root.rails, vec![span(0, true, false)]);
        assert_eq!(root.parents, Vec::<u16>::new());
    }

    #[test]
    fn merge_opens_and_closes_lanes() {
        let mut layout = LaneLayout::new();
        let merge = layout.row("m", &["a".into(), "b".into()]);
        assert_eq!(merge.node_lane, 0);
        assert_eq!(merge.parents, vec![0, 1]);
        // Both lanes are opened by the merge, so neither is drawn above it.
        assert_eq!(
            merge.rails,
            vec![span(0, false, true), span(1, false, true)]
        );

        let a = layout.row("a", &["c".into()]);
        assert_eq!(a.node_lane, 0);
        assert_eq!(a.parents, vec![0]);
        assert_eq!(a.rails, vec![span(0, true, true), span(1, true, true)]);

        // `b` merges back into `c`, which already owns lane 0: its own lane
        // stops at the node instead of being drawn through it.
        let b = layout.row("b", &["c".into()]);
        assert_eq!(b.node_lane, 1);
        assert_eq!(b.parents, vec![0]);
        assert_eq!(b.rails, vec![span(0, true, true), span(1, true, false)]);

        let c = layout.row("c", &[]);
        assert_eq!(c.node_lane, 0);
        assert_eq!(c.lane_count, 1);
        assert_eq!(c.rails, vec![span(0, true, false)]);
    }

    #[test]
    fn a_parent_already_expected_elsewhere_keeps_its_rail() {
        let mut layout = LaneLayout::new();
        // Two independent tips share the same parent, then meet on it.
        layout.row("tip-a", &["base".into()]);
        let tip_b = layout.row("tip-b", &["base".into()]);
        // `tip-b` opens lane 1 and points at lane 0 without opening a lane of
        // its own; the shared lane is crossed edge to edge.
        assert_eq!(tip_b.node_lane, 1);
        assert_eq!(tip_b.parents, vec![0]);
        assert_eq!(tip_b.rails, vec![span(0, true, true)]);
    }

    #[test]
    fn a_duplicate_lane_is_healed_instead_of_drawn() {
        // The public API never duplicates a lane, but a resumed pager could:
        // the second lane must be dropped rather than left drawing to nowhere.
        let mut layout = LaneLayout {
            lanes: vec![Some("c".into()), None, Some("c".into())],
        };
        let row = layout.row("c", &["p".into()]);
        assert_eq!(row.node_lane, 0);
        assert_eq!(row.rails, vec![span(0, true, true)]);
    }

    #[test]
    fn octopus_creates_one_lane_per_parent() {
        let mut layout = LaneLayout::new();
        let parents: Vec<String> = (0..8).map(|index| format!("p{index}")).collect();
        let row = layout.row("m", &parents);
        assert_eq!(row.parents.len(), 8);
        assert_eq!(row.lane_count, 8);
        assert_eq!(row.parents, (0..8).collect::<Vec<u16>>());
        assert!(row
            .rails
            .iter()
            .all(|rail| !rail.from_top && rail.to_bottom));
        assert_eq!(row.rails.len(), 8);
    }

    #[test]
    fn dead_branch_keeps_its_lane_until_its_commit() {
        let mut layout = LaneLayout::new();
        layout.row("tip", &["base".into()]);
        layout.row("main", &["base".into()]);
        let row = layout.row("tip2", &[]);
        assert_eq!(row.node_lane, 1);
        assert!(row
            .rails
            .iter()
            .any(|rail| rail.lane == 0 && rail.to_bottom));
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
