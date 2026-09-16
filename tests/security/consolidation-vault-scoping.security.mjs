import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fixture, OWNER, sign } from "../fixtures/phase6-runtime.mjs";

test("Phase6 revalidates live source eligibility before returning an idempotent response", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const a = await f.source(); const b = await f.source();
    const input = { source_record_id: a.record.recordId, target_vault_id: vault.principalPrivateVaultId,
      entity_category: "preference", entity_key: "language", idempotency_key: "live-retry" };
    const entity = await f.signed("msp_memory_consolidate", input);
    await f.consolidate(b.record.recordId, vault.principalPrivateVaultId);
    const promotion = { entity_id: entity.entity_id, idempotency_key: "live-promotion" };
    await f.signed("msp_memory_passport_promote", promotion);
    f.db.prepare("UPDATE protected_memory_records SET status='REVOKED',version=version+1,updated_at=? WHERE record_id=?")
      .run(new Date().toISOString(), a.record.recordId);
    await assert.rejects(f.signed("msp_memory_consolidate", input), /not_found/);
    await assert.rejects(f.signed("msp_memory_passport_promote", promotion), /not_found/);
  } finally { await f.close(); }
});

test("Phase6 THREAD visibility still requires the source thread's current agent/workspace attachment", async () => {
  const f = await fixture();
  try {
    const source = await f.source({ visibility: "THREAD" });
    const claims = { ...OWNER, agentId: "unattached" };
    const vault = await f.vault(claims);
    await assert.rejects(f.consolidate(source.record.recordId, vault.principalPrivateVaultId, "borrow", {}, claims), /not_found/);
  } finally { await f.close(); }
});

test("Phase6 consolidates two confirmed sessions into one entity, promotes with reference-only replay, and keeps nonce protection", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault();
    const a = await f.source({ confidence: 0.9 });
    const input = { source_record_id: a.record.recordId, target_vault_id: vault.principalPrivateVaultId,
      entity_category: "preference", entity_key: "language", idempotency_key: "first" };
    const request = sign("msp_memory_consolidate", input);
    const first = await f.call("msp_memory_consolidate", request);
    assert.equal(first.decision, "consolidated");
    await assert.rejects(f.call("msp_memory_consolidate", request), /not_found: memory target is unavailable/);
    assert.deepEqual(await f.signed("msp_memory_consolidate", input), { ...first, replay: true });
    assert.deepEqual(await f.signed("msp_memory_consolidate", Object.fromEntries(Object.entries(input).reverse())), { ...first, replay: true });
    await assert.rejects(f.signed("msp_memory_consolidate", { ...input, entity_key: "different" }), /conflict/);
    const below = await f.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: "below" });
    assert.equal(below.reason, "threshold_not_met");
    const b = await f.source({ confidence: 0.8, body: { language: "English" } });
    const second = await f.consolidate(b.record.recordId, vault.principalPrivateVaultId);
    assert.equal(second.entity_id, first.entity_id);
    const entity = f.db.prepare("SELECT * FROM entities WHERE entity_id=?").get(first.entity_id);
    assert.equal(entity.current_version, 2);
    assert.equal(entity.confidence, 0.9);
    assert.equal(JSON.parse(entity.body_json).language, "English");
    await assert.rejects(f.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: "below" }), /conflict.*source set/);
    const promotion = { entity_id: first.entity_id, idempotency_key: "promote" };
    const promoted = await f.signed("msp_memory_passport_promote", promotion);
    assert.equal(promoted.decision, "promoted");
    assert.equal(promoted.provenance_ids.length, 2);
    assert.deepEqual(await f.signed("msp_memory_passport_promote", promotion), { ...promoted, replay: true });
    await assert.rejects(f.signed("msp_memory_passport_promote", { ...promotion, idempotency_key: "duplicate" }), /conflict/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entity_provenance").get().n, 4);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entity_history WHERE entity_id=?").get(first.entity_id).n, 2);
    assert.ok(f.db.prepare("SELECT * FROM entity_provenance").all().every(row => row.policy_version === "phase6-v1"));
    assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM state WHERE state_key LIKE 'phase6:%'").all()).includes('alice'));
  } finally { await f.close(); }
});

