# Windows desktop build

`mise run desktop:dist:windows` cross-compiles the Windows installers (NSIS, per-user) for arm64 and x64 in
Docker, from Linux, with [cargo-xwin](https://github.com/rust-cross/cargo-xwin). x64 builds run on the
`build-host` tailnet host when it answers, as the Linux builds do (`scripts/linux-builder.sh`). The release
(`mise run release:*`) runs the same build with the production update feed and key.
`mise run desktop:check:windows` runs the shell's clippy for both Windows targets.

- `Dockerfile` is the build image: Rust with both MSVC targets, `cargo-xwin`, the Tauri CLI, NSIS, and `jsign`.
- `apps/desktop/scripts/dist-windows.sh` runs inside it and writes `apps/desktop/release/windows-<arch>/`.
- `sign-linux.sh` signs one file; Tauri calls it through `bundle.windows.signCommand`.

The updater private key never enters the container: `scripts/build-desktop-windows.sh` signs the update
files on the Mac (`apps/desktop/scripts/finish-platform-release.sh`).

## Limits

- Cross-compiling is experimental in Tauri and supports the NSIS installer only (no MSI).
- No install or launch check runs. Install the installer on a Windows machine before a release that changes
  the shell, the installer, or signing.
- Clippy runs for the Windows targets. The shell's tests need a Windows machine.
- `ring` forces gnu-style `clang` on Windows arm64, while `cargo-xwin` passes `clang-cl` flags. The `clang`
  wrapper in the `Dockerfile` bridges them. Remove it when `ring` or `cargo-xwin` fixes this.

## Authenticode signing

The release reads the six `AZURE_*` values from the `Azure Trusted Signing` item in the Suplex 1Password
vault and signs the app and installer with Azure Trusted Signing (publisher "Meiji Heavy Industries, Inc."),
through `jsign`. The item holds the Entra app `release-signing`, which has only the Artifact Signing
Certificate Profile Signer role on the `vm-provisioning` profile in the `codesigning` resource group. Its
secret expires on 2028-10-06; create a new one with `az ad app credential reset` before then and update the
item. Without the item the installers are unsigned, and Windows SmartScreen shows an unknown publisher.
