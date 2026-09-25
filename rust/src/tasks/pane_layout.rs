//! Task display rows in a Herdr tab. Layout maintenance is presentation only:
//! an unreadable layout falls back to the known pane and never fails a split.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use crate::integrations::herdr::{Herdr, HerdrResult, LayoutPane, Pane, PaneLayout, Rect};

#[derive(Debug, Clone, PartialEq)]
pub struct PaneResize {
    pub pane_id: String,
    pub direction: &'static str,
    pub amount: f64,
}

fn contains(outer: &Rect, inner: &Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height
}

pub fn pane_for_next_row(layout: &PaneLayout, fallback: &str) -> String {
    let depth = |pane: &LayoutPane| {
        layout
            .splits
            .iter()
            .filter(|split| contains(&split.rect, &pane.rect))
            .count()
    };
    layout
        .panes
        .iter()
        .min_by(|left, right| {
            right
                .rect
                .height
                .cmp(&left.rect.height)
                .then(depth(left).cmp(&depth(right)))
                .then(right.rect.width.cmp(&left.rect.width))
                .then(right.rect.y.cmp(&left.rect.y))
                .then(left.rect.x.cmp(&right.rect.x))
        })
        .map_or_else(|| fallback.to_owned(), |pane| pane.pane_id.clone())
}

pub fn balanced_row_resizes(layout: &PaneLayout) -> Vec<PaneResize> {
    layout
        .splits
        .iter()
        .filter(|split| split.direction == "down")
        .filter_map(|split| {
            let descendants = layout
                .panes
                .iter()
                .filter(|pane| contains(&split.rect, &pane.rect))
                .collect::<Vec<_>>();
            let cut = f64::from(split.rect.y) + f64::from(split.rect.height) * split.ratio;
            let (first, second): (Vec<&LayoutPane>, Vec<&LayoutPane>) = descendants
                .iter()
                .partition(|pane| f64::from(pane.rect.y) + f64::from(pane.rect.height) / 2.0 < cut);
            if first.is_empty() || second.is_empty() {
                return None;
            }
            let delta = first.len() as f64 / descendants.len() as f64 - split.ratio;
            if delta.abs() < 0.000_001 {
                return None;
            }
            let grow_first = delta > 0.0;
            let candidates = if grow_first { &first } else { &second };
            let edge = |pane: &LayoutPane| {
                if grow_first {
                    pane.rect.y + pane.rect.height
                } else {
                    pane.rect.y
                }
            };
            let pane = candidates
                .iter()
                .skip(1)
                .fold(candidates[0], |selected, &candidate| {
                    let better = if grow_first {
                        edge(candidate) > edge(selected)
                    } else {
                        edge(candidate) < edge(selected)
                    };
                    if better { candidate } else { selected }
                });
            Some(PaneResize {
                pane_id: pane.pane_id.clone(),
                direction: if grow_first { "down" } else { "up" },
                amount: delta.abs(),
            })
        })
        .collect()
}

fn queue(key: String) -> Arc<Mutex<()>> {
    static QUEUES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    QUEUES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(key)
        .or_default()
        .clone()
}

