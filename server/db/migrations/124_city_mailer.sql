-- ---------------------------------------------------------------------------
-- THE ROLLING CITY MAILER: ONE CITY AT A TIME, SOLD UNTIL IT IS FULL
-- ---------------------------------------------------------------------------
--
-- A city is a printed mailer with a fixed number of ad slots. Brain sells the
-- slots in one city at a time; when every slot is sold the city is FULL, the
-- print order waits on a person's approval (it spends money), and the next
-- queued city opens by itself.
--
-- `mailer_cities.state` is the one stored state, because which city is being
-- sold and whether a person approved its print run are decisions, not
-- derivations. Everything else — slots left, revenue, margin — is derived from
-- the slot rows. Nothing here is ever deleted.
--
-- Outreach is composed and HELD. Sending is a separate decision nothing in this
-- migration makes; a held row is only a draft somebody can read.
CREATE TABLE mailer_cities (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id),
  city                TEXT NOT NULL,
  region              TEXT NOT NULL,
  city_key            TEXT NOT NULL,
  ordinal             INTEGER NOT NULL,
  slot_count          INTEGER NOT NULL CHECK (slot_count > 0),
  slot_price_cents    INTEGER NOT NULL CHECK (slot_price_cents > 0),
  print_cost_cents    INTEGER NOT NULL CHECK (print_cost_cents >= 0),
  lead_target         INTEGER NOT NULL CHECK (lead_target > 0),
  state               TEXT NOT NULL CHECK (state IN ('QUEUED', 'SELLING', 'FULL', 'PRINT_APPROVED', 'MAILED', 'CLOSED')),
  opened_at           TEXT,
  filled_at           TEXT,
  print_approved_by   TEXT,
  print_approved_at   TEXT,
  mailed_at           TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_mailer_cities_key ON mailer_cities (project_id, city_key);
CREATE UNIQUE INDEX idx_mailer_cities_selling ON mailer_cities (project_id) WHERE state = 'SELLING';

CREATE TABLE mailer_leads (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects (id),
  city_id         TEXT NOT NULL REFERENCES mailer_cities (id),
  business_name   TEXT NOT NULL,
  category        TEXT NOT NULL,
  category_key    TEXT NOT NULL,
  email           TEXT NOT NULL,
  email_key       TEXT NOT NULL,
  source_url      TEXT,
  state           TEXT NOT NULL CHECK (state IN ('NEW', 'DRAFTED', 'SOLD', 'DECLINED', 'OPTED_OUT')),
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_mailer_leads_email ON mailer_leads (city_id, email_key);

CREATE TABLE mailer_slots (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects (id),
  city_id        TEXT NOT NULL REFERENCES mailer_cities (id),
  slot_number    INTEGER NOT NULL,
  lead_id        TEXT NOT NULL REFERENCES mailer_leads (id),
  category_key   TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_ref    TEXT NOT NULL,
  recorded_by    TEXT NOT NULL,
  sold_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_mailer_slots_number ON mailer_slots (city_id, slot_number);
CREATE UNIQUE INDEX idx_mailer_slots_category ON mailer_slots (city_id, category_key);
CREATE UNIQUE INDEX idx_mailer_slots_payment ON mailer_slots (project_id, payment_ref);

CREATE TABLE mailer_outreach (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  city_id     TEXT NOT NULL REFERENCES mailer_cities (id),
  lead_id     TEXT NOT NULL REFERENCES mailer_leads (id),
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('HELD', 'SENT', 'WITHDRAWN')),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_mailer_outreach_lead ON mailer_outreach (lead_id);
