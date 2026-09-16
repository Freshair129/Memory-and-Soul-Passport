import { ConsolidationStore } from "@freshair129/msp-core/consolidation";
import { MemoryNotFoundError } from "@freshair129/msp-contracts/errors";
import { requireGrantNonce, verifyVaultGrant } from "@freshair129/msp-contracts/vault-grant-guard";
import { validateConsolidationContract } from "@freshair129/msp-contracts/consolidation-schema";

// Explicit allowlist: a new tool cannot silently inherit read/write authority.
const TOOLS = { msp_memory_consolidate: "consolidate", msp_memory_passport_promote: "promote", msp_memory_context_digest: "digest" };

export function createConsolidationHandlers({ db, entityStore, vaultRegistry, keyFor, now = Date.now }) {
  const store = new ConsolidationStore({ db, entityStore, vaultRegistry });
  return Object.fromEntries(Object.entries(TOOLS).map(([name, method]) => [name, async (args = {}) => {
    const { access, ...input } = args;
    let grant;
    try {
      const passportOnly = method === "digest" && access?.grant?.agentId === undefined && access?.grant?.workspaceId === undefined;
      grant = verifyVaultGrant(name, input, access, keyFor, { vaultType: passportOnly ? "principal_passport" : "principal_private", now: now() });
      if ((method === "promote" || input.include_passport === true) && grant.allowPassport !== true) throw new Error();
      if (method !== "digest") requireGrantNonce(grant);
      if (passportOnly && input.include_passport !== true) throw new Error();
    } catch { throw new MemoryNotFoundError("not_found: memory target is unavailable."); }
    validateConsolidationContract(name, args);
    const result = store[method](input, grant, method === "digest" ? keyFor(grant.tenantId) : undefined);
    validateConsolidationContract(name, result, "output");
    return result;
  }]));
}
