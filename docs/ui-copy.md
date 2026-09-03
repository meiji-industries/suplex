# UI copy: Simplified Technical English

## Rules

- Write one instruction per sentence.
- Keep instructions to 20 words or fewer.
- Keep descriptions to 25 words or fewer.
- Use the active voice.
- Name the actor. Use Forge, the Planner, the Builder, the Reviewer, the Integrator, or you.
- Start instructions and buttons with an approved imperative verb.
- Use the article. Write "Delete the worktree", not "Delete worktree".
- Do not use the -ing form of a verb for status.
- Do not use contractions, idioms, or slang.
- Use "necessary", not "required" or "needed".
- Use "not available", not "unavailable".
- Use "can", not "may" or "might".
- Write "cannot" consistently.
- Use one term for one concept. See the glossary.
- Do not use em dashes, semicolons, or ellipses in UI text.
- End a question in a title with "?". State what Forge does and what Forge keeps in the body.
- Describe present status. Use the past for completed states.

Approved imperative verbs: Accept, Add, Answer, Approve, Cancel, Check, Continue, Create, Delete, Describe, Discard, Keep, Open, Publish, Recreate, Reject, Repair, Report, Request, Resolve, Restart, Resume, Retry, Review, Revise, Save, Select, Send, Sign in, Start, Submit, Write.

## Glossary

| Term | Use | Do not use |
| --- | --- | --- |
| task | task | issue, ticket |
| Planner | Planner | Lead |
| Builder | Builder | Developer |
| Reviewer | Reviewer | second reviewer, supplemental reviewer |
| Integrator | Integrator | |
| you | you | member, human, user |
| build | build | development, execution |
| worktree, branch, base branch, pull request, CI | worktree, branch, base branch, pull request, CI | PR, target base |
| second review | second review | supplemental review |
| decision | decision | call |
| stopped | stopped | interrupted |

Code identifiers, command names, API fields, and log messages are not UI text and keep their names.

## Release blockers

| Failure code | Copy |
| --- | --- |
| `authentication-required` | GitHub could not authenticate this request. |
| `invalid-provider-response` | GitHub returned an invalid release response. |
| `wrong-remote` | git found a remote that does not match the pinned repository. |
| `stale-reviewed-revision` | Forge could not match the reviewed commit to a build. |
| `pinned-configuration-incomplete` | Forge could not find the accepted release configuration. |
| `target-base-drift` | git found that the target base changed. |
| `remote-head-conflict` | git found that the remote branch points to another commit. |
| `ambiguous-provider-state` | GitHub returned conflicting pull request details. |
| `provider-rate-limited` | GitHub limited release requests. |
| `provider-unavailable` | GitHub did not answer the release request. |
| `public-projection-unsafe` | Forge cannot safely project the release history. |
