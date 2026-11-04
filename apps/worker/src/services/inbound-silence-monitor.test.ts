import { describe, expect, test, vi, beforeEach } from 'vitest';
import { checkInboundSilence, notifyInboundSilence } from './inbound-silence-monitor.js';

vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn(),
  createNotification: vi.fn().mockResolvedValue(undefined),
  hasNotificationSince: vi.fn(),
  getActiveNotificationRulesByEvent: vi.fn().mockResolvedValue([]),
  getActiveOutgoingWebhooksByEvent: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn().mockReturnValue('2026-11-04T12:00:00.000+09:00'),
}));

vi.mock('./event-bus.js', () => ({
  fireOutgoingWebhooks: vi.fn().mockResolvedValue(0),
}));

import {
  getLineAccounts,
  createNotification,
  hasNotificationSince,
} from '@line-crm/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkInboundSilence', () => {
  const mockDb = {} as D1Database;

  test('returns zero alerted when all accounts have recent inbound', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        is_active: 1,
        last_inbound_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
      } as unknown as Parameters<typeof getLineAccounts>[0] extends D1Database
        ? Awaited<ReturnType<typeof getLineAccounts>>[0]
        : never,
    ]);

    const result = await checkInboundSilence(mockDb);
    expect(result.checked).toBe(1);
    expect(result.alerted).toBe(0);
  });

  test('skips inactive accounts', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'acc-inactive',
        is_active: 0,
        last_inbound_at: null,
      } as unknown as Awaited<ReturnType<typeof getLineAccounts>>[0],
    ]);

    const result = await checkInboundSilence(mockDb);
    expect(result.checked).toBe(0);
  });

  test('detects accounts with silence exceeding threshold', async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'acc-silent',
        name: 'Silent Account',
        is_active: 1,
        last_inbound_at: fourDaysAgo,
      } as unknown as Awaited<ReturnType<typeof getLineAccounts>>[0],
    ]);
    vi.mocked(hasNotificationSince).mockResolvedValue(false);

    const result = await checkInboundSilence(mockDb, { thresholdHours: 72 });
    expect(result.checked).toBe(1);
    expect(result.alerted).toBe(1);
    expect(createNotification).toHaveBeenCalled();
  });
});

describe('notifyInboundSilence', () => {
  const mockDb = {} as D1Database;

  test('does not notify if already notified within 24h', async () => {
    vi.mocked(hasNotificationSince).mockResolvedValue(true);

    const result = await notifyInboundSilence(mockDb, {
      lineAccountId: 'acc-1',
      accountName: 'Test Account',
      lastInboundAt: '2026-10-31T12:00:00.000+09:00',
      silenceHours: 96,
    });

    expect(result).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('creates notification when not recently notified', async () => {
    vi.mocked(hasNotificationSince).mockResolvedValue(false);

    const result = await notifyInboundSilence(mockDb, {
      lineAccountId: 'acc-1',
      accountName: 'Test Account',
      lastInboundAt: '2026-10-31T12:00:00.000+09:00',
      silenceHours: 96,
    });

    expect(result).toBe(true);
    expect(createNotification).toHaveBeenCalled();
    
    const call = vi.mocked(createNotification).mock.calls[0];
    expect(call[1].eventType).toBe('inbound_silence_alert');
    expect(call[1].title).toContain('Test Account');
  });
});
