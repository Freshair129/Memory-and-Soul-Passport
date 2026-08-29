// domain/entity-store: upsert/get/list/history/forget over `entities` +
// `entity_history`. Depends only on db/ (via an already-open connection
// passed in by the composition root) and other domain/ modules
// (domain/ids.mjs, domain/temporal-engine.mjs, domain/errors.mjs) -- never
// retrieval/ or contracts/, per ADR-027's layering rule.
//
// WP-14: every entity is now vault-scoped (entities.vault_id, migration
// 0003_vault_scoping.sql). computeEntityId folds vault_id into the hash
// input so two different vaults never collide on the same (category, key)
// pair's entity_id, matching the UNIQUE(vault_id, category, key) constraint
// migration 0003 establishes. Every public method below now requires a
// vaultId argument and scopes its lookup/write to it -- this is a breaking
// internal API change to this module (WP-14 Bounded Scope item 2); every
// caller across packages/msp-runtime/src/** was updated in the same change
// (see transport/handlers/lifecycle-handlers.mjs).
//
// entity_history is NOT vault-scoped directly: its UNIQUE(entity_id,
// version) constraint already presupposes a vault-scoped entity_id, which
// is exactly what computeEntityId now provides (see migration 0003's header
// comment for the full reasoning). history()/forget() resolve the
// vault-scoped entities row first, then act on entity_history via its
// (already-vault-scoped-by-construction) entity_id.
import { MemoryNotFoundError } from "./errors.mjs";
import { sha256Hex, mintRef } from "./ids.mjs";
import { isTemporalVisible } from "./temporal-engine.mjs";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function computeEntityId(vaultId, category, key) {
  // Same convention as domain/ids.mjs's stableId (space-joined parts,
  // sha256, first 24 hex chars), minted as an msp:-namespaced ref via
  // mintRef. WP-14: vaultId is now the first hashed part after the "entity"
  // tag, so the same (category, key) pair in two different vaults always
  // produces two different entity_ids.
  const digest = sha256Hex(["entity", vaultId, category, key].join(" ")).slice(0, 24);
  return mintRef("entity", digest);
}

function computeSourceHash({ bodyJson, epistemicState, confidence }) {
  return sha256Hex(stableStringify({ bodyJson: bodyJson ?? {}, epistemicState, confidence }));
}

