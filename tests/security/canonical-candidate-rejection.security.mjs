// AC-06 (adversarial/boundary test, per AC-08's guidance -- see
// test/shared-scope-fail-closed.security.mjs's header comment for the
// node:test / `node --test` convention this file also follows): a candidate
// object containing a canonical_id/gks_id/target_ref key, or any
// gks:-prefixed string value, passed to msp_memory_promote is rejected
// SERVER-SIDE by src/contracts/namespace-guard.mjs's rejectCanonicalCandidate
// -- defense in depth, independent of the GoVibe-side rejectCanonicalCandidate
// guard scripts/mcp/msp-vault-context-contracts.mjs's promoteMemory already
// runs before this request is ever sent.
//
// This deliberately bypasses createTypedVaultContextMsp's own client-side
// guard (it does not call promoteMemory at all) and instead speaks the raw
// stdio JSON-RPC wire protocol directly against the real, running process --
// simulating exactly the "hypothetical caller that skipped the client-side
// guard" WP-13 AC-06 requires this packet to defend against on its own.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-runtime-canonical-test-"));
  const dbPath = path.join(dir, "msp.sqlite3");
  return {
    dbPath,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup (Windows file-lock race on child process exit)
      }
    },
  };
}

/** Raw NDJSON JSON-RPC 2.0 exchange against the real process -- no client-side guard in the path. */
async function rawToolCall(dbPath, name, args) {
  const child = spawn(process.execPath, [binPath], { env: { ...process.env, MSP_DB_PATH: dbPath }, stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wp13-canonical-test", version: "0.1.0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const response = await send("tools/call", { name, arguments: args });
    return response.result;
  } finally {
    rl.close();
    child.kill();
  }
}

function basePromotionArgs(overrides = {}) {
  return {
    schema_version: "govibe-memory-promotion/v1",
    actor: "boss",
    agent_id: "agent-canonical",
    workspace_id: "workspace-canonical",
    source_memory_ref: "msp:memory/canonical-source",
    target_scope: "global_private",
    evidence_refs: ["msp:proof/canonical-1"],
    reason: "canonical candidate rejection test",
    idempotency_key: `idem-canonical-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

const CANONICAL_KEY_CASES = ["canonical_id", "canonicalId", "gks_id", "gksId", "target_ref", "targetRef", "TARGET_REF"];

for (const key of CANONICAL_KEY_CASES) {
  test(`AC-06: msp_memory_promote rejects a candidate with a "${key}" key server-side, even bypassing the client-side guard`, async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const raw = await rawToolCall(
        dbPath,
        "msp_memory_promote",
        basePromotionArgs({ candidate: { note: "looks fine", [key]: "some-value" } }),
      );
      assert.equal(raw.isError, true);
      assert.match(raw.structuredContent.message, /canonical gks identity|provider_canonical_identity_forbidden/i);
    } finally {
      cleanup();
    }
  });
}

test('AC-06: msp_memory_promote rejects a candidate with a "gks:"-prefixed string value, server-side', async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = await rawToolCall(
      dbPath,
      "msp_memory_promote",
      basePromotionArgs({ candidate: { note: "gks:shared/forged-identity" } }),
    );
    assert.equal(raw.isError, true);
    assert.match(raw.structuredContent.message, /canonical gks identity|provider_canonical_identity_forbidden/i);
  } finally {
    cleanup();
  }
});

test('AC-06: msp_memory_promote rejects a "GKS:"-prefixed value case-insensitively', async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = await rawToolCall(
      dbPath,
      "msp_memory_promote",
      basePromotionArgs({ candidate: { note: "GKS:Shared/Forged" } }),
    );
    assert.equal(raw.isError, true);
    assert.match(raw.structuredContent.message, /canonical gks identity|provider_canonical_identity_forbidden/i);
  } finally {
    cleanup();
  }
});

test("AC-06: msp_memory_promote rejects a gks:-prefixed evidence_refs entry server-side", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = await rawToolCall(
      dbPath,
      "msp_memory_promote",
      basePromotionArgs({ candidate: { note: "well-formed" }, evidence_refs: ["gks:shared/forged-evidence"] }),
    );
    assert.equal(raw.isError, true);
    assert.match(raw.structuredContent.message, /gks:-namespaced/i);
  } finally {
    cleanup();
  }
});

test("AC-06: msp_memory_promote rejects a gks:-prefixed source_memory_ref server-side", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = await rawToolCall(
      dbPath,
      "msp_memory_promote",
      basePromotionArgs({ candidate: { note: "well-formed" }, source_memory_ref: "gks:shared/forged-source" }),
    );
    assert.equal(raw.isError, true);
    assert.match(raw.structuredContent.message, /gks:-namespaced/i);
  } finally {
    cleanup();
  }
});

test("AC-06: a well-formed candidate with no canonical key/value is accepted (control case, proves the guard is not over-broad)", async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = await rawToolCall(
      dbPath,
      "msp_memory_promote",
      basePromotionArgs({ candidate: { note: "perfectly ordinary candidate", targetLooksLikeButIsNot: "ref-1" } }),
    );
    assert.equal(raw.isError, undefined);
    assert.match(raw.structuredContent.promotion_ref, /^msp:memory-promotion\//);
  } finally {
    cleanup();
  }
});
