import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fetchIssueMeta } from './issues.ts';
import { renderHtml } from './report.ts';
import { buildReport } from './runs.ts';
import { extract } from './scan.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    projects: { type: 'string', multiple: true },
    handoff: { type: 'string', default: join(homedir(), '.claude', 'litecode') },
    out: { type: 'string', default: join(homedir(), '.claude', 'litecode-analytics') },
    'min-op-seconds': { type: 'string', default: '5' },
    'min-op-tokens': { type: 'string', default: '2000' },
    'no-gh': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});

const command = positionals[0] ?? 'all';
const projects = values.projects ?? [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.claude-personal', 'projects'),
];
const log = (s: string) => values.quiet || console.error(s);

const records = extract(projects, join(values.out, 'cache'), log);
if (command === 'extract') process.exit(0);

const report = buildReport(records, values.handoff, {
  durMs: Number(values['min-op-seconds']) * 1000,
  tokens: Number(values['min-op-tokens']),
});
if (!values['no-gh']) report.issueMeta = fetchIssueMeta(report, log);
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'report.json'), JSON.stringify(report));
const htmlPath = join(values.out, 'report.html');
writeFileSync(htmlPath, renderHtml(report));
log(`${report.runs.length} runs, ${report.otherIssues.length} issues outside runs`);
console.log(htmlPath);
