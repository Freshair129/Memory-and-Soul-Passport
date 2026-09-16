import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { consumeGrantNonce } from "./grant-nonces.mjs";
import { MemoryNotFoundError, MemoryConflictError, ThreadValidationError } from "./errors.mjs";

const POLICY = "phase6-v1";
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const unavailable = () => new MemoryNotFoundError("not_found: memory target is unavailable.");

// Called only with verified claims by the transport. All mutation reads,
// nonce consumption and result bookkeeping share the same immediate TX.
export class ConsolidationStore {
  constructor({ db, entityStore, vaultRegistry }) {
    this.db = db;
    this.entities = entityStore;
    this.vaults = vaultRegistry;
  }

  ownedVault(id, grant, type = "principal_private") {
    const vault = this.vaults.getVaultById(id);
    if (vault?.vault_type !== type || this.vaults.classifyPrincipalAccess(vault, grant) !== "ok") throw unavailable();
    return vault;
  }

  source(id, grant, { passport = false } = {}) {
    const row = this.db.prepare(`SELECT r.*, t.thread_kind, s.session_id AS valid_session
      FROM protected_memory_records r JOIN threads t ON t.thread_id=r.thread_id AND t.tenant_id=r.tenant_id
      LEFT JOIN chat_sessions s ON s.session_id=r.session_id AND s.thread_id=r.thread_id AND s.tenant_id=r.tenant_id
      WHERE r.record_id=?`).get(id);
    if (!row || row.tenant_id !== grant.tenantId || row.subject_person_id !== grant.principalId ||
      (!passport && row.visibility === "AGENT" && row.agent_id !== grant.agentId)) throw unavailable();
    if (!passport && !this.db.prepare("SELECT 1 FROM thread_agents WHERE thread_id=? AND tenant_id=? AND agent_id=? AND workspace_id=? AND left_at IS NULL")
      .get(row.thread_id, grant.tenantId, grant.agentId, grant.workspaceId)) throw unavailable();
    const refs = JSON.parse(row.source_message_refs_json);
    row.live_sources = Array.isArray(refs) && refs.length > 0 && refs.every(id => this.db.prepare(
      "SELECT 1 FROM thread_messages WHERE message_id=? AND thread_id=? AND session_id=? AND tenant_id=? AND redaction_state='none'")
      .get(id, row.thread_id, row.session_id, row.tenant_id));
    return row;
  }

  eligible(row) {
    return row.status === "ACTIVE" && row.verification_state === "CONFIRMED" && row.redaction_state === "none" &&
      row.thread_kind === "DIRECT" && row.valid_session && row.live_sources && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1;
  }

  mutate(name, args, grant, work) {
    try {
      return this.db.transaction(() => {
        consumeGrantNonce(this.db, { tenantId: grant.tenantId, nonce: grant.nonce, expiresAt: grant.expiresAt });
        const stateKey = `phase6:${hash([grant.tenantId, name, args.idempotency_key])}`;
        const requestHash = hash([args, grant.tenantId, grant.principalId, grant.agentId, grant.workspaceId, grant.allowPassport === true]);
        const saved = this.db.prepare("SELECT value_json FROM state WHERE state_key=?").get(stateKey);
        const prior = saved ? JSON.parse(saved.value_json) : null;
        const assertRequest = () => {
          if (prior && prior.requestHash !== requestHash) throw new MemoryConflictError("conflict: idempotency key names a different request.");
        };
        const result = work(prior, assertRequest);
        if (!prior) this.db.prepare("INSERT INTO state(state_key,value_json,expires_at,updated_at) VALUES(?,?,NULL,?)")
          .run(stateKey, JSON.stringify({ requestHash, policy_version: POLICY, ...result }), new Date().toISOString());
        return prior ? { ...result.response, replay: true } : result.response;
      }).immediate();
    } catch (error) {
      if (error?.code === "grant_replayed") throw unavailable();
      if (error?.code?.startsWith("SQLITE_BUSY") || error?.code?.startsWith("SQLITE_CONSTRAINT_UNIQUE") || error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new MemoryConflictError("conflict: concurrent memory mutation; retry with a fresh grant.");
      }
      throw error;
    }
  }

