-- WEIN platform expansion: roles, invites, community, messaging, moderation.
-- Forward-only. Every table carries created_at for audit.

-- Role and profile on the existing users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason text;

CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

-- The owner is whoever created the account first. Guarantee exactly one owner.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner_idx ON users ((role)) WHERE role = 'owner';

-- Invite-only registration. A code is created by the owner and consumed once.
CREATE TABLE IF NOT EXISTS invites (
  code        text PRIMARY KEY,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  note        text,
  expires_at  timestamptz,
  used_by     text REFERENCES users(id) ON DELETE SET NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_created_idx ON invites (created_at DESC);

-- Per-user broker ownership. A broker row now belongs to the user who connected it.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS brokers_user_idx ON brokers (user_id);

-- Platform-level settings owned by the owner (live-trading master switch, catalog).
CREATE TABLE IF NOT EXISTS platform_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Owner-curated broker catalog. Controls what members may connect.
CREATE TABLE IF NOT EXISTS broker_catalog (
  provider   text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  note       text,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Community feed. Posts may reference a strategy to share.
CREATE TABLE IF NOT EXISTS posts (
  id          text PRIMARY KEY,
  author_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL,
  strategy_id text,
  symbol      text,
  hidden_at   timestamptz,
  hidden_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_created_idx ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts (author_id);

CREATE TABLE IF NOT EXISTS comments (
  id         text PRIMARY KEY,
  post_id    text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL,
  hidden_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id, created_at);

-- One reaction per user per post. `kind` is a small fixed vocabulary.
CREATE TABLE IF NOT EXISTS reactions (
  post_id    text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'like',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- Private messaging. A thread is a pair of user ids in canonical (sorted) order.
CREATE TABLE IF NOT EXISTS threads (
  id           text PRIMARY KEY,
  user_a       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS threads_last_idx ON threads (last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         text PRIMARY KEY,
  thread_id  text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL,
  read_at    timestamptz,
  hidden_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);

-- Moderation: actions taken by PHIRST2 automatically or by a human moderator.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id           text PRIMARY KEY,
  target_user  text REFERENCES users(id) ON DELETE SET NULL,
  target_type  text NOT NULL,           -- post | comment | message | user
  target_id    text,
  action       text NOT NULL,           -- warn | hide | suspend | ban | restore
  actor        text NOT NULL,           -- 'phirst2' | user id
  automated    boolean NOT NULL DEFAULT false,
  reason       text NOT NULL,
  evidence     jsonb,
  reverted_at  timestamptz,
  reverted_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_created_idx ON moderation_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_target_idx ON moderation_actions (target_user);

-- Member-facing warnings and appeals.
CREATE TABLE IF NOT EXISTS moderation_notices (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id  text REFERENCES moderation_actions(id) ON DELETE SET NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_notices_user_idx ON moderation_notices (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS appeals (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id  text REFERENCES moderation_actions(id) ON DELETE SET NULL,
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'open',   -- open | upheld | denied
  resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appeals_status_idx ON appeals (status, created_at DESC);

-- Reporting lets a member flag content for review.
CREATE TABLE IF NOT EXISTS content_reports (
  id          text PRIMARY KEY,
  reporter_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id   text NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON content_reports (status, created_at DESC);
