-- msp-migration: foreign-keys=off
-- 0011_principal_vaults.sql (API-010, PH-MEMOS-5, DEC-MEMOS-36..39)
--
-- Adds two new vault types, principal_private (the "episodic vault",
-- owner tuple tenant_id/principal_id/agent_id/workspace_id) and
-- principal_passport (the "Soul Passport vault", owner tuple
-- tenant_id/principal_id only), plus a type-pinned decay_policy column.
-- vaults is a real parent table with existing rows and four existing
-- child tables (vault_mounts, entities, promotions, links) referencing
-- it by foreign key -- this directive and the safe CREATE-new/INSERT/
-- DROP/RENAME rebuild order (docs/MIGRATION.md) are both required, not
-- optional, on a populated database.
--
-- CHECK cannot be altered or dropped in place in SQLite -- this rebuild
-- is the only way to widen vault_type's existing CHECK and add the new
-- per-type owner CHECKs below.

CREATE TABLE vaults_new (
  vault_id TEXT PRIMARY KEY,
  vault_type TEXT NOT NULL CHECK (vault_type IN (
    'shared', 'workspace_private', 'global_private',
    'principal_private', 'principal_passport'
  )),
  project_id TEXT,
  workspace_id TEXT,
  agent_id TEXT,
  tenant_id TEXT,
  principal_id TEXT,
  -- principal_hmac is deliberately NOT a column here. The random principal
  -- vault id needs no stored, owner-keyed lookup column; the journal actor
  -- pseudonym is computed transiently by msp_vault_resolve.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'erased')),
  decay_policy TEXT NOT NULL DEFAULT 'ebbinghaus' CHECK (decay_policy IN ('ebbinghaus', 'pinned')),
  role TEXT,
  created_at TEXT NOT NULL,
  -- decay_policy is type-pinned (design §5): a principal_passport vault
  -- never decays; every other type, including principal_private, uses
  -- the ordinary Ebbinghaus schedule. This is a fact about the type, not
  -- a caller-chosen setting.
  CHECK (
    (vault_type = 'principal_passport' AND decay_policy = 'pinned')
    OR (vault_type != 'principal_passport' AND decay_policy = 'ebbinghaus')
  ),
  -- Legacy vault types never carry a tenant_id/principal_id -- those two
  -- columns exist only for the two principal vault types. This keeps a
  -- legacy row from coincidentally satisfying a principal-vault CHECK
  -- branch below.
  CHECK (
    (vault_type IN ('shared', 'workspace_private', 'global_private')
      AND tenant_id IS NULL AND principal_id IS NULL)
    OR vault_type IN ('principal_private', 'principal_passport')
  ),
  -- principal_private: owner tuple is tenant_id, principal_id, agent_id,
  -- workspace_id, all NOT NULL while active. An erased row (status =
  -- 'erased') is exempted with principal_id blanked -- design §11.1's
  -- vaults disposition row -- but vault erasure ITSELF is out of this
  -- phase's scope (PH-MEMOS-6, BL-MEMOS-074); this CHECK only makes the
  -- row shape correct in advance so PH-MEMOS-6 needs no second rebuild.
  CHECK (
    vault_type != 'principal_private'
    OR (status = 'erased' AND principal_id IS NULL)
    OR (status = 'active' AND tenant_id IS NOT NULL AND principal_id IS NOT NULL
        AND agent_id IS NOT NULL AND workspace_id IS NOT NULL)
  ),
  -- principal_passport: owner tuple is tenant_id, principal_id only;
  -- agent_id/workspace_id are always NULL for this type, active or
  -- erased -- a passport is never agent- or workspace-scoped.
  CHECK (
    vault_type != 'principal_passport'
    OR (agent_id IS NULL AND workspace_id IS NULL
        AND (
          (status = 'erased' AND principal_id IS NULL)
          OR (status = 'active' AND tenant_id IS NOT NULL AND principal_id IS NOT NULL)
        ))
  )
);

INSERT INTO vaults_new
  (vault_id, vault_type, project_id, workspace_id, agent_id, tenant_id,
   principal_id, status, decay_policy, role, created_at)
SELECT
  vault_id, vault_type, project_id, workspace_id, agent_id, NULL,
  NULL, status, 'ebbinghaus', role, created_at
FROM vaults;

DROP TABLE vaults;
ALTER TABLE vaults_new RENAME TO vaults;

-- vault_mounts.vault_id / entities.vault_id / promotions.vault_id /
-- links.vault_id REFERENCES vaults (vault_id): SQLite resolves each by
-- table name at check time, so all four re-attach to the rebuilt
-- `vaults` automatically once the rename above completes -- none of the
-- four child tables is itself recreated by this migration.

CREATE INDEX idx_vaults_project_id ON vaults (project_id);
CREATE INDEX idx_vaults_workspace_id ON vaults (workspace_id);
CREATE INDEX idx_vaults_agent_id ON vaults (agent_id);
CREATE INDEX idx_vaults_tenant_id ON vaults (tenant_id);
CREATE INDEX idx_vaults_principal_id ON vaults (principal_id);

-- Idempotent-resolve backstop for VaultRegistry.provisionPrincipal*Vault
-- (design §5.0.3): at most one ACTIVE row per owner tuple, per type.
CREATE UNIQUE INDEX idx_vaults_principal_private_active
  ON vaults (tenant_id, principal_id, agent_id, workspace_id)
  WHERE vault_type = 'principal_private' AND status = 'active';

