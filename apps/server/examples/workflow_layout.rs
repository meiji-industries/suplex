//! Regenerate the New Task diagram geometry with:
//! cargo run --manifest-path apps/server/Cargo.toml --example workflow_layout --quiet > .context/workflow-layouts.json
//! mv .context/workflow-layouts.json apps/web/features/tasks/workflow-layouts.json
use serde_json::{Value, json};

type Graph = (
    &'static str,
    &'static [&'static str],
    &'static [(&'static str, &'static str)],
);

const GRAPHS: &[Graph] = &[
    (
        "standard",
        &["plan", "build", "review", "delivery"],
        &[
            ("plan", "build"),
            ("build", "review"),
            ("review", "delivery"),
        ],
    ),
    (
        "direct_build",
        &["plan", "build", "review", "delivery"],
        &[
            ("plan", "build"),
            ("build", "review"),
            ("review", "delivery"),
        ],
    ),
    (
        "independent_review",
        &["plan", "build", "review", "reviewer", "delivery"],
        &[
            ("plan", "build"),
            ("build", "review"),
            ("review", "reviewer"),
            ("reviewer", "delivery"),
            ("reviewer", "build"),
        ],
    ),
    (
        "competing_plans",
        &[
            "objective",
            "plan-a",
            "plan-b",
            "combine",
            "build",
            "review",
            "delivery",
        ],
        &[
            ("objective", "plan-a"),
            ("objective", "plan-b"),
            ("plan-a", "combine"),
            ("plan-b", "combine"),
            ("combine", "build"),
            ("build", "review"),
            ("review", "delivery"),
        ],
    ),
    (
        "refine_pull_request",
        &["source", "rater", "coordinator", "repair", "merge"],
        &[
            ("source", "rater"),
            ("rater", "coordinator"),
            ("coordinator", "repair"),
            ("coordinator", "merge"),
        ],
    ),
    (
        "approve_then_build",
        &["plan", "approval", "build", "review", "delivery"],
        &[
            ("plan", "approval"),
            ("approval", "build"),
            ("build", "review"),
            ("review", "delivery"),
        ],
    ),
];

