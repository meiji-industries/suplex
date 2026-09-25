use crate::shared::hash::sha256_hex;
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt, fs,
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    path::Path,
    time::Duration,
};

use chrono::NaiveDateTime;
use rusqlite::{Connection, OpenFlags, params};

use super::embedded::{EmbeddedFile, MIGRATIONS};

pub type DatabaseResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenMode {
    Migrate,
    ReadWrite,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchemaState {
    Current,
    Behind,
    Ahead,
    Partial,
    Corrupt,
    Locked,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Migration {
    pub tag: String,
    pub hash: String,
    pub created_at: i64,
}

#[derive(Debug)]
pub struct SchemaStatus {
    pub state: SchemaState,
    pub expected: Vec<Migration>,
    pub applied: Vec<Migration>,
    pub wal_mode: bool,
}

#[derive(Debug)]
pub struct DatabaseHealth {
    pub wal_mode: bool,
    pub schema_state: SchemaState,
    pub expected_migrations: usize,
    pub applied_migrations: usize,
    pub readable: bool,
    pub writable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepositoryIdentityCollision {
    pub project_id: String,
    pub company_id: String,
    pub repository_identity: String,
}

#[derive(Debug)]
pub struct DatabaseMigrationFailure(pub Vec<RepositoryIdentityCollision>);

impl fmt::Display for DatabaseMigrationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Project repository identities must be unique before migrations can continue"
        )
    }
}
impl Error for DatabaseMigrationFailure {}

pub struct SuplexDatabase {
    connection: Connection,
    mode: OpenMode,
    callbacks: Vec<Vec<Box<dyn FnOnce() + Send>>>,
    deferred_callbacks: Option<Vec<Box<dyn FnOnce() + Send>>>,
}

impl SuplexDatabase {
    pub fn open(filename: &Path, mode: OpenMode) -> DatabaseResult<Self> {
        if mode == OpenMode::Migrate {
            fs::create_dir_all(filename.parent().ok_or("database path has no parent")?)?;
        }
        let flags = match mode {
            OpenMode::Migrate => OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
            OpenMode::ReadWrite => OpenFlags::SQLITE_OPEN_READ_WRITE,
            OpenMode::ReadOnly => OpenFlags::SQLITE_OPEN_READ_ONLY,
        };
        let connection = Connection::open_with_flags(filename, flags)?;
        connection.busy_timeout(Duration::from_millis(5_000))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;")?;
        if mode != OpenMode::ReadOnly {
            connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")?;
        }
        let mut database = Self {
            connection,
            mode,
            callbacks: Vec::new(),
            deferred_callbacks: None,
        };
        if mode == OpenMode::Migrate {
            database.preflight_repository_identities()?;
            database.apply_migrations()?;
        }
        Ok(database)
    }

    pub fn mode(&self) -> OpenMode {
        self.mode
    }
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn transaction<T>(
        &mut self,
        immediate: bool,
        operation: impl FnOnce(&mut Self) -> DatabaseResult<T>,
    ) -> DatabaseResult<T> {
        let depth = self.callbacks.len();
        let savepoint = format!("suplex_nested_{depth}");
        let begin = if depth == 0 {
            if immediate {
                "BEGIN IMMEDIATE"
            } else {
                "BEGIN"
            }
            .to_owned()
        } else {
            format!("SAVEPOINT {savepoint}")
        };
        self.connection.execute_batch(&begin)?;
        self.callbacks.push(Vec::new());
        let result = catch_unwind(AssertUnwindSafe(|| operation(self)));
        let finish = if depth == 0 {
            "COMMIT".to_owned()
        } else {
            format!("RELEASE SAVEPOINT {savepoint}")
        };
        match result {
            Ok(Ok(value)) => match self.connection.execute_batch(&finish) {
                Ok(()) => {
                    let callbacks = self.callbacks.pop().expect("transaction callbacks");
                    if let Some(parent) = self.callbacks.last_mut() {
                        parent.extend(callbacks);
                    } else if let Some(deferred) = self.deferred_callbacks.as_mut() {
                        deferred.extend(callbacks);
                    } else {
                        for callback in callbacks {
                            let _ = catch_unwind(AssertUnwindSafe(callback));
                        }
                    }
                    Ok(value)
                }
                Err(error) => {
                    self.rollback(depth, &savepoint);
                    self.callbacks.pop();
                    Err(error.into())
                }
            },
            Ok(Err(error)) => {
                self.rollback(depth, &savepoint);
                self.callbacks.pop();
                Err(error)
            }
            Err(payload) => {
                self.rollback(depth, &savepoint);
                self.callbacks.pop();
                resume_unwind(payload)
            }
        }
    }

