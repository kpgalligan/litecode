/** One API call, deduplicated by message id (streamed chunks repeat usage per content block). */
export interface Call {
  ts: number;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One tool call: tool_use paired with its tool_result. */
export interface Op {
  tool: string;
  label: string;
  start: number;
  durMs: number;
  /** Rough size of the result added to context (chars / 4). */
  resultTokens: number;
  /** Output tokens of the issuing turn, split across the tool calls it made. */
  outTokens: number;
  isError: boolean;
}

export interface Compaction {
  ts: number;
  trigger: string;
  preTokens: number;
  postTokens: number;
  durationMs: number;
}

export interface Issue {
  ts: number;
  url: string;
  title: string;
}

/** A tool call in a main session that referenced a litecode handoff dir. */
export interface HandoffRef {
  ts: number;
  repo: string;
  slug: string;
}

/** Everything extracted from one transcript file. Cached so data outlives transcript cleanup. */
export interface FileRecord {
  path: string;
  mtimeMs: number;
  size: number;
  sessionId: string;
  kind: 'main' | 'subagent';
  agentType?: string;
  agentId?: string;
  description?: string;
  /** First user message of a subagent: the dispatch prompt. */
  prompt?: string;
  cwd?: string;
  start: number;
  end: number;
  /** Sum of gaps between entries, with idle gaps capped, so resumed agents don't count idle hours. */
  activeMs: number;
  calls: Call[];
  ops: Op[];
  compactions: Compaction[];
  issues: Issue[];
  handoffRefs: HandoffRef[];
}

export interface StageOpGroup {
  tool: string;
  count: number;
  durMs: number;
  resultTokens: number;
  outTokens: number;
}

export interface Stage {
  agentId: string;
  stage: string;
  /** Stage family used for grouping and color: triage, design, adversary, design-final, implement, review, fix. */
  family: string;
  pass?: number;
  model: string;
  sessionId: string;
  start: number;
  end: number;
  activeMs: number;
  toolMs: number;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  peakContext: number;
  finalContext: number;
  /** [ms since stage start, context tokens] per call, downsampled. */
  contextCurve: [number, number][];
  compactions: Compaction[];
  ops: Op[];
  minorOps: StageOpGroup[];
}

export interface Orchestrator {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  peakContext: number;
  compactions: Compaction[];
  /** [epoch ms, context tokens] per call, downsampled. */
  contextCurve: [number, number][];
}

export interface Run {
  key: string;
  repo: string;
  slug: string;
  title: string;
  route: string;
  status: string;
  sessions: string[];
  start: number;
  end: number;
  stages: Stage[];
  orchestrator: Orchestrator;
  issues: (Issue & { source: string })[];
}

export interface Report {
  generatedAt: number;
  opThreshold: { durMs: number; tokens: number };
  runs: Run[];
  /** Issues created in sessions outside any litecode run window. */
  otherIssues: (Issue & { project: string })[];
  /** Current title and state per issue URL, from GitHub. */
  issueMeta: Record<string, { title: string; state: string; closedAt: number | null }>;
}
