// BL-MEMOS-073: direct-domain proof for the bounded, atomic erase_vault
// extension. The test seeds the existing thread path through its handler,
// then seeds vault entities/provenance directly to keep this file independent
// of root-owned Phase 6 transport wiring.
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../apps/msp-server/src/server.mjs";
import { ThreadMemoryStore, MemoryErasureLimitError } from "../../packages/msp-core/src/domain/thread-memory.mjs";

const roots = [];
const servers = [];
const IDENTITY_KEY = "phase6-vault-erasure-test-identity-key-32bytes";
const IDENTITY_KEY_VERSION = "identity-v1";

afterEach(() => {
  while (servers.length) servers.pop().close();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function nonce() {
  return randomBytes(16).toString("hex");
}

function makeServer() {
  const root = mkdtempSync(path.join(tmpdir(), "msp-phase6-erasure-"));
  roots.push(root);
  const server = createServer({
    dbPath: path.join(root, "msp.sqlite3"),
    env: { ...process.env, MSP_TEST_CLOCK: "1", MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY, MSP_IDENTITY_HMAC_KEY_VERSION: IDENTITY_KEY_VERSION },
  });
  servers.push(server);
  return server;
}

function grantFields() {
  return { grant_agent_id: "agent-p6", grant_workspace_id: "workspace-p6", grant_nonce: nonce(), grant_expires_at: Date.now() + 60_000 };
}

function seedVault(db, { vaultId, type, principalId = "principal-p6", agentId = "agent-p6", workspaceId = "workspace-p6" }) {
  const passport = type === "principal_passport";
  db.prepare("INSERT INTO vaults (vault_id, vault_type, status, decay_policy, tenant_id, principal_id, agent_id, workspace_id, role, created_at) VALUES (?, ?, 'active', ?, 'tenant-p6', ?, ?, ?, 'memory', ?)")
    .run(vaultId, type, passport ? "pinned" : "ebbinghaus", principalId, passport ? null : agentId, passport ? null : workspaceId, "2026-09-17T00:00:00.000Z");
}

function seedProvenance(db, { provenanceId, sourceRecordId, targetVaultId, targetEntityId }) {
  db.prepare(`INSERT INTO entity_provenance
    (provenance_id, tenant_id, operation, source_record_id, source_thread_id, source_session_id,
     source_message_refs_json, target_vault_id, target_entity_id, decision, confidence,
     confirmed_session_count, policy_version, idempotency_key, source_set_hash, recorded_at)
    VALUES (?, 'tenant-p6', 'msp_memory_consolidate', ?, 'thread-p6', 'session-p6',
     '["message-p6"]', ?, ?, 'consolidated', 0.91, 1, 'phase6-v1', ?, 'set-p6', '2026-09-17T00:00:00.000Z')`)
    .run(provenanceId, sourceRecordId, targetVaultId, targetEntityId, `idem-${provenanceId}`);
}

describe("Phase 6 vault erasure", () => {
  it("atomically clears principal vault content, history, retrieval, provenance, and owner tuple", async () => {
    const server = makeServer();
    const handlers = server.threadHandlers;
    const { thread } = await handlers.msp_thread_resolve({
      ...grantFields(),
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE",
      channel_account_id: "oa-p6",
      external_room_ref: "room-p6",
      tenant_id: "tenant-p6",
      business_id: "business-p6",
    });
    const inbound = await handlers.msp_thread_message_append({
      ...grantFields(),
      thread_id: thread.threadId,
      source_event_id: "event-p6",
      speaker_id: "principal-p6",
      speaker_kind: "HUMAN",
      person_id: "principal-p6",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: "private source text",
    });
    const store = new ThreadMemoryStore(server.db, server.journal, { identityHmacKey: IDENTITY_KEY, identityHmacKeyVersion: IDENTITY_KEY_VERSION });
    const record = store.recordProtectedMemory({
      threadId: thread.threadId,
      sessionId: inbound.session.sessionId,
      kind: "PREFERENCE",
      assertedBySpeakerId: "principal-p6",
      subjectPersonId: "principal-p6",
      body: { text: "source memory" },
      sourceMessageRefs: [inbound.message.messageId],
      verificationState: "CONFIRMED",
      confidence: 0.83,
      nonce: nonce(),
      grantExpiresAt: Date.now() + 60_000,
    });
    expect(record.confidence).toBe(0.83);
    expect(() => server.db.prepare("UPDATE protected_memory_records SET confidence = 0.5 WHERE record_id = ?").run(record.recordId)).toThrow(/may only be superseded|tombstoned/i);

    seedVault(server.db, { vaultId: "vault-p6-private", type: "principal_private" });
    seedVault(server.db, { vaultId: "vault-p6-passport", type: "principal_passport" });
    const privateEntity = server.entityStore.upsert({ vaultId: "vault-p6-private", category: "preference", key: "coffee", bodyJson: { text: "private secret" }, epistemicState: "confirmed", confidence: 0.91, actor: "test" }).entity;
    const passportEntity = server.entityStore.upsert({ vaultId: "vault-p6-passport", category: "preference", key: "passport", bodyJson: { text: "passport secret" }, epistemicState: "confirmed", confidence: 0.91, actor: "test" }).entity;
    for (const entity of [privateEntity, passportEntity]) {
      server.db.prepare("INSERT INTO embeddings (entity_id, vector, content_hash, created_at) VALUES (?, ?, ?, ?)").run(entity.entity_id, Buffer.from("embedding"), "hash", "2026-09-17T00:00:00.000Z");
    }
    seedProvenance(server.db, { provenanceId: "prov-p6-private", sourceRecordId: record.recordId, targetVaultId: "vault-p6-private", targetEntityId: privateEntity.entity_id });
    seedProvenance(server.db, { provenanceId: "prov-p6-passport", sourceRecordId: record.recordId, targetVaultId: "vault-p6-passport", targetEntityId: passportEntity.entity_id });

    const result = store.erasePrincipal({
      principalId: "principal-p6",
      tenantId: "tenant-p6",
      idempotencyKey: "erase-vault-p6",
      agentId: "agent-p6",
      workspaceId: "workspace-p6",
      eraseVault: true,
      nonce: nonce(),
      grantExpiresAt: Date.now() + 60_000,
    });
    expect(result.replay).toBe(false);
    expect(result).not.toHaveProperty("principalId");
    expect(result).not.toHaveProperty("tenantId");
    expect(result.tablesAffected).toMatchObject({ vaults: 2, entities: 2, entityHistory: 2, embeddings: 2, entitiesFts: 2, entityProvenance: 2 });
    expect(server.db.prepare("SELECT status, tenant_id, principal_id, agent_id, workspace_id FROM vaults WHERE vault_id = 'vault-p6-private'").get()).toEqual({ status: "erased", tenant_id: null, principal_id: null, agent_id: null, workspace_id: null });
    expect(server.db.prepare("SELECT lifecycle_state, body_json, epistemic_state, confidence FROM entities ORDER BY entity_id").all()).toEqual([
      { lifecycle_state: "forgotten", body_json: "{}", epistemic_state: "deprecated", confidence: 0 },
      { lifecycle_state: "forgotten", body_json: "{}", epistemic_state: "deprecated", confidence: 0 },
    ]);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM entity_history WHERE redaction_state = 'tombstoned' AND body_json = '{}' AND epistemic_state = 'deprecated' AND confidence = 0").get().count).toBe(2);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM embeddings").get().count).toBe(0);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM entities_fts WHERE entity_id IN (?, ?)").get(privateEntity.entity_id, passportEntity.entity_id).count).toBe(0);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM entity_provenance WHERE redaction_state = 'tombstoned' AND source_message_refs_json = '[]'").get().count).toBe(2);
    expect(server.db.prepare("SELECT redaction_state, text FROM thread_messages WHERE message_id = ?").get(inbound.message.messageId)).toEqual({ redaction_state: "tombstoned", text: "" });

    const replay = store.erasePrincipal({
      principalId: "principal-p6",
      tenantId: "tenant-p6",
      idempotencyKey: "erase-vault-p6",
      agentId: "agent-p6",
      workspaceId: "workspace-p6",
      eraseVault: true,
      nonce: nonce(),
      grantExpiresAt: Date.now() + 60_000,
    });
    expect(replay.replay).toBe(true);
    expect(replay).not.toHaveProperty("principalId");
    expect(replay).not.toHaveProperty("tenantId");
    expect(replay.tablesAffected).toEqual(result.tablesAffected);
  });

  it("refuses a set over 200 rows before mutation and rolls back the nonce", () => {
    const server = makeServer();
    seedVault(server.db, { vaultId: "vault-p6-large", type: "principal_private" });
    const now = "2026-09-17T00:00:00.000Z";
    const insert = server.db.prepare(`INSERT INTO entities
      (entity_id, vault_id, category, key, body_json, epistemic_state, confidence, current_version,
       valid_from, recorded_at, lifecycle_state, decay_score, access_count, source_hash, created_at, updated_at)
      VALUES (?, 'vault-p6-large', 'preference', ?, '{}', 'confirmed', 0.5, 1, ?, ?, 'active', 1, 0, ?, ?, ?)`);
    const insertMany = server.db.transaction(() => {
      for (let index = 0; index < 201; index += 1) insert.run(`entity-p6-large-${index}`, `key-${index}`, now, now, `hash-${index}`, now, now);
    });
    insertMany();
    const store = new ThreadMemoryStore(server.db, server.journal, { identityHmacKey: IDENTITY_KEY, identityHmacKeyVersion: IDENTITY_KEY_VERSION });
    const eraseNonce = nonce();
    expect(() => store.erasePrincipal({
      principalId: "principal-p6",
      tenantId: "tenant-p6",
      idempotencyKey: "erase-over-bound",
      agentId: "agent-p6",
      workspaceId: "workspace-p6",
      eraseVault: true,
      nonce: eraseNonce,
      grantExpiresAt: Date.now() + 60_000,
    })).toThrow(MemoryErasureLimitError);
    expect(server.db.prepare("SELECT status, principal_id FROM vaults WHERE vault_id = 'vault-p6-large'").get()).toEqual({ status: "active", principal_id: "principal-p6" });
    expect(server.db.prepare("SELECT lifecycle_state FROM entities WHERE entity_id = 'entity-p6-large-0'").get()).toEqual({ lifecycle_state: "active" });
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM grant_nonces WHERE tenant_id = 'tenant-p6' AND nonce = ?").get(eraseNonce).count).toBe(0);
  });
});
