import { nativeApp } from "../helpers/native-app.js";

const fixture = await nativeApp();
try {
  const now = "2026-09-25T12:00:00.000Z";
  fixture.database.authTransaction(db => {
    db.prepare("INSERT INTO suplex_task_templates (id,project_id,name,configuration_json,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("template_z", fixture.project.id, "Zebra", JSON.stringify({
        name: " Zebra ", description: "  Read source  ",
        advisorProfileIds: { reviewer: "reviewer-profile" },
      }), now, now);
    db.prepare("INSERT INTO suplex_task_templates (id,project_id,name,configuration_json,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("template_a", fixture.project.id, "alpha", JSON.stringify({
        name: "alpha", deliveryTarget: "local_worktree", runProjectTests: false,
      }), now, now);
  });
  const response = await fixture.app.inject({
    url: `/api/projects/${fixture.project.id}/task-templates`, headers: fixture.headers,
  });
  process.stdout.write(JSON.stringify({
    databasePath: fixture.config.databasePath,
    projectId: fixture.project.id,
    cookie: fixture.headers.cookie,
    status: response.statusCode,
    body: JSON.parse(response.body) as unknown,
  }) + "\n");
  await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
} finally {
  await fixture.close();
}
