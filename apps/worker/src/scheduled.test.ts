import { describe, expect, test } from 'vitest';
import { isFiveMinuteTick } from './scheduled.js';

/** UTC の分を指定して tick イベントを作る。 */
function tick(cron: string, utcMinute: number) {
  return { cron, scheduledTime: Date.UTC(2026, 7, 26, 4, utcMinute) };
}

describe('isFiveMinuteTick', () => {
  test('分足の tick では5分ごとに1回だけ true になる', () => {
    expect(isFiveMinuteTick(tick('* * * * *', 0))).toBe(true);
    expect(isFiveMinuteTick(tick('* * * * *', 5))).toBe(true);
    expect(isFiveMinuteTick(tick('* * * * *', 55))).toBe(true);
  });

  test('5の倍数でない分では false', () => {
    expect(isFiveMinuteTick(tick('* * * * *', 1))).toBe(false);
    expect(isFiveMinuteTick(tick('* * * * *', 4))).toBe(false);
    expect(isFiveMinuteTick(tick('* * * * *', 59))).toBe(false);
  });

  test('5分足 cron の tick は分に関係なく true', () => {
    // インストーラや LHC のテナント生成が書く wrangler.toml は
    // crons = ["*/5 * * * *", "0 */6 * * *"]。分足 tick が一度も来ない構成なので、
    // 分足だけを見ていると 5分ジョブが永久に走らない。
    expect(isFiveMinuteTick(tick('*/5 * * * *', 0))).toBe(true);
    expect(isFiveMinuteTick(tick('*/5 * * * *', 3))).toBe(true);
  });

  test('6時間足の cron では false（同じ分に二重で走らせない）', () => {
    expect(isFiveMinuteTick(tick('0 */6 * * *', 0))).toBe(false);
  });
});

import { isHourlyTick, isHeavyJobTick, HEAVY_JOB_INTERVAL_MIN } from './scheduled.js';

describe('isHourlyTick', () => {
  test('分=0 の tick だけ true (分足・5分足どちらの cron でも)', () => {
    expect(isHourlyTick(tick('* * * * *', 0))).toBe(true);
    expect(isHourlyTick(tick('*/5 * * * *', 0))).toBe(true);
    expect(isHourlyTick(tick('* * * * *', 5))).toBe(false);
    expect(isHourlyTick(tick('*/5 * * * *', 30))).toBe(false);
  });

  test('6時間足の cron では false（同じ分に二重で走らせない）', () => {
    expect(isHourlyTick(tick('0 */6 * * *', 0))).toBe(false);
  });
});

describe('isHeavyJobTick', () => {
  test('HEAVY_JOB_INTERVAL_MIN is 10 by default', () => {
    expect(HEAVY_JOB_INTERVAL_MIN).toBe(10);
  });

  test('returns true when UTC minute is divisible by HEAVY_JOB_INTERVAL_MIN', () => {
    expect(isHeavyJobTick(tick('* * * * *', 0))).toBe(true);
    expect(isHeavyJobTick(tick('* * * * *', 10))).toBe(true);
    expect(isHeavyJobTick(tick('* * * * *', 20))).toBe(true);
    expect(isHeavyJobTick(tick('* * * * *', 30))).toBe(true);
    expect(isHeavyJobTick(tick('* * * * *', 40))).toBe(true);
    expect(isHeavyJobTick(tick('* * * * *', 50))).toBe(true);
  });

  test('returns false when UTC minute is NOT divisible by HEAVY_JOB_INTERVAL_MIN', () => {
    expect(isHeavyJobTick(tick('* * * * *', 1))).toBe(false);
    expect(isHeavyJobTick(tick('* * * * *', 5))).toBe(false);
    expect(isHeavyJobTick(tick('* * * * *', 9))).toBe(false);
    expect(isHeavyJobTick(tick('* * * * *', 11))).toBe(false);
    expect(isHeavyJobTick(tick('* * * * *', 15))).toBe(false);
    expect(isHeavyJobTick(tick('* * * * *', 59))).toBe(false);
  });

  test('works with 5-minute cron as well', () => {
    expect(isHeavyJobTick(tick('*/5 * * * *', 0))).toBe(true);
    expect(isHeavyJobTick(tick('*/5 * * * *', 10))).toBe(true);
    expect(isHeavyJobTick(tick('*/5 * * * *', 5))).toBe(false);
    expect(isHeavyJobTick(tick('*/5 * * * *', 15))).toBe(false);
  });

  test('6時間足の cron では false（二重実行防止）', () => {
    expect(isHeavyJobTick(tick('0 */6 * * *', 0))).toBe(false);
  });

  test('runs 6 times per hour (at minutes 0, 10, 20, 30, 40, 50)', () => {
    let count = 0;
    for (let m = 0; m < 60; m++) {
      if (isHeavyJobTick(tick('* * * * *', m))) count++;
    }
    expect(count).toBe(6);
  });
});
