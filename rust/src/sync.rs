//! Live company lists. One thread reads a company's active tasks, moves, and
//! project state again when any process commits to the database, or when a
//! move run's terminal opens or closes. It publishes the result to that
//! company's subscribers. A published list is a display observation, not
//! authority.

use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::watch;

use crate::{
    moves::{self, MoveResponse},
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    projects::service as projects,
    tasks::{repository, response::TaskListItem},
    terminals::host::HostTerminals,
};

/// What one company's sockets send. A field keeps its allocation while its
/// value does not change, so `Arc::ptr_eq` tells a socket what to skip.
pub struct CompanyLists {
    pub tasks: Arc<Vec<TaskListItem>>,
    pub moves: Arc<Vec<MoveResponse>>,
    /// Changes when a project of the company changes. The client reads
    /// projects over HTTP.
    pub projects: Arc<String>,
}

pub type Published = Arc<CompanyLists>;

const POLL: Duration = Duration::from_millis(50);

#[derive(Default)]
struct Subscriptions {
    companies: HashMap<String, watch::Sender<Option<Published>>>,
    running: bool,
}

pub struct CompanyFeed {
    database_path: PathBuf,
    terminals: Arc<HostTerminals>,
    subscriptions: Arc<Mutex<Subscriptions>>,
}

impl CompanyFeed {
    pub fn new(database_path: PathBuf, terminals: Arc<HostTerminals>) -> Self {
        Self {
            database_path,
            terminals,
            subscriptions: Arc::default(),
        }
    }

    /// The same database with another terminal registry.
    pub fn with_terminals(&self, terminals: Arc<HostTerminals>) -> Self {
        Self::new(self.database_path.clone(), terminals)
    }

    /// The company's lists, `None` until the first read. The channel closes
    /// when the feed cannot read the database; subscribe again.
    pub fn subscribe(&self, company_id: &str) -> watch::Receiver<Option<Published>> {
        let mut subscriptions = self
            .subscriptions
            .lock()
            .expect("company feed lock poisoned");
        let receiver = subscriptions
            .companies
            .entry(company_id.to_owned())
            .or_insert_with(|| watch::channel(None).0)
            .subscribe();
        if !subscriptions.running {
            subscriptions.running = true;
            let path = self.database_path.clone();
            let terminals = self.terminals.clone();
            let shared = self.subscriptions.clone();
            std::thread::spawn(move || tail(&path, &terminals, &shared));
        }
        receiver
    }
}

/// A run's terminal opened or closed after the list was published. The
/// terminal registry is in memory, so no commit reports the change.
fn runs_moved(terminals: &HostTerminals, moves: &[MoveResponse]) -> bool {
    moves
        .iter()
        .filter_map(|item| item.last_run.as_ref())
        .any(|run| run.live != terminals.contains(&moves::shell::terminal_id(&run.id)))
}

/// Runs while a company has a subscriber. `PRAGMA data_version` changes when
/// another connection commits, in this process or another one.
// ponytail: reads the whole lists on each change, about 1-2 ms at 500 tasks.
// Add a trigger-fed set of changed task ids when a company has thousands of
// active tasks.
fn tail(path: &Path, terminals: &HostTerminals, subscriptions: &Mutex<Subscriptions>) {
    let mut database: Option<SuplexDatabase> = None;
    let mut seen_version = None;
    loop {
        let waiting = {
            let mut subscriptions = subscriptions.lock().expect("company feed lock poisoned");
            subscriptions
                .companies
                .retain(|_, sender| sender.receiver_count() > 0);
            if subscriptions.companies.is_empty() {
                subscriptions.running = false;
                return;
            }
            subscriptions
                .companies
                .iter()
                .map(|(id, sender)| {
                    let stale = sender
                        .borrow()
                        .as_ref()
                        .is_none_or(|lists| runs_moved(terminals, &lists.moves));
                    (id.clone(), stale)
                })
                .collect::<Vec<_>>()
        };
        // Read the version before the lists: a commit between the two reads
        // causes one more read, never a missed change.
        let read = match &database {
            Some(open) => Ok(open),
            None => SuplexDatabase::open(path, OpenMode::ReadOnly)
                .map(|opened| &*database.insert(opened)),
        }
        .and_then(|open| Ok((open, data_version(open)?)));
        let failed = match read {
            Ok((open, version)) => {
                let changed = seen_version != Some(version);
                seen_version = Some(version);
                waiting
                    .into_iter()
                    .filter(|(_, stale)| changed || *stale)
                    .filter(|(company_id, _)| {
                        publish(open, terminals, subscriptions, company_id).is_err()
                    })
                    .map(|(company_id, _)| company_id)
                    .collect::<Vec<_>>()
            }
            Err(_) => waiting.into_iter().map(|(id, _)| id).collect(),
        };
        if !failed.is_empty() {
            // Dropping a sender closes its sockets; their clients read over HTTP
            // and connect again.
            let mut subscriptions = subscriptions.lock().expect("company feed lock poisoned");
            for company_id in &failed {
                subscriptions.companies.remove(company_id);
            }
            database = None;
            seen_version = None;
        }
        std::thread::sleep(POLL);
    }
}

