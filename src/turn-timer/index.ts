/**
 * turn-timer: how long each turn took, like Codex's "Worked for 47s".
 *
 * After every turn the status bar shows, for example:
 *   ⏱ 45.6s · first 0.7s · read 10k @ 310/s · wrote 375 @ 60/s · 13k cached · 3 reqs
 *
 * Kept short so it fits a narrow terminal: pi cuts the status line at the
 * window width.
 *
 *   total        start of the turn to the end, tool calls included
 *   first        time until the model's first streamed output: mostly the
 *                prompt being read, so a big number here is a cold cache
 *   read N @ R   prompt tokens read fresh (not from the provider's cache),
 *                summed over the turn's requests, and their rate: each
 *                request's wait for its first output. Rate left out under
 *                500 tokens, where latency swamps it
 *   wrote N @ R  output tokens and the generation rate: each request's first
 *                output to its end. Rate left out under 10 tokens
 *   N cached     the last request's prompt tokens reused from the cache
 *
 * A turn with tool calls makes several model requests ("N reqs"). Timing
 * each one keeps prompt reading out of the generation rate: the old single
 * rate (output over first output to end) counted a re-read README as slow
 * writing, so a Mac at 60 tok/s showed "8/s". A silence of over GAP_MS inside
 * a reply is counted as reading too: pi-think-budget's cut aborts the request
 * and sends a follow-up inside the same message, whose prompt read showed up
 * as writing (a 60 tok/s model at "33/s"). Streamed tokens come every ~20 ms.
 *
 * Colours come from pi's theme roles, so they follow whatever theme is in use,
 * and they carry meaning: first output is green under 5 s, yellow to 20 s and
 * red beyond (a cold prompt read); fresh prompt tokens ("read") turn yellow over 2,000
 * (a big uncached read); cached tokens are green.
 *
 * In print mode (pi -p) there is no status bar, so the line goes to stderr,
 * uncoloured.
 *
 * On by default; `"turnTimer": { "enabled": false }` in tacklebox.json turns it off.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config.ts';

const GAP_MS = 500;

export default function (pi: ExtensionAPI) {
  if (!loadConfig().turnTimer.enabled) return;
  let start = 0;
  let firstOutput = 0;
  let outputTokens = 0;
  let freshTokens = 0;
  let lastCached = 0;
  let requests = 0;
  // The request in progress, and time summed over the turn's requests.
  let requestStart = 0;
  let requestFirst = 0;
  let lastEvent = 0;
  let gapMs = 0;
  let readMs = 0;
  let writeMs = 0;

  pi.on('agent_start', async () => {
    start = Date.now();
    firstOutput = 0;
    outputTokens = 0;
    freshTokens = 0;
    lastCached = 0;
    requests = 0;
    requestStart = 0;
    requestFirst = 0;
    lastEvent = 0;
    gapMs = 0;
    readMs = 0;
    writeMs = 0;
  });

  // One model request per pi turn; the hooks before it take milliseconds.
  pi.on('turn_start', async () => {
    requestStart = Date.now();
    requestFirst = 0;
    lastEvent = 0;
    gapMs = 0;
  });

  // The first streamed event marks the end of the wait. Kept trivial: these
  // handlers are awaited in stream order.
  pi.on('provider_stream_event', async () => {
    if (!start) return;
    const now = Date.now();
    if (!firstOutput) firstOutput = now;
    if (requestStart && !requestFirst) requestFirst = now;
    if (lastEvent && now - lastEvent > GAP_MS) gapMs += now - lastEvent;
    lastEvent = now;
  });

  pi.on('message_end', async (event) => {
    const message = event.message as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
    if (message.role !== 'assistant' || !message.usage) return;
    requests += 1;
    outputTokens += message.usage.output ?? 0;
    freshTokens += message.usage.input ?? 0;
    lastCached = message.usage.cacheRead ?? 0;
    if (requestStart && requestFirst) {
      readMs += requestFirst - requestStart + gapMs;
      writeMs += Date.now() - requestFirst - gapMs;
    }
    requestStart = 0;
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!start) return;
    const end = Date.now();
    const color = ctx.hasUI
      ? (role: string, text: string) => ctx.ui.theme.fg(role as never, text)
      : (_role: string, text: string) => text;
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const k = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const parts = [color('accent', `⏱ ${secs(end - start)}`)];
    if (firstOutput) {
      const wait = firstOutput - start;
      const role = wait < 5000 ? 'success' : wait < 20000 ? 'warning' : 'error';
      parts.push(color(role, `first ${secs(wait)}`));
    }
    const rate = (n: number, ms: number, min: number) => (ms > 0 && n >= min ? ` @ ${Math.round((n * 1000) / ms)}/s` : '');
    if (freshTokens) {
      parts.push(color(freshTokens > 2000 ? 'warning' : 'muted', `read ${k(freshTokens)}${rate(freshTokens, readMs, 500)}`));
    }
    if (outputTokens) parts.push(color('muted', `wrote ${k(outputTokens)}${rate(outputTokens, writeMs, 10)}`));
    if (lastCached) parts.push(color('success', `${k(lastCached)} cached`));
    if (requests > 1) parts.push(color('muted', `${requests} reqs`));
    const line = parts.join(color('dim', ' · '));
    start = 0;

    if (ctx.hasUI) ctx.ui.setStatus('turn-timer', line);
    else process.stderr.write(`${line}\n`);
  });
}
