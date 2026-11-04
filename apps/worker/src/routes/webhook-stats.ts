import { Hono } from 'hono';
import type { Env } from '../index.js';

const webhookStats = new Hono<Env>();

interface WebhookStatRow {
  id: string;
  line_account_id: string | null;
  stat_date: string;
  inbound_count: number;
  signature_mismatch_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/webhook-stats
 * Returns webhook signature verification statistics.
 * Query params:
 *   - lineAccountId: filter by account (optional)
 *   - days: number of days to look back (default 30, max 90)
 *   - includeMismatches: include global mismatch stats (default true)
 */
webhookStats.get('/api/webhook-stats', async (c) => {
  try {
    const db = c.env.DB;
    const lineAccountId = c.req.query('lineAccountId');
    const daysParam = c.req.query('days');
    const days = Math.min(90, Math.max(1, Number(daysParam) || 30));
    const includeMismatches = c.req.query('includeMismatches') !== 'false';

    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const results: {
      accounts: Array<{
        lineAccountId: string;
        totalInbound: number;
        dailyStats: Array<{ date: string; inbound: number }>;
      }>;
      globalMismatches?: {
        total: number;
        dailyStats: Array<{ date: string; mismatches: number }>;
      };
    } = { accounts: [] };

    // Get per-account stats
    let accountQuery = `
      SELECT line_account_id, stat_date, inbound_count
      FROM webhook_signature_stats
      WHERE line_account_id IS NOT NULL AND stat_date >= ?
    `;
    const binds: unknown[] = [cutoffDate];

    if (lineAccountId) {
      accountQuery += ' AND line_account_id = ?';
      binds.push(lineAccountId);
    }
    accountQuery += ' ORDER BY line_account_id, stat_date DESC';

    const accountRows = await db
      .prepare(accountQuery)
      .bind(...binds)
      .all<Pick<WebhookStatRow, 'line_account_id' | 'stat_date' | 'inbound_count'>>();

    // Group by account
    const byAccount = new Map<
      string,
      { totalInbound: number; dailyStats: Array<{ date: string; inbound: number }> }
    >();

    for (const row of accountRows.results) {
      if (!row.line_account_id) continue;
      let entry = byAccount.get(row.line_account_id);
      if (!entry) {
        entry = { totalInbound: 0, dailyStats: [] };
        byAccount.set(row.line_account_id, entry);
      }
      entry.totalInbound += row.inbound_count;
      entry.dailyStats.push({ date: row.stat_date, inbound: row.inbound_count });
    }

    results.accounts = Array.from(byAccount.entries()).map(([id, data]) => ({
      lineAccountId: id,
      ...data,
    }));

    // Get global mismatch stats (line_account_id IS NULL)
    if (includeMismatches) {
      const mismatchRows = await db
        .prepare(`
          SELECT stat_date, signature_mismatch_count
          FROM webhook_signature_stats
          WHERE line_account_id IS NULL AND stat_date >= ?
          ORDER BY stat_date DESC
        `)
        .bind(cutoffDate)
        .all<Pick<WebhookStatRow, 'stat_date' | 'signature_mismatch_count'>>();

      let totalMismatches = 0;
      const dailyMismatches: Array<{ date: string; mismatches: number }> = [];

      for (const row of mismatchRows.results) {
        totalMismatches += row.signature_mismatch_count;
        dailyMismatches.push({ date: row.stat_date, mismatches: row.signature_mismatch_count });
      }

      results.globalMismatches = {
        total: totalMismatches,
        dailyStats: dailyMismatches,
      };
    }

    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('GET /api/webhook-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/webhook-stats/summary
 * Returns a quick summary of recent webhook activity for the dashboard.
 */
webhookStats.get('/api/webhook-stats/summary', async (c) => {
  try {
    const db = c.env.DB;

    // Get total inbound and mismatches for the last 24h and 7d
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const [todayStats, weekStats] = await Promise.all([
      db
        .prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN line_account_id IS NOT NULL THEN inbound_count ELSE 0 END), 0) as total_inbound,
            COALESCE(SUM(CASE WHEN line_account_id IS NULL THEN signature_mismatch_count ELSE 0 END), 0) as total_mismatches
          FROM webhook_signature_stats
          WHERE stat_date = ?
        `)
        .bind(today)
        .first<{ total_inbound: number; total_mismatches: number }>(),
      db
        .prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN line_account_id IS NOT NULL THEN inbound_count ELSE 0 END), 0) as total_inbound,
            COALESCE(SUM(CASE WHEN line_account_id IS NULL THEN signature_mismatch_count ELSE 0 END), 0) as total_mismatches
          FROM webhook_signature_stats
          WHERE stat_date >= ?
        `)
        .bind(weekAgo)
        .first<{ total_inbound: number; total_mismatches: number }>(),
    ]);

    return c.json({
      success: true,
      data: {
        today: {
          inbound: todayStats?.total_inbound ?? 0,
          mismatches: todayStats?.total_mismatches ?? 0,
        },
        last7Days: {
          inbound: weekStats?.total_inbound ?? 0,
          mismatches: weekStats?.total_mismatches ?? 0,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/webhook-stats/summary error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { webhookStats };
