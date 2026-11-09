-- Simulated provider state. Used only when a provider is set to `simulated`.
-- These tables never receive live data; the admin UI labels everything here as simulated.

CREATE TABLE sim_messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('to_owner', 'from_owner', 'provider_auto')),
  body TEXT NOT NULL,
  provider_sid TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  status_callback_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sim_messages_created ON sim_messages (created_at);

CREATE TABLE sim_calls (
  sid TEXT PRIMARY KEY,
  instructions_url TEXT NOT NULL,
  status_callback_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL
);

CREATE TABLE sim_calendars (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  access_role TEXT NOT NULL DEFAULT 'owner',
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
);

CREATE TABLE sim_calendar_events (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recurring_event_id TEXT,
  etag_counter INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (calendar_id, event_id)
);

-- Scripted behaviours (queue of outcomes) for failure injection, keyed by operation.
CREATE TABLE sim_behaviors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sim_behaviors_op ON sim_behaviors (operation, id);

-- Record of simulated side effects that would have hit a provider (for assertions).
CREATE TABLE sim_provider_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
