import { createHash, createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { canReadContext } from "@freshair129/msp-contracts/context-scope-guard";

it("scoped context expiry uses the supplied verification instant, including the exact expiry boundary", () => {
  const key = "synthetic-context-clock-key-32-bytes";
  const name = "msp_context_audit";
  const input = { actor: "synthetic", context_id: "synthetic-context" };
  const row = { tenant_id: "tenant", principal_id: "principal" };
  const instant = 1_000_000;
  for (const [expiresAt, allowed] of [[instant - 1, false], [instant, false], [instant + 1, true], [instant + 65_000, true], [instant + 65_001, false]]) {
    const grant = {
      operation: name, tenantId: "tenant", principalId: "principal", expiresAt,
      payloadHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    };
    const signature = createHmac("sha256", key).update(JSON.stringify(grant)).digest("hex");
    expect(canReadContext(row, name, { ...input, access: { grant, signature } }, key, instant)).toBe(allowed);
  }
});
