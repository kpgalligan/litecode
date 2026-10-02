# litecode

A Claude Code skill that runs a sequential coding pipeline for features, refactors, and non-trivial bug fixes, built to use less than a multi-agent fan-out like ultracode.

**Note:** This is the skill I currently use. I'm not claiming it's the best approach, and I change it periodically. But somebody wanted to see it.

It runs one subagent at a time in a fixed order. Each stage has a pinned model, a set effort level, and a narrow job. Stages pass work to each other through files on disk, not through shared context. The orchestrator (the main Claude session) only dispatches stages and checks stop conditions. It never reads source code itself.

```
triage ─┬─ small ──────────────────────────────────────────┐
        │                                                  ▼
        └─ full ─▶ design ─▶ adversary ─▶ (revise design) ─▶ implement ─▶ review ─▶ fix loop (≤5)
```

## Installation

Copy the skill directory and the agent definitions into your Claude Code config. Use `~/.claude/` for all projects, or a project's `.claude/` for one repo:

```sh
cp -r litecode ~/.claude/skills/
cp agents/*.md ~/.claude/agents/
```

The skill needs all six `lc-*` agents. The orchestrator refuses to dispatch any other agent.

## Usage

Start a run by saying "litecode", or by asking for a feature, refactor, or bug fix and saying you want to save usage:

```
litecode: add a --dry-run flag to the sync command
```

Continue an interrupted run:

```
litecode resume <task-slug>
```

The skill is not for questions, explanations, or one-line edits. Ask Claude for those directly.

## Pipeline

| Stage | Agent | Model / effort | Reads | Writes |
|---|---|---|---|---|
| 0. Triage | `lc-triage` | Sonnet, low | `request.md` | `00-triage.md` |
| 1. Design | `lc-designer` | Opus, xhigh | request, triage, the repo | `01-spec.md` |
| 2. Adversary | `lc-adversary` | Opus, high | spec plus the files it names | `02-objections.md` |
| 1b. Final design | `lc-designer` | Opus, xhigh | spec, objections | `03-spec-final.md` |
| 3. Implement | `lc-implementer` | Opus, high | final spec (or request on the small route) | code changes, `04-impl-notes.md`, `04-checks.txt` |
| 4. Review | `lc-reviewer` | Opus, high | spec, notes, checks, `git diff` | `05-review.md` |
| 5. Fix loop | `lc-fixer` → `lc-reviewer` | Opus, high | latest review, diff | `06-fix-notes-N.md`, `07-review-N+1.md` |

### Routing and skips

- **Triage always runs.** It picks the `small` route only when the task touches at most 3 files, adds no public interface, changes no migrations, config formats, or build system, and doesn't cross module boundaries. If it is unsure, it picks `full`. The small route goes straight to implementation with no spec.
- **The adversary can approve the spec as written.** If it returns `verdict: proceed` with no objections, the spec is copied to `03-spec-final.md` and the revision step is skipped.
- **Review is skipped for small, green diffs.** If the diff is under 80 changed lines and every verification command passed, the run finishes without a review.
- **The fix loop runs at most 5 passes.** It ends early when a re-review passes, or when the same finding at the same `file:line` comes back after the fixer claimed to fix it. Findings still open at the end are reported, not retried.

### Agent roles

- **Triage** is a router. It does a few greps, guesses which files the task touches, and picks a route.
- **Designer** is the only agent that explores the codebase broadly. It writes a spec of at most about 150 lines covering an authoritative file list, exact interfaces, ordered steps, constraints, real verification commands, and what is out of scope. It runs read-only commands only. On its second call it accepts objections that have evidence behind them and declines the rest in one line each.
- **Adversary** gets one round to raise up to 5 objections against the spec. Each needs a risk category and evidence: a `file:line` or a concrete scenario. Style comments, speculation, and "consider also" suggestions are not allowed. Raising no objections is a valid result.
- **Implementer** carries out the spec exactly: no refactors, no side cleanups, no new dependencies. It runs verification and gets 3 attempts to make it pass.
- **Reviewer** reviews the diff against the spec, not the whole repo. It reports at most 6 findings, each rated `blocker`, `should-fix`, or `nit`, with a `file:line`. Nits never trigger a fix.
- **Fixer** makes the smallest change that resolves each blocker or should-fix, then re-runs verification. It does no redesign and touches nothing the review didn't flag.

## Handoff directory

Each run writes its files to:

```
~/.claude/litecode/<repo-name>/<task-slug>/
```

The orchestrator gives each agent this path and the names of the files to read. It never pastes file contents into prompts. Each run leaves a complete record you can inspect, and resume works by finding the first stage whose output file is missing.

Templates for the spec, objections, and review files are in `litecode/references/`.

## Stopping

Any stage can halt the run by writing `STOP: <reason>` as the first line of its output, for example when a request is ambiguous, a spec can't be implemented, or a fix would require a redesign. The orchestrator then reports the reason, lists the handoff files that exist, and asks you how to continue. A stage that hits its turn cap is treated the same way.

## Final summary

When a run finishes, the orchestrator prints:

- the route taken (small or full)
- the stages run, including the number of fix passes
- the files changed (`git diff --stat`)
- the verification result, naming any failing commands
- the objections the designer declined
- any unresolved blockers or should-fix findings
- the handoff directory path

## Layout

```
litecode/
  SKILL.md                         orchestrator instructions
  references/
    spec-template.md
    objections-template.md
    review-template.md
agents/
  lc-triage.md
  lc-designer.md
  lc-adversary.md
  lc-implementer.md
  lc-reviewer.md
  lc-fixer.md
```

## Analytics

`analytics/` builds a report of timing, tokens, context size, compactions, and filed GitHub issues for every litecode run. It reads Claude Code's transcripts, so it covers past runs without any setup in the skill or agents.

```sh
cd analytics
pnpm install
pnpm all        # extract new transcripts, then write the report
open ~/.claude/litecode-analytics/report.html
```

How it works:

- **Extract.** Scans `~/.claude/projects` and `~/.claude-personal/projects` (override with `--projects <dir>`, repeatable). Each transcript is parsed once and cached in `~/.claude/litecode-analytics/cache/`. The cache is kept after Claude Code deletes old transcripts (`cleanupPeriodDays`, 30 days by default), so run the extractor at least that often.
- **Runs.** A subagent belongs to a run when its dispatch prompt names a handoff dir. Its stage comes from the agent type and the file it was told to write. Route, title, and outcome come from the handoff files when they still exist.
- **Orchestrator.** Main-session turns between the run's first stage and 30 minutes after its last stage (or the next run's start) are counted as orchestrator overhead.
- **Operations.** Each tool call records its duration, the size of its result, and its share of the turn's output tokens. Calls under 5s and 2k tokens are grouped by tool (`--min-op-seconds`, `--min-op-tokens`).
- **Issues.** Any `gh issue create` whose output prints an issue URL. The report fetches current titles and open/closed state with one `gh issue list` per repo (`--no-gh` skips this).

Agent time is time a transcript was active, with idle gaps over 30 minutes removed. Tokens include cache reads, which make up most of the total, so the report also shows output and uncached input separately.