test("Phase6 serializes two real-process idempotent writes and maps a held writer lock to conflict", async () => {
  const f = await fixture(); let second;
  try {
    const vault = await f.vault(); const source = await f.source();
    second = f.fork(); await second("msp_ping", {});
    const input = { source_record_id: source.record.recordId, target_vault_id: vault.principalPrivateVaultId,
      entity_category: "preference", entity_key: "race", idempotency_key: "race" };
    const name = "msp_memory_consolidate";
    const results = await Promise.all([f.signed(name, input), second(name, sign(name, input))]);
    assert.equal(results[0].entity_id, results[1].entity_id);
    assert.deepEqual(results.map(row => row.replay).sort(), [false, true]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entity_provenance").get().n, 1);
    const request = sign(name, { ...input, idempotency_key: "locked", entity_key: "locked" });
    f.db.exec("BEGIN IMMEDIATE");
    try { await assert.rejects(f.call(name, request), /conflict: concurrent memory mutation/); }
    finally { f.db.exec("ROLLBACK"); }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM grant_nonces WHERE nonce=?").get(request.access.grant.nonce).n, 0);
    assert.equal((await f.call(name, request)).decision, "consolidated");
  } finally { await second?.close(); await f.close(); }
});

test("Phase6 principal refusals have one exact envelope for absent/invalid grant, source, target, tenant and agent", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const source = await f.source();
    const input = { source_record_id: source.record.recordId, target_vault_id: vault.principalPrivateVaultId,
      entity_category: "preference", entity_key: "language", idempotency_key: "test" };
    const bad = sign("msp_memory_consolidate", input); bad.access.signature = "00".repeat(32);
    const cases = [input, bad, sign("msp_memory_consolidate", input, { ...OWNER, principalId: "bob" }),
      sign("msp_memory_consolidate", input, { ...OWNER, tenantId: "other" }),
      sign("msp_memory_consolidate", input, { ...OWNER, agentId: "other" }),
      sign("msp_memory_consolidate", input, { ...OWNER, workspaceId: "other" }),
      sign("msp_memory_consolidate", { ...input, target_vault_id: "unknown" }),
      sign("msp_memory_consolidate", { ...input, source_record_id: "unknown" }),
      sign("msp_memory_consolidate", { ...input, target_vault_id: vault.principalPassportVaultId })];
    const global = f.db.prepare("SELECT vault_id FROM vaults WHERE vault_type='global_private'").get();
    cases.push(sign("msp_memory_consolidate", { ...input, target_vault_id: global.vault_id }));
    let message;
    for (const args of cases) await assert.rejects(f.call("msp_memory_consolidate", args), error => {
      message ??= error.message; assert.equal(error.message, message); return true;
    });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 0);
  } finally { await f.close(); }
});

test("Phase6 defers ineligible sources, rejects caller confidence, and never counts a repeated session twice", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const a = await f.source({ state: "CANDIDATE" });
    assert.equal((await f.consolidate(a.record.recordId, vault.principalPrivateVaultId)).reason, "source_ineligible");
    await assert.rejects(f.consolidate(a.record.recordId, vault.principalPrivateVaultId, "language", { confidence: 1 }), /validation_failed/);
    const b = await f.source();
    const first = await f.consolidate(b.record.recordId, vault.principalPrivateVaultId);
    const record = await f.signed("msp_thread_memory_record", { ...b.input, body: { language: "new" } }, b.scope);
    await f.consolidate(record.recordId, vault.principalPrivateVaultId);
    const result = await f.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: randomUUID() });
    assert.equal(result.reason, "threshold_not_met");
    await assert.rejects(f.consolidate(b.record.recordId, vault.principalPrivateVaultId), /conflict/);
    for (const confidence of [-0.01, 1.01, "0.9", null]) await assert.rejects(f.signed("msp_thread_memory_record", { ...b.input, confidence }, b.scope), /validation_failed/);
  } finally { await f.close(); }
});

test("Phase6 rollback restores entities, provenance, idempotency and nonce on a failed provenance write", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const source = await f.source();
    const input = { source_record_id: source.record.recordId, target_vault_id: vault.principalPrivateVaultId,
      entity_category: "preference", entity_key: "language", idempotency_key: "atomic" };
    const request = sign("msp_memory_consolidate", input);
    f.db.exec("CREATE TRIGGER phase6_test_abort BEFORE INSERT ON entity_provenance BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
    await assert.rejects(f.call("msp_memory_consolidate", request), /injected write failure/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entity_history").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM grant_nonces WHERE nonce=?").get(request.access.grant.nonce).n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM state WHERE state_key LIKE 'phase6:%'").get().n, 0);
    f.db.exec("DROP TRIGGER phase6_test_abort");
    assert.equal((await f.call("msp_memory_consolidate", request)).decision, "consolidated");
  } finally { await f.close(); }
});
