import type { LoopEvent } from './loop.ts';

const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const rate = (tokens: number, ms: number) => (ms > 0 && tokens > 0 ? `${Math.round((tokens * 1000) / ms)}/s` : '-');

/** One line per loop event worth showing (progress ticks return undefined). */
export function describeEvent(e: LoopEvent): string | undefined {
  switch (e.kind) {
    case 'start':
      return `pi-loop ${e.runId}: sessions in ${e.sessionDir}`;
    case 'step-start':
      return `#${e.step.n} round ${e.step.round}: ${e.step.role} ${e.step.kind}…`;
    case 'step-end': {
      const s = e.step;
      const limit = s.stoppedBy ? ` · stopped by ${s.stoppedBy}${s.wrappedUp ? ', wrapped up' : ''}` : '';
      const v = s.verdict ? ` · VERDICT ${s.verdict.verdict} (${s.verdict.counts.critical} critical, ${s.verdict.counts.high} high, ${s.verdict.counts.minor} minor)` : '';
      return `#${s.n} ${s.role} ${s.kind} done: ${s.turns} turns · ${min(s.ms)} · read ${rate(s.readTokens, s.readMs)} · write ${rate(s.writeTokens, s.writeMs)}${limit}${v}`;
    }
    case 'gates':
      return `checks: ${e.results.map((g) => `${g.command} ${g.ok ? 'ok' : g.timedOut ? 'TIMED OUT' : 'FAILED'}`).join(', ') || 'none'}`;
    case 'done':
      return `pi-loop done: ${e.report.outcome} (${e.report.detail}) in ${min(e.report.ms)}; report ${e.report.reportFile}`;
    default:
      return undefined;
  }
}

/** The live status for one running step: "#3 reviewer review · 12 turns · 4.2 min · bash". */
export function describeProgress(e: Extract<LoopEvent, { kind: 'step-progress' }>): string {
  const p = e.progress;
  return `#${e.step.n} ${e.step.role} ${e.step.kind} · ${p.turns} turns · ${min(p.elapsedMs)}${p.tool ? ` · ${p.tool}` : ''}`;
}
