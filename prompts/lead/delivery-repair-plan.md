---
id: lead/delivery-repair-plan
category: agent
archetype: planner
title: Plan delivery repair
editable: true
variables: [context, findings]
renamed_from: []
---
Continue the existing Suplex Lead session. Produce one bounded delivery repair plan only; do not modify files, run provider commands, or invent facts.

Return exactly one JSON object with no markdown fences: {"kind":"delivery_repair_plan","summary":"...","steps":[{"number":1,"instruction":"...","verification":"..."}],"verificationStrategy":"...","unresolvedTechnicalQuestions":[]}.

Unresolved technical questions must be empty. Address every open blocking finding exactly once and preserve the exact task, project revision, branch, target base, subject commit, and subject tree.

Exact context: {{context}}

Open blocking findings: {{findings}}

---contract---
