# Database migrations

Forge migrations are immutable SQL files in `drizzle/`. Their names begin with
a unique UTC timestamp, which determines their logical order without requiring
a shared journal or sequential number:

```text
20260812143522123_add_release_status.sql
```

Create one with:

```bash
pnpm migration:new add release status
```

Separate statements with `--> statement-breakpoint`. Never rename or edit a
migration after it has been applied. The runtime records each migration by its
timestamp and SHA-256 hash, so independently-created migrations can merge and
apply even when a newer migration has already reached a database.
