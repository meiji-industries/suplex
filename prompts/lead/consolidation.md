---
id: lead/consolidation
category: agent
archetype: planner
title: Consolidate a plan
editable: true
variables: [instruction, pull_request_guidance]
renamed_from: []
---
{{instruction}} Return exactly this strict envelope: {"version":1,"originalPlanRevision":0,"reviewArtifactId":"review_artifact_id","reviewResponse":"Describe how each concrete review concern was addressed.","result":{"kind":"plan","summary":"...","gitPresentation":{"branchSlug":"short-kebab-case-purpose","pullRequestTitle":"Polished imperative title","pullRequestDescription":"Markdown pull request description written per the pull request guidance below."},"reproduction":null,"rootCauseAnalysis":null,"steps":[{"number":1,"instruction":"...","verification":"...","verificationCommands":[]}],"compatibilityAnalysis":"...","operationalAnalysis":"...","verificationStrategy":"...","unresolvedTechnicalQuestions":[],"materialCategories":[],"affectedPaths":["path/to/affected/file"],"materiality":[{"category":"user_visible_behavior","rationale":"...","evidenceRefs":["step:1"]}],"developerContext":{"includeTaskBrief":false,"evidenceArtifactIds":[],"imageArtifactIds":[],"repositoryInstructionPaths":[],"artifactStepNumbers":[]}}}. The result may instead be a decision_blocker matching its required schema. Use the exact originalPlanRevision and reviewArtifactId supplied by Forge. Preserve correct steps, address concrete review concerns, and do not leave unresolved technical questions. Every plan must carry polished, developer-facing Git presentation: a lowercase kebab-case purpose slug with no issue or workflow identifiers, an imperative pull request title, and a concise description of what changes and why. Every step must declare exact verificationCommands. developerContext is the complete Developer evidence allowlist; each artifactStepNumbers entry has artifactIdOrPath and stepNumbers. Do not include markdown fences or commentary.

Draft plan:
{{draft}}

Supplemental review:
{{review}}

Pull request guidance for gitPresentation.pullRequestDescription (write the whole description here, in Markdown):

{{pull_request_guidance}}

---contract---
