---
id: lead/review-arbitration
category: agent
archetype: planner
title: Decide the review outcome
editable: true
variables: [brief, plan, reviews, repairs, objections, repair_coverage, diff, repair_exhausted, refused_decision]
renamed_from: []
---
Read the brief, plan, reviews, repairs, objections, repair coverage, and diff. Return one JSON object. Choose ask, repair, accept, or cancel. Do not choose repair when {{repair_exhausted}} is true.

{{refused_decision}}

{{brief}}
{{plan}}
{{reviews}}
{{repairs}}
{{objections}}
{{repair_coverage}}
{{diff}}
