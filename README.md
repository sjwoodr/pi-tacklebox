# pi-tacklebox

A box of extensions for [pi](https://pi.dev), mostly for running local models on Ollama. The
parts aren't related; each one fixes one thing and can be switched off on its own.

| Extension | What it does | Docs |
|---|---|---|
| think-budget | Caps thinking tokens on servers that have no thinking budget (Ollama): stops the reasoning at the cap and asks for the answer, with the reasoning so far as notes | [docs/think-budget.md](docs/think-budget.md) |

More are on the way.

## Install

```bash
pi install git:https://github.com/sjwoodr/pi-tacklebox
```

If you used the standalone `pi-think-budget` before, remove
`git:https://github.com/sjwoodr/pi-think-budget` from `~/.pi/agent/settings.json`, or the budget
loads twice. Its configuration (`~/.pi/agent/think-budget.json`) is unchanged.

To leave an extension out, filter it in your settings:

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
