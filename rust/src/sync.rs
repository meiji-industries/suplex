//! Live company lists and watched task values. One thread reads a company's
//! active tasks, moves, and projects again when any process commits to the
//! database, or when a move run's terminal opens or closes. The same thread
//! reads the stored values of each open task, and starts a thread that reads
//! the task costs again when the stored usage changed. A second thread reads
//! the native runtime values of watched tasks on a timer, because native files
//! report no change. A published value is a display observation, not
//! authority.

use std::{
    collections::{HashMap, HashSet, hash_map::DefaultHasher},
    error::Error,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread::Thread,
    time::Duration,
};

use chrono::Utc;
use serde::Serialize;
use tokio::sync::watch;

use crate::{
    coordination::root_session_store,
    http::{
        contracts::task_reads::{
            TaskActivityResponse, TaskAgents, TaskCost, TaskExecutionResponse,
        },
        contracts::typed::projects::ProjectResponse,
        routes::{task_agents, task_reads},
    },
    moves::{self, MoveResponse},
    platform::database::{DatabaseResult, OpenMode, SuplexDatabase},
    projects::service as projects,
    tasks::{
        analytics, repository,
        response::{TaskListItem, TaskResponse},
        timeline::{self, TimelineResponse},
    },
    terminals::host::HostTerminals,
};

/// What one company's sockets send. A field keeps its allocation while its
/// value does not change, so `Arc::ptr_eq` tells a socket what to skip.
pub struct CompanyLists {
    pub tasks: Arc<Vec<TaskListItem>>,
    pub moves: Arc<Vec<MoveResponse>>,
    /// `None` until the first costs read ends.
    pub costs: Option<Arc<Vec<TaskCost>>>,
    pub projects: Arc<Vec<ProjectResponse>>,
    /// The stored usage that `costs` comes from.
    usage: Option<u64>,
}

pub type Published = Arc<CompanyLists>;

/// What one watch shows. A value keeps its allocation while it does not
/// change, so `Arc::ptr_eq` tells a socket what to skip.
#[derive(Clone, Default)]
pub struct Watched {
    /// The agents of each watched task that the feed could read.
    pub agents: Vec<Arc<TaskAgents>>,
    /// The values of the open task that the feed could read.
    pub open: OpenValues,
}

#[derive(Clone, Default)]
pub struct OpenValues {
    pub task: Option<Arc<TaskResponse>>,
    pub activity: Option<Arc<TaskActivityResponse>>,
    pub execution: Option<Arc<TaskExecutionResponse>>,
    pub timeline: Option<Arc<TimelineResponse>>,
}

const POLL: Duration = Duration::from_millis(50);
/// Agents each pass, the open task's execution and timeline each second pass.
const RUNTIME_POLL: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Subscriptions {
    companies: HashMap<String, watch::Sender<Option<Published>>>,
    running: bool,
    watchers: Vec<Watcher>,
    /// The last values of each watched task.
    tasks: HashMap<String, Observed>,
    /// The thread that reads native runtime values while a socket watches.
    observer: Option<Thread>,
    /// The companies whose costs a thread reads now, and the newest stored
    /// usage the tail saw for each.
    costing: HashMap<String, u64>,
}

struct Watcher {
    agent_task_ids: Vec<String>,
    open_task_id: Option<String>,
    /// `None` until each reader tried every watched value once, so the first
    /// value carries everything the feed could read.
    sender: watch::Sender<Option<Watched>>,
}

