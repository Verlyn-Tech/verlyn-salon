import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  phone TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en',
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  opted_out_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  event TEXT NOT NULL,
  source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  service TEXT NOT NULL,
  visited_at TEXT NOT NULL,
  amount_aed REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('completed','no_show','cancelled','booked')),
  UNIQUE (client_id, service, visited_at)
);
CREATE TABLE IF NOT EXISTS campaign_assignments (
  campaign_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  arm TEXT NOT NULL CHECK (arm IN ('treatment','control')),
  assigned_at TEXT NOT NULL,
  last_visit_at TEXT NOT NULL,
  interval_days INTEGER NOT NULL,
  service_label TEXT,
  sent_at TEXT,
  skipped_reason TEXT,
  PRIMARY KEY (campaign_id, client_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT UNIQUE,
  agent TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  type TEXT NOT NULL CHECK (type IN ('new','reschedule','cancel')),
  service_id TEXT,
  preferred_time TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','declined')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_prices (
  service_id TEXT PRIMARY KEY,
  price_aed REAL NOT NULL CHECK (price_aed >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS availability_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','booked')),
  created_at TEXT NOT NULL,
  UNIQUE (service_id, starts_at, ends_at)
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  request_id INTEGER NOT NULL UNIQUE REFERENCES booking_requests(id),
  slot_id INTEGER NOT NULL UNIQUE REFERENCES availability_slots(id),
  service_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retention_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id),
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  client_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id, visited_at);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id, at);
`;

export function openDb(path = ":memory:"): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function audit(
  db: DB,
  at: Date,
  clientId: string | null,
  actor: string,
  action: string,
  detail?: unknown,
): void {
  db.prepare("INSERT INTO audit (at, client_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)").run(
    at.toISOString(),
    clientId,
    actor,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  );
}
