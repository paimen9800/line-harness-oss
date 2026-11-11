/**
 * Tests for D1 rows-read reduction changes.
 *
 * These tests verify that the optimized queries select the exact same set of
 * rows as the original implementation (semantic equivalence).
 */

import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: { changes: number };
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              const info = stmt.run(...params);
              return { results: [], success: true, meta: { changes: info.changes } };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>(): Promise<D1Result<T>> {
              const rows = stmt.all(...params) as T[];
              return { results: rows, success: true, meta: { changes: 0 } };
            },
          };
        },
        async run() {
          const info = stmt.run();
          return { results: [], success: true, meta: { changes: info.changes } };
        },
        async first<T>() {
          return (stmt.get() as T) ?? null;
        },
        async all<T>(): Promise<D1Result<T>> {
          const rows = stmt.all() as T[];
          return { results: rows, success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  } as unknown as D1Database;
}

describe('getDueScheduledBroadcasts', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(__dirname, '../schema.sql'), 'utf8'));
    sqlite.exec('ALTER TABLE broadcasts ADD COLUMN line_account_id TEXT');
    sqlite.exec('ALTER TABLE broadcasts ADD COLUMN alt_text TEXT');
    db = asD1(sqlite);
  });

  test('selects only scheduled broadcasts with scheduled_at <= now', async () => {
    const now = '2026-11-06T12:00:00.000Z';
    const pastTime = '2026-11-06T11:00:00.000Z';
    const futureTime = '2026-11-06T13:00:00.000Z';

    // Insert test broadcasts
    sqlite.exec(`
      INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, scheduled_at, total_count, success_count, created_at)
      VALUES
        ('b1', 'Due broadcast', 'text', 'hello', 'all', 'scheduled', '${pastTime}', 0, 0, '${pastTime}'),
        ('b2', 'Future broadcast', 'text', 'hello', 'all', 'scheduled', '${futureTime}', 0, 0, '${pastTime}'),
        ('b3', 'Draft broadcast', 'text', 'hello', 'all', 'draft', '${pastTime}', 0, 0, '${pastTime}'),
        ('b4', 'Already sent', 'text', 'hello', 'all', 'sent', '${pastTime}', 100, 100, '${pastTime}'),
        ('b5', 'Due broadcast 2', 'text', 'hello', 'all', 'scheduled', '${now}', 0, 0, '${pastTime}'),
        ('b6', 'No scheduled_at', 'text', 'hello', 'all', 'scheduled', NULL, 0, 0, '${pastTime}')
    `);

    const { getDueScheduledBroadcasts } = await import('../src/broadcasts.js');
    const result = await getDueScheduledBroadcasts(db, now);

    // Should return only b1 and b5 (scheduled, scheduled_at <= now)
    const ids = result.map((b) => b.id).sort();
    expect(ids).toEqual(['b1', 'b5']);
  });

  test('respects LIMIT parameter', async () => {
    const now = '2026-11-06T12:00:00.000Z';
    const pastTime = '2026-11-06T11:00:00.000Z';

    // Insert 10 due broadcasts
    for (let i = 1; i <= 10; i++) {
      sqlite.exec(`
        INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, scheduled_at, total_count, success_count, created_at)
        VALUES ('b${i}', 'Broadcast ${i}', 'text', 'hello', 'all', 'scheduled', '${pastTime}', 0, 0, '${pastTime}')
      `);
    }

    const { getDueScheduledBroadcasts } = await import('../src/broadcasts.js');
    const result = await getDueScheduledBroadcasts(db, now, 5);

    expect(result.length).toBe(5);
  });

  test('orders by scheduled_at ASC', async () => {
    const now = '2026-11-06T12:00:00.000Z';

    sqlite.exec(`
      INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, scheduled_at, total_count, success_count, created_at)
      VALUES
        ('b1', 'Later', 'text', 'hello', 'all', 'scheduled', '2026-11-06T11:30:00.000Z', 0, 0, '2026-11-01T00:00:00Z'),
        ('b2', 'Earlier', 'text', 'hello', 'all', 'scheduled', '2026-11-06T10:00:00.000Z', 0, 0, '2026-11-01T00:00:00Z'),
        ('b3', 'Middle', 'text', 'hello', 'all', 'scheduled', '2026-11-06T11:00:00.000Z', 0, 0, '2026-11-01T00:00:00Z')
    `);

    const { getDueScheduledBroadcasts } = await import('../src/broadcasts.js');
    const result = await getDueScheduledBroadcasts(db, now);

    expect(result.map((b) => b.id)).toEqual(['b2', 'b3', 'b1']);
  });
});

