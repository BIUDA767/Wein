-- Trading authority modes and the approval queue.
--
-- `trading_mode` (manual | approval | autonomous) is a separate axis from the
-- paper/live environment. It is persisted so a restart cannot silently widen or
-- narrow PHIRST2's authority. Approval mode parks a concrete, risk-sized trade
-- here until the owner decides; approving executes it once, and the status flip
-- is what prevents a duplicate order.

CREATE TABLE IF NOT EXISTS trade_proposals (
  id              text PRIMARY KEY,
  symbol          text NOT NULL,
  side            text NOT NULL CHECK (side IN ('buy', 'sell')),
  amount          numeric(18,2) NOT NULL,
  duration_sec    integer NOT NULL,
  strategy_id     text,
  rationale       text,
  mode            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'blocked')),
  reference_price numeric(18,6),
  block_reason    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  decided_at      timestamptz,
  order_id        text
);

-- At most one pending proposal per symbol and direction. Without this the loop would
-- queue a fresh proposal on every tick while a signal held, burying the owner.
CREATE UNIQUE INDEX IF NOT EXISTS trade_proposals_one_pending_per_side_idx
  ON trade_proposals (symbol, side)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS trade_proposals_created_idx
  ON trade_proposals (created_at DESC);

INSERT INTO app_settings (key, value)
VALUES ('tradingMode', '"manual"'::jsonb)
ON CONFLICT (key) DO NOTHING;
