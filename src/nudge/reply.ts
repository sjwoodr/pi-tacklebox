/** The parts of a finished assistant message the checks look at. */
export interface Reply {
  role: string;
  stopReason?: string;
  content: { type: string; text?: string }[];
}

export type Problem = 'leaked' | 'empty' | 'announced';

// Tool-call markup that reached the reply as text because the server didn't parse it: Gemma 4's
// `<|tool_call>call:edit{...}<tool_call|>` (a UD code-suite run ended on `<tool_call|><|tool_response>`)
// and Qwen's `<tool_call>` / `<function=read>` (qwen3-coder:30b, 2 of 24 code-suite runs), plus tags
// it makes up when the call format slips: the UD wrote `<edit_call>` and a JSON body after a think-budget
// cut, and no edit ran. A line that opens with a tag naming a tool, call or function counts.
const LEAKED = /<\|?tool_call\|?>|<\|tool_response>|<\/?tool_call>|<function=[\w.-]+>|^\s*call:\w+\{|^\s*<\|?[\w-]*(?:tool|call|function)[\w-]*\|?(?:>|\s|=)/im;

/** What went wrong with the reply the run is about to end on, or undefined when nothing did. Only a
 *  reply with no tool call can be a problem: with one, pi runs it and the run goes on. */
export function problemWith(reply: Reply | undefined): Problem | undefined {
  if (!reply || reply.role !== 'assistant') return undefined;
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return undefined;
  if (reply.content.some((c) => c.type === 'toolCall')) return undefined;
  const text = reply.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
  if (LEAKED.test(text)) return 'leaked';
  if (!text) return 'empty';
  // "First, let me update `src/money.ts`:" and then nothing (qwen3-coder:30b, 2 of 24 runs).
  if (text.endsWith(':')) return 'announced';
  return undefined;
}

export const NUDGES: Record<Problem, string> = {
  leaked:
    "Your last tool call didn't run: it came out as plain text instead of a tool call. Make the call again, as a tool call.",
  empty: 'Your last reply was empty. Continue: answer, or make the tool call you need.',
  announced:
    "You said what you would do next but made no tool call, so nothing happened. Make the call now, or say you're done.",
};
