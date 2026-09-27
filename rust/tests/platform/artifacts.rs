mod tests {
    use std::io;

    use super::*;
    use crate::platform::database::OpenMode;

    #[test]
    fn task_image_file_and_row_share_commit_and_rollback_cleanup() {
        let directory = std::env::temp_dir().join(format!("suplex-artifacts-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let root = directory.join("artifacts");
        let mut database =
            SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        database
            .connection()
            .execute(
                "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?1)",
                [now.to_rfc3339()],
            )
            .unwrap();
        let input = ArtifactInput {
            filename: "proof.png",
            mime_type: "image/png",
            bytes: &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            task_id: "task_1",
        };
        let mut written = Vec::new();
        let failed: DatabaseResult<()> = database.transaction(true, |database| {
            written.push(put_in_transaction(
                database,
                &root,
                "company",
                "task-image",
                &input,
                now,
            )?);
            Err(io::Error::other("later task write failed").into())
        });
        assert!(failed.is_err());
        for artifact in &written {
            remove_written(&root, artifact);
        }
        let count: i64 = database
            .connection()
            .query_row("SELECT count(*) FROM suplex_artifacts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            !checked(&root, "company", &written[0].storage_path)
                .unwrap()
                .exists()
        );

        let stored = database
            .transaction(true, |database| {
                put_in_transaction(database, &root, "company", "task-image", &input, now)
            })
            .unwrap();
        assert_eq!(
            read(&root, &stored.company_id, &stored.storage_path).unwrap(),
            input.bytes
        );
        assert_eq!(stored.byte_size, input.bytes.len());
        assert_eq!(stored.sha256, sha256_hex(input.bytes));
        assert!(stored.storage_path.starts_with("company/objects/"));
        let recorded_path: String = database
            .connection()
            .query_row(
                "SELECT storage_path FROM suplex_artifacts WHERE id = ?1 AND task_id = 'task_1'",
                [&stored.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded_path, stored.storage_path);
        use std::os::unix::fs::PermissionsExt;
        let file_path = checked(&root, "company", &stored.storage_path).unwrap();
        assert_eq!(
            fs::metadata(&file_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(file_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(read(&root, "company", "other/objects/aa/image.bin").is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn verified_path_rejects_changed_stored_bytes() {
        let directory = std::env::temp_dir().join(format!("suplex-artifacts-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let root = directory.join("artifacts");
        let mut database =
            SuplexDatabase::open(&directory.join("suplex.sqlite"), OpenMode::Migrate).unwrap();
        let now = Utc::now();
        database.connection().execute(
            "INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?1)",
            [now.to_rfc3339()],
        ).unwrap();
        let stored = database
            .transaction(true, |database| {
                put_in_transaction(
                    database,
                    &root,
                    "company",
                    "delivery-image",
                    &ArtifactInput {
                        filename: "proof.png",
                        mime_type: "image/png",
                        bytes: b"original",
                        task_id: "task_1",
                    },
                    now,
                )
            })
            .unwrap();
        let path = checked(&root, "company", &stored.storage_path).unwrap();
        fs::write(path, b"changed").unwrap();
        assert!(
            verified_path(&root, "company", &stored.storage_path, &stored.sha256)
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
