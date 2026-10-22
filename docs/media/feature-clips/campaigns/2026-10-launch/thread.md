# Meet Suplex: X launch thread

## 1/ Hook (video: post-1-meet-suplex.mp4)

This year I shipped more production code than ever. I wrote zero lines of it.

My actual job: copy-paste. Plans between agents. CI logs back. Doomscrolling while tests ran.

Velocity was up. My brain was fried.

Every backlog moved at the speed of my clipboard. I wasn't the engineer anymore. I was the bottleneck.

So I built the eng squad I ran for 15 years as a CTO, out of agents.

Meet Suplex.

## 2/ How it works (video: post-2-how-it-works.mp4)

You describe the task. A Coordinator (your strongest model) writes the plan. A Worker (something faster) builds it in its own worktree. The Coordinator reviews, sends fixes, opens the PR, watches CI, and merges.

Swap models or providers per role. The workflow stays the same.

## 3/ Review (video: post-3-review-and-repair.mp4)

A model reviewing its own code isn't review.

Review and repair: a Rater scores an open PR, a Worker fixes the findings, and it repeats until the PR scores 9/10 with no blockers. Then it merges.

Double plans: two agents plan independently, and the Coordinator combines them.

## 4/ Interview to tasks (video: post-4-interview-to-tasks.mp4)

My favorite trick:

Paste a customer interview into Claude Code.
"What are the takeaways?"
"Build them in Suplex."

Claude queues a task per takeaway over MCP. The squad starts on the first one before you're off the next call.

## 5/ Moves (video: post-5-moves.mp4)

Moves are your ops runbooks, one click each.

Restart the API servers. Scale workers to 6. Purge the CDN cache. Force an app update.

Suplex reads your repo and suggests Moves from the commands you already have. Every run logs who, which inputs, and the full transcript.

## 6/ Proof (video: post-6-double-plans.mp4, optional)

Hot take: the best contributor at one of my clients is the CEO.

He labels a PR and moves on. Suplex resolves conflicts, reorders DB migrations, polishes it to 9/10 with green CI, and merges.

1,000+ PRs in. I'm no longer the bottleneck. I went OOO for a week; he kept shipping.

## 7/ CTA (no video, so the link card shows)

I run my clients, startups, and apps on Suplex.

Bring the agents you already pay for: Claude Code, Codex, OpenCode, Pi. Native Rust app, about 20 MB. Mac or Linux, plus your phone.

Free to start: https://getsuplex.ai

What would you hand your squad first?
