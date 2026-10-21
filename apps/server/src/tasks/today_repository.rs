use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use rusqlite::{Row, params};

use crate::{
    http::contracts::typed::today::{TodayCompany, TodayResponse, TodaySpend, TodayTask},
    identity::companies,
    platform::database::{DatabaseResult, SuplexDatabase},
    shared::time::rfc3339_millis,
    tasks::{
        analytics::{TaskUsage, usage_metrics},
        control::TaskStatus,
        response,
    },
};

struct TaskRow {
    task: TodayTask,
    archived: bool,
}

fn task_row(row: &Row<'_>) -> DatabaseResult<TaskRow> {
    let company_code: Option<String> = row.get("issue_code")?;
    let issue_number: Option<i64> = row.get("issue_number")?;
    let question = response::task_question(
        row.get("human_question")?,
        row.get("human_question_id")?,
        row.get("limit_pause_json")?,
        row.get("human_question_options_json")?,
        row.get("recovery_turn_id")?,
    )?;
    Ok(TaskRow {
        task: TodayTask {
            task_id: row.get("task_id")?,
            title: row.get("title")?,
            company_id: row.get("company_id")?,
            company_name: row.get("company_name")?,
            project_id: row.get("project_id")?,
            project_name: row.get("project_name")?,
            issue_key: company_code
                .zip(issue_number)
                .map(|(code, number)| format!("{code}-{number}")),
            status: row.get("status")?,
            delivery_target: row.get("delivery_target")?,
            last_updated: row.get("last_updated")?,
            shipped_at: row.get("shipped_at")?,
            human_question: question,
        },
        archived: row.get("archived")?,
    })
}

fn task_rows(
    database: &SuplexDatabase,
    company_ids: &str,
    start: &str,
    end: &str,
) -> DatabaseResult<Vec<TaskRow>> {
    let mut statement = database.connection().prepare(
        r#"SELECT t.id AS task_id,t.title,t.company_id,company.name AS company_name,
        t.project_id,project.name AS project_name,t.issue_number,company.issue_code,
        control.status,control.delivery_target,control.human_question,control.human_question_id,
        control.limit_pause_json,control.human_question_options_json,control.recovery_turn_id,
        CASE WHEN julianday(t.updated_at) >= julianday(control.updated_at) THEN t.updated_at ELSE control.updated_at END AS last_updated,
        CASE WHEN control.status = 'delivered' THEN control.status_changed_at END AS shipped_at,
        t.archived_at IS NOT NULL AS archived
        FROM suplex_tasks t
        JOIN suplex_task_controls control ON control.task_id = t.id
        JOIN suplex_companies company ON company.id = t.company_id
        JOIN suplex_projects project ON project.id = t.project_id
        WHERE t.company_id IN (SELECT value FROM json_each(?1))
          AND (t.archived_at IS NULL OR (control.status = 'delivered' AND julianday(control.status_changed_at) >= julianday(?2) AND julianday(control.status_changed_at) < julianday(?3)))
        ORDER BY julianday(last_updated) DESC,t.id"#,
    )?;
    let mut rows = statement.query(params![company_ids, start, end])?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next()? {
        tasks.push(task_row(row)?);
    }
    Ok(tasks)
}

struct CompanyUsage {
    entries: Vec<TaskUsage>,
    incomplete_coverage: bool,
}