CREATE UNIQUE INDEX idx_vaults_principal_passport_active
  ON vaults (tenant_id, principal_id)
  WHERE vault_type = 'principal_passport' AND status = 'active';

-- Identity-pin UPDATE guard (design §5.2, DEC-MEMOS-39): the only two
-- permitted UPDATE shapes are (a) the pre-existing legacy project_id
-- backfill, now legacy-types-only, and (b) the future PH-MEMOS-6
-- erasure transition (active -> erased, principal_id blanked, principal
-- vault types only) -- not built by this migration, only made possible
-- by it. Every other column is pinned on both branches,
-- EXCEPT as widened below.
--
-- Branch (b) PERMITS (never requires) NEW.tenant_id/NEW.agent_id/
-- NEW.workspace_id to also be NULL on this same transition
-- (RSK-MEMOS-14, design §5.2). This phase's own erasure prose still
-- only blanks principal_id (design §11.1's vaults row) -- this widening
-- does not change that -- but with CHECK already forbidding it (above,
-- both principal-type CHECKs impose no NOT-NULL requirement on an
-- erased row's tenant_id/agent_id/workspace_id), the trigger was the
-- only thing standing between "the schema permits a stronger
-- disposition" and "0011 forecloses it until a second rebuild." Checked
-- against every reader of these columns on an erased row before
-- widening: principal ids are minted randomly and never derived from a
-- stored row; both partial unique indexes above are WHERE status = 'active'
-- only; and #isVaultRowAccessibleTo
-- (design §5.2) refuses status != 'active' before any tuple comparison
-- at all -- none of the three depends on these columns surviving
-- erasure, so this widening is safe today and requires no other change
-- in this migration.
CREATE TRIGGER trg_vaults_update_guard
BEFORE UPDATE ON vaults
BEGIN
  SELECT CASE WHEN NOT (
    (
      OLD.project_id IS NULL AND NEW.project_id IS NOT NULL
      AND OLD.vault_type NOT IN ('principal_private', 'principal_passport')
      AND NEW.vault_id IS OLD.vault_id AND NEW.vault_type IS OLD.vault_type
      AND NEW.workspace_id IS OLD.workspace_id AND NEW.agent_id IS OLD.agent_id
      AND NEW.tenant_id IS OLD.tenant_id AND NEW.principal_id IS OLD.principal_id
      AND NEW.status IS OLD.status AND NEW.decay_policy IS OLD.decay_policy
      AND NEW.role IS OLD.role AND NEW.created_at IS OLD.created_at
    ) OR (
      OLD.status = 'active' AND NEW.status = 'erased'
      AND OLD.vault_type IN ('principal_private', 'principal_passport')
      AND NEW.principal_id IS NULL
      AND NEW.vault_id IS OLD.vault_id AND NEW.vault_type IS OLD.vault_type
      AND NEW.project_id IS OLD.project_id
      AND (NEW.workspace_id IS OLD.workspace_id OR NEW.workspace_id IS NULL)
      AND (NEW.agent_id IS OLD.agent_id OR NEW.agent_id IS NULL)
      AND (NEW.tenant_id IS OLD.tenant_id OR NEW.tenant_id IS NULL)
      AND NEW.decay_policy IS OLD.decay_policy
      AND NEW.role IS OLD.role AND NEW.created_at IS OLD.created_at
    )
  ) THEN RAISE(ABORT, 'vaults rows may only backfill project_id (legacy types only) or transition active -> erased (principal_id blanked, tenant_id/agent_id/workspace_id optionally blanked)')
  END;
END;

-- No-delete enforcement: every other append-only table 0008/0009/0010
-- added already carries a *_no_delete trigger; vaults did not. The
-- vault_id staying in this table forever -- deleting it would orphan
-- erasure_receipts, journal `ref` values and promotions/links provenance
-- and silently turn an erased target into an unknown one. Refuses
-- every DELETE on `vaults`, legacy and principal rows alike -- no tool
-- deletes a vaults row today either, so this closes an unenforced
-- invariant, not a new restriction on any shipped behavior.
CREATE TRIGGER trg_vaults_no_delete
BEFORE DELETE ON vaults
BEGIN
  SELECT RAISE(ABORT, 'vaults rows may never be deleted');
END;

-- Never-mountable enforcement, DB layer (design §5.2, DEC-MEMOS-39): the
-- JS-layer half is VaultRegistry#mountVault's own new pre-check. Fires
-- on vault_mounts, the table that actually records a mount, not on
-- vaults itself -- a mount is a row in vault_mounts naming a vault_id,
-- so that is where an attempt to create or repoint one must be refused.
CREATE TRIGGER trg_vault_mounts_refuse_principal_insert
BEFORE INSERT ON vault_mounts
BEGIN
  SELECT RAISE(ABORT, 'principal vaults are never mountable')
  WHERE (SELECT vault_type FROM vaults WHERE vault_id = NEW.vault_id)
    IN ('principal_private', 'principal_passport');
END;

CREATE TRIGGER trg_vault_mounts_refuse_principal_update
BEFORE UPDATE ON vault_mounts
BEGIN
  SELECT RAISE(ABORT, 'principal vaults are never mountable')
  WHERE (SELECT vault_type FROM vaults WHERE vault_id = NEW.vault_id)
    IN ('principal_private', 'principal_passport');
END;