fn data_version(database: &SuplexDatabase) -> DatabaseResult<i64> {
    Ok(database
        .connection()
        .query_row("PRAGMA data_version", [], |row| row.get(0))?)
}

/// The previous allocation when the value did not change.
fn kept<T: PartialEq>(previous: Option<&Arc<T>>, next: T) -> Arc<T> {
    match previous {
        Some(previous) if **previous == next => previous.clone(),
        _ => Arc::new(next),
    }
}

fn publish(
    database: &SuplexDatabase,
    terminals: &HostTerminals,
    subscriptions: &Mutex<Subscriptions>,
    company_id: &str,
) -> Result<(), Box<dyn Error>> {
    let tasks = repository::list_active(database, company_id)?;
    let mut moves = moves::list_company(database, company_id)?;
    for item in &mut moves {
        item.last_run = item
            .last_run
            .take()
            .map(|run| moves::observed(terminals, run));
    }
    let projects = project_state(database, company_id)?;
    let subscriptions = subscriptions.lock().expect("company feed lock poisoned");
    if let Some(sender) = subscriptions.companies.get(company_id) {
        sender.send_if_modified(|current| {
            let previous = current.as_deref();
            let next = CompanyLists {
                tasks: kept(previous.map(|lists| &lists.tasks), tasks),
                moves: kept(previous.map(|lists| &lists.moves), moves),
                projects: kept(previous.map(|lists| &lists.projects), projects),
            };
            let same = previous.is_some_and(|lists| {
                Arc::ptr_eq(&lists.tasks, &next.tasks)
                    && Arc::ptr_eq(&lists.moves, &next.moves)
                    && Arc::ptr_eq(&lists.projects, &next.projects)
            });
            if !same {
                *current = Some(Arc::new(next));
            }
            !same
        });
    }
    Ok(())
}

/// Every stored value the project responses of a company read. The feed only
/// compares it with the previous one.
// ponytail: projects travel over HTTP after this value changes, because the
// project response has no generated browser type. Publish the projects here
// when it has one.
fn project_state(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<String> {
    let mut statement = database
        .connection()
        .prepare(&projects::company_selection())?;
    let columns = statement.column_count();
    let mut rows = statement.query([company_id])?;
    let mut state = String::new();
    while let Some(row) = rows.next()? {
        for column in 0..columns {
            write!(state, "{:?}\u{1f}", row.get_ref(column)?)?;
        }
        state.push('\n');
    }
    Ok(state)
}

/// The tasks of `next` that `previous` lacks or holds with other values, and
/// the ids only `previous` holds.
pub fn diff(previous: &[TaskListItem], next: &[TaskListItem]) -> (Vec<TaskListItem>, Vec<String>) {
    let before = previous
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<HashMap<_, _>>();
    let changed = next
        .iter()
        .filter(|task| before.get(task.id.as_str()) != Some(task))
        .cloned()
        .collect();
    let after = next
        .iter()
        .map(|task| task.id.as_str())
        .collect::<HashSet<_>>();
    let removed = previous
        .iter()
        .filter(|task| !after.contains(task.id.as_str()))
        .map(|task| task.id.clone())
        .collect();
    (changed, removed)
}

#[cfg(test)]
include!("../tests/sync/feed.rs");