describe('getFriendScenariosDueForDelivery', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(__dirname, '../schema.sql'), 'utf8'));
    db = asD1(sqlite);
  });

  test('selects only active scenarios with next_delivery_at <= now (Z timezone)', async () => {
    const now = '2026-11-06T12:00:00.000Z';
    const pastTime = '2026-11-06T11:00:00.000Z';
    const futureTime = '2026-11-06T13:00:00.000Z';

    // Insert friends first (foreign key)
    sqlite.exec(`
      INSERT INTO friends (id, line_user_id, is_following, created_at, updated_at)
      VALUES ('f1', 'U1', 1, '${now}', '${now}'),
             ('f2', 'U2', 1, '${now}', '${now}'),
             ('f3', 'U3', 1, '${now}', '${now}'),
             ('f4', 'U4', 1, '${now}', '${now}'),
             ('f5', 'U5', 1, '${now}', '${now}')
    `);

    // Insert scenario
    sqlite.exec(`
      INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode, created_at, updated_at)
      VALUES ('s1', 'Test scenario', 'friend_add', 1, 'relative', '${now}', '${now}')
    `);

    // Insert friend_scenarios with various states
    // Note: friend_scenarios uses started_at instead of created_at
    sqlite.exec(`
      INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, next_delivery_at, started_at, updated_at)
      VALUES
        ('fs1', 'f1', 's1', 1, 'active', '${pastTime}', '${now}', '${now}'),
        ('fs2', 'f2', 's1', 1, 'active', '${futureTime}', '${now}', '${now}'),
        ('fs3', 'f3', 's1', 1, 'completed', '${pastTime}', '${now}', '${now}'),
        ('fs4', 'f4', 's1', 1, 'active', NULL, '${now}', '${now}'),
        ('fs5', 'f5', 's1', 1, 'active', '${now}', '${now}', '${now}')
    `);

    const { getFriendScenariosDueForDelivery } = await import('../src/scenarios.js');
    const result = await getFriendScenariosDueForDelivery(db, now);

    // Should return only fs1 and fs5 (active, next_delivery_at <= now)
    const ids = result.map((fs) => fs.id).sort();
    expect(ids).toEqual(['fs1', 'fs5']);
  });

  test('handles mixed timezone formats (Z and +09:00)', async () => {
    // This is the key semantic test: the original code used epoch comparison
    // to handle mixed timezone formats. The new code uses julianday() which
    // should produce the same results.
    const nowZ = '2026-11-06T03:00:00.000Z'; // = 12:00 JST
    const pastJst = '2026-11-06T11:00:00.000+09:00'; // = 02:00 UTC, before nowZ
    const futureJst = '2026-11-06T13:00:00.000+09:00'; // = 04:00 UTC, after nowZ

    // Insert friends first (foreign key)
    sqlite.exec(`
      INSERT INTO friends (id, line_user_id, is_following, created_at, updated_at)
      VALUES ('f1', 'U1', 1, '${nowZ}', '${nowZ}'),
             ('f2', 'U2', 1, '${nowZ}', '${nowZ}')
    `);

    sqlite.exec(`
      INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode, created_at, updated_at)
      VALUES ('s1', 'Test scenario', 'friend_add', 1, 'relative', '${nowZ}', '${nowZ}')
    `);

    sqlite.exec(`
      INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, next_delivery_at, started_at, updated_at)
      VALUES
        ('fs1', 'f1', 's1', 1, 'active', '${pastJst}', '${nowZ}', '${nowZ}'),
        ('fs2', 'f2', 's1', 1, 'active', '${futureJst}', '${nowZ}', '${nowZ}')
    `);

    const { getFriendScenariosDueForDelivery } = await import('../src/scenarios.js');
    const result = await getFriendScenariosDueForDelivery(db, nowZ);

    // fs1 has next_delivery_at = 02:00 UTC which is before 03:00 UTC (nowZ)
    // fs2 has next_delivery_at = 04:00 UTC which is after 03:00 UTC (nowZ)
    expect(result.map((fs) => fs.id)).toEqual(['fs1']);
  });

  test('excludes inactive scenarios', async () => {
    const now = '2026-11-06T12:00:00.000Z';
    const pastTime = '2026-11-06T11:00:00.000Z';

    // Insert friend first (foreign key)
    sqlite.exec(`
      INSERT INTO friends (id, line_user_id, is_following, created_at, updated_at)
      VALUES ('f1', 'U1', 1, '${now}', '${now}')
    `);

    // Insert inactive scenario
    sqlite.exec(`
      INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode, created_at, updated_at)
      VALUES ('s1', 'Inactive scenario', 'friend_add', 0, 'relative', '${now}', '${now}')
    `);

    sqlite.exec(`
      INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, next_delivery_at, started_at, updated_at)
      VALUES ('fs1', 'f1', 's1', 1, 'active', '${pastTime}', '${now}', '${now}')
    `);

    const { getFriendScenariosDueForDelivery } = await import('../src/scenarios.js');
    const result = await getFriendScenariosDueForDelivery(db, now);

    expect(result).toEqual([]);
  });

  test('respects LIMIT parameter', async () => {
    const now = '2026-11-06T12:00:00.000Z';
    const pastTime = '2026-11-06T11:00:00.000Z';

    // Insert friends first (foreign key)
    for (let i = 1; i <= 10; i++) {
      sqlite.exec(`
        INSERT INTO friends (id, line_user_id, is_following, created_at, updated_at)
        VALUES ('f${i}', 'U${i}', 1, '${now}', '${now}')
      `);
    }

    sqlite.exec(`
      INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode, created_at, updated_at)
      VALUES ('s1', 'Test scenario', 'friend_add', 1, 'relative', '${now}', '${now}')
    `);

    // Insert 10 due enrollments
    for (let i = 1; i <= 10; i++) {
      sqlite.exec(`
        INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, next_delivery_at, started_at, updated_at)
        VALUES ('fs${i}', 'f${i}', 's1', 1, 'active', '${pastTime}', '${now}', '${now}')
      `);
    }

    const { getFriendScenariosDueForDelivery } = await import('../src/scenarios.js');
    const result = await getFriendScenariosDueForDelivery(db, now, 5);

    expect(result.length).toBe(5);
  });

  test('orders by next_delivery_at ASC', async () => {
    const now = '2026-11-06T12:00:00.000Z';

    // Insert friends first (foreign key)
    sqlite.exec(`
      INSERT INTO friends (id, line_user_id, is_following, created_at, updated_at)
      VALUES ('f1', 'U1', 1, '${now}', '${now}'),
             ('f2', 'U2', 1, '${now}', '${now}'),
             ('f3', 'U3', 1, '${now}', '${now}')
    `);

    sqlite.exec(`
      INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode, created_at, updated_at)
      VALUES ('s1', 'Test scenario', 'friend_add', 1, 'relative', '${now}', '${now}')
    `);

    sqlite.exec(`
      INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, next_delivery_at, started_at, updated_at)
      VALUES
        ('fs1', 'f1', 's1', 1, 'active', '2026-11-06T11:30:00.000Z', '${now}', '${now}'),
        ('fs2', 'f2', 's1', 1, 'active', '2026-11-06T10:00:00.000Z', '${now}', '${now}'),
        ('fs3', 'f3', 's1', 1, 'active', '2026-11-06T11:00:00.000Z', '${now}', '${now}')
    `);

    const { getFriendScenariosDueForDelivery } = await import('../src/scenarios.js');
    const result = await getFriendScenariosDueForDelivery(db, now);

    expect(result.map((fs) => fs.id)).toEqual(['fs2', 'fs3', 'fs1']);
  });
});
