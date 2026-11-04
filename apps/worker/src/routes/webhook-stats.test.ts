import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { webhookStats } from './webhook-stats.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhookStats);
  return app;
}

const mockDb = {
  prepare: vi.fn(),
};

const baseEnv = {
  DB: mockDb as unknown as D1Database,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/webhook-stats', () => {
  test('returns empty stats when no data exists', async () => {
    const stmt = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    mockDb.prepare.mockReturnValue(stmt);

    const app = setupApp();
    const res = await app.request(
      '/api/webhook-stats',
      { method: 'GET' },
      baseEnv,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.accounts).toEqual([]);
  });

  test('returns per-account stats grouped correctly', async () => {
    const stmt = {
      bind: vi.fn(),
      all: vi.fn()
        .mockResolvedValueOnce({
          results: [
            { line_account_id: 'acc-1', stat_date: '2026-11-03', inbound_count: 10 },
            { line_account_id: 'acc-1', stat_date: '2026-11-02', inbound_count: 5 },
            { line_account_id: 'acc-2', stat_date: '2026-11-03', inbound_count: 8 },
          ],
        })
        .mockResolvedValueOnce({
          results: [
            { stat_date: '2026-11-03', signature_mismatch_count: 2 },
          ],
        }),
    };
    stmt.bind.mockReturnValue(stmt);
    mockDb.prepare.mockReturnValue(stmt);

    const app = setupApp();
    const res = await app.request(
      '/api/webhook-stats?days=7',
      { method: 'GET' },
      baseEnv,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.accounts).toHaveLength(2);
    
    const acc1 = json.data.accounts.find((a: { lineAccountId: string }) => a.lineAccountId === 'acc-1');
    expect(acc1.totalInbound).toBe(15);
    expect(acc1.dailyStats).toHaveLength(2);
    
    expect(json.data.globalMismatches.total).toBe(2);
  });

  test('filters by lineAccountId when provided', async () => {
    const stmt = {
      bind: vi.fn(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    mockDb.prepare.mockReturnValue(stmt);

    const app = setupApp();
    await app.request(
      '/api/webhook-stats?lineAccountId=acc-1',
      { method: 'GET' },
      baseEnv,
    );

    // Verify the query included the account filter
    expect(stmt.bind).toHaveBeenCalled();
    const bindCalls = stmt.bind.mock.calls[0];
    expect(bindCalls).toContain('acc-1');
  });
});

describe('GET /api/webhook-stats/summary', () => {
  test('returns today and 7-day summary', async () => {
    const stmt = {
      bind: vi.fn(),
      first: vi.fn()
        .mockResolvedValueOnce({ total_inbound: 50, total_mismatches: 3 })
        .mockResolvedValueOnce({ total_inbound: 200, total_mismatches: 10 }),
    };
    stmt.bind.mockReturnValue(stmt);
    mockDb.prepare.mockReturnValue(stmt);

    const app = setupApp();
    const res = await app.request(
      '/api/webhook-stats/summary',
      { method: 'GET' },
      baseEnv,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.today).toEqual({ inbound: 50, mismatches: 3 });
    expect(json.data.last7Days).toEqual({ inbound: 200, mismatches: 10 });
  });

  test('handles null results gracefully', async () => {
    const stmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    mockDb.prepare.mockReturnValue(stmt);

    const app = setupApp();
    const res = await app.request(
      '/api/webhook-stats/summary',
      { method: 'GET' },
      baseEnv,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.today).toEqual({ inbound: 0, mismatches: 0 });
    expect(json.data.last7Days).toEqual({ inbound: 0, mismatches: 0 });
  });
});
