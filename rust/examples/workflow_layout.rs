//! Regenerate the New Task diagram geometry with:
//! cargo run --manifest-path rust/Cargo.toml --example workflow_layout --quiet > .context/workflow-layouts.json
//! mv .context/workflow-layouts.json src/frontend/features/tasks/workflow-layouts.json
use serde_json::{Value, json};

const GRAPHS: &[(&str, &[&str], &[(&str, &str)])] = &[
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
];

fn layout(id: &str, nodes: &[&str], edges: &[(&str, &str)], compact: bool) -> Value {
    let wide_spacing = match id {
        "standard" | "direct_build" => "140",
        "independent_review" | "refine_pull_request" => "108",
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
        .unwrap()
        .iter()
        .map(|node| {
            json!({
                "id": node["id"], "x": node["x"], "y": node["y"]
            })
        })
        .collect();
    let mut routes: Vec<Value> = result["edges"]
        .as_array()
        .unwrap()
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
            .unwrap();
        let rater = positions.iter().find(|node| node["id"] == "rater").unwrap();
        let px = repair["x"].as_f64().unwrap();
        let py = repair["y"].as_f64().unwrap();
        let rx = rater["x"].as_f64().unwrap();
        let ry = rater["y"].as_f64().unwrap();
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
            .unwrap();
        let coordinator_y = coordinator["y"].as_f64().unwrap();
        let coordinator_right = coordinator["x"].as_f64().unwrap() + 44.0;
        let merge = positions
            .iter_mut()
            .find(|node| node["id"] == "merge")
            .unwrap();
        let merge_x = merge["x"].as_f64().unwrap() + 152.0;
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
                route["id"].as_str().unwrap(),
                "objective-plan-a" | "objective-plan-b" | "plan-a-combine" | "plan-b-combine"
            ) {
                continue;
            }
            let points = route["points"].as_array().unwrap();
            let start = &points[0];
            let end = &points[points.len() - 1];
            let sx = start["x"].as_f64().unwrap();
            let sy = start["y"].as_f64().unwrap();
            let ex = end["x"].as_f64().unwrap();
            let ey = end["y"].as_f64().unwrap();
            let middle = (sx + ex) / 2.0;
            route["points"] = json!([start, {"x": middle, "y": sy}, {"x": middle, "y": ey}, end]);
        }
    }
    if id != "refine_pull_request" {
        let build = positions.iter().find(|node| node["id"] == "build").unwrap();
        let review = positions
            .iter()
            .find(|node| node["id"] == "review")
            .unwrap();
        let bx = build["x"].as_f64().unwrap() + 22.0;
        let by = build["y"].as_f64().unwrap() + 22.0;
        let rx = review["x"].as_f64().unwrap() + 22.0;
        let ry = review["y"].as_f64().unwrap() + 22.0;
        let points = if compact {
            let loop_x = bx.max(rx) + 44.0;
            vec![
                json!({"x": rx + 22.0, "y": ry}),
                json!({"x": loop_x, "y": ry}),
                json!({"x": loop_x, "y": by}),
                json!({"x": bx + 22.0, "y": by}),
            ]
        } else {
            let loop_y = by.min(ry) - 32.0;
            vec![
                json!({"x": rx, "y": ry - 22.0}),
                json!({"x": rx, "y": loop_y}),
                json!({"x": bx, "y": loop_y}),
                json!({"x": bx, "y": by - 22.0}),
            ]
        };
        routes.push(json!({"id": "review-build", "points": points}));
    }
    let width = if id == "refine_pull_request" && !compact {
        json!(result["width"].as_f64().unwrap() + 152.0)
    } else {
        result["width"].clone()
    };
    json!({"width": width, "height": result["height"], "nodes": positions, "edges": routes})
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
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
