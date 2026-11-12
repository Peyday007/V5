-- ---------------------------------------------------------------------------
-- SALES DESK (§107)
--
-- What Brain learned and decided with Sellbird's sales mind, owned here:
--
--   sales_leads      one row per lead Brain researched for a business: the
--                    fit score and its reasons, the facts a writer may use,
--                    and the first email Sellbird wrote (or why none). A
--                    lead's research is replaced when it is read again.
--   sales_replies    one row per reply Instantly received, keyed by its
--                    email id: Sellbird's intent, stage, opt-out and
--                    escalation reading, its drafted answer, and what Brain
--                    did. Append-only: a reply is analysed once.
--   sales_learnings  append-only measurements and decisions per business:
--                    the analyst's findings, variant reply rates, the
--                    allocation they set, deliverability readings.
--
-- Addresses are the recipients' published business addresses (§104); no
-- credential is stored.
-- ---------------------------------------------------------------------------

CREATE TABLE sales_leads (
  id TEXT PRIMARY KEY,
  business TEXT NOT NULL,
  email TEXT NOT NULL,
  domain TEXT NOT NULL,
  campaign_id TEXT,
  fit_score INTEGER,
  fit_reasons TEXT NOT NULL DEFAULT '[]',
  facts TEXT NOT NULL DEFAULT '[]',
  research TEXT NOT NULL DEFAULT '{}',
  variant TEXT NOT NULL CHECK (variant IN ('PERSONAL', 'TEMPLATE')),
  subject TEXT,
  body TEXT,
  write_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business, email)
);

CREATE INDEX idx_sales_leads_business ON sales_leads (business, created_at);

CREATE TABLE sales_replies (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL UNIQUE,
  business TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  lead_email TEXT NOT NULL,
  thread_id TEXT,
  received_at TEXT,
  reply_text TEXT NOT NULL,
  intent TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  opt_out TEXT,
  escalation TEXT,
  answer TEXT,
  action TEXT NOT NULL,
  action_detail TEXT NOT NULL,
  answer_email_id TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_sales_replies_business ON sales_replies (business, recorded_at);
CREATE INDEX idx_sales_replies_lead ON sales_replies (lead_email);

CREATE TABLE sales_learnings (
  id TEXT PRIMARY KEY,
  business TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_sales_learnings_lookup ON sales_learnings (business, kind, recorded_at);
