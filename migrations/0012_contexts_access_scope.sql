-- 0012_contexts_access_scope.sql (API-006/API-009, PH-MEMOS-5, DEC-MEMOS-46)
--
-- Additive, nullable columns. A "scoped" contexts row (both columns
-- non-null) is one msp_context_resolve produced with a caller-supplied,
-- self-asserted access_context (design §5.4 -- not verified against an
-- actual vaults row); a legacy row (both columns null) is everything
-- before this migration and every call that sent no access_context
-- after it. Both-or-neither is enforced in contracts/context-scope-
-- guard.mjs, not here -- ALTER TABLE ADD COLUMN cannot add a
-- multi-column table-level CHECK without a full rebuild, and this table
-- is not otherwise a rebuild candidate this phase (design §5.4, mirroring
-- migrations/0006_links.sql's own app-layer-only cross-column precedent).
ALTER TABLE contexts ADD COLUMN tenant_id TEXT;
ALTER TABLE contexts ADD COLUMN principal_id TEXT;

CREATE INDEX idx_contexts_tenant_principal ON contexts (tenant_id, principal_id);
