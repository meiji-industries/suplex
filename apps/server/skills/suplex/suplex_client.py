"""Suplex external-agent client. Python standard library only.

Reads SUPLEX_BASE_URL and SUPLEX_AGENT_CREDENTIAL from the environment at call
time. The credential is never logged, printed, or written to a file: every
message that leaves this module passes through redact().

Run `python3 suplex_client.py --self-check` to exercise the redaction and
idempotency-key logic without a server.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "suplex-agent-skill/1"
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class SuplexError(Exception):
    """A Suplex runtime failure carrying the server's safe error code."""

    def __init__(self, message: str, status: int | None = None, code: str | None = None, findings: list | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.findings = findings or []


class SuplexConfigError(SuplexError):
    """Configuration is missing. Never carries a value, only a variable name."""


class SuplexCredentialInvalid(SuplexError):
    """The credential was rejected. Ask the human for a new pairing code."""


def redact(text: str, credential: str) -> str:
    """Replace the credential anywhere it could reach a transcript or log."""
    return text.replace(credential, "[redacted credential]") if credential else text


def idempotency_key(scope: str, payload: dict) -> str:
    """Derive a key that is stable for one payload and different for any other.

    Retries reuse the key because it is derived, not generated: the same
    request always hashes to the same key, and any edit to the payload
    produces a new one instead of colliding with the earlier request.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(f"{scope}\n{canonical}".encode()).hexdigest()
    return f"suplex-{digest[:32]}"


def _host(base_url: str) -> str:
    return urllib.parse.urlparse(base_url).netloc or base_url


class SuplexClient:
    """Thin typed-route client over the Suplex Agent API.

    Prefer the Suplex MCP tools when the bridge is configured; this client is
    the documented HTTP fallback and speaks only routes that exist in Suplex.
    """

    def __init__(self, base_url: str | None = None, credential: str | None = None, env: dict | None = None):
        env = os.environ if env is None else env
        self.base_url = (base_url or env.get("SUPLEX_BASE_URL", "")).strip().rstrip("/")
        self.credential = (credential or env.get("SUPLEX_AGENT_CREDENTIAL", "")).strip()
        if not self.base_url:
            raise SuplexConfigError("Set SUPLEX_BASE_URL in the client process environment.")
        if not self.credential:
            raise SuplexConfigError("Set SUPLEX_AGENT_CREDENTIAL in the client process environment.")

    @property
    def host(self) -> str:
        return _host(self.base_url)

    def request(self, method: str, path: str, body: dict | None = None, headers: dict | None = None, attempts: int = 4) -> tuple[int, object]:
        """Send one authenticated request, retrying transient failures with backoff."""
        data = None if body is None else json.dumps(body).encode()
        request_headers = {"Authorization": f"Bearer {self.credential}", "Accept": "application/json", "User-Agent": USER_AGENT}
        if data is not None:
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})

        delay = 0.5
        for attempt in range(1, attempts + 1):
            try:
                status, payload = self._send(method, path, data, request_headers)
            except urllib.error.URLError as error:
                if attempt == attempts:
                    raise SuplexError(redact(f"Suplex is unreachable at {self.base_url}: {error.reason}", self.credential)) from None
                time.sleep(delay)
                delay = min(delay * 2, 8)
                continue
            if status in RETRY_STATUSES and attempt < attempts:
                time.sleep(delay)
                delay = min(delay * 2, 8)
                continue
            return status, payload
        raise SuplexError("Suplex did not answer after retries")

    def _send(self, method: str, path: str, data: bytes | None, headers: dict) -> tuple[int, object]:
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                text = response.read().decode()
                return response.status, (json.loads(text) if text else None)
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            try:
                return error.code, json.loads(text) if text else None
            except json.JSONDecodeError:
                return error.code, None

    def call(self, method: str, path: str, body: dict | None = None, headers: dict | None = None, expect: tuple = (200, 201)) -> object:
        """Request and raise the server's safe error unless the status is expected."""
        status, payload = self.request(method, path, body, headers)
        if status in expect:
            return payload
        safe = payload if isinstance(payload, dict) else {}
        code = safe.get("code")
        message = redact(str(safe.get("error") or f"Suplex returned HTTP {status}"), self.credential)
        if status == 401 or code == "credential_invalid":
            raise SuplexCredentialInvalid(
                "The Suplex credential was rejected. Ask the person you work for to issue a new pairing code "
                "in Suplex admin, then re-exchange it and replace SUPLEX_AGENT_CREDENTIAL.",
                status, code,
            )
        raise SuplexError(message, status, code, safe.get("findings"))

    # Routes served by apps/server/src/http/routes/agent_api.rs.

    def whoami(self) -> dict:
        return self.call("GET", "/api/agent/me")

    def capabilities(self) -> dict:
        return self.call("GET", "/api/agent/capabilities")

    def list_workflows(self, project_id: str) -> dict:
        return self.call("GET", f"/api/agent/workflows?{urllib.parse.urlencode({'projectId': project_id})}")

    def list_templates(self, project_id: str) -> dict:
        return self.call("GET", f"/api/agent/templates?{urllib.parse.urlencode({'projectId': project_id})}")

    def list_tasks(self, **query) -> dict:
        search = urllib.parse.urlencode({key: value for key, value in query.items() if value is not None})
        return self.call("GET", f"/api/agent/tasks?{search}" if search else "/api/agent/tasks")

    def get_task(self, task_id: str) -> dict:
        return self.call("GET", f"/api/agent/tasks/{urllib.parse.quote(task_id)}")

    def create_task(self, project_id: str, title: str, description: str | None = None, key: str | None = None, **extra) -> dict:
        """Create a backlog task. Pass queue=True to start it when every prerequisite is complete."""
        payload = {"projectId": project_id, "title": title, **extra}
        if description is not None:
            payload["description"] = description
        payload["idempotencyKey"] = key or idempotency_key(project_id, payload)
        return self.call("POST", "/api/agent/tasks", payload)

    def set_dependencies(self, task_id: str, depends_on: list[str], blocked_by_pull_requests: list[dict] | None = None, **extra) -> dict:
        """Replace the prerequisites (Blocked by) of a task with the complete set given."""
        payload = {"dependsOn": depends_on, **extra}
        if blocked_by_pull_requests is not None:
            payload["blockedByPullRequests"] = blocked_by_pull_requests
        return self.call("PUT", f"/api/agent/tasks/{urllib.parse.quote(task_id)}/dependencies", payload)

    def command_task(self, task_id: str, command: str, revision: str, note: str | None = None, key: str | None = None) -> dict:
        """Apply one lifecycle command. revision must be the task's current revision."""
        payload = {"command": command, "revision": revision}
        if note is not None:
            payload["note"] = note
        payload["idempotencyKey"] = key or idempotency_key(task_id, payload)
        return self.call("POST", f"/api/agent/tasks/{urllib.parse.quote(task_id)}/commands", payload)

    def update_task(self, task_id: str, revision: str, key: str | None = None, **fields) -> dict:
        """Change the details of a backlog or queued task. revision must be the task's current revision."""
        payload = {"revision": revision, **fields}
        payload["idempotencyKey"] = key or idempotency_key(task_id, payload)
        return self.call("PATCH", f"/api/agent/tasks/{urllib.parse.quote(task_id)}", payload)

    def poll_task(self, task_id: str, until=None, attempts: int = 8, delay: float = 2.0) -> dict:
        """Read a task repeatedly with exponential backoff until `until` holds."""
        task = self.get_task(task_id)
        for _ in range(attempts - 1):
            if until is None or until(task):
                return task
            time.sleep(delay)
            delay = min(delay * 2, 60)
            task = self.get_task(task_id)
        return task

    # Moves. Served only when an administrator granted this agent Move access.

    def list_moves(self, project_id: str) -> dict:
        return self.call("GET", f"/api/agent/moves?{urllib.parse.urlencode({'projectId': project_id})}")

    def get_move(self, move_id: str) -> dict:
        return self.call("GET", f"/api/agent/moves/{urllib.parse.quote(move_id)}")

    def create_move(self, project_id: str, name: str, prompt: str, runner: str, confirm: bool = True, key: str | None = None, **extra) -> dict:
        """Create a saved Move. runner is prompt, script, pull_request_tasks, or task."""
        payload = {"projectId": project_id, "name": name, "prompt": prompt, "runner": runner, "confirm": confirm, **extra}
        payload["idempotencyKey"] = key or idempotency_key(f"move:{project_id}", payload)
        return self.call("POST", "/api/agent/moves", payload)

    def update_move(self, move_id: str, updated_at: str, **fields) -> dict:
        """Replace a Move. fields is the complete Move body; updated_at must be the Move's current updatedAt."""
        return self.call("PUT", f"/api/agent/moves/{urllib.parse.quote(move_id)}", {**fields, "updatedAt": updated_at})

    def delete_move(self, move_id: str, updated_at: str) -> None:
        """Delete a Move and its run records. updated_at must be the Move's current updatedAt."""
        self.call("DELETE", f"/api/agent/moves/{urllib.parse.quote(move_id)}?{urllib.parse.urlencode({'updatedAt': updated_at})}", expect=(204,))

    def start_move(self, move_id: str, inputs: dict | None = None, excluded_pull_requests: list[int] | None = None, key: str | None = None) -> dict:
        """Start a Move run. Same inputs retried reuse the same idempotency key."""
        payload = {"inputs": inputs or {}, "excludedPullRequests": excluded_pull_requests or []}
        payload["idempotencyKey"] = key or idempotency_key(f"move-run:{move_id}", payload)
        return self.call("POST", f"/api/agent/moves/{urllib.parse.quote(move_id)}/runs", payload)

    def list_move_runs(self, move_id: str) -> dict:
        return self.call("GET", f"/api/agent/moves/{urllib.parse.quote(move_id)}/runs")

    def get_move_run(self, run_id: str) -> dict:
        return self.call("GET", f"/api/agent/move-runs/{urllib.parse.quote(run_id)}")

    def get_move_run_transcript(self, run_id: str) -> dict:
        return self.call("GET", f"/api/agent/move-runs/{urllib.parse.quote(run_id)}/transcript")

    def stop_move_run(self, run_id: str) -> None:
        """Stop a live run by closing its terminal."""
        self.call("DELETE", f"/api/agent/move-runs/{urllib.parse.quote(run_id)}/terminal", expect=(204,))

    def archive_move_run(self, run_id: str) -> None:
        self.call("POST", f"/api/agent/move-runs/{urllib.parse.quote(run_id)}/archive", expect=(204,))


def _self_check() -> None:
    credential = "self-check-placeholder-not-a-credential"
    assert redact(f"Bearer {credential} failed", credential) == "Bearer [redacted credential] failed"
    assert redact("nothing to hide", "") == "nothing to hide"

    payload = {"projectId": "p1", "title": "Add search"}
    reordered = {"title": "Add search", "projectId": "p1"}
    assert idempotency_key("p1", payload) == idempotency_key("p1", reordered), "same payload must reuse one key"
    assert idempotency_key("p1", payload) != idempotency_key("p1", {**payload, "title": "Add filters"}), "a different payload must not reuse the key"
    assert idempotency_key("p1", payload) != idempotency_key("p2", payload), "scope must separate keys"
    assert len(idempotency_key("p1", payload)) <= 128

    for missing in ({"SUPLEX_AGENT_CREDENTIAL": credential}, {"SUPLEX_BASE_URL": "http://127.0.0.1:4111"}, {}):
        try:
            SuplexClient(env=missing)
            raise AssertionError("missing configuration must fail")
        except SuplexConfigError as error:
            assert credential not in str(error), "configuration errors must not carry values"

    client = SuplexClient(env={"SUPLEX_BASE_URL": "http://127.0.0.1:4111/", "SUPLEX_AGENT_CREDENTIAL": credential})
    assert client.base_url == "http://127.0.0.1:4111"
    assert client.host == "127.0.0.1:4111"
    print("suplex_client self-check passed")


if __name__ == "__main__":
    import sys

    if "--self-check" not in sys.argv:
        print("Usage: python3 suplex_client.py --self-check", file=sys.stderr)
        raise SystemExit(2)
    _self_check()
