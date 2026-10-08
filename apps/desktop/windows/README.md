# Windows build VM

`mise run desktop:dist:windows` builds the Windows installers on a Windows 11 Arm VM in VMware Fusion,
over SSH. `mise run desktop:check:windows` runs the shell's clippy and tests there. The release
(`mise run release:*`) runs the same build with the production update feed and key.

Suplex uses the VM that the VM provisioning repository provisions. Its settings file
`~/.cache/vm-provisioning/windows/vm.conf` names the VM, the guest user, and the SSH key. Set
`SUPLEX_WINDOWS_VM_CONFIG` to use another file in the same format.

## One-time setup

1. Provision the VM with `windows/setup.sh` and `windows/provision.sh` in the VM provisioning
   repository. That installs Visual Studio Build Tools, Rust with the `x86_64-pc-windows-msvc`
   target, Git, Python, and OpenSSH.
2. Add a build disk. The VM's `C:` disk has little free space, so Suplex keeps its checkout, Cargo
   cache, and build output on `S:`. With the VM stopped:

   ```sh
   vm="$HOME/Virtual Machines.localized/Windows 11 64-bit Arm.vmwarevm"
   "/Applications/VMware Fusion.app/Contents/Library/vmware-vdiskmanager" -c -s 80GB -a nvme -t 1 "$vm/Suplex Build.vmdk"
   printf 'nvme0:1.fileName = "Suplex Build.vmdk"\nnvme0:1.present = "TRUE"\n' >> "$vm/Windows 11 64-bit Arm.vmx"
   ```

   Start the VM, then format the disk as `S:` in an administrator PowerShell:

   ```powershell
   Initialize-Disk -Number 1 -PartitionStyle GPT
   New-Partition -DiskNumber 1 -UseMaximumSize -DriveLetter S | Format-Volume -FileSystem NTFS -NewFileSystemLabel SuplexBuild
   ```

The first build installs the Tauri CLI on `S:` (`install-tools.bat`).

## How a build runs

`scripts/build-desktop-windows.sh` starts the VM when it is off, copies `apps/desktop/` to
`S:\suplex\checkout`, and runs `build.bat <arch>`. The VM is Arm, so the x64 build uses the Arm-hosted
cross compiler, and the x64 installer runs under emulation in the install check
(`test-packaged.ps1`). The installers come back to `apps/desktop/release/windows-<arch>/`, where the Mac signs
the update files: the updater private key never reaches the VM.

## Authenticode signing

The release reads the six `AZURE_*` values from the `Azure Trusted Signing` item in the Suplex
1Password vault and signs the app, the installer, and its plugins with Azure Trusted Signing
(publisher "Meiji Heavy Industries, Inc."). The item holds the Entra app `release-signing`,
which has only the Artifact Signing Certificate Profile Signer role on the `vm-provisioning` profile in
the `codesigning` resource group. Its secret expires periodically; create a new one with
`az ad app credential reset` before then and update the item. Without the item the installers are
unsigned, and Windows SmartScreen shows an unknown publisher.

signtool needs Windows DPAPI, which an SSH key logon cannot unlock, so each signature runs in a
scheduled task that logs on with the VM user's password (`sign-task.ps1`). The build copies the
service principal and that password to the VM as files and deletes them when it ends.