#[derive(Default)]
struct Observed {
    agents_read: bool,
    database_read: bool,
    runtime_read: bool,
    /// The task Shell terminal was open when `activity` was read.
    shell_live: bool,
    agents: Option<Arc<TaskAgents>>,
    open: OpenValues,
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
        self.start(&mut subscriptions);
        receiver
    }

    /// The values of the watched tasks. The caller authorizes the ids. Drop
    /// the receiver to stop the watch.
    pub fn watch(
        &self,
        agent_task_ids: Vec<String>,
        open_task_id: Option<String>,
    ) -> watch::Receiver<Option<Watched>> {
        let mut subscriptions = self
            .subscriptions
            .lock()
            .expect("company feed lock poisoned");
        for id in agent_task_ids.iter().chain(&open_task_id) {
            subscriptions.tasks.entry(id.clone()).or_default();
        }
        let (sender, receiver) = watch::channel(None);
        subscriptions.watchers.push(Watcher {
            agent_task_ids,
            open_task_id,
            sender,
        });
        // Another watch can have read every value already.
        publish_watched(&subscriptions);
        self.start(&mut subscriptions);
        receiver
    }

    fn start(&self, subscriptions: &mut Subscriptions) {
        if !subscriptions.running {
            subscriptions.running = true;
            let path = self.database_path.clone();
            let terminals = self.terminals.clone();
            let shared = self.subscriptions.clone();
            std::thread::spawn(move || tail(&path, &terminals, &shared));
        }
        if subscriptions.watchers.is_empty() {
            return;
        }
        // A new watch reads its runtime values now instead of on the next pass.
        match &subscriptions.observer {
            Some(observer) => observer.unpark(),
            None => {
                let path = self.database_path.clone();
                let shared = self.subscriptions.clone();
                let observer = std::thread::spawn(move || observe(&path, &shared));
                subscriptions.observer = Some(observer.thread().clone());
            }
        }
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

/// Drops the watches of closed sockets and the values that no watch shows.
fn forget_unwatched(subscriptions: &mut Subscriptions) {
    subscriptions
        .watchers
        .retain(|watcher| watcher.sender.receiver_count() > 0);
    let watched = subscriptions
        .watchers
        .iter()
        .flat_map(|watcher| watcher.agent_task_ids.iter().chain(&watcher.open_task_id))
        .collect::<HashSet<_>>();
    subscriptions.tasks.retain(|id, _| watched.contains(id));
}

/// The open tasks of every watch.
fn open_ids(subscriptions: &Subscriptions) -> HashSet<String> {
    subscriptions
        .watchers
        .iter()
        .filter_map(|watcher| watcher.open_task_id.clone())
        .collect()
}

pub(crate) fn same<T>(left: &Option<Arc<T>>, right: &Option<Arc<T>>) -> bool {
    left.as_ref().map(Arc::as_ptr) == right.as_ref().map(Arc::as_ptr)
}

/// Sends each watch its values once every reader tried them.
fn publish_watched(subscriptions: &Subscriptions) {
    for watcher in &subscriptions.watchers {
        let tasks = &subscriptions.tasks;
        let agents = watcher
            .agent_task_ids
            .iter()
            .map(|id| tasks.get(id).filter(|task| task.agents_read))
            .collect::<Option<Vec<_>>>();
        let open = match &watcher.open_task_id {
            Some(id) => tasks
                .get(id)
                .filter(|task| task.database_read && task.runtime_read)
                .map(|task| task.open.clone()),
            None => Some(OpenValues::default()),
        };
        let (Some(agents), Some(open)) = (agents, open) else {
            continue;
        };
        let next = Watched {
            agents: agents
                .into_iter()
                .filter_map(|task| task.agents.clone())
                .collect(),
            open,
        };
        watcher.sender.send_if_modified(|current| {
            let modified = current.as_ref().is_none_or(|current| {
                !current
                    .agents
                    .iter()
                    .map(Arc::as_ptr)
                    .eq(next.agents.iter().map(Arc::as_ptr))
                    || !same(&current.open.task, &next.open.task)
                    || !same(&current.open.activity, &next.open.activity)
                    || !same(&current.open.execution, &next.open.execution)
                    || !same(&current.open.timeline, &next.open.timeline)
            });
            if modified {
                *current = Some(next);
            }
            modified
        });
    }
}

/// Runs while a company has a subscriber or a socket watches a task. `PRAGMA
/// data_version` changes when another connection commits, in this process or
/// another one.
// ponytail: reads the whole lists on each change. Measured in a release build
// (`refresh_time_at_scale`): 4 ms at 500 active tasks, 15 ms at 2,000, 39 ms at
// 5,000. Add a trigger-fed set of changed task ids when a company has
// thousands of active tasks.
fn tail(path: &Path, terminals: &HostTerminals, subscriptions: &Arc<Mutex<Subscriptions>>) {
    let mut database: Option<SuplexDatabase> = None;
    let mut seen_version = None;
    loop {
        let (waiting, open) = {
            let mut subscriptions = subscriptions.lock().expect("company feed lock poisoned");
            subscriptions
                .companies
                .retain(|_, sender| sender.receiver_count() > 0);
            forget_unwatched(&mut subscriptions);
            if subscriptions.companies.is_empty() && subscriptions.watchers.is_empty() {
                subscriptions.running = false;
                return;
            }
            let waiting = subscriptions
                .companies
                .iter()
                .map(|(id, sender)| {
                    let stale = sender
                        .borrow()
                        .as_ref()
                        .is_none_or(|lists| runs_moved(terminals, &lists.moves));
                    (id.clone(), stale)
                })
                .collect::<Vec<_>>();
            let open = open_ids(&subscriptions)
                .into_iter()
                .filter_map(|id| {
                    let task = subscriptions.tasks.get(&id)?;
                    // The Shell terminal registry is in memory, so no commit
                    // reports that the task Shell opened or closed.
                    let stale = !task.database_read
                        || task.shell_live != terminals.contains(&crate::terminals::shell_id(&id));
                    Some((id, stale, task.open.clone()))
                })
                .collect::<Vec<_>>();
            (waiting, open)
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
            Ok((database, version)) => {
                let changed = seen_version != Some(version);
                seen_version = Some(version);
                let host = crate::terminals::host_enabled(database);
                let stored = open
                    .into_iter()
                    .filter(|(_, stale, _)| changed || *stale)
                    .map(|(id, _, previous)| {
                        let shell_live = terminals.contains(&crate::terminals::shell_id(&id));
                        let task = repository::task_response(database, &id).ok().flatten();
                        let activity = root_session_store::root_observation_rows(database, &id)
                            .ok()
                            .map(|rows| {
                                task_reads::activity_document(
                                    database,
                                    &rows,
                                    &id,
                                    host.then_some(terminals),
                                )
                            });
                        let task = kept_json(previous.task, task);
                        let activity = kept_json(previous.activity, activity);
                        (id, shell_live, task, activity)
                    })
                    .collect::<Vec<_>>();
                if !stored.is_empty() {
                    let mut subscriptions =
                        subscriptions.lock().expect("company feed lock poisoned");
                    for (id, shell_live, task, activity) in stored {
                        if let Some(observed) = subscriptions.tasks.get_mut(&id) {
                            observed.database_read = true;
                            observed.shell_live = shell_live;
                            observed.open.task = task;
                            observed.open.activity = activity;
                        }
                    }
                    publish_watched(&subscriptions);
                }
                waiting
                    .into_iter()
                    .filter(|(_, stale)| changed || *stale)
                    .filter(|(company_id, _)| {
                        publish(database, path, terminals, subscriptions, company_id).is_err()
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

/// Runs while a socket watches a task. Native runtime files report no change,
/// so this thread reads them again on a timer, apart from the database pushes.
// ponytail: parses the native files again on each pass even when they did not
// change. The readers resolve their own paths; cache by file time if this
// shows up in a profile.
fn observe(path: &Path, subscriptions: &Mutex<Subscriptions>) {
    let mut database: Option<SuplexDatabase> = None;
    for pass in 0_u64.. {
        let (agents, open) = {
            let mut subscriptions = subscriptions.lock().expect("company feed lock poisoned");
            forget_unwatched(&mut subscriptions);
            if subscriptions.watchers.is_empty() {
                subscriptions.observer = None;
                return;
            }
            let agents = subscriptions
                .watchers
                .iter()
                .flat_map(|watcher| &watcher.agent_task_ids)
                .collect::<HashSet<_>>()
                .into_iter()
                .filter_map(|id| Some((id.clone(), subscriptions.tasks.get(id)?.agents.clone())))
                .collect::<Vec<_>>();
            let open = open_ids(&subscriptions)
                .into_iter()
                .filter_map(|id| {
                    let task = subscriptions.tasks.get(&id)?;
                    (pass % 2 == 0 || !task.runtime_read).then(|| (id, task.open.clone()))
                })
                .collect::<Vec<_>>();
            (agents, open)
        };
        let opened = match &database {
            Some(open) => Ok(open),
            None => SuplexDatabase::open(path, OpenMode::ReadOnly)
                .map(|opened| &*database.insert(opened)),
        };
        // The tail closes the sockets when the database cannot be read.
        if let Ok(database) = opened {
            let host = crate::terminals::host_enabled(database);
            let agents = agents
                .into_iter()
                .map(|(id, previous)| {
                    let next = task_agents::saved_task(database, &id)
                        .ok()
                        .map(|task| task_agents::agents(&task, path, host));
                    let next = match (previous, next) {
                        (Some(previous), Some(next)) if *previous == next => Some(previous),
                        (previous, next) => next.map(Arc::new).or(previous),
                    };
                    (id, next)
                })
                .collect::<Vec<_>>();
            let open = open
                .into_iter()
                .map(|(id, previous)| {
                    let execution = root_session_store::root_observation_rows(database, &id)
                        .ok()
                        .and_then(|rows| task_reads::execution_document(&rows, path).ok());
                    let timeline = timeline::read_saved(database, &id)
                        .ok()
                        .flatten()
                        .and_then(|saved| timeline::observe(path, saved).ok());
                    let execution = kept_json(previous.execution, execution);
                    let timeline = kept_json(previous.timeline, timeline);
                    (id, execution, timeline)
                })
                .collect::<Vec<_>>();
            let mut subscriptions = subscriptions.lock().expect("company feed lock poisoned");
            for (id, next) in agents {
                if let Some(observed) = subscriptions.tasks.get_mut(&id) {
                    observed.agents_read = true;
                    observed.agents = next;
                }
            }
            for (id, execution, timeline) in open {
                if let Some(observed) = subscriptions.tasks.get_mut(&id) {
                    observed.runtime_read = true;
                    observed.open.execution = execution;
                    observed.open.timeline = timeline;
                }
            }
            publish_watched(&subscriptions);
        }
        std::thread::park_timeout(RUNTIME_POLL);
    }
}

/// The previous allocation when the value did not change.
fn kept<T: PartialEq>(previous: Option<&Arc<T>>, next: T) -> Arc<T> {
    match previous {
        Some(previous) if **previous == next => previous.clone(),
        _ => Arc::new(next),
    }
}

/// The previous allocation when the value serializes the same, and the
/// previous value when the read failed. Most responses have no `PartialEq`.
fn kept_json<T: Serialize>(previous: Option<Arc<T>>, next: Option<T>) -> Option<Arc<T>> {
    match (previous, next) {
        (Some(previous), Some(next))
            if serde_json::to_vec(&*previous).ok() == serde_json::to_vec(&next).ok() =>
        {
            Some(previous)
        }
        (previous, next) => next.map(Arc::new).or(previous),
    }
}

fn publish(
    database: &SuplexDatabase,
    path: &Path,
    terminals: &HostTerminals,
    shared: &Arc<Mutex<Subscriptions>>,
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
    // A project that cannot be read fails `GET /api/companies/{id}/projects`
    // too. Keep the previous projects, so tasks and moves still arrive.
    let projects = projects::list_company(database, company_id)
        .ok()
        .map(|list| list.iter().map(projects::response_project).collect());
    let usage = usage_state(database, company_id)?;
    let mut subscriptions = shared.lock().expect("company feed lock poisoned");
    let Some(sender) = subscriptions.companies.get(company_id) else {
        return Ok(());
    };
    sender.send_if_modified(|current| {
        let previous = current.as_deref();
        let next = CompanyLists {
            tasks: kept(previous.map(|lists| &lists.tasks), tasks),
            moves: kept(previous.map(|lists| &lists.moves), moves),
            costs: previous.and_then(|lists| lists.costs.clone()),
            projects: kept_json(previous.map(|lists| lists.projects.clone()), projects)
                .unwrap_or_default(),
            usage: previous.and_then(|lists| lists.usage),
        };
        let modified = previous.is_none_or(|lists| {
            !Arc::ptr_eq(&lists.tasks, &next.tasks)
                || !Arc::ptr_eq(&lists.moves, &next.moves)
                || !Arc::ptr_eq(&lists.projects, &next.projects)
        });
        if modified {
            *current = Some(Arc::new(next));
        }
        modified
    });
    let costs_usage = sender.borrow().as_ref().and_then(|lists| lists.usage);
    // The costs read the whole company's analytics: only after the stored
    // usage changed, and on their own thread, so no push waits for them.
    match subscriptions.costing.get_mut(company_id) {
        // The running read reads again for the newest usage when it ends.
        Some(newest) => *newest = usage,
        None if costs_usage != Some(usage) => {
            subscriptions.costing.insert(company_id.to_owned(), usage);
            let (path, shared, company_id) =
                (path.to_owned(), shared.clone(), company_id.to_owned());
            std::thread::spawn(move || read_costs(&path, &shared, &company_id));
        }
        None => {}
    }
    Ok(())
}

/// Reads a company's costs until they come from the newest stored usage the
/// tail saw.
// ponytail: reads every task of the company again: 0.08 s at 500 tasks, 0.33 s
// at 2,000, 0.8 s at 5,000 (release build). Read only the tasks whose usage
// changed when costs must arrive sooner.
fn read_costs(path: &Path, subscriptions: &Mutex<Subscriptions>, company_id: &str) {
    let database = SuplexDatabase::open(path, OpenMode::ReadOnly).ok();
    loop {
        let Some(&usage) = subscriptions
            .lock()
            .expect("company feed lock poisoned")
            .costing
            .get(company_id)
        else {
            return;
        };
        // A failed read keeps the previous costs.
        let costs = database.as_ref().and_then(|database| {
            analytics::company_analytics(database, company_id, Utc::now())
                .and_then(|value| analytics::task_costs(&value))
                .ok()
        });
        let mut subscriptions = subscriptions.lock().expect("company feed lock poisoned");
        if let Some(sender) = subscriptions.companies.get(company_id) {
            sender.send_if_modified(|current| {
                let Some(lists) = current.as_deref() else {
                    return false;
                };
                let costs = match costs {
                    Some(costs) => Some(kept(lists.costs.as_ref(), costs.tasks)),
                    None => lists.costs.clone(),
                };
                let modified = !same(&lists.costs, &costs);
                *current = Some(Arc::new(CompanyLists {
                    tasks: lists.tasks.clone(),
                    moves: lists.moves.clone(),
                    costs,
                    projects: lists.projects.clone(),
                    usage: Some(usage),
                }));
                modified
            });
        }
        // A company without sockets needs no costs.
        if !subscriptions.companies.contains_key(company_id)
            || subscriptions.costing.get(company_id) == Some(&usage)
        {
            subscriptions.costing.remove(company_id);
            return;
        }
    }
}

/// Every stored value the task costs of a company read, hashed. The feed only
/// compares it with the previous one.
// ponytail: reads every usage snapshot of the company on each commit. Add a
// usage revision column when a company holds more usage than one read per
// commit can carry.
fn usage_state(database: &SuplexDatabase, company_id: &str) -> DatabaseResult<u64> {
    let mut statement = database.connection().prepare(
        "SELECT t.id FROM suplex_tasks t WHERE t.company_id = ?1
         UNION ALL SELECT u.snapshot FROM suplex_task_usage u JOIN suplex_tasks t ON t.id = u.task_id WHERE t.company_id = ?1
         UNION ALL SELECT s.session_id || (s.observed_at IS NULL) || (s.error_at IS NULL) FROM suplex_task_analytics_sessions s JOIN suplex_tasks t ON t.id = s.task_id WHERE t.company_id = ?1
         UNION ALL SELECT s.id FROM suplex_task_sessions s JOIN suplex_tasks t ON t.id = s.task_id WHERE t.company_id = ?1 AND s.native_session_id IS NOT NULL",
    )?;
    let mut rows = statement.query([company_id])?;
    let mut hasher = DefaultHasher::new();
    while let Some(row) = rows.next()? {
        row.get_ref(0)?.as_bytes_or_null()?.hash(&mut hasher);
    }
    Ok(hasher.finish())
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
