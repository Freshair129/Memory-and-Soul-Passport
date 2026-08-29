import { createMspStdioCaller } from "@freshair129/msp-client-js";

const serverBin = process.env.MSP_SERVER_BIN;
const dbPath = process.env.MSP_DB_PATH;
if (!serverBin || !dbPath) throw new Error("MSP_SERVER_BIN and MSP_DB_PATH are required.");

const call = createMspStdioCaller({
  command: process.execPath,
  args: [serverBin],
  env: {
    ...process.env,
    MSP_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://127.0.0.1:1",
  },
  timeoutMs: 15_000,
});

try {
  const ping = await call("msp_ping", {});
  await call("msp_workspace_register", {
    actor: "external-client-smoke",
    workspace_id: "external-workspace",
    project_id: "external-project",
    workspace_path: "/external/workspace",
    idempotency_key: "external-register",
    run_id: "external-run",
    source_hash: "b".repeat(64),
    schema_version: "govibe-workspace-register/v1",
  });
  const status = await call("msp_vault_status", {
    actor: "external-client-smoke",
    workspace_id: "external-workspace",
    workspace_path: "/external/workspace",
    agent_id: null,
  });
  const vault = status.vaults.find((item) => item.vault_type === "workspace_private");
  const upsert = await call("msp_memory_upsert", {
    vault: { vault_id: vault.vault_id, vault_type: vault.vault_type },
    category: "external-smoke",
    key: "standalone-client",
    body_json: { source: "packed-client" },
    epistemic_state: "confirmed",
    confidence: 1,
    valid_from: "2026-08-12T00:00:00Z",
    valid_to: null,
  });
  const search = await call("msp_memory_search", {
    vault_id: vault.vault_id,
    query: "standalone-client",
    mode: "fts",
    limit: 10,
  });
  const history = await call("msp_memory_history", { entity_id: upsert.entity.entity_id });

  process.stdout.write(`${JSON.stringify({
    package: "@freshair129/msp-client-js",
    ping: ping.ok,
    vault_type: vault.vault_type,
    created: upsert.created,
    search_hits: search.hits.length,
    history_versions: history.history.length,
  })}\n`);
} finally {
  call.close();
}
