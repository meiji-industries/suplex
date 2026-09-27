#[test]
fn generated_collection_and_issue_retention_share_media_deduplication() {
    let (directory, operations, task_id, head) =
        crate::delivery::operations::tests::workflow_task("standard");
    let generated = evidence_root(operations.database_path())
        .join(&task_id)
        .join("generated");
    fs::create_dir_all(&generated).unwrap();
    let screenshot = generated.join("shot.png");
    let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    fs::write(&screenshot, bytes).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&screenshot)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2)),
        )
        .unwrap();
    let mut database =
        SuplexDatabase::open(operations.database_path(), OpenMode::ReadWrite).unwrap();
    let collected = crate::tasks::artifacts::collect_generated_media(
        &mut database,
        operations.database_path(),
        operations.artifact_root(),
        &task_id,
    );
    assert_eq!(collected.imported, 1);
    retain(
        &mut database,
        operations.artifact_root(),
        &task_id,
        &format!("{head}-shot.png"),
        "image/png",
        &bytes,
    )
    .unwrap();
    assert_eq!(
        database.connection().query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM suplex_artifacts WHERE task_id = ?1 AND kind = 'delivery-image'",
            [&task_id],
            |row| row.get(0),
        ).unwrap(),
        1
    );
    fs::remove_dir_all(directory).unwrap();
}
