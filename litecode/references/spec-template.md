# Spec: <task>

## Goal
<two sentences max>

## Files
- `path/to/file.ext` — <one line: what changes>
<every file to create or modify; this list is authoritative>

## Interfaces
<exact signatures, types, endpoints, schemas touched or added; no bodies>

## Approach
1. <step, in implementation order>
2. ...

## Constraints
- <existing patterns to follow>
- <things that must not break; callers that depend on touched code>

## Verification
Targeted (run while iterating; covers only the code in **Files**):
```
<exact commands scoped to the change: one test file, a test-name filter, one module's build or typecheck>
```
Full (run once, after the targeted checks pass; only commands the files in **Files** can affect):
```
<exact commands from the repo's standard gate: test, lint, typecheck, build>   # ~<duration, if the repo documents it>
<a probe, benchmark, or scripted drive, only if this task changes what it checks>   # covers: <the changed behavior>
```
Passing means: <what output/exit status counts as green for this task>

## Out of scope
- <adjacent things NOT to do>
