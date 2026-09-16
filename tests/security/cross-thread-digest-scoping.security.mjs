import assert from "node:assert/strict";
import test from "node:test";
import { fixture, OWNER } from "../fixtures/phase6-runtime.mjs";

test("Phase6 digest pages only own DIRECT facts, exposes reference-only receipts, and supports agent-agnostic passport reads", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault();
    const a = await f.source(); const b = await f.source();
    const first = await f.consolidate(a.record.recordId, vault.principalPrivateVaultId);
    await f.consolidate(b.record.recordId, vault.principalPrivateVaultId);
    const promoted = await f.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: "passport" });
    const ownB = { ...OWNER, agentId: "agent-two" };
    const secondVault = await f.vault(ownB);
    const ownSource = await f.source({ claims: ownB });
    await f.consolidate(ownSource.record.recordId, secondVault.principalPrivateVaultId, "other-agent", {}, ownB);
    const input = { include_passport: true, limit: 1 };
    const before = f.db.prepare("SELECT COUNT(*) AS n FROM grant_nonces").get().n;
    const page1 = await f.signed("msp_memory_context_digest", input);
    const page2 = await f.signed("msp_memory_context_digest", { ...input, cursor: page1.next_cursor });
    assert.ok(page1.next_cursor); assert.equal(page2.next_cursor, null);
    const cursorParts = page1.next_cursor.split(".");
    const altered = JSON.parse(Buffer.from(cursorParts[0], "base64url").toString());
    altered[1] = "2099-01-01T00:00:00.000Z";
    cursorParts[0] = Buffer.from(JSON.stringify(altered)).toString("base64url");
    await assert.rejects(f.signed("msp_memory_context_digest", { ...input, cursor: cursorParts.join(".") }), /validation_failed/);
    const all = [...page1.items, ...page2.items];
    assert.deepEqual(new Set(all.map(row => row.entity_id)), new Set([first.entity_id, promoted.passport_entity_id]));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM grant_nonces").get().n, before);
    assert.ok(all.every(row => Object.keys(row).sort().join() === ['entity_id','vault_id','category','key','confidence','provenance_receipt'].sort().join()));
    const passport = await f.signed("msp_memory_context_digest", { include_passport: true }, { tenantId: OWNER.tenantId, principalId: OWNER.principalId, allowPassport: true });
    assert.deepEqual(passport.items.map(row => row.entity_id), [promoted.passport_entity_id]);
    await assert.rejects(f.signed("msp_memory_context_digest", input, { ...OWNER, allowPassport: false }), /not_found/);
    await assert.rejects(f.signed("msp_memory_context_digest", { ...input, cursor: page1.next_cursor }, ownB), /validation_failed/);
    for (const change of [{ limit: 51 }, { limit: 0 }, { cursor: "%%%" }, { query: "x".repeat(1025) }]) {
      await assert.rejects(f.signed("msp_memory_context_digest", { ...input, ...change }), /validation_failed/);
    }
    assert.deepEqual((await f.signed("msp_memory_context_digest", { query: "no match" })).items, []);
    f.db.prepare("UPDATE protected_memory_records SET redaction_state='tombstoned',body_json='{}',scope_json='{}' WHERE record_id=?").run(a.record.recordId);
    assert.deepEqual((await f.signed("msp_memory_context_digest", { include_passport: true })).items, []);
  } finally { await f.close(); }
});

test("Phase6 source and passport promotion cannot borrow another agent's private tuple", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault(); const source = await f.source();
    const first = await f.consolidate(source.record.recordId, vault.principalPrivateVaultId);
    f.db.prepare("UPDATE entities SET body_json='malformed-json' WHERE entity_id=?").run(first.entity_id);
    for (const changed of [{ agentId: "other" }, { workspaceId: "other" }, { tenantId: "other" }, { principalId: "bob" }, { allowPassport: false }]) {
      await assert.rejects(f.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: "bad" }, { ...OWNER, ...changed }), /not_found/);
    }
    const other = { ...OWNER, agentId: "other" }; const otherVault = await f.vault(other);
    await assert.rejects(f.consolidate(source.record.recordId, otherVault.principalPrivateVaultId, "borrowed", {}, other), /not_found/);
  } finally { await f.close(); }
});
