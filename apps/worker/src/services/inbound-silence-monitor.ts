/**
 * Inbound Silence Monitor — detect accounts with no webhook inbound for extended periods.
 *
 * This catches the silent failure mode where signature verification mismatches
 * cause all incoming events from LINE to be silently dropped (200 OK returned,
 * but no processing occurs). Common causes:
 *   - Channel secret mismatch after rotation in LINE console
 *   - Webhook URL misconfigured in LINE console
 *   - LINE account deactivated or deleted
 *
 * The monitor checks last_inbound_at for each active account and notifies
 * operators when silence exceeds the configured threshold (default 72h).
 */

import {
  getLineAccounts,
  createNotification,
  hasNotificationSince,
  getActiveNotificationRulesByEvent,
  getActiveOutgoingWebhooksByEvent,
  jstNow,
} from '@line-crm/db';
import { fireOutgoingWebhooks } from './event-bus.js';

export const INBOUND_SILENCE_EVENT = 'inbound_silence_alert';
const DEFAULT_SILENCE_THRESHOLD_HOURS = 72;

export interface InboundSilenceInput {
  lineAccountId: string;
  accountName?: string | null;
  lastInboundAt: string | null;
  silenceHours: number;
}

function jstHoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600_000);
  const jstMs = d.getTime() + 9 * 60 * 60_000;
  const jst = new Date(jstMs);
  return jst.toISOString().slice(0, -1) + '+09:00';
}

/**
 * Check all active accounts for inbound silence and notify operators.
 * Dedup: one notification per account per 24 hours.
 */
export async function checkInboundSilence(
  db: D1Database,
  opts: { thresholdHours?: number } = {},
): Promise<{ checked: number; alerted: number }> {
  const thresholdHours = opts.thresholdHours ?? DEFAULT_SILENCE_THRESHOLD_HOURS;
  const accounts = await getLineAccounts(db);
  const activeAccounts = accounts.filter((a) => a.is_active);
  
  let checked = 0;
  let alerted = 0;

  for (const account of activeAccounts) {
    checked++;
    try {
      const notified = await checkSingleAccountSilence(db, account, thresholdHours);
      if (notified) alerted++;
    } catch (err) {
      console.error(`[inbound-silence] check failed for account ${account.id}:`, err);
    }
  }

  return { checked, alerted };
}

async function checkSingleAccountSilence(
  db: D1Database,
  account: { id: string; name?: string | null; last_inbound_at?: string | null },
  thresholdHours: number,
): Promise<boolean> {
  const lastInbound = account.last_inbound_at;
  
  // If no last_inbound_at recorded, check if account was created recently enough
  // to not have had time to receive anything yet
  if (!lastInbound) {
    // Account has never received an inbound — this is concerning if it's been
    // active for more than the threshold. We'd need created_at to check.
    // For now, skip accounts with no inbound history (they may be new).
    return false;
  }

  const lastInboundDate = new Date(lastInbound);
  const silenceMs = Date.now() - lastInboundDate.getTime();
  const silenceHours = silenceMs / (1000 * 60 * 60);

  if (silenceHours < thresholdHours) {
    return false; // Not silent long enough
  }

  // Notify about the silence
  return notifyInboundSilence(db, {
    lineAccountId: account.id,
    accountName: account.name ?? null,
    lastInboundAt: lastInbound,
    silenceHours: Math.round(silenceHours),
  });
}

/**
 * Notify operators about an account with extended inbound silence.
 * Dedup: one notification per account per 24 hours.
 */
export async function notifyInboundSilence(
  db: D1Database,
  input: InboundSilenceInput,
): Promise<boolean> {
  try {
    // Dedup: check if we already notified for this account in the last 24h
    const already = await hasNotificationSince(db, {
      eventType: INBOUND_SILENCE_EVENT,
      lineAccountId: input.lineAccountId,
      since: jstHoursAgo(24),
    });
    if (already) return false;

    const name = input.accountName || input.lineAccountId;
    const title = `Webhook無通信アラート: ${name}`;
    
    let lastInboundDisplay = '記録なし';
    if (input.lastInboundAt) {
      const d = new Date(input.lastInboundAt);
      lastInboundDisplay = `${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP')}`;
    }
    
    const body = `アカウント「${name}」は${input.silenceHours}時間以上Webhookを受信していません。` +
      `最終受信: ${lastInboundDisplay}。` +
      `LINEコンソールでWebhook設定とChannel Secretの一致を確認してください。`;

    const metadata = JSON.stringify({
      lineAccountId: input.lineAccountId,
      source: 'silence-monitor',
      silenceHours: input.silenceHours,
      lastInboundAt: input.lastInboundAt,
    });

    // Get notification rules for this event type
    const rules = (await getActiveNotificationRulesByEvent(db, INBOUND_SILENCE_EVENT)).filter(
      (r) => !r.line_account_id || r.line_account_id === input.lineAccountId,
    );
    const byChannel = new Map<string, string | undefined>([['dashboard', undefined]]);
    for (const rule of rules) {
      let channels: unknown = [];
      try {
        channels = JSON.parse(rule.channels);
      } catch {
        channels = [];
      }
      if (!Array.isArray(channels)) continue;
      for (const channel of channels) {
        if (typeof channel === 'string' && !byChannel.has(channel)) {
          byChannel.set(channel, rule.id);
        }
      }
    }

    // Fire outgoing webhooks
    const webhookSubscribers = await getActiveOutgoingWebhooksByEvent(db, INBOUND_SILENCE_EVENT);
    let webhookDelivered = 0;
    if (webhookSubscribers.length > 0) {
      webhookDelivered = await fireOutgoingWebhooks(
        db,
        INBOUND_SILENCE_EVENT,
        {
          eventData: {
            lineAccountId: input.lineAccountId,
            accountName: input.accountName ?? null,
            title,
            body,
            silenceHours: input.silenceHours,
            lastInboundAt: input.lastInboundAt,
          },
        },
        webhookSubscribers,
      );
    }

    // Create notification records
    const now = jstNow();
    for (const [channel, ruleId] of byChannel) {
      const status =
        channel === 'dashboard'
          ? 'sent'
          : channel === 'webhook'
            ? webhookDelivered > 0 ? 'sent' : 'failed'
            : 'pending';
      await createNotification(db, {
        ruleId,
        eventType: INBOUND_SILENCE_EVENT,
        title,
        body,
        channel,
        status,
        metadata,
        lineAccountId: input.lineAccountId,
      });
    }

    console.warn(
      `[inbound-silence] Alert: account ${input.lineAccountId} silent for ${input.silenceHours}h`,
    );
    return true;
  } catch (err) {
    console.error(`[inbound-silence] notify failed for account ${input.lineAccountId}:`, err);
    return false;
  }
}
