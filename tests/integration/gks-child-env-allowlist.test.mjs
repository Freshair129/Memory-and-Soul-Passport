// @req SEC — a GKS child process must never receive MSP's whole inherited
// environment. zuri-ai's web server passes its ENTIRE environment to MSP
// today (production database URLs, LINE credentials, model keys); MSP must
// build every GKS child's environment from an explicit allowlist instead of
// forwarding a copy of its own process.env, independently of any fix on
// zuri-ai's side.
// @spec docs/ARCHITECTURE.md "Security invariants"
// @tested this file
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createGksProviderFromEnvironment } from "../../apps/msp-server/src/providers/gks-stdio-provider.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const providerPath = path.join(here, "fixtures", "env-report-gks-provider.mjs");

// The OS basics a Node child needs to start at all, taken from the real
// process environment this test itself runs under (so the assertions hold
// on both Windows and POSIX CI runners).
const OS_BASIC_KEYS = ["PATH", "Path", "path", "PATHEXT", "SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
const osBasics = {};
for (const key of OS_BASIC_KEYS) if (process.env[key] !== undefined) osBasics[key] = process.env[key];

// Decoy application secrets that must never reach a GKS child — exactly the
// shape zuri-ai's web server hands MSP today.
const decoySecrets = {
  DATABASE_URL: "postgres://decoy-user:decoy-pass@decoy-host:5432/decoy_production",
  LINE_CHANNEL_SECRET: "decoy-line-channel-secret",
  ANTHROPIC_API_KEY: "sk-decoy-anthropic-key-0000000000000000",
};

// MSP's own secrets, which must also never reach a GKS child (the pre-fix
// `pipelineEnv` blocklist already stripped these from the pipeline path;
// this proves the allowlist strips them from every path, and that
// MSP_GKS_COMMAND/ARGS/CWD — needed only to launch the child, never inside
// it — are excluded too).
const mspOwnSecrets = {
  MSP_DB_PATH: "C:\\decoy\\msp.sqlite",
  MSP_PIPELINE_PRINCIPALS: JSON.stringify([{ credential: "decoy-principal-credential", principalId: "decoy", role: "source", scope: { portfolioId: "p", tenantId: "t", businessId: "b", workspaceId: "", agentId: "", visibility: "private" } }]),
  MSP_GKS_PIPELINE_CREDENTIAL: "decoy-msp-relay-credential",
  MSP_PIPELINE_WORKER_TOKEN: "decoy-worker-token",
  GENESIS_WORKER_QUERY_TOKEN: "decoy-worker-query-token",
};

// GKS's own configuration namespace — these must survive, because a GKS
// child cannot start (GKS_DB_PATH) or authenticate the pipeline relay
// (GKS_PIPELINE_RELAY_CREDENTIAL) without them.
const gksConfig = {
  GKS_DB_PATH: "C:\\allowlist-test\\gks.sqlite",
  GKS_DEFAULT_PORTFOLIO_ID: "portfolio-allowlist-test",
  GKS_AUTOMERGE_FLOOR: "0.91",
  GKS_PIPELINE_RELAY_CREDENTIAL: "allowlist-test-relay-credential",
};

const REPORT_KEYS = [...Object.keys(decoySecrets), ...Object.keys(mspOwnSecrets), ...Object.keys(gksConfig), "MSP_GKS_COMMAND", "MSP_GKS_ARGS", "MSP_GKS_CWD", ...OS_BASIC_KEYS];

function buildFakeMspEnvironment() {
  return {
    ...osBasics,
    ...decoySecrets,
    ...mspOwnSecrets,
    ...gksConfig,
    MSP_GKS_COMMAND: process.execPath,
    MSP_GKS_ARGS: JSON.stringify([providerPath]),
  };
}

function assertAllowlistedEnv(receivedEnv) {
  // OS basics: present, unchanged.
  for (const [key, value] of Object.entries(osBasics)) expect(receivedEnv[key], `OS basic ${key} must reach the GKS child`).toBe(value);
  // GKS's own configuration namespace: present, unchanged.
  for (const [key, value] of Object.entries(gksConfig)) expect(receivedEnv[key], `GKS config ${key} must reach the GKS child`).toBe(value);
  // Decoy application secrets: absent.
  for (const key of Object.keys(decoySecrets)) expect(receivedEnv[key], `decoy secret ${key} must NOT reach the GKS child`).toBeNull();
  // MSP's own secrets, including the spawn parameters themselves: absent.
  for (const key of [...Object.keys(mspOwnSecrets), "MSP_GKS_COMMAND", "MSP_GKS_ARGS", "MSP_GKS_CWD"]) {
    expect(receivedEnv[key], `MSP-internal value ${key} must NOT reach the GKS child`).toBeNull();
  }
}

describe("GKS child process environment allowlist", () => {
  it("promote(): forwards OS basics and GKS_* config, withholds every MSP/decoy secret", async () => {
    const provider = createGksProviderFromEnvironment(buildFakeMspEnvironment());
    const result = await provider.promote({ report_keys: REPORT_KEYS });
    assertAllowlistedEnv(result.received_env);
  });

  it("exportStageEvidence(): same allowlist as promote()", async () => {
    const provider = createGksProviderFromEnvironment(buildFakeMspEnvironment());
    const result = await provider.exportStageEvidence({ report_keys: REPORT_KEYS });
    assertAllowlistedEnv(result.received_env);
  });

  it("pipelineCall(): same allowlist as the other two spawns (the pre-fix pipelineEnv blocklist covered only this path)", async () => {
    const provider = createGksProviderFromEnvironment(buildFakeMspEnvironment());
    const result = await provider.pipelineCall("submit", { report_keys: REPORT_KEYS });
    assertAllowlistedEnv(result.received_env);
  });

  it("no GKS child is spawned at all when MSP_GKS_COMMAND is unset (fail-closed, unaffected by the allowlist change)", () => {
    const env = buildFakeMspEnvironment();
    delete env.MSP_GKS_COMMAND;
    expect(createGksProviderFromEnvironment(env)).toBeNull();
  });
});
