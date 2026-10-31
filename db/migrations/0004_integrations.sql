-- External service integrations: transactional email delivery records and an optional
-- Supabase identity link. Forward-only. Every table carries created_at for audit.

-- Delivery records for Resend. A row exists only after a real send attempt, and `ok`
-- reflects the provider's answer, so the platform never claims a delivery that failed.
CREATE TABLE IF NOT EXISTS email_log (
  id         text PRIMARY KEY,
  provider   text NOT NULL DEFAULT 'resend',
  to_address text NOT NULL,
  subject    text NOT NULL,
  category   text NOT NULL DEFAULT 'system',   -- security | auth | system | test
  ok         boolean NOT NULL,
  provider_id text,                            -- Resend message id when accepted
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_created_idx ON email_log (created_at DESC);

-- Optional link between a first-party Wein user and a Supabase Auth user. Wein keeps its
-- own session auth; this table lets a Supabase-issued token be recognised for a linked
-- account. It is empty unless an owner deliberately links an identity.
CREATE TABLE IF NOT EXISTS supabase_identity (
  user_id           text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  supabase_user_id  text NOT NULL UNIQUE,
  email             text,
  linked_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supabase_identity_supabase_idx ON supabase_identity (supabase_user_id);
