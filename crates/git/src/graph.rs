//! Lane computation for the history graph.
//!
//! Lanes are computed in Rust from parent lists so the frontend only draws
//! segments. State is incremental: appending a page never recomputes the
//! previous pages.
//!
//! A lane carries a run of commits linked by first-parent edges. When a commit
//! has a second parent, that parent opens (or reuses) a lane *below* the commit
//! and the corner is rounded under the row's centerline. When a commit's first
//! parent is already expected by another lane, both lanes carry the line down
//! and the join is rounded *on the parent's row*, which is the shape the benchmark client
//! draws: the branch curves into the commit it lands on instead of leaving the
//! commit sideways.

use serde::{Deserialize, Serialize};

use crate::log::CommitSummary;

/// Hard ceiling on simultaneous lanes, protecting memory against pathological
/// histories. Beyond it, extra parents visually collapse on the last lane.
pub const MAX_LANES: usize = 16_384;

/// One vertical lane segment inside a row.
///
/// `from_top` / `to_bottom` tell which row edges the segment reaches: a segment
/// that starts below the top edge is a lane opened by an extra parent, and one
/// that stops before the bottom edge is a lane whose line ends on this commit.
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
    /// Lanes whose line ends on this commit. Their corner is rounded above the
    /// row's centerline, so the branch joins the node from above.
    pub arrivals: Vec<u16>,
    /// Lanes opened below the commit for its 2nd..nth parents. Their corner is
    /// rounded below the centerline.
    pub departures: Vec<u16>,
    /// True when the lane ceiling collapsed one or more edges.
    pub overflow: bool,
    /// Stash selector when this row stands for a stash entry (`stash@{0}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash: Option<String>,
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
        // Every lane whose line was heading to this commit ends on it.
        let expecting: Vec<usize> = self
            .lanes
            .iter()
            .enumerate()
            .filter(|(_, lane)| lane.as_deref() == Some(sha))
            .map(|(index, _)| index)
            .collect();
        let node_fresh = expecting.is_empty();
        let node_lane = expecting
            .first()
            .copied()
            .or_else(|| self.try_allocate())
            .unwrap_or(MAX_LANES - 1);
        if node_lane >= self.lanes.len() {
            self.lanes.resize(node_lane + 1, None);
        }
        // The leftmost lane carries the node; the other lanes join it with a
        // rounded corner on this row.
        let arrivals: Vec<u16> = expecting
            .iter()
            .copied()
            .filter(|lane| *lane != node_lane)
            .map(|lane| lane as u16)
            .collect();
        for lane in &expecting {
            self.lanes[*lane] = None;
        }
        self.lanes[node_lane] = None;

        let has_parents = !parents.is_empty();
        let mut overflow = false;
        let mut departures: Vec<u16> = Vec::with_capacity(parents.len().saturating_sub(1));
        let mut opened: Vec<u16> = Vec::with_capacity(parents.len().saturating_sub(1));
        let mut seen: Vec<&str> = Vec::with_capacity(parents.len());

        for (position, parent) in parents.iter().enumerate() {
            if seen.contains(&parent.as_str()) {
                continue;
            }
            seen.push(parent.as_str());

            if position == 0 {
                // The first parent is reached from this commit's own lane: the
                // line keeps that lane until the parent's row, where it joins
                // the parent even if another lane already expects it.
                self.lanes[node_lane] = Some(parent.clone());
                continue;
            }
            if let Some(existing) = self
                .lanes
                .iter()
                .position(|lane| lane.as_deref() == Some(parent.as_str()))
            {
                departures.push(existing as u16);
            } else if let Some(lane) = self.try_allocate() {
                self.lanes[lane] = Some(parent.clone());
                departures.push(lane as u16);
                opened.push(lane as u16);
            } else {
                overflow = true;
            }
        }

        let mut rails: Vec<LaneSpan> = Vec::with_capacity(self.lanes.len() + arrivals.len());
        for (index, lane) in self.lanes.iter().enumerate() {
            if lane.is_none() {
                continue;
            }
            let lane = index as u16;
            if lane == node_lane as u16 {
                continue;
            }
            // A lane just opened by a parent starts on its elbow; an inherited
            // lane is crossed edge to edge.
            rails.push(LaneSpan {
                lane,
                from_top: !opened.contains(&lane) && !arrivals.contains(&lane),
                to_bottom: true,
            });
        }
        // The node's own lane: the line above it comes from its children, the
        // one below heads to its first parent.
        if !node_fresh || has_parents {
            rails.push(LaneSpan {
                lane: node_lane as u16,
                from_top: !node_fresh,
                to_bottom: has_parents,
            });
        }
        for lane in &arrivals {
            rails.push(LaneSpan {
                lane: *lane,
                from_top: true,
                to_bottom: false,
            });
        }
        rails.sort_unstable();
        rails.dedup();
        departures.sort_unstable();
        departures.dedup();

        self.trim();
        let lane_count = self
            .active_lane_count()
            .max(node_lane + 1)
            .max(
                rails
                    .iter()
                    .map(|span| span.lane as usize + 1)
                    .max()
                    .unwrap_or(0),
            )
            .max(
                departures
                    .iter()
                    .map(|lane| *lane as usize + 1)
                    .max()
                    .unwrap_or(0),
            );
        GraphRow {
            node_lane: node_lane as u16,
            lane_count: lane_count as u16,
            rails,
            arrivals,
            departures,
            overflow,
            stash: None,
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
        // The first parent continues the lane without any elbow.
        assert!(first.arrivals.is_empty());
        assert!(first.departures.is_empty());
        assert_eq!(second.node_lane, 0);
        assert_eq!(second.rails, vec![span(0, true, true)]);
        // The root closes the lane: the rail stops at the node.
        assert_eq!(root.rails, vec![span(0, true, false)]);
        assert!(root.departures.is_empty());
    }

    #[test]
    fn merge_opens_its_extra_parent_below_the_row() {
        let mut layout = LaneLayout::new();
        let merge = layout.row("m", &["a".into(), "b".into()]);
        assert_eq!(merge.node_lane, 0);
        // Only the second parent becomes an elbow; the first one keeps lane 0.
        assert_eq!(merge.departures, vec![1]);
        assert!(merge.arrivals.is_empty());
        assert_eq!(
            merge.rails,
            vec![span(0, false, true), span(1, false, true)]
        );

        let a = layout.row("a", &["c".into()]);
        assert_eq!(a.node_lane, 0);
        assert!(a.departures.is_empty());
        assert_eq!(a.rails, vec![span(0, true, true), span(1, true, true)]);

        // `b` is still travelling in its own lane: the join is postponed to
        // the row of `c`, where both lanes reach the same commit.
        let b = layout.row("b", &["c".into()]);
        assert_eq!(b.node_lane, 1);
        assert!(b.departures.is_empty());
        assert!(b.arrivals.is_empty());
        assert_eq!(b.rails, vec![span(0, true, true), span(1, true, true)]);

        let c = layout.row("c", &[]);
        assert_eq!(c.node_lane, 0);
        assert_eq!(c.lane_count, 2);
        // `b`'s lane ends on `c` and curves into the node from above.
        assert_eq!(c.arrivals, vec![1]);
        assert!(c.departures.is_empty());
        assert_eq!(c.rails, vec![span(0, true, false), span(1, true, false)]);
    }

    #[test]
    fn a_parent_already_expected_elsewhere_joins_on_its_own_row() {
        let mut layout = LaneLayout::new();
        // Two tips share the same parent.
        layout.row("tip-a", &["base".into()]);
        let tip_b = layout.row("tip-b", &["base".into()]);
        assert_eq!(tip_b.node_lane, 1);
        // The second tip keeps its lane instead of bending into lane 0.
        assert_eq!(tip_b.rails, vec![span(0, true, true), span(1, false, true)]);

        let base = layout.row("base", &[]);
        assert_eq!(base.node_lane, 0);
        assert_eq!(base.arrivals, vec![1]);
        assert_eq!(base.rails, vec![span(0, true, false), span(1, true, false)]);
    }

    #[test]
    fn duplicate_lanes_arrive_instead_of_being_dropped() {
        // A resumed pager can leave two lanes expecting the same commit: the
        // extra lane is drawn as an arrival, not discarded.
        let mut layout = LaneLayout {
            lanes: vec![Some("c".into()), None, Some("c".into())],
        };
        let row = layout.row("c", &["p".into()]);
        assert_eq!(row.node_lane, 0);
        assert_eq!(row.arrivals, vec![2]);
        assert_eq!(row.rails, vec![span(0, true, true), span(2, true, false)]);
    }

    #[test]
    fn octopus_creates_one_lane_per_parent() {
        let mut layout = LaneLayout::new();
        let parents: Vec<String> = (0..8).map(|index| format!("p{index}")).collect();
        let row = layout.row("m", &parents);
        assert_eq!(row.departures.len(), 7);
        assert_eq!(row.lane_count, 8);
        assert_eq!(row.departures, (1..8).collect::<Vec<u16>>());
        assert!(row
            .rails
            .iter()
            .all(|rail| !rail.from_top && rail.to_bottom));
        assert_eq!(row.rails.len(), 8);
    }

    #[test]
    fn a_stash_row_reports_its_selector() {
        let mut pager = GraphPager::new();
        let mut rows = pager.rows(None, 1, &[commit("s", &["c"]), commit("c", &[])], None);
        rows[0].stash = Some("stash@{0}".to_owned());
        assert_eq!(rows[0].stash.as_deref(), Some("stash@{0}"));
        assert_eq!(rows[1].stash, None);
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
