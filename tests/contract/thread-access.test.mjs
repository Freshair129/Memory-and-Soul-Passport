// PH-MEMOS-3 stage 2 (BL-MEMOS-040): pure unit coverage of
// packages/msp-contracts/src/contracts/thread-access.mjs's grant
// construction and verification -- no server, no DB. The real-process,
// real-guard proof (agentId/workspaceId required end to end, on every one
// of the ten API-011 tools) lives in
// tests/security/thread-agent-scoping.security.mjs instead.
import { describe, expect, it } from "vitest";

import { signThreadRequest, verifyThreadGrant } from "../../packages/msp-contracts/src/contracts/thread-access.mjs";

const KEY = "thread-access-unit-test-key-0123456789ab";

function baseClaims(overrides = {}) {
  return { tenantId: "tenant-a", principalId: "alice", policyRevision: "v1", agentId: "agent-a", workspaceId: "workspace-a", ...overrides };
}

describe("signThreadRequest: nonce auto-generation (DEC-MEMOS-20)", () => {
  it("auto-generates a nonce when the caller's claims carry none", () => {
    const { access } = signThreadRequest("msp_thread_resolve", { a: 1 }, baseClaims(), KEY);
    expect(typeof access.grant.nonce).toBe("string");
    expect(access.grant.nonce.length).toBeGreaterThanOrEqual(32); // 16 random bytes, hex-encoded = 128 bits
    expect(access.grant.nonce.length).toBeLessThanOrEqual(128);
  });

  it("generates a DIFFERENT nonce on every call, even with byte-identical claims", () => {
    const first = signThreadRequest("msp_thread_resolve", { a: 1 }, baseClaims(), KEY);
    const second = signThreadRequest("msp_thread_resolve", { a: 1 }, baseClaims(), KEY);
    expect(first.access.grant.nonce).not.toBe(second.access.grant.nonce);
  });

  it("honors an explicit nonce from the caller's claims (replay testing)", () => {
    const { access } = signThreadRequest("msp_thread_resolve", { a: 1 }, baseClaims({ nonce: "fixed-value-for-replay-test" }), KEY);
    expect(access.grant.nonce).toBe("fixed-value-for-replay-test");
  });

  it("honors an explicit undefined nonce from the caller's claims (testing absence)", () => {
    const { access } = signThreadRequest("msp_thread_resolve", { a: 1 }, baseClaims({ nonce: undefined }), KEY);
    expect(access.grant.nonce).toBeUndefined();
  });
});

describe("verifyThreadGrant: agentId/workspaceId required claims (DEC-MEMOS-21)", () => {
  function sign(claims) {
    return signThreadRequest("msp_thread_resolve", { a: 1 }, claims, KEY);
  }

  it("verifies successfully when agentId/workspaceId are present and within bounds", () => {
    const { access } = sign(baseClaims());
    const grant = verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY);
    expect(grant.agentId).toBe("agent-a");
    expect(grant.workspaceId).toBe("workspace-a");
  });

  it("refuses a grant missing agentId", () => {
    const { access } = sign(baseClaims({ agentId: undefined }));
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).toThrow(/grant_signature_invalid/);
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).toThrow(/agentId/);
  });

  it("refuses a grant missing workspaceId", () => {
    const { access } = sign(baseClaims({ workspaceId: undefined }));
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).toThrow(/grant_signature_invalid/);
  });

  it("refuses an agentId longer than 128 characters", () => {
    const { access } = sign(baseClaims({ agentId: "a".repeat(129) }));
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).toThrow(/grant_signature_invalid/);
  });

  it("refuses a workspaceId longer than 128 characters", () => {
    const { access } = sign(baseClaims({ workspaceId: "w".repeat(129) }));
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).toThrow(/grant_signature_invalid/);
  });

  it("accepts an agentId/workspaceId at exactly the 128-character bound", () => {
    const { access } = sign(baseClaims({ agentId: "a".repeat(128), workspaceId: "w".repeat(128) }));
    const grant = verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY);
    expect(grant.agentId).toHaveLength(128);
    expect(grant.workspaceId).toHaveLength(128);
  });

  it("does not constrain agentId/workspaceId's charset beyond the length bound (DEC-MEMOS-21: opaque, Tier-1-owned strings)", () => {
    const { access } = sign(baseClaims({ agentId: "agent with spaces / slashes / émoji 😀", workspaceId: "ws\nwith\tcontrol chars" }));
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).not.toThrow();
  });

  it("refuses a non-string agentId even if truthy", () => {
    const { access } = sign(baseClaims({ agentId: 12345 }));
    expect(() => verifyThreadGrant("msp_thread_resolve", { a: 1 }, access, KEY)).toThrow(/grant_signature_invalid/);
  });
});
