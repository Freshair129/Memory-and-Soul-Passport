-- Persisted receipts for canonical GKS knowledge promotion. This is distinct
-- from private-memory `promotions`: no private vault owns canonical knowledge.
CREATE TABLE knowledge_promotions (
  promotion_ref TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  knowledge_ref TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_knowledge_promotions_knowledge_ref ON knowledge_promotions (knowledge_ref);
