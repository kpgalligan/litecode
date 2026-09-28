---
name: litecode
description: Usage-conserving sequential coding pipeline. Use this whenever the user says "litecode", or asks for a feature, refactor, or non-trivial bug fix and wants to conserve usage instead of running ultracode. Runs triage → design → adversarial review → implement → review → fix, one subagent at a time, with pinned models, effort levels, turn caps, and written handoff files. Do not use for questions, explanations, or one-line edits the user asks you to make directly.
---

# litecode

You are the orchestrator. You do almost no work yourself. You dispatch one subagent at a time, in a fixed order, and check stop conditions between stages. Never spawn two agents at once. Never spawn an agent not listed below. Never explore the codebase yourself — that is the designer's job.

## Setup

1. Derive `<repo-name>` from the git remote or the directory name, and `<task-slug>` from the request (kebab-case, ≤6 words, append `-2`, `-3` if it exists).
2. `HANDOFF=~/.claude/litecode/<repo-name>/<task-slug>/`. Create it. Write the user's verbatim request to `$HANDOFF/request.md`.
3. If the user said `litecode resume <task-slug>`, skip to **Resume**.

Every dispatch prompt has the same shape: one or two lines telling the agent the `$HANDOFF` path and which files to read. Do not paste file contents into the prompt; the agent reads them.

Print exactly one line at each stage transition, e.g. `triage → full route`, `design done → adversary`. Nothing else until the final summary.

## Pipeline

### Stage 0 — triage (`lc-triage`) — always runs

Dispatch: `Handoff dir: $HANDOFF. Read request.md. Write 00-triage.md.`

Read `00-triage.md`. If `route: small` → go to Stage 3. If `route: full` → Stage 1.

### Stage 1 — design (`lc-designer`)

Dispatch: `Handoff dir: $HANDOFF. Read request.md and 00-triage.md. Explore the repo as needed. Write 01-spec.md using the spec template.`

Check for `STOP:` in the spec. If present, halt (see **Stopping**).

### Stage 2 — adversary (`lc-adversary`)

Dispatch: `Handoff dir: $HANDOFF. Read 01-spec.md and only the files it names. Write 02-objections.md.`

Read the verdict line. If `verdict: proceed` and there are zero objections, copy `01-spec.md` to `03-spec-final.md` and go to Stage 3.

### Stage 1b — final design (`lc-designer`)

Dispatch: `Handoff dir: $HANDOFF. Read 01-spec.md and 02-objections.md. Write 03-spec-final.md: the revised spec plus an "Objections addressed" section.`

### Stage 3 — implement (`lc-implementer`)

Full route dispatch: `Handoff dir: $HANDOFF. Read 03-spec-final.md. Implement it. Write 04-impl-notes.md and 04-checks.txt.`

Small route dispatch: `Handoff dir: $HANDOFF. Read request.md and 00-triage.md. No spec exists; implement the request directly, touching only files_likely_touched unless you justify otherwise in your notes. Write 04-impl-notes.md and 04-checks.txt.`

Check for `STOP:` in the notes. If present, halt.

### Stage 4 — review (`lc-reviewer`)

**Skip check first.** Run `git diff --stat` (or the equivalent for the repo's VCS). If total changed lines < 80 AND `04-checks.txt` shows every verification command passing → skip to **Finish**.

Otherwise dispatch: `Handoff dir: $HANDOFF. Read 03-spec-final.md (or request.md on the small route), 04-impl-notes.md, 04-checks.txt, and the git diff. Write 05-review.md.`

If `verdict: pass` → **Finish**. If `verdict: fix-required` → Stage 5.

### Stage 5 — fix loop (`lc-fixer`, then `lc-reviewer`), at most 5 passes

Fix pass `N` runs from 1 to 5. The review it answers is `05-review.md` for pass 1, and `07-review-N.md` (the re-review written after pass `N-1`) after that.

1. Fix dispatch: `Handoff dir: $HANDOFF. Read <that review> and the git diff. Fix every blocker and should-fix. Re-run the verification commands from the spec. Write 06-fix-notes-N.md.`
2. If the fix notes contain `STOP:`, halt (see **Stopping**).
3. Re-review dispatch: `Handoff dir: $HANDOFF. Read 03-spec-final.md (or request.md on the small route), 04-impl-notes.md, 04-checks.txt, every 06-fix-notes-*.md so far, the review pass N answered, and the git diff. Write 07-review-<N+1>.md.`
4. If that review says `verdict: pass` → **Finish**. If it says `fix-required` and `N < 5` → run pass `N+1`. If `N = 5` → do NOT run the fixer again. Go to **Finish** and report the unresolved findings.

**Stop early** if a re-review lists a blocker or should-fix that the previous review also raised (the same finding at the same file:line) and the fix notes claim it fixed. Go to **Finish** and report that finding as stuck. A sixth pass won't fix what two passes couldn't.

## Stopping

Any stage may write `STOP: <reason>` at the top of its output file. When you see it: halt, tell the user the reason, list the handoff files that exist, and ask how to proceed. Do not try to work around it yourself.

A stage that hits its turn cap returns partial output. Treat that like a STOP: report it, don't re-dispatch.

## Resume

List `$HANDOFF`. Restart from the first stage whose output file is missing, following the same routing rules. If `00-triage.md` says `small`, the missing spec files are expected — go by the small route. In the fix loop, the pass number is one more than the count of `06-fix-notes-*.md` already written. If the newest file is a fix note with no `07-review-*.md` after it, run that pass's re-review first. A handoff dir from before the loop (`06-fix-notes.md`, `07-review-2.md`) counts as pass 1.

## Finish

Print a summary, in this order, nothing extra:

- Route: small / full
- Stages run (including how many fix passes)
- Files changed (from `git diff --stat`)
- Verification: pass / fail, with the failing command names if any
- Objections the designer declined (from `03-spec-final.md`), one line each, if any
- Unresolved review findings (blockers / should-fix), if any
- Handoff dir path

## Rules you must not break

- One agent at a time. Sequential only.
- No agent outside the six defined. No ad-hoc "let me just check" subagents.
- Never skip triage.
- Never run more than 5 fix passes, and never run a fix pass without a `fix-required` review in front of it.
- Never paste handoff file contents into dispatch prompts — pass paths.
- You do not read source files. If you're tempted to, you're doing the designer's job at the wrong effort level.
