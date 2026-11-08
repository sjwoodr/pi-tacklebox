/**
 * A stand-in for `pi --mode rpc`: reads commands on stdin and answers with pi's responses and session events,
 * driven by a JSON file named in FAKE_PI_CONFIG. Every command received is logged to FAKE_PI_LOG as
 * {"role", "cmd", "message"?}.
 *
 * Config: { implementer?: Behavior, reviewer?: Behavior, wrapUp?: { text?, texts? }, stallFirstStart?: role[] }
 *   Behavior: { turns: number | "forever", delayMs?: number, texts?: string[] (final text per call, last repeats),
 *               steeredText?: string (the report after a steer), ignoreSteer?: boolean,
 *               writeFile?: string (append to this file in cwd each call),
 *               spawnSleeper?: string (write the pid of a `sleep 60` child to this file),
 *               hangOnClose?: boolean (don't exit when stdin closes) }
 *   wrapUp: the answer to each prompt after the first (the final ask or a follow-up).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Behavior {
  turns: number | 'forever';
  delayMs?: number;
  texts?: string[];
  steeredText?: string;
  ignoreSteer?: boolean;
  /** Ignore this many steers, then obey the next one. */
  ignoreSteers?: number;
  writeFile?: string;
  spawnSleeper?: string;
  hangOnClose?: boolean;
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionDir = opt('--session-dir')!;
const promptFile = opt('--append-system-prompt');
const role = promptFile && readFileSync(promptFile, 'utf8').includes('You are the reviewer') ? 'reviewer' : 'implementer';
const config = JSON.parse(readFileSync(process.env.FAKE_PI_CONFIG!, 'utf8'));
const b: Behavior = config[role] ?? { turns: 1 };
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ role, ...entry }) + '\n');
};
const out = (e: unknown) => process.stdout.write(JSON.stringify(e) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

log({ cmd: 'start', args });
if (process.env.FAKE_PI_ENV_LOG) appendFileSync(process.env.FAKE_PI_ENV_LOG, `${process.env.PI_OFFLINE ?? ''}\n`);

// stallFirstStart: the first start of this role never answers anything (a startup hang).
const stallFile = process.env.FAKE_PI_CONFIG + `.${role}.stalled`;
if (config.stallFirstStart?.includes(role) && !existsSync(stallFile)) {
  writeFileSync(stallFile, '1');
  await sleep(600_000);
}

const counterFile = process.env.FAKE_PI_CONFIG + `.${role}.count`;
const call = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
writeFileSync(counterFile, String(call + 1));

mkdirSync(sessionDir, { recursive: true });
const id = `fake${Math.random().toString(16).slice(2, 10)}`;
writeFileSync(join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), '');

let steers = 0;
let abort = false;
let running: Promise<void> | undefined;
let prompts = 0;

async function turn(text: string, delayMs: number) {
  out({ type: 'turn_start' });
  await sleep(Math.max(1, delayMs / 2));
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } });
  await sleep(Math.max(1, delayMs / 2));
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1000, output: 50, cacheRead: 0 } } });
  out({ type: 'turn_end' });
}

async function mainRun() {
  if (b.writeFile) appendFileSync(join(process.cwd(), b.writeFile), `call ${call}\n`);
  if (b.spawnSleeper) writeFileSync(b.spawnSleeper, String(spawn('sleep', ['60'], { stdio: 'ignore' }).pid));
  const texts = b.texts ?? ['done'];
  const max = b.turns === 'forever' ? Infinity : b.turns;
  for (let i = 1; i <= max && !abort; i++) {
    if (steers > (b.ignoreSteers ?? (b.ignoreSteer ? Infinity : 0))) {
      await turn(b.steeredText ?? texts[Math.min(call, texts.length - 1)], b.delayMs ?? 2);
      break;
    }
    await turn(i === max ? texts[Math.min(call, texts.length - 1)] : `working ${i}`, b.delayMs ?? 2);
  }
  out({ type: 'agent_end' });
  out({ type: 'agent_settled', aborted: abort });
  abort = false;
}

async function askRun() {
  const w = config.wrapUp ?? {};
  const n = prompts - 2; // 0 for the first ask
  const text = w.texts ? w.texts[Math.min(n, w.texts.length - 1)] : (w.text ?? 'WRAPPED UP');
  await turn(text, 2);
  out({ type: 'agent_end' });
  out({ type: 'agent_settled', aborted: false });
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let i: number;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    log({ cmd: c.type, message: c.message });
    const respond = (data?: unknown) => out({ id: c.id, type: 'response', command: c.type, success: true, data });
    switch (c.type) {
      case 'get_state':
        respond({ sessionId: id });
        break;
      case 'prompt':
        prompts++;
        respond({ disposition: 'started' });
        running = prompts === 1 ? mainRun() : askRun();
        break;
      case 'steer':
        steers++;
        respond({ disposition: 'queued' });
        break;
      case 'abort':
        abort = true;
        void (running ?? Promise.resolve()).then(() => respond());
        break;
    }
  }
});
process.stdin.on('end', async () => {
  if (b.hangOnClose) return void (await sleep(600_000));
  await running;
  process.exit(0);
});