/// Splits a new display row below the tallest pane of the tab, then balances
/// the rows. Splits in one tab run one at a time.
pub fn split_balanced_pane_row(herdr: &Herdr, pane_id: &str, cwd: &str) -> HerdrResult<Pane> {
    let key = herdr.get_pane_layout(pane_id).map_or_else(
        |_| format!("pane:{pane_id}"),
        |layout| format!("tab:{}", layout.tab_id),
    );
    let lock = queue(key);
    let _serialized = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let target = herdr.get_pane_layout(pane_id).map_or_else(
        |_| pane_id.to_owned(),
        |layout| pane_for_next_row(&layout, pane_id),
    );
    let pane = herdr.split_pane(&target, "down", Some(0.5), cwd)?;
    if let Ok(layout) = herdr.get_pane_layout(&pane.pane_id) {
        for resize in balanced_row_resizes(&layout) {
            if herdr
                .resize_pane(&resize.pane_id, resize.direction, resize.amount)
                .is_err()
            {
                break;
            }
        }
    }
    Ok(pane)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };

    use serde_json::{Value, json};

    use super::*;
    use crate::integrations::herdr::{LayoutSplit, fake};

    fn rect(y: u32, height: u32) -> Rect {
        Rect {
            x: 0,
            y,
            width: 120,
            height,
        }
    }

    fn pane(id: &str, y: u32, height: u32) -> LayoutPane {
        LayoutPane {
            pane_id: id.into(),
            focused: false,
            rect: rect(y, height),
        }
    }

    fn split(id: &str, ratio: f64, height: u32) -> LayoutSplit {
        LayoutSplit {
            id: id.into(),
            direction: "down".into(),
            ratio,
            rect: rect(0, height),
        }
    }

    fn layout() -> PaneLayout {
        PaneLayout {
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            zoomed: false,
            focused_pane_id: "p1".into(),
            area: rect(0, 60),
            panes: vec![pane("p1", 0, 15), pane("p2", 15, 15), pane("p3", 30, 30)],
            splits: vec![split("root", 0.5, 60), split("top", 0.5, 30)],
        }
    }

    fn layout_value() -> Value {
        json!({"layout":{"workspace_id":"w1","tab_id":"w1:t1","zoomed":false,"focused_pane_id":"p1",
            "area":{"x":0,"y":0,"width":120,"height":60},
            "panes":[{"pane_id":"p1","focused":false,"rect":{"x":0,"y":0,"width":120,"height":15}},
                     {"pane_id":"p2","focused":false,"rect":{"x":0,"y":15,"width":120,"height":15}},
                     {"pane_id":"p3","focused":true,"rect":{"x":0,"y":30,"width":120,"height":30}}],
            "splits":[{"id":"root","direction":"down","ratio":0.5,"rect":{"x":0,"y":0,"width":120,"height":60}},
                      {"id":"top","direction":"down","ratio":0.5,"rect":{"x":0,"y":0,"width":120,"height":30}}]}})
    }

    #[test]
    fn chooses_a_tallest_row_and_balances_split_ratios_by_descendant_counts() {
        assert_eq!(pane_for_next_row(&layout(), "fallback"), "p3");
        let resizes = balanced_row_resizes(&layout());
        assert_eq!(
            (resizes[0].pane_id.as_str(), resizes[0].direction),
            ("p2", "down")
        );
        assert!((resizes[0].amount - 1.0 / 6.0).abs() < 1e-9);
    }

    #[test]
    fn breaks_equal_height_ties_with_the_shallowest_leaf() {
        let mut equal = layout();
        equal.panes = vec![pane("p1", 0, 20), pane("p2", 20, 20), pane("p3", 40, 20)];
        equal.splits = vec![split("root", 2.0 / 3.0, 60), split("top", 0.5, 40)];
        assert_eq!(pane_for_next_row(&equal, "fallback"), "p3");
    }

    #[test]
    fn splits_downward_and_keeps_layout_maintenance_presentation_only() {
        let layouts = AtomicUsize::new(0);
        let (herdr, calls) = fake::herdr(move |args| match args[1].as_str() {
            "layout" if layouts.fetch_add(1, Ordering::SeqCst) < 2 => {
                fake::envelope(layout_value())
            }
            "layout" => fake::failed(json!({"error":{"code":"unavailable"}})),
            _ => fake::envelope(json!({"pane":{"pane_id":"p4"}})),
        });
        assert_eq!(
            split_balanced_pane_row(&herdr, "p1", "/repo")
                .unwrap()
                .pane_id,
            "p4"
        );
        assert!(calls.lock().unwrap().contains(&vec![
            "pane".to_owned(),
            "split".into(),
            "p3".into(),
            "--direction".into(),
            "down".into(),
            "--ratio".into(),
            "0.5".into(),
            "--cwd".into(),
            "/repo".into(),
            "--no-focus".into()
        ]));
    }

    #[test]
    fn falls_back_to_the_known_pane_and_continues_after_a_failed_split() {
        let splits = AtomicUsize::new(0);
        let (herdr, calls) = fake::herdr(move |args| match args[1].as_str() {
            "layout" => fake::failed(json!({"error":{"code":"unavailable"}})),
            _ if splits.fetch_add(1, Ordering::SeqCst) == 0 => {
                fake::failed(json!({"error":{"code":"split_failed","message":"split failed"}}))
            }
            _ => fake::envelope(json!({"pane":{"pane_id":"p2"}})),
        });
        assert!(split_balanced_pane_row(&herdr, "p1", "/repo").is_err());
        assert_eq!(
            split_balanced_pane_row(&herdr, "p1", "/repo")
                .unwrap()
                .pane_id,
            "p2"
        );
        assert!(
            calls
                .lock()
                .unwrap()
                .iter()
                .all(|args| args[1] != "split" || args[2] == "p1")
        );
    }

    #[test]
    fn serializes_concurrent_layout_updates_in_the_same_tab() {
        let (release, wait) = mpsc::channel::<()>();
        let wait = Mutex::new(wait);
        let splits = Arc::new(AtomicUsize::new(0));
        let observed = splits.clone();
        let (herdr, _) = fake::herdr(move |args| match args[1].as_str() {
            "layout" => fake::envelope(
                json!({"layout":{"workspace_id":"w9","tab_id":"w9:serial","zoomed":false,"focused_pane_id":"p1",
                "area":{"x":0,"y":0,"width":10,"height":10},"panes":[],"splits":[]}}),
            ),
            _ => {
                if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                    wait.lock().unwrap().recv().unwrap();
                }
                fake::envelope(json!({"pane":{"pane_id":"p4"}}))
            }
        });
        let workers = (0..2)
            .map(|_| {
                let herdr = herdr.clone();
                std::thread::spawn(move || split_balanced_pane_row(&herdr, "p1", "/repo").unwrap())
            })
            .collect::<Vec<_>>();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(splits.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(splits.load(Ordering::SeqCst), 2);
    }
}
