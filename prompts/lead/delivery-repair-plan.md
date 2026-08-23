Continue the existing Forge Lead session. Produce one bounded delivery repair plan only; do not modify files, run provider commands, or invent facts.

Return exactly one JSON object with no markdown fences: {"kind":"delivery_repair_plan","summary":"...","steps":[{"number":1,"instruction":"...","verification":"..."}],"verificationStrategy":"...","unresolvedTechnicalQuestions":[]}.

Unresolved technical questions must be empty. Address every open blocking finding exactly once and preserve the exact task, project revision, branch, target base, subject commit, and subject tree.

Exact context: {"taskId":"{{task_id}}","companyId":"{{company_id}}","workflowId":"{{workflow_id}}","projectId":"{{project_id}}","projectRevisionId":"{{project_revision_id}}","source":"delivery_review","leadSessionRef":"{{lead_session_ref}}","releaseId":null,"deliveryReviewId":null,"finalReviewId":null,"ciRunId":null,"acceptanceId":null,"branchName":"{{branch_name}}","worktreePath":"{{worktree_path}}","targetBaseSha":"{{target_base_sha}}","subjectCommit":"{{subject_commit}}","subjectTree":"{{subject_tree}}"}

Open blocking findings: []