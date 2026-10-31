-- Deriv OAuth 2.0 (Authorization Code + PKCE) account connection.
--
-- Two things are stored here that do not exist for PAT connections:
--
-- 1. `oauth_states` — the server-side half of the CSRF handshake. The `state` value is
--    generated when the user taps Connect, stored with the PKCE `code_verifier` (encrypted,
--    because it is as sensitive as a password for the life of the code) and the exact
--    `redirect_uri` used. The callback is accepted only if the state exists, has not been
--    consumed and has not expired. A row is single-use: `consumed_at` is set inside the
--    same transaction that reads it, so a replayed callback finds nothing.
--
-- 2. OAuth token metadata on `brokers`. Deriv does not issue refresh tokens, so the only
--    way to know a connection has lapsed is the expiry the token response carried. The
--    access token itself lives in the existing `credentials_enc` column, encrypted with
--    AES-256-GCM exactly like a PAT; only its expiry and scope are stored in the clear,
--    because neither is a secret and both are needed to decide when to reauthorise.

CREATE TABLE IF NOT EXISTS oauth_states (
  state            text PRIMARY KEY,
  provider         text NOT NULL DEFAULT 'deriv',
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier_enc text NOT NULL,
  redirect_uri     text NOT NULL,
  /** 'connect' opens a new connection; 'reconnect' refreshes an existing broker's token. */
  intent           text NOT NULL DEFAULT 'connect',
  /** Set for a reconnect, so the callback updates that broker instead of creating one. */
  broker_id        text REFERENCES brokers(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_user_idx ON oauth_states (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);

-- How a broker was connected. 'pat' keeps the manual-token behaviour; 'oauth' means the
-- token came from Deriv's OAuth server and will expire.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'pat';
-- When the OAuth access token stops working. NULL for PAT connections, which do not expire.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS oauth_expires_at timestamptz;
-- Space-separated scopes the owner granted at Deriv, recorded so the UI can show what the
-- connection is actually allowed to do instead of assuming.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS oauth_scope text;
-- The Deriv account id chosen as active within this connection, persisted per broker.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS active_account_id text;

-- Provider-reported account status (Deriv returns "active"). Null when not reported.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status text;