    fn rollback(&self, depth: usize, savepoint: &str) {
        let sql = if depth == 0 {
            "ROLLBACK".to_owned()
        } else {
            format!("ROLLBACK TO SAVEPOINT {savepoint}; RELEASE SAVEPOINT {savepoint}")
        };
        let _ = self.connection.execute_batch(&sql);
    }

    pub fn after_commit(&mut self, callback: impl FnOnce() + Send + 'static) {
        if let Some(pending) = self.callbacks.last_mut() {
            pending.push(Box::new(callback));
        } else if let Some(deferred) = self.deferred_callbacks.as_mut() {
            deferred.push(Box::new(callback));
        } else {
            let _ = catch_unwind(AssertUnwindSafe(callback));
        }
    }

    pub(crate) fn defer_callbacks(&mut self) {
        self.deferred_callbacks = Some(Vec::new());
    }

    pub(crate) fn take_deferred_callbacks(&mut self) -> Vec<Box<dyn FnOnce() + Send>> {
        self.deferred_callbacks.take().unwrap_or_default()
    }

    fn preflight_repository_identities(&mut self) -> DatabaseResult<()> {
        let exists: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'suplex_projects')", [], |row| row.get(0))?;
        if !exists {
            return Ok(());
        }
        let mut statement = self.connection.prepare("SELECT id, company_id, repository_identity FROM suplex_projects WHERE repository_identity IS NOT NULL")?;
        let rows = statement
            .query_map([], |row| {
                Ok(RepositoryIdentityCollision {
                    project_id: row.get(0)?,
                    company_id: row.get(1)?,
                    repository_identity: row.get::<_, String>(2)?.trim().to_lowercase(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut by_identity: HashMap<&str, Vec<&RepositoryIdentityCollision>> = HashMap::new();
        for row in &rows {
            by_identity
                .entry(&row.repository_identity)
                .or_default()
                .push(row);
        }
        let mut collisions = by_identity
            .values()
            .filter(|group| group.len() > 1)
            .flat_map(|group| group.iter().map(|row| (**row).clone()))
            .collect::<Vec<_>>();
        if !collisions.is_empty() {
            collisions.sort_by(|left, right| {
                left.repository_identity
                    .cmp(&right.repository_identity)
                    .then(left.project_id.cmp(&right.project_id))
            });
            return Err(DatabaseMigrationFailure(collisions).into());
        }
        self.transaction(false, |database| {
            for row in &rows {
                database.connection.execute("UPDATE suplex_projects SET repository_identity = ?1 WHERE id = ?2 AND repository_identity IS NOT NULL", params![row.repository_identity, row.project_id])?;
            }
            Ok(())
        })
    }

    fn apply_migrations(&mut self) -> DatabaseResult<()> {
        let migrations = read_migrations(MIGRATIONS)?;
        self.connection.execute_batch("CREATE TABLE IF NOT EXISTS __drizzle_migrations (\n    id SERIAL PRIMARY KEY,\n    hash text NOT NULL,\n    created_at numeric\n  )")?;
        let foreign_keys: i64 = self
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
        if foreign_keys != 0 {
            self.connection.execute_batch("PRAGMA foreign_keys = OFF")?;
        }
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            self.transaction(true, |database| {
                let mut statement = database
                    .connection
                    .prepare("SELECT hash, created_at FROM __drizzle_migrations")?;
                let applied = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(statement);
                let by_timestamp = applied
                    .into_iter()
                    .map(|(hash, timestamp)| (timestamp, hash))
                    .collect::<HashMap<_, _>>();
                for migration in &migrations {
                    if let Some(hash) = by_timestamp.get(&migration.created_at)
                        && hash != &migration.hash
                    {
                        return Err(format!(
                            "Applied migration timestamp has different SQL: {}",
                            migration.tag
                        )
                        .into());
                    }
                }
                for migration in &migrations {
                    if by_timestamp.get(&migration.created_at) == Some(&migration.hash) {
                        continue;
                    }
                    let sql = MIGRATIONS
                        .iter()
                        .find(|file| file.name == format!("{}.sql", migration.tag))
                        .ok_or("embedded migration missing")?;
                    let sql = std::str::from_utf8(sql.bytes)?;
                    for statement in sql
                        .split("--> statement-breakpoint")
                        .filter(|statement| !statement.trim().is_empty())
                    {
                        preserve_additive_columns_during_rebuild(&database.connection, statement)?;
                        database.connection.execute_batch(statement)?;
                    }
                    database.connection.execute(
                        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?1, ?2)",
                        params![migration.hash, migration.created_at],
                    )?;
                }
                Ok(())
            })
        }));
        let restored = if foreign_keys != 0 {
            self.connection.execute_batch("PRAGMA foreign_keys = ON")
        } else {
            Ok(())
        };
        match outcome {
            Ok(result) => {
                restored?;
                result
            }
            Err(payload) => {
                let _ = restored;
                resume_unwind(payload)
            }
        }
    }

