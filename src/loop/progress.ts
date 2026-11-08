import { type LoopEvent, shortModel } from './report.ts';

const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const rate = (tokens: number, ms: number) => (ms > 0 && tokens > 0 ? `${Math.round((tokens * 1000) / ms)}/s` : '-');

/** One line per loop event worth showing (progress ticks return undefined). */
export function describeEvent(e: LoopEvent): string | undefined {
  switch (e.kind) {
    case 'start':
      return `pi-loop ${e.runId} (${e.workflow}): sessions in ${e.sessionDir}`;
    case 'step-start':
      return `step ${e.step.n}: ${e.step.label} (${shortModel(e.step.model)})…`;
    case 'step-end': {
      const s = e.step;
      const limit = s.stoppedBy ? ` · ${s.stoppedBy} limit${s.aborted ? ', aborted' : ', finished after the firm steer'}${s.wrappedUp ? ', asked again' : ''}` : s.warned ? ' · warned' : '';
      const v = s.verdict ? ` · VERDICT ${s.verdict.verdict} (${s.verdict.counts.critical} critical, ${s.verdict.counts.high} high, ${s.verdict.counts.minor} minor)` : '';
      return `step ${s.n} done: ${s.label} · ${s.turns} turns · ${min(s.ms)} · read ${rate(s.readTokens, s.readMs)} · write ${rate(s.writeTokens, s.writeMs)}${limit}${v}`;
    }
    case 'gates':
      return `checks: ${e.results.map((g) => `${g.command} ${g.ok ? 'ok' : g.timedOut ? 'TIMED OUT' : 'FAILED'}`).join(', ') || 'none'}`;
    case 'done':
      return `pi-loop done: ${e.report.outcome} (${e.report.detail}) in ${min(e.report.ms)}; report ${e.report.reportFile}`;
    default:
      return undefined;
  }
}

/** The live status for one running step: "step 3: review 1 · 12 turns · 4.2 min · bash". */
export function describeProgress(e: Extract<LoopEvent, { kind: 'step-progress' }>): string {
  const p = e.progress;
  return `step ${e.step.n}: ${e.step.label} · ${p.turns} turns · ${min(p.elapsedMs)}${p.warned ? ' · warned' : ''}${p.tool ? ` · ${p.tool}` : ''}`;
}
