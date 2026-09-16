import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/phase6-runtime.mjs";

test("Phase6 excludes historical GROUP and ROOM records and unresolved speakers from private memory", async () => {
  const f = await fixture();
  try {
    const vault = await f.vault();
    for (const kind of ["GROUP", "ROOM"]) {
      const group = await f.source({ kind });
      await assert.rejects(f.signed("msp_thread_memory_record", group.input, group.scope), /thread_scope_denied/);
      assert.equal((await f.consolidate(group.record.recordId, vault.principalPrivateVaultId)).reason, "source_ineligible");
      for (const speaker_kind of ["UNKNOWN", "OPERATOR"]) {
        await f.signed("msp_thread_message_append", { thread_id: group.thread.threadId, source_event_id: `${kind}-${speaker_kind}`,
          speaker_id: `${kind}-${speaker_kind}`, speaker_kind, identity_assurance: "UNRESOLVED", direction: "INBOUND", text: "must stay in group" }, group.scope);
        await assert.rejects(f.signed("msp_thread_memory_record", { ...group.input, asserted_by_speaker_id: `${kind}-${speaker_kind}` }, group.scope), /thread_scope_denied/);
      }
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 0);
    assert.deepEqual((await f.signed("msp_memory_context_digest", { include_passport: true })).items, []);
  } finally { await f.close(); }
});
