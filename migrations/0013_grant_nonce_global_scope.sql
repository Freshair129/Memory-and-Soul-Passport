-- MEMOS-008 approved nonce amendment: preserve tenant partitions and add
-- one genuinely tenantless global partition without a reserved sentinel.
CREATE TABLE grant_nonces_new (
  tenant_id TEXT,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, nonce)
);
INSERT INTO grant_nonces_new (tenant_id, nonce, expires_at)
SELECT tenant_id, nonce, expires_at FROM grant_nonces;
DROP TABLE grant_nonces;
ALTER TABLE grant_nonces_new RENAME TO grant_nonces;
CREATE INDEX idx_grant_nonces_expiry ON grant_nonces (expires_at);
CREATE UNIQUE INDEX idx_grant_nonces_global_nonce ON grant_nonces (nonce)
WHERE tenant_id IS NULL;
