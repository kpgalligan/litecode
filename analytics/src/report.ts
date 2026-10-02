import { readFileSync } from 'node:fs';
import type { Report } from './types.ts';

const TEMPLATE = new URL('./report.html', import.meta.url);

/** Self-contained HTML report with the data embedded; no network needed to view it. */
export function renderHtml(report: Report): string {
  // Escape '<' so embedded strings can't close the script element.
  const json = JSON.stringify(report).replace(/</g, '\\u003c');
  return readFileSync(TEMPLATE, 'utf8').replace('/*__DATA__*/', () => json);
}
