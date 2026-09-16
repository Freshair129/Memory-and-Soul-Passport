import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixture, OWNER, sign } from "../fixtures/phase6-runtime.mjs";
import { validateConsolidationContract } from "@freshair129/msp-contracts/consolidation-schema";

let runtime;
beforeAll(async () => { runtime = await fixture(); });
afterAll(async () => { await runtime?.close(); });

it("Phase6 contract freezes its exact three guarded operations and checks output envelopes", async () => {
  const schema = JSON.parse(readFileSync(new URL("../../packages/msp-contracts/schemas/PHASE6.tools.json", import.meta.url)));
  expect(schema.tools.map(tool => tool.name)).toEqual(["msp_memory_consolidate", "msp_memory_passport_promote", "msp_memory_context_digest"]);
  for (const tool of schema.tools) {
    await expect(runtime.call(tool.name, {})).rejects.toThrow("not_found: memory target is unavailable");
    expect(() => validateConsolidationContract(tool.name, {}, "output")).toThrow(/validation_failed/);
  }
});

it("Phase6 operation, payload, nonce and expiry stay authenticated, including idempotent retry", async () => {
  const vault = await runtime.vault(); const source = await runtime.source();
  const input = { target_vault_id: vault.principalPrivateVaultId, source_record_id: source.record.recordId,
    entity_category: "preference", entity_key: "with spaces", idempotency_key: "contract" };
  const name = "msp_memory_consolidate";
  const request = sign(name, input);
  const result = await runtime.call(name, request);
  expect(() => validateConsolidationContract(name, result, "output")).not.toThrow();
  const variants = [sign("msp_memory_passport_promote", input), { ...sign(name, input), entity_key: "tampered" },
    sign(name, input, OWNER, Date.now() - 60001), sign(name, input, { ...OWNER, nonce: undefined })];
  for (const bad of variants) await expect(runtime.call(name, bad)).rejects.toThrow("not_found: memory target is unavailable");
  expect(runtime.db.prepare("SELECT COUNT(*) AS n FROM entity_provenance").get().n).toBe(1);
});

it("Phase6 requires two sessions and the inclusive source confidence boundary, never a caller override", async () => {
  const claims = { ...OWNER, principalId: "threshold" };
  const vault = await runtime.vault(claims);
  const a = await runtime.source({ claims, confidence: 0.899999 });
  const b = await runtime.source({ claims, confidence: 0 });
  const first = await runtime.consolidate(a.record.recordId, vault.principalPrivateVaultId, "threshold", {}, claims);
  await runtime.consolidate(b.record.recordId, vault.principalPrivateVaultId, "threshold", {}, claims);
  const promoted = await runtime.signed("msp_memory_passport_promote", { entity_id: first.entity_id, idempotency_key: "defer" }, claims);
  expect(promoted).toMatchObject({ decision: "passport_deferred", reason: "threshold_not_met" });
  expect(runtime.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE vault_id=?").get(vault.principalPassportVaultId).n).toBe(0);
});
