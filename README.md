# pi-tacklebox

A box of extensions for [pi](https://pi.dev), mostly for running local models on Ollama. The
parts aren't related; each one fixes one thing and can be switched off on its own.

| Extension | What it does | Default |
|---|---|---|
| think-budget | Caps thinking tokens on servers that have no thinking budget (Ollama): stops the reasoning at the cap and asks for the answer, with the reasoning so far as notes. [docs/think-budget.md](docs/think-budget.md) | on for the models in `think-budget.json` |
| turn-timer | How long each turn took, in the status bar: `⏱ 45.6s · first 0.7s · read 10k @ 310/s · wrote 375 @ 60/s · 13k cached · 3 reqs` (prompt reading and writing timed apart, per request) | on |
| outline-reads | A whole-file read of a large file returns its first 80 lines and an outline of definitions with line numbers, so a slow machine doesn't spend a minute reading 100 KB; reads with `offset`/`limit` are untouched | off |
| search | `web_search` and `web_fetch` tools, through a SearXNG instance or Ollama's web search, with prompt guidance that includes today's date | off |

## Install

```bash
pi install git:https://github.com/sjwoodr/pi-tacklebox
```

If you used the standalone `pi-think-budget` before, remove
`git:https://github.com/sjwoodr/pi-think-budget` from `~/.pi/agent/settings.json`, or the budget
loads twice. Its configuration (`~/.pi/agent/think-budget.json`) is unchanged.
Likewise remove any loose copies of these extensions from `~/.pi/agent/extensions/` (a second
`web_search` tool stops pi from starting).

## Configure

`~/.pi/agent/tacklebox.json` (or `$PI_CODING_AGENT_DIR/tacklebox.json`); every setting is optional,
and no file means the defaults below. A misspelt setting is an error at startup, not ignored.

```json
{
  "turnTimer": { "enabled": true },
  "outlineReads": { "enabled": false, "maxChars": 20000 },
  "search": {
    "backend": "off",
    "searxngUrl": "http://127.0.0.1:8888",
    "ollamaUrl": "http://127.0.0.1:11434"
  }
}
```

- `search.backend`: `"off"`, `"searxng"` (needs a SearXNG with the JSON format enabled; pages are
  fetched from your machine, never from local or private addresses) or `"ollama"` (Ollama's web
  search through your local Ollama; needs `ollama signin`, and queries and fetched URLs go to
  ollama.com).
- `outlineReads.maxChars`: a whole-file read returning more text than this gets the outline.

think-budget has its own file, `think-budget.json`: see [docs/think-budget.md](docs/think-budget.md).

To leave an extension out entirely, filter it in pi's settings:

```json
{ "source": "git:https://github.com/sjwoodr/pi-tacklebox", "extensions": ["!src/think-budget/**"] }
```

## Development

```bash
npm install
npm test        # node --test
npm run check   # tsc
```

## License

MIT
