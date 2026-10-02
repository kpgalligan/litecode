import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Call,
  Compaction,
  FileRecord,
  Issue,
  Op,
  Orchestrator,
  Report,
  Run,
  Stage,
  StageOpGroup,
} from './types.ts';

const HANDOFF_RE = /\.claude\/litecode\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/;
/** How far orchestrator activity may trail the last stage and still count toward the run (Finish summary, filing issues). */
const TRAIL_MS = 30 * 60 * 1000;
/** How far before the first stage a handoff-dir reference counts as run setup. */
const LEAD_MS = 15 * 60 * 1000;
const CURVE_POINTS = 60;
const MAX_OPS_PER_STAGE = 60;

export interface Thresholds {
  durMs: number;
  tokens: number;
}

function classify(
  agentType: string,
  prompt: string,
): { stage: string; family: string; pass?: number } {
  switch (agentType) {
    case 'lc-triage':
      return { stage: 'triage', family: 'triage' };
    case 'lc-adversary':
      return { stage: 'adversary', family: 'adversary' };
    case 'lc-implementer':
      return { stage: 'implement', family: 'implement' };
    case 'lc-designer':
      return /Write\s+03-spec-final/.test(prompt)
        ? { stage: 'design final', family: 'design-final' }
        : { stage: 'design', family: 'design' };
    case 'lc-reviewer': {
      const m = prompt.match(/Write\s+07-review-(\d+)/);
      return m
        ? { stage: `re-review ${m[1]}`, family: 'review', pass: Number(m[1]) }
        : { stage: 'review', family: 'review' };
    }
    case 'lc-fixer': {
      const m = prompt.match(/06-fix-notes-(\d+)/);
      const pass = m ? Number(m[1]) : 1;
      return { stage: `fix ${pass}`, family: 'fix', pass };
    }
    default:
      return { stage: agentType, family: 'other' };
  }
}

function context(c: Call): number {
  return c.input + c.cacheRead + c.cacheWrite;
}

function curve(calls: Call[], t0: number): [number, number][] {
  const step = Math.max(1, Math.ceil(calls.length / CURVE_POINTS));
  const peak = calls.reduce((best, c, i) => (context(c) > context(calls[best]) ? i : best), 0);
  return calls
    .filter((_, i) => i % step === 0 || i === peak || i === calls.length - 1)
    .map((c) => [c.ts - t0, context(c)]);
}

