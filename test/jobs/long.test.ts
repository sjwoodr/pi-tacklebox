import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedReason } from '../../src/jobs/index.ts';
import { longRunning } from '../../src/jobs/long.ts';

test('commands that wait on something for minutes are caught', () => {
  for (const command of [
    'gh run watch 123456',
    'gh run watch --exit-status',
    'cd app && gh pr checks 42 --watch',
    'kubectl -n hearth rollout status deploy/hearth-api',
    'kubectl wait --for=condition=ready pod -l app=x',
    'kubectl logs -f deploy/api',
    'docker logs --follow web',
    'kubectl get pods -w',
    'tail -f /var/log/syslog',
    'tail -n 50 -F app.log',
    'watch kubectl get pods',
    'until curl -s localhost:8080; do sleep 5; done',
    'while ! gh run view 1 | grep -q completed; do sleep 30; done',
    'while true\ndo\n  curl -s localhost:8080 && break\n  sleep 5\ndone',
    'until kubectl get pod x; do sleep $DELAY; done',
    'sleep 300',
    'sleep 2m && gh run view 1',
    // A heredoc that runs keeps its text, and a loop after a written one is still seen.
    "bash <<'EOF'\nwhile true; do sleep 5; done\nEOF",
    "cat <<'EOF' | bash\nwhile true; do sleep 5; done\nEOF",
    "cat > a.txt <<'EOF'\nx\nEOF\nwhile true; do sleep 5; done",
    "cat > a.txt <<'EOF'\nwhile true; do sleep 5; done",
  ]) assert.ok(longRunning(command), command);
});

test('ordinary and one-shot commands pass', () => {
  for (const command of [
    'gh run view 123456',
    'gh run list --limit 5',
    // 2026-11-19: Python written to a file, with a while loop and asyncio.sleep in it, is not a polling loop.
    "cat << 'PYEOF' > /tmp/repro.py\nasync def handle(r, w):\n    while True:\n        await r.read(1)\n\nasyncio.run(asyncio.sleep(1))\nPYEOF\npython3 /tmp/repro.py",
    "cat >> /tmp/aip/ai-proxy <<'PYEOF'\n    while True:\n        await asyncio.sleep(5)\nPYEOF",
    'tee notes.md <<EOF\nwhile we wait, sleep\nEOF',
    'cat > loop.sh <<-EOF\n\twhile true; do sleep 9; done\n\tEOF',
    // Program text with a loop and a sleep call is not a shell polling loop (2026-11-19: an echo test).
    'python3 -c "import asyncio; async def h(r, w):\n    while True: await r.read(1)\nasyncio.run(asyncio.sleep(1))"',
    // The trade-off: a Python polling loop is not caught either.
    "python3 <<'EOF'\nimport time\nwhile True:\n    time.sleep(5)\nEOF",
    'gh pr checks 42',
    'kubectl get pods',
    'kubectl logs deploy/api --tail=100',
    'tail -n 50 app.log',
    'npm test',
    'sleep 5',
    'sleep 30 && gh run view 1',
    'grep -r watch src/',
    'cat watchlist.txt',
  ]) assert.equal(longRunning(command), undefined, command);
});

test('the refusal suggests a one-shot check that fits what was refused', () => {
  assert.match(blockedReason(longRunning('gh run watch 1')!), /run `gh run view <id>` instead of `gh run watch`\.$/);
  assert.match(blockedReason(longRunning('until curl -s x; do sleep 5; done')!), /^Not run: this waits on a polling loop[\s\S]*run the loop's check once, without the loop\.$/);
  assert.match(blockedReason(longRunning('sleep 120 && make')!), /waits on a 120 s sleep[\s\S]*run the command without the sleep\.$/);
});
