/**
 * web_fetch for the searxng backend: the page is downloaded from this machine.
 *
 * Local and private addresses (loopback, LAN, link-local) are refused, checked again on every
 * redirect, so a web page's text can't steer the model into reading Ollama, SearXNG or anything
 * else on this machine or network. The check resolves DNS before fetching, so a host that changes
 * its answer in between could still slip past; fine for a personal tool, not a sandbox.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { clip, MAX_TITLE, type Page } from './guidance.ts';

const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) pi-web-fetch';

/** Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    // Any other IPv4-mapped form (::ffff:7f00:1) is refused outright.
    return v6 === '::' || v6 === '::1' || v6.startsWith('::ffff:') || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

async function assertPublic(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`${url.hostname} is a local or private address, which web_fetch doesn't read`);
  }
}

async function fetchPublic(start: URL, signal: AbortSignal): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en,fr;q=0.8',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('the page redirected to a non-web address');
      continue;
    }
    return { res, url };
  }
  throw new Error('too many redirects');
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const charset =
    contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', copy: '©', deg: '°',
  oelig: 'œ', OElig: 'Œ', szlig: 'ß',
};
// &eacute; &Agrave; &ccedil; ...: every accented letter French uses.
for (const [name, mark] of Object.entries({ acute: '́', grave: '̀', circ: '̂', uml: '̈', cedil: '̧' })) {
  for (const letter of 'aeiouycAEIOUYC') {
    const char = (letter + mark).normalize('NFC');
    if (char.length === 1) ENTITIES[letter + name] = char;
  }
}

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[e] ?? match;
  });

/** Readable text from HTML: the <main> (or <article>) part when it has real
 *  content, minus scripts, navigation and footers; headings and list items kept. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = clip(decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''), MAX_TITLE);
  const clean = (part: string) =>
    decodeEntities(
      part
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' | ')
        .replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|pre|h[1-6]|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    )
      .split('\n')
      .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  for (const tag of ['main', 'article']) {
    const start = body.search(new RegExp(`<${tag}\\b`, 'i'));
    const end = body.toLowerCase().lastIndexOf(`</${tag}>`);
    if (start >= 0 && end > start) {
      const text = clean(body.slice(start, end));
      if (text.length >= 300) return { title, text };
    }
  }
  return { title, text: clean(body) };
}

/** The page's readable text; throws with the reason the model is told when it can't. */
export async function fetchPage(address: string, signal: AbortSignal): Promise<Page> {
  const { res, url } = await fetchPublic(new URL(address), signal);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the site returned ${res.status}`);
  }
  const type = (res.headers.get('content-type') ?? 'text/html').toLowerCase();
  const isHtml = /html/.test(type);
  if (!isHtml && !/^text\/|json|xml/.test(type)) {
    await res.body?.cancel();
    throw new Error(`it is ${type.split(';')[0]}, not a web page or text`);
  }
  const raw = decodeBody(await readCapped(res, MAX_BYTES), type);
  const page = isHtml ? htmlToText(raw) : { title: '', text: raw.trim() };
  if (!page.text) throw new Error('the page has no readable text (it may need JavaScript)');
  return { url: url.href, ...page };
}
