# think-budget


Thinking token budgets for [pi](https://pi.dev) on model servers that have none, such as Ollama.

pi's `thinkingBudgets` setting only works where the server enforces a cap (vLLM, llama.cpp).
Ollama only switches thinking on or off, so a local reasoning model can think for minutes
before it says anything, or think and then stop with an empty reply.

This extension enforces the cap on pi's side, the way budget forcing works:

1. It streams the reply and counts thinking tokens.
2. At the cap it aborts the request and sends one more, with thinking off. That request
   carries the reasoning so far as notes and asks the model to answer or make its tool call now.
3. When the reasoning ends with nothing said, it sends the same follow-up.
4. When a follow-up comes back with nothing either (no text, no tool call), it asks again, up to
   four follow-ups in all, so the agent does not stop with an empty reply. An empty follow-up is
   usually a tool call the server dropped: Gemma on Ollama sometimes writes one slightly malformed
   (`call{edit{` for `call:edit{`), and Ollama returns nothing for it, without an error. In replays
   of one cut that happened 3 to 5 times in 10, so two asks still ended empty about a time in five.

pi sees one assistant message: the thinking, then the follow-up's answer or tool call.

On one local grading benchmark, a 200-token cap kept all of unlimited thinking's accuracy
while cutting the worst case from over five minutes to 30 seconds. Most thinking past the
first couple of hundred tokens was wasted.

## Install

Part of pi-tacklebox; see the [README](../README.md#install).

Review third-party pi extensions before installing them: they run with your user permissions.

## Configure

Put the rules in a `thinkBudget` section of `tacklebox.json` in pi's agent directory
(`~/.pi/agent/`, or `$PI_CODING_AGENT_DIR`):

```json
{
  "thinkBudget": {
    "rules": [
      { "provider": "ollama", "model": "gemma4:26b", "budget": 200 },
      { "provider": "ollama", "model": "gpt-oss:20b", "budget": { "low": 200, "medium": 400, "high": 800 } }
    ]
  }
}
```

Without that section, the rules are read from `think-budget.json` in the same directory (the
standalone pi-think-budget's file, `{ "rules": [...] }`), so an existing setup keeps working. When
both are there, the section wins and a warning at startup says the old file is ignored; an empty
`"rules": []` in the section is how to switch the old file off.

| Field | Meaning |
|---|---|
| `provider` | The provider name in your `models.json` |
| `model` | A model id, or a pattern where `*` matches anything (`"gemma4*"`). Leave it out, or use `"*"`, for every model of the provider |
| `budget` | One cap for every thinking level, or a cap per level. A level left out is not capped |
| `api` | The API the provider's models use. Defaults to `"openai-completions"` |

The first matching rule wins, so put exact ids before a pattern that would also cover them, and a
default such as `"gemma4*"` last. Nothing changes when thinking is off. A rule that names no known
model (check the ids with `pi --list-models`) gets a warning when the session starts, since it would
otherwise cap nothing.

The cap applies to the thinking before the model starts its answer. Ollama streams about one
token per chunk, so the extension counts chunks as tokens.

## Override per run

```bash
pi --thinking low --think-budget 100 "..."   # a different cap for this run
pi --thinking low --think-budget 0 "..."     # no cap
```

`--think-budget` only affects models that match a rule.

## Seeing the cuts

Each cut shows a notice, such as "Thinking capped at 200 tokens; asked for the answer", and the
footer keeps a count for the session (`think cap: 3 cuts`). Without a UI (`pi -p`, `--mode json`)
the notice goes to stderr, prefixed `[think-budget]`.

## Ollama ignores pi's max tokens

This is separate from thinking, but it bites the same setups: pi sends a model's `maxTokens` as
`max_completion_tokens`, which Ollama ignores, so a reply that loops runs until something else stops
it. Have pi send `max_tokens` instead, in each Ollama model's `compat` in `models.json`:

```json
"compat": { "maxTokensField": "max_tokens" }
```

With Ollama the limit covers thinking and answer together, so leave room for the thinking budget.

## How it hooks in

The extension registers each configured provider again with only a stream function, so the
provider keeps its models, endpoint and key from `models.json`. The stream delegates to pi's
own implementation for the provider's API. Models without a matching rule pass straight through.

The aborted request never reports usage, so a capped reply's usage counts the thinking from
the stream and leaves out that request's input tokens.

## Development

```bash
npm install
npm test        # node --test, no model needed
npm run check   # tsc
```

## License

MIT