// Exported (WP-15 Bounded Scope item 2/3): retrieval/fts.mjs and
// retrieval/vector.mjs both join back to `entities` for the full
// MemoryEntity projection and reuse this exact mapping rather than
// duplicating it -- ADR-027's layering rule permits retrieval/ to import
// domain/, so this is the DRY choice over a second, drifting copy.
export function rowToEntity(row) {
  if (!row) return null;
  return {
    entity_id: row.entity_id,
    vault_id: row.vault_id,
    category: row.category,
    key: row.key,
    body_json: JSON.parse(row.body_json),
    epistemic_state: row.epistemic_state,
    confidence: row.confidence,
    current_version: row.current_version,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    recorded_at: row.recorded_at,
    superseded_at: row.superseded_at,
    lifecycle_state: row.lifecycle_state,
    decay_score: row.decay_score,
    access_count: row.access_count,
    source_hash: row.source_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function historyRowToEntry(row) {
  return {
    history_id: row.history_id,
    entity_id: row.entity_id,
    version: row.version,
    body_json: JSON.parse(row.body_json),
    epistemic_state: row.epistemic_state,
    confidence: row.confidence,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    recorded_at: row.recorded_at,
    superseded_at: row.superseded_at,
    change_reason: row.change_reason,
    actor: row.actor,
    source_hash: row.source_hash,
  };
}

export class EntityStore {
  #db;
  #selectByKey;
  #selectById;
  #insertEntity;
  #updateEntity;
  #insertHistory;
  #selectHistoryDesc;
  #selectHistoryAsc;

  constructor(db) {
    this.#db = db;
    this.#selectByKey = db.prepare("SELECT * FROM entities WHERE vault_id = ? AND category = ? AND key = ?");
    this.#selectById = db.prepare("SELECT * FROM entities WHERE entity_id = ?");
    this.#insertEntity = db.prepare(`
      INSERT INTO entities
        (entity_id, vault_id, category, key, body_json, epistemic_state, confidence, current_version,
         valid_from, valid_to, recorded_at, superseded_at, lifecycle_state, decay_score,
         access_count, source_hash, created_at, updated_at)
      VALUES
        (@entity_id, @vault_id, @category, @key, @body_json, @epistemic_state, @confidence, @current_version,
         @valid_from, @valid_to, @recorded_at, @superseded_at, @lifecycle_state, @decay_score,
         @access_count, @source_hash, @created_at, @updated_at)
    `);
    this.#updateEntity = db.prepare(`
      UPDATE entities SET
        body_json = @body_json,
        epistemic_state = @epistemic_state,
        confidence = @confidence,
        current_version = @current_version,
        valid_from = @valid_from,
        valid_to = @valid_to,
        recorded_at = @recorded_at,
        lifecycle_state = @lifecycle_state,
        source_hash = @source_hash,
        updated_at = @updated_at
      WHERE entity_id = @entity_id
    `);
    this.#insertHistory = db.prepare(`
      INSERT INTO entity_history
        (entity_id, version, body_json, epistemic_state, confidence, valid_from, valid_to,
         recorded_at, superseded_at, change_reason, actor, source_hash)
      VALUES
        (@entity_id, @version, @body_json, @epistemic_state, @confidence, @valid_from, @valid_to,
         @recorded_at, @superseded_at, @change_reason, @actor, @source_hash)
    `);
    this.#selectHistoryDesc = db.prepare("SELECT * FROM entity_history WHERE entity_id = ? ORDER BY version DESC");
    this.#selectHistoryAsc = db.prepare("SELECT * FROM entity_history WHERE entity_id = ? ORDER BY version ASC");
  }

  /**
   * Idempotent by (vaultId, category, key): if the content hash is
   * unchanged, this is a no-op that returns the current row. If changed (or
   * reviving a previously-forgotten entity), bumps current_version and
   * writes a new entity_history row in the same db.transaction().
   */
  upsert({
    vaultId,
    category,
    key,
    bodyJson,
    epistemicState = "hypothesis",
    confidence = 0.5,
    reason = null,
    actor,
    validFrom,
    validTo = null,
  }) {
    if (!vaultId) throw new TypeError("entity-store.upsert requires vaultId.");
    if (!category) throw new TypeError("entity-store.upsert requires category.");
    if (!key) throw new TypeError("entity-store.upsert requires key.");
    if (!actor) throw new TypeError("entity-store.upsert requires actor.");

    const now = new Date().toISOString();
    const effectiveValidFrom = validFrom || now;
    const sourceHash = computeSourceHash({ bodyJson, epistemicState, confidence });

    const run = this.#db.transaction(() => {
      const existingRow = this.#selectByKey.get(vaultId, category, key);

      if (existingRow && existingRow.source_hash === sourceHash && existingRow.lifecycle_state !== "forgotten") {
        return { entity: rowToEntity(existingRow), created: false, changed: false };
      }

      if (!existingRow) {
        const entityId = computeEntityId(vaultId, category, key);
        const entityRow = {
          entity_id: entityId,
          vault_id: vaultId,
          category,
          key,
          body_json: JSON.stringify(bodyJson ?? {}),
          epistemic_state: epistemicState,
          confidence,
          current_version: 1,
          valid_from: effectiveValidFrom,
          valid_to: validTo,
          recorded_at: now,
          superseded_at: null,
          lifecycle_state: "active",
          decay_score: 1.0,
          access_count: 0,
          source_hash: sourceHash,
          created_at: now,
          updated_at: now,
        };
        this.#insertEntity.run(entityRow);
        this.#insertHistory.run({
          entity_id: entityId,
          version: 1,
          body_json: entityRow.body_json,
          epistemic_state: epistemicState,
          confidence,
          valid_from: effectiveValidFrom,
          valid_to: validTo,
          recorded_at: now,
          superseded_at: null,
          change_reason: reason ?? "initial",
          actor,
          source_hash: sourceHash,
        });
        return { entity: rowToEntity(this.#selectById.get(entityId)), created: true, changed: true };
      }

      // Content changed, or reviving a forgotten entity: bump the version.
      const nextVersion = existingRow.current_version + 1;
      this.#updateEntity.run({
        entity_id: existingRow.entity_id,
        body_json: JSON.stringify(bodyJson ?? {}),
        epistemic_state: epistemicState,
        confidence,
        current_version: nextVersion,
        valid_from: effectiveValidFrom,
        valid_to: validTo,
        recorded_at: now,
        lifecycle_state: "active",
        source_hash: sourceHash,
        updated_at: now,
      });
      this.#insertHistory.run({
        entity_id: existingRow.entity_id,
        version: nextVersion,
        body_json: JSON.stringify(bodyJson ?? {}),
        epistemic_state: epistemicState,
        confidence,
        valid_from: effectiveValidFrom,
        valid_to: validTo,
        recorded_at: now,
        superseded_at: null,
        change_reason: reason ?? "update",
        actor,
        source_hash: sourceHash,
      });
      return { entity: rowToEntity(this.#selectById.get(existingRow.entity_id)), created: false, changed: true };
    });

    return run();
  }

  /**
   * Current-state read by default. If asOfValidAt or asOfRecordedAt is
   * given, performs a bitemporal point read over entity_history using
   * domain/temporal-engine's isTemporalVisible. Because entity_history rows
   * are never updated after insert (see the migration's comment), the
   * "superseded by a later version" boundary is derived at query time from
   * the next version's recorded_at rather than from a stored column.
   *
   * Known Phase 1 limitation: recorded_at has millisecond (ISO-8601)
   * resolution and is server-assigned per upsert() call. If two versions of
   * the same (vaultId, category, key) are recorded within the same
   * millisecond, the earlier version's [recordedAt, supersededAt)
   * visibility window collapses to empty (isTemporalVisible correctly
   * excludes both the lower bound being satisfied and the upper bound being
   * satisfied at once). This is inherent to millisecond-granularity
   * timestamps + a half-open interval, not a bug in this port; a
   * higher-resolution or monotonic recorded_at (e.g. a sequence counter) is
   * a reasonable future-phase improvement, not something WP-12 asks this
   * packet to solve.
   */
  get({ vaultId, category, key, asOfValidAt = null, asOfRecordedAt = null } = {}) {
    if (!vaultId) throw new TypeError("entity-store.get requires vaultId.");
    const currentRow = this.#selectByKey.get(vaultId, category, key);
    if (!currentRow) return null;

    if (!asOfValidAt && !asOfRecordedAt) {
      return rowToEntity(currentRow);
    }

    const historyRows = this.#selectHistoryAsc.all(currentRow.entity_id);
    for (let index = historyRows.length - 1; index >= 0; index -= 1) {
      const row = historyRows[index];
      const nextRow = historyRows[index + 1];
      const temporalItem = {
        validFrom: row.valid_from,
        validTo: row.valid_to ?? undefined,
        recordedAt: row.recorded_at,
        supersededAt: nextRow ? nextRow.recorded_at : (row.superseded_at ?? undefined),
      };
      const options = {};
      if (asOfValidAt) options.asOfValidAt = asOfValidAt;
      if (asOfRecordedAt) options.asOfRecordedAt = asOfRecordedAt;
      if (isTemporalVisible(temporalItem, options)) {
        return historyRowToEntry(row);
      }
    }
    return null;
  }

  /**
   * Paginated list over the current-state `entities` table, scoped to a
   * single vaultId (WP-14: listing without a vault scope would leak
   * cross-vault entities, so vaultId is mandatory here, not optional).
   * Excludes forgotten AND archived entities by default (WP-16 Bounded
   * Scope item 6) unless lifecycleState is explicitly set to 'forgotten',
   * 'archived', or another explicit value -- the explicit filter always
   * wins over the default exclusion.
   */
  list({ vaultId, category = null, lifecycleState = null, limit = 50, cursor = null } = {}) {
    if (!vaultId) throw new TypeError("entity-store.list requires vaultId.");
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const conditions = ["vault_id = ?"];
    const params = [vaultId];

    if (category) {
      conditions.push("category = ?");
      params.push(category);
    }
    if (lifecycleState) {
      conditions.push("lifecycle_state = ?");
      params.push(lifecycleState);
    } else {
      conditions.push("lifecycle_state NOT IN ('archived', 'forgotten')");
    }
    if (cursor) {
      conditions.push("entity_id > ?");
      params.push(cursor);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT * FROM entities ${where} ORDER BY entity_id ASC LIMIT ?`)
      .all(...params, boundedLimit + 1);

    const hasMore = rows.length > boundedLimit;
    const page = rows.slice(0, boundedLimit);

    return {
      entities: page.map(rowToEntity),
      nextCursor: hasMore ? page[page.length - 1].entity_id : null,
    };
  }

  /**
   * WP-15 Bounded Scope item 6: msp_memory_history/msp_memory_forget's wire
   * request (API-009 SS4.4/SS4.5) carries only entity_id -- no vaultId,
   * category, or key -- unlike every other entity-store method above, which
   * predates this packet and is vault-scoped by (vaultId, category, key).
   * This is a direct-by-primary-key lookup so transport/handlers/
   * memory-handlers.mjs can resolve entity_id -> {vaultId, category, key}
   * before delegating to the vault-scoped methods above. It performs no
   * additional scoping of its own because entity_id itself already
   * uniquely, non-forgeably determines its vault (WP-14's computeEntityId
   * folds vaultId into the hash) -- there is no cross-vault ambiguity a
   * second scope parameter could resolve here. Returns null, never throws,
   * on an unknown entity_id.
   */
  getById(entityId) {
    if (!entityId) throw new TypeError("entity-store.getById requires entityId.");
    return rowToEntity(this.#selectById.get(entityId));
  }

  /** Full entity_history ledger for (vaultId, category, key), newest-first. */
  history({ vaultId, category, key }) {
    if (!vaultId) throw new TypeError("entity-store.history requires vaultId.");
    const currentRow = this.#selectByKey.get(vaultId, category, key);
    if (!currentRow) return [];
    return this.#selectHistoryDesc.all(currentRow.entity_id).map(historyRowToEntry);
  }

  /**
   * Soft delete only: sets lifecycle_state='forgotten' and valid_to=now on
   * the entities row, and appends a final entity_history row. Never issues
   * DELETE FROM entities or DELETE FROM entity_history.
   */
  forget({ vaultId, category, key, reason, actor }) {
    if (!vaultId) throw new TypeError("entity-store.forget requires vaultId.");
    if (!actor) throw new TypeError("entity-store.forget requires actor.");

    const run = this.#db.transaction(() => {
      const currentRow = this.#selectByKey.get(vaultId, category, key);
      if (!currentRow) {
        throw new MemoryNotFoundError(`No memory entity found for vault_id="${vaultId}" category="${category}" key="${key}".`);
      }
      if (currentRow.lifecycle_state === "forgotten") {
        return rowToEntity(currentRow);
      }

      const now = new Date().toISOString();
      const nextVersion = currentRow.current_version + 1;

      this.#db
        .prepare(
          `UPDATE entities SET lifecycle_state = 'forgotten', valid_to = @valid_to,
             current_version = @current_version, updated_at = @updated_at
           WHERE entity_id = @entity_id`,
        )
        .run({
          entity_id: currentRow.entity_id,
          valid_to: now,
          current_version: nextVersion,
          updated_at: now,
        });

      this.#insertHistory.run({
        entity_id: currentRow.entity_id,
        version: nextVersion,
        body_json: currentRow.body_json,
        epistemic_state: currentRow.epistemic_state,
        confidence: currentRow.confidence,
        valid_from: currentRow.valid_from,
        valid_to: now,
        recorded_at: now,
        superseded_at: null,
        change_reason: reason ?? "forget",
        actor,
        source_hash: currentRow.source_hash,
      });

      return rowToEntity(this.#selectById.get(currentRow.entity_id));
    });

    return run();
  }
}
