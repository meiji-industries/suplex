import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

test.each([
  { file: "20260928151155776_rename_review_and_repair.sql", id: "workflow_native_refine_pull_request", before: "Pull request repair", after: "Review and repair" },
  { file: "20260928151659229_rename_plan_and_build.sql", id: "workflow_native_standard", before: "Standard", after: "Plan and build" },
])("$after renames the default without replacing custom names", ({ file, id, before, after }) => {
  const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE suplex_workflows (id TEXT PRIMARY KEY, name TEXT UNIQUE)");
    const insert = database.prepare("INSERT INTO suplex_workflows VALUES (?, ?)");
    insert.run(id, before);
    const name = () => database.prepare("SELECT name FROM suplex_workflows WHERE id = ?").get(id)?.name;
    database.exec(sql);
    expect(name()).toBe(after);
    database.exec("UPDATE suplex_workflows SET name = 'My workflow'");
    database.exec(sql);
    expect(name()).toBe("My workflow");
    database.prepare("UPDATE suplex_workflows SET name = ?").run(before);
    insert.run("custom", after);
    database.exec(sql);
    expect(name()).toBe(before);
  } finally { database.close(); }
});

test("double plans and double reviews preserve custom names", () => {
  const sql = readFileSync(new URL("../migrations/20260928150834180_rename_double_plans_and_reviews.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE suplex_workflows (id TEXT PRIMARY KEY, name TEXT UNIQUE); INSERT INTO suplex_workflows VALUES ('workflow_native_competing_plans', 'Extra plan'), ('workflow_native_independent_review', 'Extra review')");
    database.exec(sql);
    const names = () => database.prepare("SELECT name FROM suplex_workflows ORDER BY id").all().map(row => row.name);
    expect(names()).toEqual(["Double plans", "Double reviews"]);
    database.exec("UPDATE suplex_workflows SET name = 'My plans' WHERE id = 'workflow_native_competing_plans'; UPDATE suplex_workflows SET name = 'Extra review' WHERE id = 'workflow_native_independent_review'; INSERT INTO suplex_workflows VALUES ('custom', 'Double reviews')");
    database.exec(sql);
    expect(names()).toEqual(["Double reviews", "My plans", "Extra review"]);
  } finally { database.close(); }
});

test("simple task and extra plan rename only the matching built-in presets", () => {
  const sql = readFileSync(new URL("../migrations/20260928150652933_rename_simple_task_and_extra_plan.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE suplex_workflows (id TEXT PRIMARY KEY, name TEXT UNIQUE)");
    const insert = database.prepare("INSERT INTO suplex_workflows VALUES (?, ?)");
    insert.run("workflow_native_direct_build", "Just build");
    insert.run("workflow_native_competing_plans", "Combined planning");
    database.exec(sql);
    const names = () => database.prepare("SELECT name FROM suplex_workflows ORDER BY id").all().map(row => row.name);
    expect(names()).toEqual(["Extra plan", "Simple task"]);
    database.exec("UPDATE suplex_workflows SET name = 'My build' WHERE id = 'workflow_native_direct_build'; UPDATE suplex_workflows SET name = 'Combined planning' WHERE id = 'workflow_native_competing_plans'");
    insert.run("custom", "Extra plan");
    database.exec(sql);
    expect(names()).toEqual(["Extra plan", "Combined planning", "My build"]);
  } finally { database.close(); }
});

test("workflow names update defaults while preserving custom names and collisions", () => {
  const sql = readFileSync(new URL("../migrations/20260928145859109_rename_build_and_review_workflows.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE suplex_workflows (id TEXT PRIMARY KEY, name TEXT UNIQUE)");
    const insert = database.prepare("INSERT INTO suplex_workflows VALUES (?, ?)");
    insert.run("workflow_native_direct_build", "Direct build");
    insert.run("workflow_native_independent_review", "Second opinion");
    database.exec(sql);
    const names = () => database.prepare("SELECT name FROM suplex_workflows ORDER BY id").all().map(row => row.name);
    expect(names()).toEqual(["Just build", "Extra review"]);
    database.exec("UPDATE suplex_workflows SET name = 'My build' WHERE id = 'workflow_native_direct_build'; UPDATE suplex_workflows SET name = 'Second opinion' WHERE id = 'workflow_native_independent_review'");
    insert.run("custom", "Extra review");
    database.exec(sql);
    expect(names()).toEqual(["Extra review", "My build", "Second opinion"]);
  } finally { database.close(); }
});
