use std::{env, fs, path::PathBuf};

pub struct Installation {
    pub root: PathBuf,
    pub data: PathBuf,
    pub database: PathBuf,
    pub artifacts: PathBuf,
    pub logs: PathBuf,
    pub runtime: PathBuf,
    pub repositories: PathBuf,
    pub worktrees: PathBuf,
    pub configuration: PathBuf,
    pub port: u16,
}

impl Installation {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let root = match env::var_os("SUPLEX_RUST_ROOT") {
            Some(path) => PathBuf::from(path),
            None => env::current_dir()?.join(".suplex-rust"),
        };
        let port = match env::var("SUPLEX_RUST_PORT") {
            Ok(value) => parse_port(&value)?,
            Err(env::VarError::NotPresent) => {
                let base = env::var("CONDUCTOR_PORT").unwrap_or_else(|_| "4111".to_owned());
                let base = base.parse::<u16>()?;
                base.checked_add(2).ok_or("Rust port exceeds 65535")?
            }
            Err(error) => return Err(error.into()),
        };
        fs::create_dir_all(&root)?;
        Ok(Self::at(root, port))
    }

    fn at(root: PathBuf, port: u16) -> Self {
        let data = root.join("data");
        Self {
            database: data.join("suplex.sqlite"),
            artifacts: data.join("artifacts"),
            runtime: data.join("runtime"),
            logs: root.join("logs"),
            repositories: root.join("repositories"),
            worktrees: root.join("worktrees"),
            configuration: root.join("suplex.env"),
            root,
            data,
            port,
        }
    }
}

fn parse_port(value: &str) -> Result<u16, Box<dyn std::error::Error>> {
    let port = value.parse::<u16>()?;
    if port == 0 {
        return Err("SUPLEX_RUST_PORT must be between 1 and 65535".into());
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_under_experimental_root() {
        let root = PathBuf::from("/tmp/suplex-test/.suplex-rust");
        let config = Installation::at(root.clone(), 4113);
        for path in [
            &config.data,
            &config.database,
            &config.artifacts,
            &config.logs,
            &config.runtime,
            &config.repositories,
            &config.worktrees,
            &config.configuration,
        ] {
            assert!(path.starts_with(&root));
        }
        assert_eq!(config.database, root.join("data/suplex.sqlite"));
    }

    #[test]
    fn rejects_invalid_port() {
        for value in ["0", "65536", "hello", "4111.5"] {
            assert!(parse_port(value).is_err());
        }
        assert_eq!(parse_port("4113").unwrap(), 4113);
    }
}
