fn settled_write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2)),
        )
        .unwrap();
}

#[tokio::test]
async fn active_and_finished_sweeps_collect_generated_media() {
    let (directory, database_path, database, task_id) = crate::tasks::artifacts::tests::fixture();
    let generated = database_path
        .parent()
        .unwrap()
        .join("runtime/task-evidence")
        .join(&task_id)
        .join("generated");
    std::fs::create_dir_all(&generated).unwrap();
    settled_write(
        &generated.join("finished.png"),
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
    );
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET status = 'cancelled', delivery_target = 'local_worktree' WHERE task_id = ?1",
            [&task_id],
        )
        .unwrap();
    drop(database);
    let artifact_root = directory.join("artifacts");
    sweep_task(
        &database_path,
        &artifact_root,
        &task_id,
        None,
        &HashMap::new(),
    )
    .await
    .unwrap();
    let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
    assert_eq!(
        database
            .connection()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM suplex_artifacts WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap(),
        1
    );
    settled_write(&generated.join("active.gif"), b"GIF89a");
    database
        .connection()
        .execute(
            "UPDATE suplex_task_controls SET status = 'active' WHERE task_id = ?1",
            [&task_id],
        )
        .unwrap();
    drop(database);
    tokio::time::timeout(
        Duration::from_secs(30),
        sweep_task(
            &database_path,
            &artifact_root,
            &task_id,
            None,
            &HashMap::new(),
        ),
    )
    .await
    .expect("active task sweep timed out")
    .unwrap();
    let database = SuplexDatabase::open(&database_path, OpenMode::ReadWrite).unwrap();
    assert_eq!(
        database
            .connection()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM suplex_artifacts WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .unwrap(),
        2
    );
    drop(database);
    std::fs::remove_dir_all(directory).unwrap();
}
