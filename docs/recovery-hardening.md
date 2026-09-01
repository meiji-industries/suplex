# Recovery

Forge reads live state instead of maintaining recovery queues.

At boot, Forge loads every non-terminal workflow snapshot with
`loadIssueRuns`. It then calls `failOrphanedExecutionsFromHerdr`.
An execution stays active only when Herdr reports its current turn as live.
Other active execution rows become failed and expose the workflow retry action.

Every 60 seconds, and when `POST /api/tasks/:id/refresh` runs, Forge calls
`reconcile()`. The pass runs these operations in order:

1. `reconcileActiveTurns` reads current Herdr turns.
2. `reconcileWorktrees` reads the filesystem.
3. `reconcileGithubObservations` reads pull requests and checks. The periodic
   pass waits five minutes between GitHub reads.
4. `CapacityManager.reconcileFromLedgers` updates capacity from its ledgers.

If an engine loop fails, Forge stores the failure as Last workflow error.
The next human command rebuilds that workflow from its latest snapshot before
it runs the command. The retry control does the same, then sends the first
allowed retry command.
