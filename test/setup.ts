// Every test process starts with an empty pi agent dir, so the developer's own tacklebox.json (a
// sandbox that is on, say) never changes what a test runs. A test that needs settings sets its own.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'tacklebox-agent-'));
