import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SuplexDatabase } from "../src/platform/database.js";

test("nested callbacks run only after the outer transaction commits in order", () => {
  const directory = mkdtempSync(join(tmpdir(), "suplex-commit-"));
  const database = new SuplexDatabase(join(directory, "suplex.sqlite"));
  const observed: string[] = [];
  try {
    database.authImmediateTransaction(db => {
      db.exec("CREATE TABLE telemetry_check (status TEXT)");
      db.prepare("INSERT INTO telemetry_check VALUES ('active')").run();
      database.afterCommit(() => observed.push("started"));
      database.authTransaction(inner => {
        inner.prepare("UPDATE telemetry_check SET status = 'cancelled'").run();
        database.afterCommit(() => observed.push("cancelled"));
      });
      expect(observed).toEqual([]);
    });
    expect(observed).toEqual(["started", "cancelled"]);
    expect(database.authQuery(db => db.prepare("SELECT status FROM telemetry_check").get())).toEqual({ status: "cancelled" });
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("rolled-back callbacks cannot acquire a later same-status update", () => {
  const directory = mkdtempSync(join(tmpdir(), "suplex-commit-"));
  const database = new SuplexDatabase(join(directory, "suplex.sqlite"));
  const observed: string[] = [];
  try {
    database.authTransaction(db => db.exec("CREATE TABLE telemetry_check (status TEXT)"));
    database.authTransaction(db => {
      try {
        database.authImmediateTransaction(inner => {
          inner.prepare("INSERT INTO telemetry_check VALUES ('active')").run();
          database.afterCommit(() => observed.push("rolled-back-start"));
          throw new Error("rollback");
        });
      } catch { /* The outer transaction continues. */ }
      db.prepare("INSERT INTO telemetry_check VALUES ('active')").run();
      database.afterCommit(() => observed.push("committed-start"));
    });
    expect(observed).toEqual(["committed-start"]);
    database.afterCommit(() => { throw new Error("diagnostic failure"); });
    expect(database.authQuery(db => db.prepare("SELECT COUNT(*) AS count FROM telemetry_check").get())).toEqual({ count: 1 });
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