  appendProvenance({ name, args, grant, source, entity, decision, sessions, sourceSetHash }) {
    const id = `provenance_${randomUUID()}`;
    this.db.prepare(`INSERT INTO entity_provenance
      (provenance_id,tenant_id,operation,source_record_id,source_thread_id,source_session_id,source_message_refs_json,
       target_vault_id,target_entity_id,decision,confidence,confirmed_session_count,policy_version,idempotency_key,source_set_hash,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, grant.tenantId, name, source.record_id, source.thread_id, source.session_id,
      source.source_message_refs_json, entity.vault_id, entity.entity_id, decision, source.confidence, sessions, POLICY,
      args.idempotency_key, sourceSetHash, new Date().toISOString());
    return id;
  }

  consolidate(args, grant) {
    const name = "msp_memory_consolidate";
    return this.mutate(name, args, grant, (prior, assertRequest) => {
      this.ownedVault(args.target_vault_id, grant);
      const source = this.source(args.source_record_id, grant);
      assertRequest();
      if (prior) {
        if (prior.response.decision === "consolidated" && !this.eligible(source)) throw unavailable();
        return prior;
      }
      if (!this.eligible(source)) return { response: { decision: "passport_deferred", reason: "source_ineligible" } };
      const existing = this.db.prepare("SELECT * FROM entities WHERE vault_id=? AND category=? AND key=?")
        .get(args.target_vault_id, args.entity_category, args.entity_key);
      if (existing && this.db.prepare("SELECT 1 FROM entity_provenance WHERE operation=? AND source_record_id=? AND target_entity_id=?")
        .get(name, source.record_id, existing.entity_id)) throw new MemoryConflictError("conflict: source already consolidated into this entity.");
      const { entity } = this.entities.upsert({ vaultId: args.target_vault_id, category: args.entity_category, key: args.entity_key,
        bodyJson: JSON.parse(source.body_json), epistemicState: "confirmed", confidence: Math.max(existing?.confidence ?? 0, source.confidence),
        actor: "phase6", reason: POLICY });
      const sessions = new Set(this.db.prepare("SELECT source_session_id FROM entity_provenance WHERE target_entity_id=? AND decision='consolidated' AND redaction_state='none'")
        .all(entity.entity_id).map((row) => row.source_session_id));
      sessions.add(source.session_id);
      const provenanceId = this.appendProvenance({ name, args, grant, source, entity, decision: "consolidated", sessions: sessions.size,
        sourceSetHash: hash([[source.record_id], entity.entity_id, POLICY]) });
      return { response: { decision: "consolidated", entity_id: entity.entity_id, target_vault_id: entity.vault_id, provenance_id: provenanceId, replay: false } };
    });
  }

  promote(args, grant) {
    const name = "msp_memory_passport_promote";
    return this.mutate(name, args, grant, (prior, assertRequest) => {
      const reference = this.db.prepare("SELECT vault_id FROM entities WHERE entity_id=?").get(args.entity_id);
      if (!reference) throw unavailable();
      this.ownedVault(reference.vault_id, grant);
      const entity = this.entities.getById(args.entity_id);
      assertRequest();
      const rows = this.db.prepare("SELECT * FROM entity_provenance WHERE target_entity_id=? AND decision='consolidated' AND redaction_state='none' ORDER BY source_record_id")
        .all(entity.entity_id);
      const sourceSetHash = hash([rows.map((row) => row.source_record_id), entity.entity_id, POLICY]);
      const sources = rows.map((row) => this.source(row.source_record_id, grant));
      if (prior) {
        if (prior.response.decision === "promoted" && (entity.lifecycle_state === "forgotten" || !sources.length || sources.some(row => !this.eligible(row)))) throw unavailable();
        if (prior.sourceSetHash !== sourceSetHash) throw new MemoryConflictError("conflict: candidate source set changed.");
        return prior;
      }
      const deferred = (reason) => ({ sourceSetHash, response: { decision: "passport_deferred", reason, entity_id: entity.entity_id, replay: false } });
      if (entity.lifecycle_state === "forgotten" || sources.some((row) => !this.eligible(row))) return deferred("source_ineligible");
      const sessions = new Set(sources.map((row) => row.session_id));
      const confidence = Math.max(0, ...sources.map((row) => row.confidence));
      if (sessions.size < 2 || confidence < 0.9) return deferred("threshold_not_met");
      const vault = this.vaults.provisionPrincipalPassportVault({ tenantId: grant.tenantId, principalId: grant.principalId });
      this.ownedVault(vault.vault_id, grant, "principal_passport");
      const target = this.db.prepare("SELECT * FROM entities WHERE vault_id=? AND category=? AND key=?").get(vault.vault_id, entity.category, entity.key);
      if (target && this.db.prepare("SELECT 1 FROM entity_provenance WHERE target_entity_id=? AND decision='promoted' AND source_set_hash=?")
        .get(target.entity_id, sourceSetHash)) throw new MemoryConflictError("conflict: source set already promoted.");
      if (target && sources.some((row) => this.db.prepare("SELECT 1 FROM entity_provenance WHERE target_entity_id=? AND decision='promoted' AND source_record_id=?")
        .get(target.entity_id, row.record_id))) return deferred("duplicate_source");
      const { entity: passport } = this.entities.upsert({ vaultId: vault.vault_id, category: entity.category, key: entity.key,
        bodyJson: entity.body_json, epistemicState: "confirmed", confidence, actor: "phase6", reason: POLICY });
      const ids = sources.map((source) => this.appendProvenance({ name, args, grant, source, entity: passport,
        decision: "promoted", sessions: sessions.size, sourceSetHash }));
      return { sourceSetHash, response: { decision: "promoted", entity_id: entity.entity_id, passport_entity_id: passport.entity_id, provenance_ids: ids, replay: false } };
    });
  }

  digest(args, grant, cursorKey) {
    // One read transaction provides a consistent vault/source/provenance view.
    return this.db.transaction(() => {
      const vaults = this.db.prepare("SELECT * FROM vaults WHERE tenant_id=? AND principal_id=? AND status='active' AND vault_type IN ('principal_private','principal_passport')")
        .all(grant.tenantId, grant.principalId).filter((vault) => (vault.vault_type !== "principal_passport" || args.include_passport === true) &&
          this.vaults.classifyPrincipalAccess(vault, grant) === "ok");
      if (!vaults.length) throw unavailable();
      const binding = hash([grant.tenantId, grant.principalId, grant.agentId, grant.workspaceId, args.include_passport === true, args.query ?? "", args.limit ?? 20]);
      const mac = (payload) => createHmac("sha256", cursorKey).update(`phase6-cursor:${payload}`).digest();
      let after = null;
      if (args.cursor) {
        try {
          const parts = args.cursor.split(".");
          if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
          const actual = Buffer.from(parts[1], "base64url");
          const expected = mac(parts[0]);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
          after = JSON.parse(Buffer.from(parts[0], "base64url").toString());
          if (!Array.isArray(after) || after.length !== 3 || after[0] !== binding || typeof after[1] !== "string" || typeof after[2] !== "string") throw new Error();
        } catch { throw new ThreadValidationError("invalid digest cursor."); }
      }
      const ids = vaults.map((vault) => vault.vault_id);
      const query = args.query ?? "";
      const candidates = this.db.prepare(`SELECT * FROM entities WHERE vault_id IN (${ids.map(() => "?").join(",")})
        AND lifecycle_state != 'forgotten' AND (?='' OR instr(lower(category || ' ' || key || ' ' || body_json),lower(?))>0)
        AND (recorded_at>? OR (recorded_at=? AND entity_id>?)) ORDER BY recorded_at,entity_id`)
        .iterate(...ids, query, query, after?.[1] ?? "", after?.[1] ?? "", after?.[2] ?? "");
      const items = [];
      const limit = args.limit ?? 20;
      let last = null;
      let more = false;
      for (const entity of candidates) {
        const passport = vaults.find((row) => row.vault_id === entity.vault_id).vault_type === "principal_passport";
        const provenance = this.db.prepare("SELECT * FROM entity_provenance WHERE tenant_id=? AND target_vault_id=? AND target_entity_id=? AND operation=? AND redaction_state='none' ORDER BY recorded_at,provenance_id")
          .all(grant.tenantId, entity.vault_id, entity.entity_id, passport ? "msp_memory_passport_promote" : "msp_memory_consolidate");
        let eligible = provenance.length > 0;
        for (const row of provenance) {
          try { if (!this.eligible(this.source(row.source_record_id, grant, { passport }))) eligible = false; }
          catch (error) { if (error.code === "not_found") eligible = false; else throw error; }
        }
        if (!eligible) continue;
        if (items.length === limit) { more = true; break; }
        items.push({ entity_id: entity.entity_id, vault_id: entity.vault_id, category: entity.category, key: entity.key,
          confidence: entity.confidence, provenance_receipt: provenance[0].provenance_id });
        last = [binding, entity.recorded_at, entity.entity_id];
      }
      const payload = more ? Buffer.from(JSON.stringify(last)).toString("base64url") : null;
      return { items, next_cursor: payload ? `${payload}.${mac(payload).toString("base64url")}` : null };
    })();
  }
}
