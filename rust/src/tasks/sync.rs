//! Live task lists. One thread reads a company's active tasks again when any
//! process commits to the database, and publishes the list to that company's
//! subscribers. A published list is a display observation, not task authority.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::watch;

use super::{repository, response::TaskListItem};
use crate::platform::database::{DatabaseResult, OpenMode, SuplexDatabase};

pub type TaskList = Arc<Vec<TaskListItem>>;

const POLL: Duration = Duration::from_millis(50);

#[derive(Default)]
struct Subscriptions {
    companies: HashMap<String, watch::Sender<Option<TaskList>>>,
    running: bool,
}

pub struct TaskFeed {
    database_path: PathBuf,
    subscriptions: Arc<Mutex<Subscriptions>>,
}

impl TaskFeed {
    pub fn new(database_path: PathBuf) -> Self {
        Self {
            database_path,
            subscriptions: Arc::default(),
        }
    }

    /// The company's active task list, `None` until the first read. The
    /// channel closes when the feed cannot read the database; subscribe again.
    pub fn subscribe(&self, company_id: &str) -> watch::Receiver<Option<TaskList>> {
        let mut subscriptions = self.subscriptions.lock().expect("task feed lock poisoned");
        let receiver = subscriptions
            .companies
            .entry(company_id.to_owned())
            .or_insert_with(|| watch::channel(None).0)
            .subscribe();
        if !subscriptions.running {
            subscriptions.running = true;
            let path = self.database_path.clone();
            let shared = self.subscriptions.clone();
            std::thread::spawn(move || tail(&path, &shared));
        }
        receiver
    }
}

/// Runs while a company has a subscriber. `PRAGMA data_version` changes when
/// another connection commits, in this process or another one.
// ponytail: reads the whole active list on each change, about 1-2 ms at 500
// tasks. Add a trigger-fed set of changed task ids when a company has
// thousands of active tasks.
fn tail(path: &Path, subscriptions: &Mutex<Subscriptions>) {
    let mut database: Option<SuplexDatabase> = None;
    let mut seen_version = None;
    loop {
        let waiting = {
            let mut subscriptions = subscriptions.lock().expect("task feed lock poisoned");
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
                .map(|(id, sender)| (id.clone(), sender.borrow().is_none()))
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
                    .filter(|(_, first)| changed || *first)
                    .filter(|(company_id, _)| publish(open, subscriptions, company_id).is_err())
                    .map(|(company_id, _)| company_id)
                    .collect::<Vec<_>>()
            }
            Err(_) => waiting.into_iter().map(|(id, _)| id).collect(),
        };
        if !failed.is_empty() {
            // Dropping a sender closes its sockets; their clients read over HTTP
            // and connect again.
            let mut subscriptions = subscriptions.lock().expect("task feed lock poisoned");
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

fn publish(
    database: &SuplexDatabase,
    subscriptions: &Mutex<Subscriptions>,
    company_id: &str,
) -> DatabaseResult<()> {
    let tasks = repository::list_active(database, company_id)?;
    let subscriptions = subscriptions.lock().expect("task feed lock poisoned");
    if let Some(sender) = subscriptions.companies.get(company_id) {
        sender.send_if_modified(|current| {
            let same = current.as_ref().is_some_and(|list| **list == tasks);
            if !same {
                *current = Some(Arc::new(tasks));
            }
            !same
        });
    }
    Ok(())
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
include!("../../tests/tasks/sync.rs");
