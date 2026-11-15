-- Optional index for getDueScheduledBroadcasts query optimization.
-- This composite index covers the WHERE clause (status, scheduled_at) and
-- supports the ORDER BY scheduled_at ASC efficiently.
--
-- Expected benefit: reduces rows read from full broadcasts table scan to
-- only the rows matching status='scheduled' with scheduled_at in range.
--
-- This migration is OPTIONAL and can be applied independently of the code change.
-- The code change is safe without this index (it just reads more rows).

CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due
  ON broadcasts (status, scheduled_at)
  WHERE status = 'scheduled' AND scheduled_at IS NOT NULL;
