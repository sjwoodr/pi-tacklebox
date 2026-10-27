import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    'sleep 300',
    'sleep 2m && gh run view 1',
  ]) assert.ok(longRunning(command), command);
});

test('ordinary and one-shot commands pass', () => {
  for (const command of [
    'gh run view 123456',
    'gh run list --limit 5',
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
