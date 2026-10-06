-- A reservation is the durable authority for one start effect.
CREATE UNIQUE INDEX suplex_move_runs_move_idempotency_key
ON suplex_move_runs(move_id, idempotency_key);
