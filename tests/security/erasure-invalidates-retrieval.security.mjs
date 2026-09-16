import assert from "node:assert/strict";
import test from "node:test";
import { fixture, OWNER, sign } from "../fixtures/phase6-runtime.mjs";

const eraser = { ...OWNER, audienceKind: "DIRECT", policyRevision: "v1", dataSubjectAccess: true };

test("Phase6 late erasure failure rolls back source, entity, history, FTS, provenance, nonce and receipt", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const source = await f.source();
    const entity = await f.consolidate(source.record.recordId, vault.principalPrivateVaultId);
    const request = sign("msp_thread_principal_erase", { idempotency_key: "rollback", erase_vault: true }, eraser);
    const tables = ['entities','entity_history','entity_provenance','protected_memory_records','thread_messages','thread_participants','vaults','entities_fts','grant_nonces','erasure_receipts'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]));
    const before = snapshot();
    f.db.exec("CREATE TRIGGER phase6_erase_abort BEFORE UPDATE ON vaults WHEN NEW.status='erased' BEGIN SELECT RAISE(ABORT,'injected erasure failure'); END");
    await assert.rejects(f.call("msp_thread_principal_erase", request), /injected erasure failure/);
    assert.deepEqual(snapshot(), before);
    f.db.exec("DROP TRIGGER phase6_erase_abort");
    f.db.exec("CREATE TRIGGER phase6_journal_abort BEFORE INSERT ON journal WHEN NEW.tool_name='msp_thread_principal_erase' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END");
    await assert.rejects(f.call("msp_thread_principal_erase", request), /injected journal failure/);
    assert.deepEqual(snapshot(), before);
    f.db.exec("DROP TRIGGER phase6_journal_abort");
    f.db.exec("BEGIN IMMEDIATE");
    try { await assert.rejects(f.call("msp_thread_principal_erase", request), /conflict/); }
    finally { f.db.exec("ROLLBACK"); }
    assert.deepEqual(snapshot(), before);
    assert.ok((await f.call("msp_thread_principal_erase", request)).erasureReceiptId);
    assert.equal(f.db.prepare("SELECT lifecycle_state FROM entities WHERE entity_id=?").get(entity.entity_id).lifecycle_state, "forgotten");
  } finally { await f.close(); }
});

test("Phase6 real erase_vault clears content and retrieval atomically, preserves immutable receipt, and refuses replay or changed mode", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const a = await f.source(); const b = await f.source();
    const first = await f.consolidate(a.record.recordId, vault.principalPrivateVaultId);
    await f.consolidate(b.record.recordId, vault.principalPrivateVaultId);
    const promoted = await f.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: "promotion" });
    const ids = [first.entity_id, promoted.passport_entity_id];
    for (const id of ids) f.db.prepare(`INSERT INTO embeddings(entity_id,collection,model,dim,vector,content_hash,created_at)
      VALUES(?,'test','synthetic',1,?,'hash',?)`).run(id, Buffer.alloc(4), new Date().toISOString());
    const input = { idempotency_key: "erase", erase_vault: true };
    const request = sign("msp_thread_principal_erase", input, eraser);
    const receipt = await f.call("msp_thread_principal_erase", request);
    assert.ok(receipt.erasureReceiptId);
    assert.ok(!Object.hasOwn(receipt, "principalId"));
    await assert.rejects(f.call("msp_thread_principal_erase", request), /grant_replayed/);
    const retry = await f.signed("msp_thread_principal_erase", input, eraser);
    assert.equal(retry.erasureReceiptId, receipt.erasureReceiptId); assert.equal(retry.replay, true);
    await assert.rejects(f.signed("msp_thread_principal_erase", { ...input, erase_vault: false }, eraser), /conflict/);
    for (const id of ids) {
      assert.deepEqual(f.db.prepare("SELECT body_json,confidence,lifecycle_state FROM entities WHERE entity_id=?").get(id), { body_json: "{}", confidence: 0, lifecycle_state: "forgotten" });
      assert.ok(f.db.prepare("SELECT * FROM entity_history WHERE entity_id=?").all(id).every(row => row.redaction_state === "tombstoned" && row.body_json === "{}" && row.confidence === 0));
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE entity_id=?").get(id).n, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities_fts WHERE entity_id=?").get(id).n, 0);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities_fts WHERE entities_fts MATCH 'Thai'").get().n, 0);
    assert.ok(f.db.prepare("SELECT * FROM entity_provenance").all().every(row => row.redaction_state === "tombstoned" && row.source_message_refs_json === "[]"));
    const tombstones = f.db.prepare("SELECT * FROM vaults WHERE vault_id IN (?,?)").all(vault.principalPrivateVaultId, vault.principalPassportVaultId);
    assert.ok(tombstones.every(row => row.status === "erased" && [row.tenant_id,row.principal_id,row.agent_id,row.workspace_id].every(value => value === null)));
    await assert.rejects(f.signed("msp_memory_context_digest", { include_passport: true }), /not_found/);
    const replacement = await f.vault();
    assert.notEqual(replacement.principalPrivateVaultId, vault.principalPrivateVaultId);
    assert.deepEqual((await f.signed("msp_memory_context_digest", { include_passport: true })).items, []);
  } finally { await f.close(); }
});

test("Phase6 erase refuses row overflow before consuming nonce or mutating a vault", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault();
    f.db.transaction(() => {
      const insert = f.db.prepare(`INSERT INTO entities(entity_id,vault_id,category,key,body_json,valid_from,recorded_at,source_hash,created_at,updated_at)
        VALUES(?,?,'limit',?,'{}',?,?, 'hash',?,?)`);
      const now = new Date().toISOString();
      for (let i=0;i<201;i++) insert.run(`limit-${i}`,vault.principalPrivateVaultId,String(i),now,now,now,now);
    })();
    const request = sign("msp_thread_principal_erase", { idempotency_key: "limit", erase_vault: true }, eraser);
    await assert.rejects(f.call("msp_thread_principal_erase", request), /memory_erasure_limit_exceeded/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erasure_receipts").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM grant_nonces WHERE nonce=?").get(request.access.grant.nonce).n, 0);
    assert.equal(f.db.prepare("SELECT status FROM vaults WHERE vault_id=?").get(vault.principalPrivateVaultId).status, "active");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE lifecycle_state='active'").get().n, 201);
  } finally { await f.close(); }
});
