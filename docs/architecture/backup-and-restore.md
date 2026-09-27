# Backup and restore boundaries

For contributors and operators, this page describes which state a Suplex
backup can recover and how its two restore paths differ. Sources:
[backup service](../../rust/src/platform/backup.rs),
[administrator routes](../../rust/src/http/routes/admin_platform.rs),
[CLI handoff](../../rust/src/cli.rs), and
[Backups settings](../../src/frontend/features/settings/backup-settings.tsx).

## What the archive contains

A backup is a compressed archive of a SQLite snapshot, the host's artifact
files, a non-secret installation configuration record, and a manifest. The
snapshot captures Suplex task and project data at creation time. The manifest
lists file sizes and SHA-256 hashes; verification also checks SQLite integrity
and the size and hash of artifacts named by the database. Archive paths are
checked before extraction.

Authentication state is removed from the snapshot: passkey credentials,
sessions, invitations, challenges, external-agent credentials and pairing
codes, and OAuth tokens and authorization codes. OAuth grant cursor keys are
rotated. Generated environment files, provider tokens, private keys, and
provider login directories are not copied into the archive. User records
remain in the database, but a restored user needs fresh authentication unless
the live-host restore path keeps that host's current login.

The archive contains task data and artifacts, and the code does not encrypt
it. Protect downloaded archives as you would the source installation. The
configuration record describes paths and access settings for a handoff; it
does not install credentials or reconfigure another host automatically.

## Two restore paths

**Backups in Settings** is an administrator operation on the running host.
Creating a backup verifies it before listing it for download. Restoring an
uploaded archive verifies it, migrates the staged database to the running
build's schema, then replaces the live database and copies artifacts into the
host's artifact directory. The browser reloads after success. The current
host's users, passkeys, and sessions are copied into the staged database so
the restoring administrator can remain signed in. The archived configuration
record is not applied to the running installation. Artifact files already on
the host that the archive does not name are not deleted by this copy.

**The CLI restore** verifies and extracts into a separate empty destination.
It migrates the extracted database and writes a `restore-handoff.json` with
recovery steps. It does not replace the live database or adopt the archived
paths and access settings. Because the archive omits authentication state,
an installation rebuilt from this destination needs new sign-in setup. See
the [README](../../README.md#back-up-and-restore) for the commands.

## What remains outside

Git repositories and worktrees are separate host data. Native provider
session storage, running tool processes, and model sign-ins are also outside
the archive. Restoring task records alone cannot recreate missing commits,
provider conversations, or unfinished native work. Restore those systems
separately, verify the actual repository and native session state, then let
Suplex recover from what their owners report. A successful archive verification
proves the archive's internal consistency; it does not prove that a recovered
task can resume on a different host.

[Architecture index](README.md)