function dominantModel(calls: Call[]): string {
  const counts = new Map<string, number>();
  for (const c of calls)
    if (c.model && !c.model.startsWith('<')) counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** Wall time covered by at least one tool call (parallel calls overlap). */
function unionMs(ops: Op[]): number {
  const iv = ops.map((o) => [o.start, o.start + o.durMs]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [s, e] = [0, 0];
  for (const [a, b] of iv) {
    if (a > e) {
      total += e - s;
      [s, e] = [a, b];
    } else e = Math.max(e, b);
  }
  return total + (e - s);
}

function sumTokens(calls: Call[]) {
  return {
    calls: calls.length,
    input: calls.reduce((n, c) => n + c.input, 0),
    cacheRead: calls.reduce((n, c) => n + c.cacheRead, 0),
    cacheWrite: calls.reduce((n, c) => n + c.cacheWrite, 0),
    output: calls.reduce((n, c) => n + c.output, 0),
    peakContext: calls.reduce((n, c) => Math.max(n, context(c)), 0),
  };
}

function buildStage(rec: FileRecord, th: Thresholds): Stage {
  const { stage, family, pass } = classify(rec.agentType ?? '', rec.prompt ?? '');
  const big: Op[] = [];
  const minor = new Map<string, StageOpGroup>();
  for (const op of rec.ops) {
    if (op.durMs >= th.durMs || op.resultTokens + op.outTokens >= th.tokens) big.push(op);
    else {
      const g = minor.get(op.tool) ?? {
        tool: op.tool,
        count: 0,
        durMs: 0,
        resultTokens: 0,
        outTokens: 0,
      };
      g.count++;
      g.durMs += op.durMs;
      g.resultTokens += op.resultTokens;
      g.outTokens += op.outTokens;
      minor.set(op.tool, g);
    }
  }
  const kept = big.sort((a, b) => b.durMs - a.durMs).slice(0, MAX_OPS_PER_STAGE);
  return {
    agentId: rec.agentId ?? '',
    stage,
    family,
    pass,
    model: dominantModel(rec.calls),
    sessionId: rec.sessionId,
    start: rec.start,
    end: rec.end,
    activeMs: rec.activeMs,
    toolMs: unionMs(rec.ops),
    ...sumTokens(rec.calls),
    finalContext: rec.calls.length ? context(rec.calls[rec.calls.length - 1]) : 0,
    contextCurve: curve(rec.calls, rec.start),
    compactions: rec.compactions,
    ops: kept.sort((a, b) => a.start - b.start),
    minorOps: [...minor.values()].sort((a, b) => b.durMs - a.durMs),
  };
}

function readMaybe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Route, title and outcome from the run's handoff files, when they still exist. */
function handoffInfo(handoffRoot: string, repo: string, slug: string, stages: Stage[]) {
  const dir = join(handoffRoot, repo, slug);
  const families = new Set(stages.map((s) => s.family));
  const inferredRoute = families.has('design') ? 'full' : families.has('implement') ? 'small' : '?';
  if (!existsSync(dir)) return { title: slug, route: inferredRoute, status: 'unknown' };

  const files = readdirSync(dir);
  const title =
    readMaybe(join(dir, 'request.md'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
      ?.slice(0, 160) ?? slug;
  const route =
    readMaybe(join(dir, '00-triage.md')).match(/route:\s*\**\s*(small|full)/i)?.[1] ??
    inferredRoute;

  let status = 'incomplete';
  const stopped = files.some((f) =>
    /^\s*STOP:/m.test(readMaybe(join(dir, f)).split('\n').slice(0, 5).join('\n')),
  );
  const reviews = files
    .filter((f) => f === '05-review.md' || /^07-review-\d+\.md$/.test(f))
    .sort(
      (a, b) =>
        (Number(a.match(/\d+(?=\.md)/)?.[0]) || 0) - (Number(b.match(/\d+(?=\.md)/)?.[0]) || 0),
    );
  if (stopped) status = 'stopped';
  else if (reviews.length) {
    const v = readMaybe(join(dir, reviews[reviews.length - 1])).match(
      /verdict:\s*\**\s*(pass|fix-required)/i,
    )?.[1];
    status = v?.toLowerCase() === 'pass' ? 'pass' : 'unresolved';
  } else if (files.includes('04-impl-notes.md')) status = 'pass (review skipped)';
  return { title, route, status };
}

export function buildReport(records: FileRecord[], handoffRoot: string, th: Thresholds): Report {
  const mains = new Map<string, FileRecord>();
  for (const r of records) if (r.kind === 'main') mains.set(r.sessionId, r);

  const byRun = new Map<string, { repo: string; slug: string; recs: FileRecord[] }>();
  const looseIssues: (Issue & { project: string })[] = [];
  for (const r of records) {
    if (r.kind !== 'subagent') continue;
    const m = r.agentType?.startsWith('lc-') ? r.prompt?.match(HANDOFF_RE) : null;
    if (!m) {
      for (const i of r.issues) looseIssues.push({ ...i, project: r.cwd ?? '' });
      continue;
    }
    const slug = m[2].replace(/\.+$/, '');
    const key = `${m[1]}/${slug}`;
    const entry = byRun.get(key) ?? { repo: m[1], slug, recs: [] };
    entry.recs.push(r);
    byRun.set(key, entry);
  }

  const runs: Run[] = [];
  for (const [key, { repo, slug, recs }] of byRun) {
    const stages = recs
      .filter((r) => r.start)
      .map((r) => buildStage(r, th))
      .sort((a, b) => a.start - b.start);
    if (!stages.length) continue;
    const info = handoffInfo(handoffRoot, repo, slug, stages);
    const issues: Run['issues'] = [];
    for (const r of recs)
      for (const i of r.issues)
        issues.push({ ...i, source: classify(r.agentType ?? '', r.prompt ?? '').stage });
    runs.push({
      key,
      repo,
      slug,
      ...info,
      sessions: [...new Set(stages.map((s) => s.sessionId))],
      start: stages[0].start,
      end: Math.max(...stages.map((s) => s.end)),
      stages,
      orchestrator: {
        calls: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        peakContext: 0,
        compactions: [],
        contextCurve: [],
      },
      issues,
    });
  }

  // Attribute orchestrator turns, compactions and issues in each main session to the run active at the time.
  const claimedIssues = new Set<string>();
  const sessionRuns = new Map<string, { run: Run; ws: number; we: number }[]>();
  for (const run of runs) {
    for (const sid of run.sessions) {
      const inSession = run.stages.filter((s) => s.sessionId === sid);
      const first = Math.min(...inSession.map((s) => s.start));
      const last = Math.max(...inSession.map((s) => s.end));
      const refs =
        mains
          .get(sid)
          ?.handoffRefs.filter(
            (h) =>
              h.repo === run.repo && h.slug === run.slug && h.ts < first && h.ts >= first - LEAD_MS,
          ) ?? [];
      const ws = Math.min(first, ...refs.map((h) => h.ts));
      const list = sessionRuns.get(sid) ?? [];
      list.push({ run, ws, we: last + TRAIL_MS });
      sessionRuns.set(sid, list);
    }
  }
  for (const [sid, list] of sessionRuns) {
    const main = mains.get(sid);
    if (!main) continue;
    list.sort((a, b) => a.ws - b.ws);
    list.forEach((w, i) => {
      if (i + 1 < list.length) w.we = Math.min(w.we, list[i + 1].ws);
      const inWin = (ts: number) => ts >= w.ws && ts <= w.we;
      const calls = main.calls.filter((c) => inWin(c.ts));
      const o: Orchestrator = w.run.orchestrator;
      const t = sumTokens(calls);
      o.calls += t.calls;
      o.input += t.input;
      o.cacheRead += t.cacheRead;
      o.cacheWrite += t.cacheWrite;
      o.output += t.output;
      o.peakContext = Math.max(o.peakContext, t.peakContext);
      o.compactions.push(...main.compactions.filter((c: Compaction) => inWin(c.ts)));
      o.contextCurve.push(...curve(calls, 0));
      w.run.start = Math.min(w.run.start, w.ws);
      for (const iss of main.issues)
        if (inWin(iss.ts) && !claimedIssues.has(iss.url)) {
          claimedIssues.add(iss.url);
          w.run.issues.push({ ...iss, source: 'orchestrator' });
        }
    });
  }

  const seen = new Set<string>();
  for (const run of runs) {
    run.orchestrator.contextCurve.sort((a, b) => a[0] - b[0]);
    run.issues = run.issues.filter((i) => !seen.has(i.url) && seen.add(i.url));
  }
  const otherIssues: Report['otherIssues'] = [];
  for (const r of records)
    if (r.kind === 'main')
      for (const i of r.issues) looseIssues.push({ ...i, project: r.cwd ?? '' });
  for (const i of looseIssues.sort((a, b) => a.ts - b.ts))
    if (!seen.has(i.url)) {
      seen.add(i.url);
      otherIssues.push(i);
    }

  runs.sort((a, b) => a.start - b.start);
  return { generatedAt: Date.now(), opThreshold: th, runs, otherIssues, issueMeta: {} };
}
