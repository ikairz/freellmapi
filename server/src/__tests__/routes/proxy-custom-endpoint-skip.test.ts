import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// #788 × #651: `custom` is not one provider. It is a pseudo-platform whose rows
// are unrelated third-party relays — each with its own base URL (endpoint_scope),
// its own keys and its own uptime. A provider-level failure (5xx, timeout, dead
// socket) is about ONE operator, so #788 rules the operator out for the rest of
// the request. Scoped by the platform NAME, that ruled out every custom relay at
// once: a model that exists only on `custom` (most of them) was left with an
// empty chain, so the loop exited after a single hop and the client saw a hard
// error with zero failover — a "fetch failed" on one relay looked exactly like
// "no fallback configured".
//
// The skip is therefore keyed by "custom:<endpoint>" so one dead relay moves the
// chain to the NEXT RELAY instead of out of the platform entirely.
//
// End-to-end through the real router, the way the bug reached production.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { mockCheckKeyHealth, mockMarkKeyHealthy } = vi.hoisted(() => ({
  mockCheckKeyHealth: vi.fn(),
  mockMarkKeyHealthy: vi.fn(),
}));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: mockMarkKeyHealthy,
}));

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};
// undici's transport error: DNS/TLS/proxy down. No HTTP status attached — the
// classifier matches it by message, and it IS provider-level (error-classify).
const errFetchFailed = () => new Error('fetch failed');
const err502 = () => Object.assign(new Error('Provider error (x/y): terminated'), { status: 502 });

// The decrypted key text identifies every dispatched attempt (chatCompletion's
// first argument), so it also identifies which ENDPOINT was hit.
const keysUsed = (): string[] => chatCompletion.mock.calls.map(call => String(call[0]));

const RELAY_A = 'https://relay-a.example/v1';
const RELAY_B = 'https://relay-b.example/v1';

// Two custom models, one per relay, ranked so relay A is tried first. Both are
// platform 'custom', so platform-name scoping would starve the chain at hop 1.
function setup(): void {
  const db = getDb();
  setRoutingStrategy('priority');
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  // Retire every catalog model from the chain instead of deleting the rows:
  // models is a parent of fallback_config/profile_models, so a DELETE here
  // trips the FK constraints that keep attempt and profile rows honest.
  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('DELETE FROM api_keys').run();

  const insertKey = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `);
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                        context_window, enabled, key_id, source, endpoint_scope)
    VALUES ('custom', ?, ?, 50, 50, 128000, 1, ?, 'custom', ?)
    ON CONFLICT(platform, model_id, endpoint_scope)
    DO UPDATE SET enabled = 1, key_id = excluded.key_id
  `);
  const findModel = db.prepare(
    'SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ?',
  );

  for (const [label, relay, modelId] of [
    ['relay-a', RELAY_A, 'vendor/model-on-a'],
    ['relay-b', RELAY_B, 'vendor/model-on-b'],
  ] as const) {
    const { encrypted, iv, authTag } = encrypt(`custom-${label}`);
    const info = insertKey.run('custom', label, encrypted, iv, authTag);
    insertModel.run(modelId, modelId, Number(info.lastInsertRowid), relay);
    const row = findModel.get('custom', modelId, relay) as { id: number };
    const modelDbId = row.id;
    // The chain row is unique per model — clear any leftover before re-ranking
    // so a previous setup() in the same in-memory DB cannot win on priority.
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(modelDbId);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
      .run(modelDbId, label === 'relay-a' ? 1 : 2);
  }
}

describe('custom endpoints fail over per-endpoint, not per-platform (#788 × #651)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    mockCheckKeyHealth.mockReset();
    mockCheckKeyHealth.mockResolvedValue('invalid');
    setup();
  });

  it('a dead socket on relay A fails over to relay B instead of ending the chain', async () => {
    chatCompletion
      .mockRejectedValueOnce(errFetchFailed())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(keysUsed()).toEqual(['custom-relay-a', 'custom-relay-b']);
  });

  it('a 502 on relay A also reaches relay B (status-based provider errors too)', async () => {
    chatCompletion
      .mockRejectedValueOnce(err502())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(keysUsed()).toEqual(['custom-relay-a', 'custom-relay-b']);
  });
});
