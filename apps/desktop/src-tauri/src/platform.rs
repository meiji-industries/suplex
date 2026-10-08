//! What the shell does differently on each operating system.

/// The bundled host runs on macOS and Linux. On Windows the shell only connects to another host.
pub const LOCAL_SUPPORTED: bool = cfg!(unix);

/// The word for the computer the shell runs on: "This Mac" on macOS, "This computer" elsewhere.
pub const MACHINE: &str = if cfg!(target_os = "macos") {
    "Mac"
} else {
    "computer"
};

/// `macos`, `linux`, or `windows`, as the setup pages and the host page receive it.
pub const NAME: &str = std::env::consts::OS;
