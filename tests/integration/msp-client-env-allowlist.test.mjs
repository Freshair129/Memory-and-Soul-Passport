// @req SEC — the publishable client must not hand an MSP child the whole
// environment of whatever host started it. zuri-ai's server and edge apps hold
// production database URLs, chat-platform credentials and model API keys; MSP
// reads none of them. Before this, createMspStdioCaller defaulted to
// `env = process.env` and passed it to spawn() unfiltered, and nothing tested
// what the child received.
// @spec docs/ARCHITECTURE.md "Security invariants"
// @tested this file
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildMspChildEnv, createMspStdioCaller, MSP_OS_ENV_NAMES, MSP_RUNTIME_ENV_NAMES } from "../../packages/msp-client-js/src/msp-stdio-transport.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "env-report-stdio-server.mjs");

// What the MSP server and the GKS child below it actually read.
const mspConfig = {
  MSP_DB_PATH: "/allowlist-test/msp.sqlite",
  MSP_GKS_COMMAND: "node",
  MSP_PIPELINE_PRINCIPALS: "[]",
  MSP_GKS_PIPELINE_CREDENTIAL: "relay-credential",
  MSP_PIPELINE_WORKER_TOKEN: "worker-token",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  GKS_DB_PATH: "/allowlist-test/gks.sqlite",
  GKS_FIXTURE_STATE_PATH: "/allowlist-test/fixture.json",
};

// What the host holds and MSP has no use for. AWS_SECRET_ACCESS_KEY is the
// point of an allowlist: no denylist ever named it.
const hostSecrets = {
  DATABASE_URL: "postgres://decoy-user:decoy-pass@decoy-host:5432/decoy_production",
  LINE_CHANNEL_SECRET: "decoy-line-channel-secret",
  ANTHROPIC_API_KEY: "sk-decoy-anthropic-key",
  AWS_SECRET_ACCESS_KEY: "decoy-aws-secret",
  NODE_OPTIONS: "--require ./decoy.js",
  GOVIBE_MSP_COMMAND: "node",
};

const REPORT_KEYS = [...Object.keys(mspConfig), ...Object.keys(hostSecrets)];

async function reportChildEnv(callerOptions) {
  const call = createMspStdioCaller({ command: process.execPath, args: [serverPath], ...callerOptions });
  try {
    const result = await call("msp_env_report", { report_keys: REPORT_KEYS });
    return result.received_env;
  } finally {
    await call.close();
  }
}

describe("MSP client child-process environment allowlist", () => {
  it("publishes the builder and both name lists from the package entry, not only the deep path", async () => {
    // The rest of this file imports by relative path; every other suite imports the
    // package. Without this, a typo in the index re-export leaves all of them green.
    const entry = await import("@freshair129/msp-client-js");
    expect(entry.buildMspChildEnv).toBe(buildMspChildEnv);
    expect(entry.MSP_RUNTIME_ENV_NAMES).toBe(MSP_RUNTIME_ENV_NAMES);
    expect(entry.MSP_OS_ENV_NAMES).toBe(MSP_OS_ENV_NAMES);
  });

  it("a spawned MSP child receives the allowlist and none of the host's secrets", async () => {
    const receivedEnv = await reportChildEnv({ env: { ...mspConfig, ...hostSecrets, PATH: process.env.PATH ?? "/usr/bin" } });
    for (const [name, value] of Object.entries(mspConfig)) expect(receivedEnv[name], `${name} must reach the MSP child`).toBe(value);
    for (const name of Object.keys(hostSecrets)) expect(receivedEnv[name], `${name} must NOT reach the MSP child`).toBeNull();
  });

  it("the default env (process.env) is filtered too — the case a caller gets by writing nothing", async () => {
    const restore = {};
    for (const [name, value] of Object.entries({ ...mspConfig, ...hostSecrets })) {
      restore[name] = process.env[name];
      process.env[name] = value;
    }
    try {
      const receivedEnv = await reportChildEnv({});
      for (const name of Object.keys(hostSecrets)) expect(receivedEnv[name], `${name} must NOT reach the MSP child`).toBeNull();
      expect(receivedEnv.MSP_DB_PATH).toBe(mspConfig.MSP_DB_PATH);
      expect(receivedEnv.GKS_DB_PATH).toBe(mspConfig.GKS_DB_PATH);
    } finally {
      for (const [name, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("forwards GKS's whole namespace, which MSP does not read but must pass on to its own GKS child", () => {
    const childEnv = buildMspChildEnv({ GKS_DB_PATH: "/gks.sqlite", gks_automerge_floor: "0.9", GKS_FIXTURE_STATE_PATH: "/fixture.json", GKSDB: "decoy", MY_GKS_TOKEN: "decoy" });
    expect(childEnv).toEqual({ GKS_DB_PATH: "/gks.sqlite", gks_automerge_floor: "0.9", GKS_FIXTURE_STATE_PATH: "/fixture.json" });
  });

  it("matches names without case and copies them as the caller spelled them", () => {
    const childEnv = buildMspChildEnv({ Path: "/usr/bin", SystemRoot: "C:/Windows", windir: "C:/Windows", msp_db_path: "/msp.sqlite", database_url: "postgres://decoy", PATH_SECRET: "decoy" });
    expect(childEnv).toEqual({ Path: "/usr/bin", SystemRoot: "C:/Windows", windir: "C:/Windows", msp_db_path: "/msp.sqlite" });
  });

  it("forwards every name MSP itself reads, and no name outside the two published lists", () => {
    const everyName = {};
    for (const name of [...MSP_RUNTIME_ENV_NAMES, ...MSP_OS_ENV_NAMES]) everyName[name] = `value-of-${name}`;
    expect(buildMspChildEnv({ ...everyName, ...hostSecrets })).toEqual(everyName);
    // Non-string values (a caller spreading a config object) are dropped, not stringified.
    expect(buildMspChildEnv({ MSP_DB_PATH: 5, HOME: undefined })).toEqual({});
  });
});
