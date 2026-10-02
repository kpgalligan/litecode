import { execFileSync } from 'node:child_process';
import type { Report } from './types.ts';

export interface IssueMeta {
  title: string;
  state: string;
  closedAt: number | null;
}

/** Looks up title and open/closed state for every issue in the report, one `gh issue list` per repo. */
export function fetchIssueMeta(
  report: Report,
  log: (s: string) => void,
): Record<string, IssueMeta> {
  const urls = [...report.runs.flatMap((r) => r.issues), ...report.otherIssues].map((i) => i.url);
  const repos = new Set(
    urls.map((u) => u.match(/github\.com\/([^/]+\/[^/]+)\/issues/)?.[1]).filter(Boolean),
  );
  const wanted = new Set(urls);
  const meta: Record<string, IssueMeta> = {};
  for (const repo of repos) {
    try {
      const out = execFileSync(
        'gh',
        [
          'issue',
          'list',
          '-R',
          repo!,
          '--state',
          'all',
          '--limit',
          '5000',
          '--json',
          'url,title,state,closedAt',
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const i of JSON.parse(out) as {
        url: string;
        title: string;
        state: string;
        closedAt: string | null;
      }[])
        if (wanted.has(i.url))
          meta[i.url] = {
            title: i.title,
            state: i.state,
            closedAt: i.closedAt ? Date.parse(i.closedAt) : null,
          };
    } catch (err) {
      log(`gh issue list failed for ${repo}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return meta;
}
