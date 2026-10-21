import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

const sql = readFileSync(new URL("../apps/server/migrations/20261021152436337_owner_account_user.sql", import.meta.url), "utf8");

function linkedHost(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE suplex_users (id TEXT PRIMARY KEY);
    CREATE TABLE suplex_account (id TEXT PRIMARY KEY CHECK (id = 'host'), account_id TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE suplex_account_users (user_id TEXT PRIMARY KEY REFERENCES suplex_users(id), account_id TEXT UNIQUE, email TEXT NOT NULL UNIQUE COLLATE NOCASE);
    INSERT INTO suplex_users VALUES ('user_development'), ('user_chris');
    INSERT INTO suplex_account VALUES ('host', 'user_owner', 'owner@example.com');
  `);
  return database;
}

const owner = (database: DatabaseSync) => database.prepare("SELECT account_id FROM suplex_account_users WHERE user_id = 'user_development'").get()?.account_id;

test("an existing link becomes the owner's hosted account", () => {
  const database = linkedHost();
  try {
    database.exec(sql);
    expect(owner(database)).toBe("user_owner");
  } finally { database.close(); }
});

test("a link that another user already holds maps nobody", () => {
  for (const conflict of ["('user_chris', 'user_owner', 'chris@example.com')", "('user_chris', NULL, 'OWNER@example.com')"]) {
    const database = linkedHost();
    try {
      database.exec(`INSERT INTO suplex_account_users VALUES ${conflict}`);
      database.exec(sql);
      expect(owner(database)).toBeUndefined();
    } finally { database.close(); }
  }
});

test("an unlinked host maps nobody", () => {
  const database = linkedHost();
  try {
    database.exec("DELETE FROM suplex_account");
    database.exec(sql);
    expect(owner(database)).toBeUndefined();
  } finally { database.close(); }
});