fn weekly_usage(
    database: &SuplexDatabase,
    company_ids: &str,
    start_ms: f64,
    end_ms: f64,
    start: &str,
    end: &str,
) -> DatabaseResult<BTreeMap<String, CompanyUsage>> {
    let mut result = BTreeMap::<String, CompanyUsage>::new();
    let mut statement = database.connection().prepare(
        "SELECT task.company_id,usage.snapshot FROM suplex_task_usage usage JOIN suplex_tasks task ON task.id = usage.task_id WHERE task.company_id IN (SELECT value FROM json_each(?1)) AND CAST(json_extract(usage.snapshot, '$.startedAt') AS REAL) >= ?2 AND CAST(json_extract(usage.snapshot, '$.startedAt') AS REAL) < ?3",
    )?;
    let snapshots = statement
        .query_map(params![company_ids, start_ms, end_ms], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (company_id, snapshot) in snapshots {
        let usage: TaskUsage = serde_json::from_str(&snapshot)?;
        result
            .entry(company_id)
            .or_insert_with(|| CompanyUsage {
                entries: Vec::new(),
                incomplete_coverage: false,
            })
            .entries
            .push(usage);
    }

    let mut statement = database.connection().prepare(
        r#"SELECT task.company_id,session.native_session_id,analytics.observed_at,analytics.error_at
        FROM suplex_task_sessions session
        JOIN suplex_tasks task ON task.id = session.task_id
        LEFT JOIN suplex_task_analytics_sessions analytics ON analytics.session_id = session.id
        WHERE task.company_id IN (SELECT value FROM json_each(?1))
          AND session.native_session_id IS NOT NULL
          AND julianday(session.created_at) < julianday(?3) AND julianday(session.updated_at) >= julianday(?2)"#,
    )?;
    let coverage = statement
        .query_map(params![company_ids, start, end], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (company_id, native, observed, error) in coverage {
        let company = result.entry(company_id).or_insert_with(|| CompanyUsage {
            entries: Vec::new(),
            incomplete_coverage: false,
        });
        company.incomplete_coverage |= native.is_none() || observed.is_none() || error.is_some();
    }
    let mut statement = database.connection().prepare(
        r#"SELECT DISTINCT task.company_id
        FROM suplex_tasks task
        JOIN suplex_task_controls control ON control.task_id = task.id
        WHERE task.company_id IN (SELECT value FROM json_each(?1))
          AND task.archived_at IS NULL AND control.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM suplex_task_sessions session
            JOIN suplex_task_analytics_sessions analytics ON analytics.session_id = session.id
            WHERE session.task_id = task.id AND session.native_session_id IS NOT NULL
              AND julianday(session.created_at) < julianday(?3) AND julianday(session.updated_at) >= julianday(?2)
              AND analytics.observed_at IS NOT NULL AND analytics.error_at IS NULL
          )"#,
    )?;
    let unknown_active_companies = statement
        .query_map(params![company_ids, start, end], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for company_id in unknown_active_companies {
        result
            .entry(company_id)
            .or_insert_with(|| CompanyUsage {
                entries: Vec::new(),
                incomplete_coverage: false,
            })
            .incomplete_coverage = true;
    }
    Ok(result)
}

pub(crate) fn read(
    database: &SuplexDatabase,
    user_id: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    now: DateTime<Utc>,
) -> DatabaseResult<TodayResponse> {
    let visible = companies::list_visible_companies(database, user_id)?;
    let company_ids = serde_json::to_string(
        &visible
            .iter()
            .map(|company| &company.id)
            .collect::<Vec<_>>(),
    )?;
    let starts_at = rfc3339_millis(start);
    let ends_at = rfc3339_millis(end);
    let rows = task_rows(database, &company_ids, &starts_at, &ends_at)?;
    let usage = weekly_usage(
        database,
        &company_ids,
        start.timestamp_millis() as f64,
        end.timestamp_millis() as f64,
        &starts_at,
        &ends_at,
    )?;

    let mut needs_you = Vec::new();
    let mut in_progress = Vec::new();
    let mut shipped_this_week = Vec::new();
    for row in rows {
        let shipped = row.task.status == TaskStatus::Delivered
            && row.task.shipped_at.as_ref().is_some_and(|at| {
                DateTime::parse_from_rfc3339(at).is_ok_and(|time| {
                    let time = time.with_timezone(&Utc);
                    time >= start && time < end
                })
            });
        if !row.archived && row.task.human_question.is_some() {
            needs_you.push(row.task);
        } else if shipped {
            shipped_this_week.push(row.task);
        } else if !row.archived && row.task.status == TaskStatus::Active {
            in_progress.push(row.task);
        }
    }

    let mut spend_by_company = Vec::new();
    for company in &visible {
        let company_usage = usage.get(&company.id);
        let entries = company_usage.map_or(&[][..], |value| value.entries.as_slice());
        let metrics = usage_metrics(entries);
        spend_by_company.push(TodaySpend {
            company_id: company.id.clone(),
            company_name: company.name.clone(),
            known_cost_usd: metrics.cost.or_else(|| {
                (metrics.unpriced_messages == 0
                    && !company_usage.is_some_and(|value| value.incomplete_coverage))
                .then_some(0.0)
            }),
            measured_messages: metrics.measured_messages,
            unpriced_messages: metrics.unpriced_messages,
            partial: metrics.unpriced_messages > 0
                || metrics.incomplete_messages > 0
                || company_usage.is_some_and(|value| value.incomplete_coverage),
            subsidized: metrics.subsidized,
            total_tokens: metrics.total_tokens as u64,
        });
    }

    Ok(TodayResponse {
        generated_at: rfc3339_millis(now),
        week_starts_at: starts_at,
        week_ends_at: ends_at,
        companies: visible
            .into_iter()
            .map(|company| TodayCompany {
                id: company.id,
                name: company.name,
            })
            .collect(),
        needs_you,
        in_progress,
        shipped_this_week,
        spend_by_company,
    })
}
