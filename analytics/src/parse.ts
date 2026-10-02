import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Call, Compaction, FileRecord, HandoffRef, Issue, Op } from './types.ts';

const IDLE_CAP_MS = 30 * 60 * 1000;
const HANDOFF_RE = /\.claude\/litecode\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g;
/** `gh issue create` prints the new issue's URL on a line by itself. */
const ISSUE_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+$/gm;

interface PendingOp {
  tool: string;
  label: string;
  start: number;
  msgId: string;
  command?: string;
}

type Block = { type?: string; [k: string]: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Block) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

function resultSize(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content as Block[]) {
    if (b.type === 'text' && typeof b.text === 'string') n += b.text.length;
    // Images cost roughly 1.5k tokens regardless of payload size.
    else if (b.type === 'image') n += 6000;
  }
  return n;
}

function short(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function opLabel(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'Bash':
      return short(str('command'), 120);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str('file_path').split('/').slice(-3).join('/');
    case 'Grep':
    case 'Glob':
      return short(str('pattern'), 80);
    case 'Agent':
    case 'Task':
      return short(str('description'), 80);
    default:
      return tool;
  }
}

function issueTitle(command: string): string {
  const m = command.match(/--title\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
  return m ? short((m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'), 140) : '';
}

/** True when the file can't contribute anything, so we can skip the JSON parse. */
function irrelevant(buf: Buffer, kind: 'main' | 'subagent', agentType?: string): boolean {
  if (kind === 'subagent' && agentType?.startsWith('lc-')) return false;
  return !buf.includes('gh issue create') && (kind === 'subagent' || !buf.includes('litecode'));
}

export function parseTranscript(path: string): FileRecord {
  const st = statSync(path);
  const kind = dirname(path).endsWith('/subagents') ? 'subagent' : 'main';
  const sessionId =
    kind === 'subagent' ? basename(dirname(dirname(path))) : basename(path, '.jsonl');
  const rec: FileRecord = {
    path,
    mtimeMs: st.mtimeMs,
    size: st.size,
    sessionId,
    kind,
    start: 0,
    end: 0,
    activeMs: 0,
    calls: [],
    ops: [],
    compactions: [],
    issues: [],
    handoffRefs: [],
  };
  if (kind === 'subagent') {
    rec.agentId = basename(path, '.jsonl').replace(/^agent-/, '');
    const metaPath = path.replace(/\.jsonl$/, '.meta.json');
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        rec.agentType = meta.agentType;
        rec.description = meta.description;
      } catch {
        // Missing metadata only loses the stage type.
      }
    }
  }

  const buf = readFileSync(path);
  if (irrelevant(buf, kind, rec.agentType)) return rec;

  const calls = new Map<string, Call>();
  const toolUsesPerMsg = new Map<string, number>();
  const pending = new Map<string, PendingOp>();
  const finished: (Op & { msgId: string })[] = [];
  const refKeys = new Set<string>();
  let lastTs = 0;

  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (!rec.start) rec.start = ts;
      if (lastTs) rec.activeMs += Math.min(Math.max(ts - lastTs, 0), IDLE_CAP_MS);
      lastTs = ts;
      rec.end = Math.max(rec.end, ts);
    }
    if (!rec.cwd && typeof e.cwd === 'string') rec.cwd = e.cwd;

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const m = e.compactMetadata ?? {};
      rec.compactions.push({
        ts,
        trigger: m.trigger ?? 'unknown',
        preTokens: m.preTokens ?? 0,
        postTokens: m.postTokens ?? 0,
        durationMs: m.durationMs ?? 0,
      } satisfies Compaction);
      continue;
    }

    const msg = e.message;
    if (!msg) continue;

    if (e.type === 'user' && kind === 'subagent' && rec.prompt === undefined) {
      const t = textOf(msg.content);
      if (t) rec.prompt = t.slice(0, 4000);
    }

    if (e.type === 'assistant' && msg.usage && msg.id) {
      const u = msg.usage;
      const prev = calls.get(msg.id);
      calls.set(msg.id, {
        ts: prev?.ts ?? ts,
        model: msg.model ?? '',
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: Math.max(prev?.output ?? 0, u.output_tokens ?? 0),
      });
    }

    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content as Block[]) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const tool = String(b.name ?? 'unknown');
        pending.set(b.id, {
          tool,
          label: opLabel(tool, input),
          start: ts,
          msgId: msg.id ?? '',
          command: tool === 'Bash' ? String(input.command ?? '') : undefined,
        });
        toolUsesPerMsg.set(msg.id ?? '', (toolUsesPerMsg.get(msg.id ?? '') ?? 0) + 1);
        if (kind === 'main') {
          for (const m of JSON.stringify(input).matchAll(HANDOFF_RE)) {
            const slug = m[2].replace(/\.+$/, '');
            const key = `${m[1]}/${slug}@${ts}`;
            if (refKeys.has(key)) continue;
            refKeys.add(key);
            rec.handoffRefs.push({ ts, repo: m[1], slug } satisfies HandoffRef);
          }
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        if (p.command?.includes('gh issue create')) {
          const urls = new Set(textOf(b.content).match(ISSUE_URL_RE) ?? []);
          const title = issueTitle(p.command);
          for (const url of urls) rec.issues.push({ ts, url, title } satisfies Issue);
        }
        finished.push({
          tool: p.tool,
          label: p.label,
          start: p.start,
          durMs: Math.max(ts - p.start, 0),
          resultTokens: Math.round(resultSize(b.content) / 4),
          outTokens: 0,
          isError: b.is_error === true,
          msgId: p.msgId,
        });
      }
    }
  }

  rec.calls = [...calls.values()].sort((a, b) => a.ts - b.ts);
  if (kind === 'subagent') {
    rec.ops = finished.map(({ msgId, ...op }) => ({
      ...op,
      outTokens: Math.round((calls.get(msgId)?.output ?? 0) / (toolUsesPerMsg.get(msgId) ?? 1)),
    }));
  }
  return rec;
}
