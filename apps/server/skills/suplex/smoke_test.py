"""Verify an external agent's Suplex pairing end to end.

Reports only that the variables are set and the base URL host, performs one
non-destructive read, then creates the connectivity acknowledgment task twice
with the same idempotency key and asserts Suplex returns the same task. The
task stays in `backlog`; this script never starts, cancels, or archives it.

Usage: python3 smoke_test.py
"""

from __future__ import annotations

import sys

from suplex_client import SuplexClient, SuplexError

TITLE = "External agent connectivity confirmed"
DESCRIPTION = "Connection acknowledged. Do not plan or execute this task."


def main() -> int:
    try:
        client = SuplexClient()
    except SuplexError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print("SUPLEX_BASE_URL is set")
    print("SUPLEX_AGENT_CREDENTIAL is set")
    print(f"Suplex host: {client.host}")

    identity = client.whoami()
    agent = identity["agent"]
    projects = identity["projects"]
    print(f"Agent: {agent['name']} ({agent['id']}), profile {agent['profileId']}")
    print(f"Granted projects: {', '.join(project['id'] for project in projects) or 'none'}")
    if not projects:
        print("error: this agent has no granted projects. Ask an administrator for project access.", file=sys.stderr)
        return 1

    project_id = projects[0]["id"]
    key = f"suplex-connectivity-{agent['id']}"
    first = client.create_task(project_id, TITLE, DESCRIPTION, key=key)
    second = client.create_task(project_id, TITLE, DESCRIPTION, key=key)
    if first["id"] != second["id"]:
        print(f"error: the same idempotency key created two tasks ({first['id']}, {second['id']}).", file=sys.stderr)
        return 1

    print(f"Acknowledgment task: {first.get('issueKey') or first['id']} ({first['id']}) status {second['status']}")
    print("Idempotent replay returned the same task. Suplex pairing verified.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SuplexError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
