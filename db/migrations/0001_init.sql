-- PHIRST2 initial schema. Forward-only. Every table carries created_at for audit.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Broker connections. Credentials are AES-256-GCM ciphertext, never plaintext.
CREATE TABLE IF NOT EXISTS brokers (
  id                     text PRIMARY KEY,
  provider               text NOT NULL,
  label                  text NOT NULL,
  credentials_enc        text NOT NULL,
  credential_fingerprint text NOT NULL,
  status                 text NOT NULL DEFAULT 'unverified',
  is_active              boolean NOT NULL DEFAULT false,
  last_verified_at       timestamptz,
  last_error             text,
  capabilities           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id           text PRIMARY KEY,
  broker_id    text NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  account_id   text NOT NULL,
  account_type text NOT NULL,
  currency     text NOT NULL DEFAULT 'USD',
  balance      numeric,
  loginid      text,
  label        text,
  is_active    boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broker_id, account_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id              text PRIMARY KEY,
  broker_id       text NOT NULL,
  account_id      text NOT NULL,
  broker_order_id text,
  symbol          text NOT NULL,
  side            text NOT NULL,
  order_type      text NOT NULL,
  amount          numeric NOT NULL,
  duration_sec    integer,
  status          text NOT NULL DEFAULT 'pending',
  fill_price      numeric,
  payout          numeric,
  profit          numeric,
  mode            text NOT NULL DEFAULT 'paper',
  strategy_id     text,
  origin          text NOT NULL DEFAULT 'manual',
  client_ref      text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_mode_created_idx ON orders (mode, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_broker_order_idx ON orders (broker_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_client_ref_idx ON orders (client_ref) WHERE client_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS positions (
  id                 text PRIMARY KEY,
  broker_id          text NOT NULL,
  account_id         text NOT NULL,
  broker_position_id text,
  symbol             text NOT NULL,
  side               text NOT NULL,
  size               numeric NOT NULL DEFAULT 0,
  entry_price        numeric,
  current_price      numeric,
  unrealized_pnl     numeric,
  mode               text NOT NULL DEFAULT 'paper',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broker_id, account_id, broker_position_id)
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id         text PRIMARY KEY,
  mode       text NOT NULL,
  equity     numeric NOT NULL,
  balance    numeric NOT NULL,
  unrealized numeric NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS equity_mode_at_idx ON equity_snapshots (mode, at DESC);

CREATE TABLE IF NOT EXISTS risk_config (
  id         integer PRIMARY KEY,
  config     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_state (
  id         integer PRIMARY KEY,
  state      text NOT NULL DEFAULT 'stopped',
  mode       text NOT NULL DEFAULT 'paper',
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategies (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  builtin     boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT false,
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_verdicts (
  id             text PRIMARY KEY,
  agent          text NOT NULL,
  supportive     boolean NOT NULL,
  confidence     numeric NOT NULL,
  summary        text NOT NULL,
  detail         jsonb,
  source         text NOT NULL,
  symbol         text,
  correlation_id text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_verdicts_at_idx ON agent_verdicts (at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         text PRIMARY KEY,
  severity   text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  category   text NOT NULL DEFAULT 'system',
  meta       jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id     text PRIMARY KEY,
  actor  text NOT NULL,
  action text NOT NULL,
  target text,
  detail jsonb,
  ip     text,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log (at DESC);

-- AI memory. Broker secrets are never written here.
CREATE TABLE IF NOT EXISTS ai_memory (
  id         text PRIMARY KEY,
  kind       text NOT NULL DEFAULT 'note',
  content    text NOT NULL,
  importance integer NOT NULL DEFAULT 1,
  source     text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_memory_active_idx ON ai_memory (importance DESC, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id     text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code       text PRIMARY KEY,
  user_id    text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id  bigint PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now()
);
