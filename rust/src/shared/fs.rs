use std::{fs, io, io::Write, os::unix::fs::OpenOptionsExt, path::Path};

/// The file text, or `None` when the file does not exist.
pub fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Replace `path` atomically with a mode 0600 file that holds `bytes`.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut pending = path.as_os_str().to_owned();
    pending.push(format!(".{}.pending", uuid::Uuid::new_v4()));
    let pending = Path::new(&pending);
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(pending)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(pending, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn writes_private_files_and_reads_missing_files_as_none() {
        let directory =
            std::env::temp_dir().join(format!("suplex-shared-fs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("file.json");
        assert_eq!(super::read_optional(&path).unwrap(), None);
        super::write_private(&path, b"one").unwrap();
        super::write_private(&path, b"two").unwrap();
        assert_eq!(super::read_optional(&path).unwrap().as_deref(), Some("two"));
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