fn layout(id: &str, nodes: &[&str], edges: &[(&str, &str)], compact: bool) -> Value {
    let wide_spacing = match id {
        "standard" | "direct_build" => "140",
        "independent_review" | "refine_pull_request" | "approve_then_build" => "108",
        _ => "76",
    };
    let input = json!({
        "id": "root",
        "layoutOptions": {
            "elk.algorithm": "layered",
            "elk.direction": if compact { "DOWN" } else { "RIGHT" },
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.spacing.nodeNode": if compact && (id == "competing_plans" || id == "refine_pull_request") { "140" } else if compact { "84" } else { "35" },
            "elk.layered.spacing.nodeNodeBetweenLayers": if compact && id == "refine_pull_request" { "26" } else if compact && id == "competing_plans" { "38" } else if compact { "18" } else { wide_spacing },
            "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
            "elk.layered.nodePlacement.favorStraightEdges": "false"
        },
        "children": nodes.iter().map(|id| json!({"id": id, "width": 44, "height": 44})).collect::<Vec<_>>(),
        "edges": edges.iter().map(|(from, to)| json!({"id": format!("{from}-{to}"), "sources": [from], "targets": [to]})).collect::<Vec<_>>()
    });
    let result = elkrs::create_elk()
        .layout_json(&input.to_string())
        .expect("layout failed");
    let mut positions: Vec<Value> = result["children"]
        .as_array()
        .expect("ELK layout output is complete")
        .iter()
        .map(|node| {
            json!({
                "id": node["id"], "x": node["x"], "y": node["y"]
            })
        })
        .collect();
    let mut routes: Vec<Value> = result["edges"]
        .as_array()
        .expect("ELK layout output is complete")
        .iter()
        .map(|edge| {
            let section = &edge["sections"][0];
            let mut points = vec![section["startPoint"].clone()];
            if let Some(bends) = section["bendPoints"].as_array() {
                points.extend(bends.iter().cloned());
            }
            points.push(section["endPoint"].clone());
            json!({"id": edge["id"], "points": points})
        })
        .collect();
    if id == "refine_pull_request" {
        let repair = positions
            .iter()
            .find(|node| node["id"] == "repair")
            .expect("ELK layout output is complete");
        let rater = positions
            .iter()
            .find(|node| node["id"] == "rater")
            .expect("ELK layout output is complete");
        let px = repair["x"].as_f64().expect("ELK layout output is complete");
        let py = repair["y"].as_f64().expect("ELK layout output is complete");
        let rx = rater["x"].as_f64().expect("ELK layout output is complete");
        let ry = rater["y"].as_f64().expect("ELK layout output is complete");
        let points = if compact {
            json!([{"x": px, "y": py + 22.0}, {"x": -30.0, "y": py + 22.0}, {"x": -30.0, "y": ry - 20.0}, {"x": rx + 22.0, "y": ry - 20.0}, {"x": rx + 22.0, "y": ry}])
        } else {
            json!([{"x": px + 44.0, "y": py + 22.0}, {"x": px + 124.0, "y": py + 22.0}, {"x": px + 124.0, "y": -50.0}, {"x": rx + 22.0, "y": -50.0}, {"x": rx + 22.0, "y": ry}])
        };
        routes.push(json!({"id": "repair-rater", "points": points}));
    }
    if id == "refine_pull_request" && !compact {
        let coordinator = positions
            .iter()
            .find(|node| node["id"] == "coordinator")
            .expect("ELK layout output is complete");
        let coordinator_y = coordinator["y"]
            .as_f64()
            .expect("ELK layout output is complete");
        let coordinator_right = coordinator["x"]
            .as_f64()
            .expect("ELK layout output is complete")
            + 44.0;
        let merge = positions
            .iter_mut()
            .find(|node| node["id"] == "merge")
            .expect("ELK layout output is complete");
        let merge_x = merge["x"].as_f64().expect("ELK layout output is complete") + 152.0;
        merge["x"] = json!(merge_x);
        merge["y"] = json!(coordinator_y);
        for route in &mut routes {
            if route["id"] == "coordinator-merge" {
                let center_y = coordinator_y + 22.0;
                route["points"] =
                    json!([{"x": coordinator_right, "y": center_y}, {"x": merge_x, "y": center_y}]);
            }
        }
    }
    if id == "competing_plans" && !compact {
        for route in &mut routes {
            if !matches!(
                route["id"].as_str().expect("ELK layout output is complete"),
                "objective-plan-a" | "objective-plan-b" | "plan-a-combine" | "plan-b-combine"
            ) {
                continue;
            }
            let points = route["points"]
                .as_array()
                .expect("ELK layout output is complete");
            let start = &points[0];
            let end = &points[points.len() - 1];
            let sx = start["x"].as_f64().expect("ELK layout output is complete");
            let sy = start["y"].as_f64().expect("ELK layout output is complete");
            let ex = end["x"].as_f64().expect("ELK layout output is complete");
            let ey = end["y"].as_f64().expect("ELK layout output is complete");
            let middle = (sx + ex) / 2.0;
            route["points"] = json!([start, {"x": middle, "y": sy}, {"x": middle, "y": ey}, end]);
        }
    }
    if id != "refine_pull_request" {
        routes.push(return_route(&positions, "review", "build", compact));
    }
    if id == "approve_then_build" {
        routes.push(return_route(&positions, "approval", "plan", compact));
    }
    let width = if id == "refine_pull_request" && !compact {
        json!(
            result["width"]
                .as_f64()
                .expect("ELK layout output is complete")
                + 152.0
        )
    } else {
        result["width"].clone()
    };
    json!({"width": width, "height": result["height"], "nodes": positions, "edges": routes})
}

/// A dashed route back to an earlier station: above the row when wide, to
/// the right of the column when compact.
fn return_route(positions: &[Value], from: &str, to: &str, compact: bool) -> Value {
    let center = |id: &str| {
        let node = positions
            .iter()
            .find(|node| node["id"] == id)
            .expect("ELK layout output is complete");
        (
            node["x"].as_f64().expect("ELK layout output is complete") + 22.0,
            node["y"].as_f64().expect("ELK layout output is complete") + 22.0,
        )
    };
    let ((fx, fy), (tx, ty)) = (center(from), center(to));
    let points = if compact {
        let loop_x = fx.max(tx) + 44.0;
        json!([{"x": fx + 22.0, "y": fy}, {"x": loop_x, "y": fy}, {"x": loop_x, "y": ty}, {"x": tx + 22.0, "y": ty}])
    } else {
        let loop_y = fy.min(ty) - 32.0;
        json!([{"x": fx, "y": fy - 22.0}, {"x": fx, "y": loop_y}, {"x": tx, "y": loop_y}, {"x": tx, "y": ty - 22.0}])
    };
    json!({"id": format!("{from}-{to}"), "points": points})
}

fn main() {
    let mut output = serde_json::Map::new();
    for (id, nodes, edges) in GRAPHS {
        output.insert(
            (*id).to_owned(),
            json!({
                "wide": layout(id, nodes, edges, false),
                "compact": layout(id, nodes, edges, true)
            }),
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&output).expect("layout output serializes")
    );
}