    pub fn schema_status(&self) -> DatabaseResult<SchemaStatus> {
        let expected = read_migrations(MIGRATIONS)?;
        let wal_mode = self
            .connection
            .query_row("PRAGMA journal_mode", [], |row| {
                Ok(row.get::<_, String>(0)?.eq_ignore_ascii_case("wal"))
            })?;
        let ledger_exists: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations')", [], |row| row.get(0))?;
        let applied = if ledger_exists {
            let mut statement = self.connection.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, hash ASC")?;
            statement
                .query_map([], |row| {
                    Ok(Migration {
                        tag: String::new(),
                        hash: row.get(0)?,
                        created_at: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            Vec::new()
        };
        let state = schema_state(&expected, &applied);
        Ok(SchemaStatus {
            state,
            expected,
            applied,
            wal_mode,
        })
    }

    pub fn health(&self) -> DatabaseHealth {
        let status = match self.schema_status() {
            Ok(status) => status,
            Err(error) => {
                return DatabaseHealth {
                    wal_mode: false,
                    schema_state: if is_locked(error.as_ref()) {
                        SchemaState::Locked
                    } else {
                        SchemaState::Unavailable
                    },
                    expected_migrations: 0,
                    applied_migrations: 0,
                    readable: false,
                    writable: false,
                };
            }
        };
        let write = self.connection.execute_batch("CREATE TABLE IF NOT EXISTS health_write_probe (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)")
            .and_then(|_| self.connection.execute_batch("DROP TABLE health_write_probe"));
        DatabaseHealth {
            wal_mode: status.wal_mode,
            schema_state: if write.as_ref().is_err_and(|error| is_locked(error)) {
                SchemaState::Locked
            } else {
                status.state
            },
            expected_migrations: status.expected.len(),
            applied_migrations: status.applied.len(),
            readable: true,
            writable: write.is_ok(),
        }
    }
}

fn is_locked(error: &(dyn Error + 'static)) -> bool {
    let Some(error) = error.downcast_ref::<rusqlite::Error>() else {
        return false;
    };
    matches!(error, rusqlite::Error::SqliteFailure(code, _) if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
}

fn read_migrations(files: &[EmbeddedFile]) -> DatabaseResult<Vec<Migration>> {
    let mut migrations = Vec::with_capacity(files.len());
    for file in files {
        let tag = file
            .name
            .strip_suffix(".sql")
            .ok_or_else(|| format!("Migration filename must end in .sql: {}", file.name))?;
        let (timestamp, slug) = tag.split_once('_').ok_or_else(|| {
            format!(
                "Migration filenames must start with a UTC timestamp: {}",
                file.name
            )
        })?;
        if !matches!(timestamp.len(), 14 | 17)
            || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
            || slug.is_empty()
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            || !slug.as_bytes()[0].is_ascii_lowercase() && !slug.as_bytes()[0].is_ascii_digit()
        {
            return Err(format!(
                "Migration filenames must start with a UTC timestamp: {}",
                file.name
            )
            .into());
        }
        let datetime = NaiveDateTime::parse_from_str(&timestamp[..14], "%Y%m%d%H%M%S")?;
        let millis = if timestamp.len() == 17 {
            timestamp[14..].parse::<i64>()?
        } else {
            0
        };
        let created_at = datetime.and_utc().timestamp_millis() + millis;
        if datetime.format("%Y%m%d%H%M%S").to_string() != timestamp[..14] {
            return Err(format!("Invalid migration timestamp: {timestamp}").into());
        }
        migrations.push(Migration {
            tag: tag.to_owned(),
            hash: sha256_hex(file.bytes),
            created_at,
        });
    }
    migrations.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.tag.cmp(&right.tag))
    });
    for pair in migrations.windows(2) {
        if pair[0].created_at == pair[1].created_at {
            return Err(format!("Migration timestamps must be unique: {}", pair[1].tag).into());
        }
    }
    Ok(migrations)
}

fn schema_state(expected: &[Migration], applied: &[Migration]) -> SchemaState {
    if applied.is_empty() && !expected.is_empty() {
        return SchemaState::Behind;
    }
    let prefix = applied
        .iter()
        .zip(expected)
        .all(|(left, right)| left.hash == right.hash);
    if prefix {
        return match applied.len().cmp(&expected.len()) {
            std::cmp::Ordering::Equal => SchemaState::Current,
            std::cmp::Ordering::Less => SchemaState::Behind,
            std::cmp::Ordering::Greater => SchemaState::Ahead,
        };
    }
    let hashes = expected
        .iter()
        .map(|migration| migration.hash.as_str())
        .collect::<HashSet<_>>();
    if applied
        .iter()
        .all(|migration| hashes.contains(migration.hash.as_str()))
    {
        SchemaState::Partial
    } else if applied.len() > expected.len() {
        SchemaState::Ahead
    } else {
        SchemaState::Corrupt
    }
}

fn preserve_additive_columns_during_rebuild(
    connection: &Connection,
    statement: &str,
) -> DatabaseResult<()> {
    let Some((destination, source)) = rebuild_copy_tables(statement) else {
        return Ok(());
    };
    type ColumnInfo = (String, String, i64, Option<String>, i64);
    let columns = |table: &str| -> rusqlite::Result<Vec<ColumnInfo>> {
        let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?
            .collect()
    };
    let mut target_names = columns(&destination)?
        .into_iter()
        .map(|column| column.0)
        .collect::<HashSet<_>>();
    for (column, kind, not_null, default, primary_key) in columns(&source)? {
        if target_names.contains(&column) {
            continue;
        }
        if primary_key != 0 || not_null != 0 && default.is_none() {
            return Err(format!("Cannot preserve required column {source}.{column} during rebuild into {destination}").into());
        }
        let quoted = column.replace('"', "\"\"");
        let default_sql = default.map_or(String::new(), |value| format!(" DEFAULT {value}"));
        let not_null_sql = if not_null != 0 { " NOT NULL" } else { "" };
        connection.execute_batch(&format!("ALTER TABLE \"{destination}\" ADD COLUMN \"{quoted}\"{kind_sql}{not_null_sql}{default_sql}", kind_sql = if kind.trim().is_empty() { String::new() } else { format!(" {}", kind.trim()) }))?;
        target_names.insert(column);
    }
    Ok(())
}

fn rebuild_copy_tables(statement: &str) -> Option<(String, String)> {
    fn whitespace(input: &mut &str) -> bool {
        let trimmed = input.trim_start_matches(char::is_whitespace);
        let consumed = trimmed.len() != input.len();
        *input = trimmed;
        consumed
    }
    fn keyword(input: &mut &str, expected: &str) -> Option<()> {
        let word = input.get(..expected.len())?;
        if !word.eq_ignore_ascii_case(expected) {
            return None;
        }
        *input = &input[expected.len()..];
        whitespace(input).then_some(())
    }
    fn identifier(input: &mut &str) -> Option<String> {
        let quote = match input.as_bytes().first() {
            Some(b'`' | b'"') => {
                let quote = input.as_bytes()[0];
                *input = &input[1..];
                Some(quote)
            }
            _ => None,
        };
        let length = input
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            .count();
        let name = input.get(..length)?;
        if name.is_empty()
            || !name
                .as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        {
            return None;
        }
        let name = name.to_owned();
        *input = &input[length..];
        if let Some(quote) = quote {
            if input.as_bytes().first() != Some(&quote) {
                return None;
            }
            *input = &input[1..];
        }
        Some(name)
    }

    let mut input = statement;
    whitespace(&mut input);
    keyword(&mut input, "INSERT")?;
    keyword(&mut input, "INTO")?;
    let destination = identifier(&mut input)?;
    whitespace(&mut input).then_some(())?;
    keyword(&mut input, "SELECT")?;
    input = input.strip_prefix('*')?;
    whitespace(&mut input).then_some(())?;
    keyword(&mut input, "FROM")?;
    let source = identifier(&mut input)?;
    whitespace(&mut input);
    let input = input.strip_prefix(';').unwrap_or(input);
    input.trim().is_empty().then_some((destination, source))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temporary_database() -> std::path::PathBuf {
        static NEXT_DATABASE: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "suplex-rust-db-{}-{}-{}.sqlite",
            std::process::id(),
            NEXT_DATABASE.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn migrates_shared_sql_and_reopens_read_only() {
        let filename = temporary_database();
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let status = database.schema_status().unwrap();
        assert_eq!(status.state, SchemaState::Current);
        assert!(status.wal_mode);
        assert_eq!(status.applied.len(), MIGRATIONS.len());
        assert_eq!(status.applied[0].hash, status.expected[0].hash);
        drop(database);
        let read_only = SuplexDatabase::open(&filename, OpenMode::ReadOnly).unwrap();
        assert_eq!(read_only.mode(), OpenMode::ReadOnly);
        assert_eq!(
            read_only.schema_status().unwrap().state,
            SchemaState::Current
        );
        assert!(read_only.health().readable);
        assert!(!read_only.health().writable);
        drop(read_only);
        let reopened = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        assert_eq!(
            reopened.schema_status().unwrap().applied.len(),
            MIGRATIONS.len()
        );
        drop(reopened);
        let _ = fs::remove_file(&filename);
        let _ = fs::remove_file(filename.with_extension("sqlite-wal"));
        let _ = fs::remove_file(filename.with_extension("sqlite-shm"));
    }

    #[test]
    fn rejects_changed_sql_at_an_applied_timestamp() {
        let filename = temporary_database();
        let database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let timestamp = database.schema_status().unwrap().expected[0].created_at;
        database
            .connection()
            .execute(
                "UPDATE __drizzle_migrations SET hash = 'changed' WHERE created_at = ?1",
                [timestamp],
            )
            .unwrap();
        drop(database);
        let error = match SuplexDatabase::open(&filename, OpenMode::Migrate) {
            Ok(_) => panic!("modified migration must fail"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("different SQL"));
        let read_only = SuplexDatabase::open(&filename, OpenMode::ReadOnly).unwrap();
        assert_eq!(
            read_only.schema_status().unwrap().state,
            SchemaState::Corrupt
        );
        assert_eq!(
            read_only.schema_status().unwrap().applied.len(),
            MIGRATIONS.len()
        );
        drop(read_only);
        let _ = fs::remove_file(&filename);
    }

    #[test]
    fn read_write_mode_does_not_apply_migrations() {
        let filename = temporary_database();
        Connection::open(&filename).unwrap().close().unwrap();
        let database = SuplexDatabase::open(&filename, OpenMode::ReadWrite).unwrap();
        assert_eq!(database.schema_status().unwrap().state, SchemaState::Behind);
        let ledger_exists: i64 = database
            .connection()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_exists, 0);
        drop(database);
        let _ = fs::remove_file(&filename);
    }

    #[test]
    fn nested_callbacks_follow_outer_commit_and_rollback() {
        let filename = temporary_database();
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let result = database.transaction(true, |database| {
            let observed_inner = observed.clone();
            database.after_commit(move || observed_inner.lock().unwrap().push("outer"));
            let _: DatabaseResult<()> = database.transaction(false, |database| {
                let observed_rolled_back = observed.clone();
                database
                    .after_commit(move || observed_rolled_back.lock().unwrap().push("rolled back"));
                Err("abort savepoint".into())
            });
            let observed_committed = observed.clone();
            database.transaction(false, |database| {
                database.after_commit(move || observed_committed.lock().unwrap().push("inner"));
                Ok(())
            })?;
            assert!(observed.lock().unwrap().is_empty());
            Ok(())
        });
        result.unwrap();
        assert_eq!(&*observed.lock().unwrap(), &["outer", "inner"]);
        database.after_commit(|| panic!("diagnostic failure after commit"));
        assert_eq!(
            database
                .connection()
                .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let observed_discarded = observed.clone();
        let _: DatabaseResult<()> = database.transaction(false, |database| {
            database.after_commit(move || observed_discarded.lock().unwrap().push("discarded"));
            Err("abort outer".into())
        });
        assert_eq!(&*observed.lock().unwrap(), &["outer", "inner"]);
        drop(database);
        let _ = fs::remove_file(&filename);
    }

    #[test]
    fn rebuild_preserves_additive_columns() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE original (id TEXT PRIMARY KEY, added TEXT DEFAULT 'value'); INSERT INTO original (id) VALUES ('one'); CREATE TABLE rebuilt (id TEXT PRIMARY KEY)").unwrap();
        let copy = "  insert  into `rebuilt` select * from `original` ; ";
        preserve_additive_columns_during_rebuild(&connection, copy).unwrap();
        connection.execute_batch(copy).unwrap();
        let added: String = connection
            .query_row("SELECT added FROM rebuilt WHERE id = 'one'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(added, "value");
        assert!(rebuild_copy_tables("INSERT INTO rebuilt (id) SELECT * FROM original").is_none());
    }

    #[test]
    fn panic_rolls_back_sql_and_callbacks() {
        let filename = temporary_database();
        let mut database = SuplexDatabase::open(&filename, OpenMode::Migrate).unwrap();
        database
            .connection()
            .execute_batch("CREATE TABLE transaction_check (value TEXT)")
            .unwrap();
        let observed = Arc::new(Mutex::new(false));
        let callback_flag = observed.clone();
        let failure = catch_unwind(AssertUnwindSafe(|| {
            let _: DatabaseResult<()> = database.transaction(true, |database| {
                database.connection().execute(
                    "INSERT INTO transaction_check VALUES ('should roll back')",
                    [],
                )?;
                database.after_commit(move || *callback_flag.lock().unwrap() = true);
                panic!("transaction failed");
            });
        }));
        assert!(failure.is_err());
        let count: i64 = database
            .connection()
            .query_row("SELECT COUNT(*) FROM transaction_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(!*observed.lock().unwrap());
        drop(database);
        let _ = fs::remove_file(&filename);
    }

    #[test]
    fn opens_typescript_database_and_creates_reverse_fixture_when_requested() {
        let Ok(from_typescript) = std::env::var("SUPLEX_TS_TEST_DATABASE_PATH") else {
            return;
        };
        let to_typescript = std::env::var("SUPLEX_RUST_TEST_DATABASE_PATH").unwrap();
        let source = SuplexDatabase::open(Path::new(&from_typescript), OpenMode::ReadOnly).unwrap();
        let status = source.schema_status().unwrap();
        assert_eq!(status.state, SchemaState::Current);
        assert_eq!(status.applied.len(), MIGRATIONS.len());
        assert!(status.wal_mode);
        let name: String = source
            .connection()
            .query_row(
                "SELECT name FROM suplex_companies WHERE id = 'ts-interop'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "TypeScript fixture");
        for (pragma, expected) in [
            ("foreign_keys", 1),
            ("recursive_triggers", 1),
            ("synchronous", 2),
        ] {
            let actual: i64 = source
                .connection()
                .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(actual, expected, "{pragma}");
        }
        let target = SuplexDatabase::open(Path::new(&to_typescript), OpenMode::Migrate).unwrap();
        assert_eq!(target.schema_status().unwrap().state, SchemaState::Current);
        target.connection().execute("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('rust-interop', 'Rust fixture', 'active', '2026-09-24T00:00:00.000Z')", []).unwrap();
        for (pragma, expected) in [
            ("foreign_keys", 1),
            ("recursive_triggers", 1),
            ("synchronous", 2),
        ] {
            let actual: i64 = target
                .connection()
                .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(actual, expected, "{pragma}");
        }
    }
}
