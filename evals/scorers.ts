import type { AgentResult } from '../src/agent/loop.js';
import type { EvalCase, Expect, Pred, RecordedCall } from './types.js';

export interface Score {
  pass: boolean;
  failures: string[];
}

function matches(value: unknown, pred: Pred): boolean {
  if (typeof pred !== 'object') return value === pred;
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if ('equals' in pred && JSON.stringify(value) !== JSON.stringify(pred.equals)) return false;
  if (pred.regex !== undefined && !new RegExp(pred.regex, 'i').test(text)) return false;
  if (pred.notRegex !== undefined && new RegExp(pred.notRegex, 'i').test(text)) return false;
  if (pred.in && !pred.in.some((x) => (x === null ? value === undefined || value === null : x === value))) return false;
  if (pred.present !== undefined && (value !== undefined && value !== null) !== pred.present) return false;
  return true;
}

function argsMatch(args: Record<string, unknown>, match: Record<string, Pred>): string | undefined {
  for (const [key, pred] of Object.entries(match)) {
    if (!matches(args[key], pred)) return `${key}=${JSON.stringify(args[key])} violates ${JSON.stringify(pred)}`;
  }
  return undefined;
}

function isSubsequence(wanted: string[], actual: string[]): boolean {
  let i = 0;
  for (const name of actual) if (name === wanted[i]) i++;
  return i === wanted.length;
}

/** Fully deterministic: compares what the model asked for against the case's expectations. No model judge. */
export function score(c: EvalCase, calls: RecordedCall[], result: AgentResult): Score {
  const e: Expect = c.expect;
  const failures: string[] = [];
  const names = calls.map((x) => x.name);
  const proposal = result.kind === 'proposal' ? result.proposal : undefined;
  const text = result.kind === 'text' ? result.text : '';

  if (result.kind === 'error') failures.push(`run failed: ${result.reason}`);

  if (e.sequence && !isSubsequence(e.sequence, names)) {
    failures.push(`expected tool sequence ${e.sequence.join(' > ')}, got ${names.join(' > ') || '(no calls)'}`);
  }
  if (e.allowedTools) {
    const extra = names.filter((n) => !e.allowedTools?.includes(n));
    if (extra.length) failures.push(`called tool(s) outside the allowed set: ${[...new Set(extra)].join(', ')}`);
  }
  const forbidden = [...new Set(names.filter((n) => e.forbiddenTools?.includes(n)))];
  if (forbidden.length) failures.push(`called forbidden tool(s): ${forbidden.join(', ')}`);

  if (e.noProposal && proposal) failures.push(`unexpected proposal ${proposal.tool}`);
  if (e.refusal) {
    if (proposal) failures.push(`refusal expected but a ${proposal.tool} proposal was made`);
    if (result.kind === 'text' && !text.trim()) failures.push('refusal expected but the reply was empty');
  }
  if (e.proposal) {
    if (!proposal) failures.push(`expected a ${e.proposal.tool} proposal, got ${result.kind}`);
    else if (proposal.tool !== e.proposal.tool) failures.push(`expected a ${e.proposal.tool} proposal, got ${proposal.tool}`);
    else {
      const bad = argsMatch(proposal.args, e.proposal.args ?? {});
      if (bad) failures.push(`proposal args: ${bad}`);
    }
  }
  for (const want of e.args ?? []) {
    const candidates = calls.filter((x) => x.name === want.tool);
    if (candidates.length === 0) failures.push(`${want.tool} was never called`);
    else if (!candidates.some((x) => argsMatch(x.args, want.match) === undefined)) {
      failures.push(`${want.tool} args: ${argsMatch(candidates[0]?.args ?? {}, want.match)}`);
    }
  }
  if (e.textRegex && !new RegExp(e.textRegex, 'i').test(text)) failures.push(`reply does not match /${e.textRegex}/`);
  if (e.textNotRegex && new RegExp(e.textNotRegex, 'i').test(text)) failures.push(`reply matches forbidden /${e.textNotRegex}/`);

  return { pass: failures.length === 0, failures };
}
