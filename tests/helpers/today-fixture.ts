import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import type { nativeFixture } from "./native-browser.js";

type NativeFixture = Awaited<ReturnType<typeof nativeFixture>>;
type Row = Record<string, SQLOutputValue>;

function cloneRow(database: DatabaseSync, table: string, sourceColumn: string, sourceValue: string, overrides: Row): void {
  const source = database.prepare(`SELECT * FROM ${table} WHERE ${sourceColumn} = ?`).get(sourceValue);
  if (!source) throw new Error(`Fixture source row is missing from ${table}`);
  const row = { ...source, ...overrides };
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(",");
  const values = columns.map(column => {
    const value = row[column];
    if (value === undefined) throw new Error(`Fixture column ${column} is missing from ${table}`);
    return value;
  });
  database.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`).run(...values);
}

export async function seedTodayFixture(fixture: NativeFixture) {
  const template = await fixture.createTask({ title: "Northwind question", description: "Choose the release branch.", startImmediately: false, idempotencyKey: "today-template" });
  const now = new Date();
  const monday = new Date(now);
  const day = monday.getDay();
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(12, 0, 0, 0);
  const current = monday.toISOString();
  const prior = new Date(monday.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const companies = [
    { id: fixture.company.id, name: "Northwind" },
    { id: "company_today_contoso", name: "Contoso" },
    { id: "company_today_fabrikam", name: "Fabrikam" },
  ];
  const projects = [
    { id: fixture.project.id, companyId: companies[0]!.id, name: "Northwind web" },
    { id: "project_today_contoso", companyId: companies[1]!.id, name: "Contoso portal" },
    { id: "project_today_fabrikam", companyId: companies[2]!.id, name: "Fabrikam API" },
  ];
  const questionTasks = [
    { id: template.id, companyId: companies[0]!.id, companyName: companies[0]!.name, projectId: projects[0]!.id, title: "Northwind question", questionId: "today-question-northwind" },
    { id: "task_today_contoso_question", companyId: companies[1]!.id, companyName: companies[1]!.name, projectId: projects[1]!.id, title: "Contoso question", questionId: "today-question-contoso" },
    { id: "task_today_fabrikam_question", companyId: companies[2]!.id, companyName: companies[2]!.name, projectId: projects[2]!.id, title: "Fabrikam question", questionId: "today-question-fabrikam" },
  ];
  const database = fixture.database;
  database.exec("BEGIN");
  try {
    database.prepare("UPDATE suplex_companies SET name = ? WHERE id = ?").run(companies[0]!.name, companies[0]!.id);
    for (const company of companies.slice(1)) {
      database.prepare("INSERT INTO suplex_companies (id,name,status,created_at) VALUES (?,?,'active',?)").run(company.id, company.name, current);
    }
    for (const [index, project] of projects.slice(1).entries()) {
      cloneRow(database, "suplex_projects", "id", fixture.project.id, {
        id: project.id, company_id: project.companyId, name: project.name,
        repository_path: `${fixture.project.repositoryPath}-${index + 2}`,
        worktree_root: `${fixture.project.worktreeRoot}-${index + 2}`,
        repository_identity: `owner/repo-${index + 2}`,
      });
    }
    const issueNumbers = new Map<string, number>([[companies[0]!.id, 1]]);
    const cloneTask = (id: string, companyId: string, projectId: string, title: string): void => {
      const issueNumber = (issueNumbers.get(companyId) ?? 0) + 1;
      issueNumbers.set(companyId, issueNumber);
      cloneRow(database, "suplex_tasks", "id", template.id, { id, company_id: companyId, project_id: projectId, title, issue_number: issueNumber, idempotency_key: id, request_hash: id });
      cloneRow(database, "suplex_task_controls", "task_id", template.id, { task_id: id });
    };
    const clearQuestion = (taskId: string, status: "active" | "delivered"): void => {
      database.prepare("UPDATE suplex_task_controls SET status=?,human_question=NULL,human_question_id=NULL,human_question_options_json='[]',limit_pause_json=NULL,recovery_turn_id=NULL,root_session_id=NULL,wake_at='2999-01-01T00:00:00.000Z' WHERE task_id=?").run(status, taskId);
    };
    for (const task of questionTasks.slice(1)) cloneTask(task.id, task.companyId, task.projectId, task.title);
    for (const task of questionTasks) {
      const sessionId = `session_${task.id}`;
      database.prepare("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at,profile_json) VALUES (?,?,'root',1,1,'reserved',?,?,?)")
        .run(sessionId, task.id, current, current, JSON.stringify(template.rootProfile));
      database.prepare("UPDATE suplex_task_controls SET status='waiting_human',status_changed_at=?,updated_at=?,root_session_id=?,human_question='Which branch should Suplex use?',human_question_id=?,human_question_options_json=? WHERE task_id=?")
        .run(current, current, sessionId, task.questionId, JSON.stringify([{ label: "Main", description: "Use the main branch.", recommended: true }]), task.id);
    }
    for (const [index, project] of projects.entries()) {
      const activeId = `task_today_active_${index}`;
      cloneTask(activeId, project.companyId, project.id, `${companies[index]!.name} active work`);
      clearQuestion(activeId, "active");
      database.prepare("UPDATE suplex_task_controls SET status_changed_at=?,updated_at=? WHERE task_id=?").run(current, current, activeId);
      const deliveredId = `task_today_delivered_${index}`;
      cloneTask(deliveredId, project.companyId, project.id, `${companies[index]!.name} delivered work`);
      clearQuestion(deliveredId, "delivered");
      database.prepare("UPDATE suplex_task_controls SET delivery_target=? WHERE task_id=?").run(index === 0 ? "local_worktree" : index === 1 ? "pull_request_draft" : "merged", deliveredId);
      database.prepare("UPDATE suplex_task_controls SET status_changed_at=?,updated_at=? WHERE task_id=?").run(current, current, deliveredId);
    }
    cloneTask("task_today_archived", companies[1]!.id, projects[1]!.id, "Contoso archived delivery");
    clearQuestion("task_today_archived", "delivered");
    database.prepare("UPDATE suplex_task_controls SET delivery_target='pull_request_ready' WHERE task_id='task_today_archived'").run();
    database.prepare("UPDATE suplex_task_controls SET status_changed_at=?,updated_at=? WHERE task_id='task_today_archived'").run(current, current);
    database.prepare("UPDATE suplex_tasks SET archived_at=? WHERE id='task_today_archived'").run(current);
    cloneTask("task_today_prior", companies[2]!.id, projects[2]!.id, "Fabrikam prior delivery");
    clearQuestion("task_today_prior", "delivered");
    database.prepare("UPDATE suplex_task_controls SET status_changed_at=?,updated_at=? WHERE task_id='task_today_prior'").run(prior, prior);
    const usage = (sessionId: string, messageId: string, cost: number, tokens: number, subsidized = false) => JSON.stringify({ sessionId, messageId, turnId: messageId, role: "root", provider: "codex", model: "fixture", startedAt: monday.getTime(), completedAt: monday.getTime() + 1000, failed: false, summary: false, steps: 1, cost, subsidized, tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "fixture" });
    database.prepare("INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?,?,?,?,?)").run("task_today_active_0", "usage-known", "known", usage("usage-known", "known", 2.5, 100), current);
    database.prepare("INSERT INTO suplex_task_usage (task_id,session_id,message_id,snapshot,observed_at) VALUES (?,?,?,?,?)").run("task_today_active_1", "usage-partial", "partial", usage("usage-partial", "partial", 0, 100), current);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { companies, questionTasks };
}
