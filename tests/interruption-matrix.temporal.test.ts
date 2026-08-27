import { test } from "vitest";

// These scenarios are intentionally kept visible while their product seams are
// completed by the concurrent hardening workers.  They must become normal
// temporal-harness tests rather than xfails, so regressions cannot be hidden.
// BUG: needs the CI workflow reconciliation fixture
test.skip("github webhook is absent, but polling sees ci pass or merge");
// BUG: needs the forward-merge Temporal fixture
test.skip("remote branch integration conflicts and auto-enters resolution");
// BUG: needs the repair workflow fixture
test.skip("required local test fails and auto-repairs");
// BUG: needs the CI repair workflow fixture
test.skip("ci fails from code and auto-repairs");
// BUG: needs the CI retry workflow fixture
test.skip("ci fails transiently and retries without attention");
// BUG: needs lifecycle command workflow fixture
test.skip("a worktree is cleaned in forge");
// BUG: needs lifecycle reconciliation workflow fixture
test.skip("a worktree is deleted outside forge while active and while terminal");
// BUG: needs cancellation race workflow fixture
test.skip("cancellation races a late agent result and a webhook");
// BUG: needs merge-decision workflow fixture
test.skip("planner note answers a merge decision on the same lead session");
// BUG: needs retry-exhaustion workflow fixture
test.skip("repair retries are exhausted");
