#!/usr/bin/env node
// BL-MEMOS-083 acceptance harness (PH-MEMOS-7).
//
// This is an executable evidence runner, not a replacement for the named
// phase suites. It drives a real msp-server process over stdio and keeps
// dependency gaps visible as NOT_RUN. A required NOT_RUN or FAIL exits 2;
// callers must not turn this report into a green release gate by ignoring the
// exit code.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open as openDatabase } from "@freshair129/msp-storage/connection";
import { signThreadRequest } from "../../packages/msp-contracts/src/contracts/thread-access.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const binPath = path.join(repoRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const serviceKey = "phase7-acceptance-thread-service-key-0123456789";
const identityKey = "phase7-acceptance-identity-hmac-key-0123456789";
const tenants = ["tenant-a", "tenant-b"];
const principals = ["principal-1", "principal-2", "principal-3"];
const agents = ["agent-1", "agent-2"];
const audiences = ["DIRECT", "GROUP"];
const policyRevision = "phase7-acceptance-v1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeClaims({ tenantId, principalId, agentId, workspaceId, room, audienceKind, ...extra }) {
  return {
    tenantId,
    principalId,
    policyRevision,
    channelAccountId: `phase7-${tenantId}`,
    externalRoomRef: room,
    audienceKind,
    agentId,
    workspaceId,
    ...extra,
  };
}

function signed(name, input, claims) {
  return signThreadRequest(name, input, claims, serviceKey);
}

function status(id, result, evidence, detail = null) {
  return { id, result, evidence, detail };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function expectDenied(call, name, input, claims, pattern, label) {
  try {
    await call(name, signed(name, input, claims));
  } catch (error) {
    const message = errorText(error);
    assert(pattern.test(message), `${label}: expected ${pattern}, got ${message}`);
    return;
  }
  throw new Error(`${label}: request unexpectedly succeeded`);
}

function legacyVaultRequest(tenantId, principalId, agentId, workspaceId) {
  return {
    actor: "phase7-legacy-acceptance",
    access_context: {
      tenant_id: tenantId,
      principal_id: principalId,
      agent_id: agentId,
      workspace_id: workspaceId,
      project_id: `project-${tenantId}`,
      policy_version: policyRevision,
    },
    authorization: {
      allowed: true,
      allow_global_private: true,
      allow_shared: true,
      read: true,
      write_private: true,
      write_shared: false,
    },
  };
}

function spawnRuntime(dbPath, env = {}, { allowTestClock = false } = {}) {
  const childEnv = { ...process.env, MSP_DB_PATH: dbPath, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  // The client transport deliberately excludes MSP_TEST_CLOCK from its
  // production child-environment allowlist. For this acceptance-only child,
  // bootstrap the opt-in at module load so the real stdio process can use
  // deterministic timestamps without widening that production allowlist.
  const args = allowTestClock
    ? [
        "--input-type=module",
        "-e",
        "import { pathToFileURL } from \"node:url\"; process.env.MSP_TEST_CLOCK = \"1\"; await import(pathToFileURL(process.argv[1]).href);",
        binPath,
      ]
    : [binPath];
  return createMspStdioCaller({
    command: process.execPath,
    args,
    env: childEnv,
    timeoutMs: 30_000,
  });
}

async function runLegacyVaultCase() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "msp-phase7-legacy-"));
  const dbPath = path.join(tempDir, "msp.sqlite3");
  const call = spawnRuntime(dbPath, {
    // The latest phase-5 contract deliberately proves this unsigned legacy
    // path without either identity or thread-service keys.
    MSP_IDENTITY_HMAC_KEY: undefined,
    MSP_THREAD_SERVICE_KEY: undefined,
    MSP_THREAD_SERVICE_KEYRING: undefined,
  });
  try {
    const result = await call("msp_vault_resolve", legacyVaultRequest("tenant-legacy", "principal-legacy", "agent-legacy", "workspace-legacy"));
    assert(typeof result.workspacePrivateVaultId === "string" && result.workspacePrivateVaultId.length > 0, "legacy vault resolve must return workspacePrivateVaultId");
    assert(Array.isArray(result.globalPrivateVaultIds), "legacy vault resolve must return globalPrivateVaultIds");
    assert(Array.isArray(result.sharedVaultIds), "legacy vault resolve must return sharedVaultIds");
    assert(result.principalPrivateVaultId === null, "unsigned legacy vault resolve must not resolve a principal private vault");
    assert(result.principalPassportVaultId === null, "unsigned legacy vault resolve must not resolve a principal passport vault");
    assert(result.permissions && typeof result.permissions === "object", "legacy vault resolve must return permissions");
    await call.close();

    const db = openDatabase(dbPath);
    try {
      const principalRows = db.prepare("SELECT COUNT(*) AS count FROM vaults WHERE vault_type IN ('principal_private', 'principal_passport')").get().count;
      assert(Number(principalRows) === 0, "unsigned legacy vault resolve must not provision principal vault rows");
    } finally {
      db.close();
    }
    return status("BL083.vault-resolve.legacy", "PASS", "real stdio msp_vault_resolve + direct vault row count", {
      principalPrivateVaultId: null,
      principalPassportVaultId: null,
    });
  } catch (error) {
    await call.close().catch(() => {});
    return status(
      "BL083.vault-resolve.legacy",
      "FAIL",
      "real stdio msp_vault_resolve",
      `${errorText(error)}; baseline does not yet contain the latest phase-5 unsigned legacy behavior`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function legacyShapeEvidence() {
  const schemaPath = path.join(repoRoot, "packages", "msp-contracts", "schemas", "API-010.tools.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert(schema.tools.some((tool) => tool.name === "msp_vault_resolve"), "API-010 must declare msp_vault_resolve");
  return status("BL083.vault-resolve.shape", "PASS", "API-010.tools.json declares msp_vault_resolve");
}

async function runThreadMatrix() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "msp-phase7-thread-"));
  const dbPath = path.join(tempDir, "msp.sqlite3");
  const call = spawnRuntime(dbPath, {
    MSP_DB_PATH: dbPath,
    MSP_THREAD_SERVICE_KEY: serviceKey,
    MSP_IDENTITY_HMAC_KEY: identityKey,
    MSP_THREAD_IDLE_TIMEOUT_MINUTES: "1",
    MSP_TEST_CLOCK: "1",
  }, { allowTestClock: true });
  const legs = [];
  const threadByKey = new Map();
  const threadMeta = new Map();
  const vaultLegs = new Map();
  try {
    for (const tenantId of tenants) {
      for (const audienceKind of audiences) {
        for (const principalId of principals) {
          const room = audienceKind === "DIRECT" ? `direct-${tenantId}-${principalId}` : `group-${tenantId}`;
          const threadKey = `${tenantId}:${audienceKind}:${room}`;
          for (const agentId of agents) {
            const legId = `${tenantId}/${principalId}/${agentId}/${audienceKind}`;
            const workspaceId = `workspace-${tenantId}`;
            const claims = makeClaims({ tenantId, principalId, agentId, workspaceId, room, audienceKind, readPrivate: true, writePrivate: true, confirmMemory: true, assertAgents: true });
            const legEvidence = [];
            try {
              const vaultKey = `${tenantId}:${principalId}:${agentId}`;
              if (!vaultLegs.has(vaultKey)) {
                const vaultResult = await call("msp_vault_resolve", legacyVaultRequest(tenantId, principalId, agentId, workspaceId));
                assert(typeof vaultResult.workspacePrivateVaultId === "string", `${legId}: vault resolve workspace id missing`);
                vaultLegs.set(vaultKey, vaultResult);
                legEvidence.push("vault_resolve_wire");
              }

              const resolveInput = {
                thread_kind: audienceKind,
                audience_kind: audienceKind,
                channel_type: "TEST",
                channel_account_id: `phase7-${tenantId}`,
                external_room_ref: room,
                tenant_id: tenantId,
              };
              const resolved = await call("msp_thread_resolve", signed("msp_thread_resolve", resolveInput, claims));
              assert(resolved.thread?.threadId, `${legId}: resolve did not return threadId`);
              assert(resolved.thread.audienceKind === audienceKind, `${legId}: resolved audience mismatch`);
              threadByKey.set(threadKey, resolved.thread.threadId);
              threadMeta.set(resolved.thread.threadId, { tenantId, principalId, agentId, room, audienceKind, workspaceId });
              legEvidence.push("resolve");

              const exchangeId = `exchange-${legId}`;
              // Use the approved test clock to make the idle-session boundary
              // deterministic without sleeping through the acceptance run.
              const appendNow = new Date(Date.now() - 5 * 60_000).toISOString();
              const inbound = await call(
                "msp_thread_message_append",
                signed(
                  "msp_thread_message_append",
                  {
                    thread_id: resolved.thread.threadId,
                    exchange_id: exchangeId,
                    source_event_id: `${legId}-inbound`,
                    speaker_id: principalId,
                    speaker_kind: "HUMAN",
                    identity_assurance: "VERIFIED",
                    direction: "INBOUND",
                    now: appendNow,
                    text: `phase7 inbound ${legId}`,
                  },
                  claims,
                ),
              );
              assert(inbound.message?.messageId, `${legId}: inbound append did not return messageId`);
              legEvidence.push("append.inbound");

              const outbound = await call(
                "msp_thread_message_append",
                signed(
                  "msp_thread_message_append",
                  {
                    thread_id: resolved.thread.threadId,
                    exchange_id: exchangeId,
                    reply_to_message_id: inbound.message.messageId,
                    source_event_id: `${legId}-outbound`,
                    speaker_id: agentId,
                    speaker_kind: "AGENT",
                    identity_assurance: "VERIFIED",
                    direction: "OUTBOUND",
                    delivery_state: "DELIVERED",
                    now: appendNow,
                    text: `phase7 outbound ${legId}`,
                  },
                  claims,
                ),
              );
              assert(outbound.message?.messageId, `${legId}: outbound append did not return messageId`);
              legEvidence.push("append.outbound");

              const contextInput = { thread_id: resolved.thread.threadId };
              if (audienceKind === "DIRECT") {
                const context = await call("msp_thread_context", signed("msp_thread_context", contextInput, claims));
                assert(context.thread?.threadId === resolved.thread.threadId, `${legId}: context thread mismatch`);
                assert(Array.isArray(context.recentExchanges), `${legId}: context recentExchanges missing`);
                legEvidence.push("context.pass");

                const record = await call(
                  "msp_thread_memory_record",
                  signed(
                    "msp_thread_memory_record",
                    {
                      thread_id: resolved.thread.threadId,
                      kind: "PREFERENCE",
                      asserted_by_speaker_id: principalId,
                      subject_person_id: principalId,
                      body: { text: `phase7 record ${legId}` },
                      source_message_refs: [inbound.message.messageId],
                      verification_state: "CONFIRMED",
                    },
                    claims,
                  ),
                );
                assert(record.recordId, `${legId}: memory record did not return recordId`);
                legEvidence.push("record.pass");
              } else {
                await expectDenied(call, "msp_thread_context", contextInput, claims, /thread_scope_denied/, `${legId}: GROUP context`);
                legEvidence.push("context.denied-as-required");
                await expectDenied(
                  call,
                  "msp_thread_memory_record",
                  {
                    thread_id: resolved.thread.threadId,
                    kind: "PREFERENCE",
                    asserted_by_speaker_id: principalId,
                    subject_person_id: principalId,
                    body: { text: `phase7 group record ${legId}` },
                    source_message_refs: [inbound.message.messageId],
                    verification_state: "CONFIRMED",
                  },
                  claims,
                  /thread_scope_denied/,
                  `${legId}: GROUP record`,
                );
                legEvidence.push("record.denied-as-required");
              }
              legs.push(status(`BL083.matrix.${legId}`, "PASS", legEvidence));
            } catch (error) {
              legs.push(status(`BL083.matrix.${legId}`, "FAIL", legEvidence, errorText(error)));
            }
          }
        }
      }
    }

    // Directed negatives keep the matrix from proving only the happy-path
    // tuples. Each request reuses a real DIRECT thread id while changing one
    // grant boundary, so the guard must reject tenant, principal, agent and
    // workspace crossings before a handler can read or mutate anything.
    const directed = [];
    const targetThreadKey = "tenant-a:DIRECT:direct-tenant-a-principal-1";
    const targetThreadId = threadByKey.get(targetThreadKey);
    const targetMeta = targetThreadId ? threadMeta.get(targetThreadId) : null;
    assert(targetThreadId && targetMeta, "directed denial target thread was not created by the matrix");
    const directedCases = [
      {
        id: "BL083.negative.cross-tenant",
        claims: makeClaims({ ...targetMeta, tenantId: "tenant-b", workspaceId: "workspace-tenant-b" }),
        pattern: /thread_scope_denied/,
        label: "cross-tenant context",
      },
      {
        id: "BL083.negative.cross-principal",
        claims: makeClaims({ ...targetMeta, principalId: "principal-2" }),
        pattern: /thread_scope_denied/,
        label: "cross-principal context",
      },
      {
        id: "BL083.negative.cross-agent",
        claims: makeClaims({ ...targetMeta, agentId: "agent-rogue" }),
        pattern: /agent_not_current/,
        label: "cross-agent context",
      },
      {
        id: "BL083.negative.cross-workspace",
        claims: makeClaims({ ...targetMeta, workspaceId: "workspace-rogue" }),
        pattern: /agent_not_current/,
        label: "cross-workspace context",
      },
    ];
    for (const negative of directedCases) {
      try {
        await expectDenied(
          call,
          "msp_thread_context",
          { thread_id: targetThreadId },
          negative.claims,
          negative.pattern,
          negative.label,
        );
        directed.push(status(negative.id, "PASS", `real stdio ${negative.label} refusal`));
      } catch (error) {
        directed.push(status(negative.id, "FAIL", `real stdio ${negative.label} refusal`, errorText(error)));
      }
    }

    // Summary coverage is exercised once per real thread after all matrix
    // legs have appended. It uses only the approved stage-2 worker tools.
    let summaryEvidence;
    try {
      const sweepNow = new Date().toISOString();
      const jobs = [];
      // Sweep is deliberately room-scoped by the guard. Run one bounded sweep
      // for every real thread instead of passing an untrusted tenant filter.
      for (const meta of new Map([...threadMeta.values()].map((value) => [`${value.tenantId}:${value.room}`, value])).values()) {
        const sweepClaims = makeClaims({ ...meta, agentId: agents[0], operator: true });
        const sweep = await call(
          "msp_session_sweep",
          signed("msp_session_sweep", { limit: 200, now: sweepNow }, sweepClaims),
        );
        assert(Array.isArray(sweep.jobs), `${meta.tenantId}/${meta.room}: summary sweep must return jobs`);
        jobs.push(...sweep.jobs);
      }

      const expectedSummaryThreadIds = new Set(threadMeta.keys());
      const sweptThreadIds = new Set(jobs.map((job) => job.threadId));
      assert(
        sweptThreadIds.size === expectedSummaryThreadIds.size &&
          [...expectedSummaryThreadIds].every((threadId) => sweptThreadIds.has(threadId)) &&
          jobs.length === sweptThreadIds.size,
        `summary sweep must return exactly one job for each matrix thread (jobs=${jobs.length}, expected=${expectedSummaryThreadIds.size})`,
      );

      const summarizedThreads = new Set();
      for (const job of jobs) {
        if (summarizedThreads.has(job.threadId)) continue;
        const meta = threadMeta.get(job.threadId);
        assert(meta, `summary job ${job.jobId} must map to a matrix thread`);
        const workerAgent = agents[1];
        const workerClaims = makeClaims({ ...meta, agentId: workerAgent, operator: true });
        const claimed = await call(
          "msp_session_compaction_claim",
          signed("msp_session_compaction_claim", { job_id: job.jobId, worker_id: `phase7-worker-${job.threadId}`, lease_seconds: 60 }, workerClaims),
        );
        assert(Array.isArray(claimed.sources) && claimed.sources.length > 0, `${job.jobId}: claim must return source rows`);
        const source = claimed.sources.find((row) => row.speaker_kind === "HUMAN") ?? claimed.sources[0];
        const summaryItem = { text: `phase7 summary ${job.threadId}`, sourceMessageRefs: [source.message_id], speakerId: source.speaker_id };
        const committed = await call(
          "msp_session_compaction_commit",
          signed(
            "msp_session_compaction_commit",
            {
              session_id: claimed.sessionId,
              job_id: claimed.jobId,
              source_start_sequence: claimed.sourceStartSequence,
              source_end_sequence: claimed.sourceEndSequence,
              summary: { topics: [summaryItem], decisions: [], openQuestions: [], pendingActions: [], corrections: [], outcomes: [], participants: [] },
              policy_revision: policyRevision,
              summarizer_version: "phase7-acceptance-worker-v1",
              invocation_state: "TERMINAL",
              lease_token: claimed.leaseToken,
              source_digest: claimed.sourceDigest,
            },
            workerClaims,
          ),
        );
        assert(committed.summary?.summaryId, `${job.jobId}: commit must return summary`);
        summarizedThreads.add(job.threadId);
      }

      assert(
        summarizedThreads.size === expectedSummaryThreadIds.size &&
          [...expectedSummaryThreadIds].every((threadId) => summarizedThreads.has(threadId)),
        `summary acceptance must commit exactly one real summary for each matrix thread (summarized=${summarizedThreads.size}, expected=${expectedSummaryThreadIds.size})`,
      );
      summaryEvidence = status("BL083.summary", "PASS", "real stdio sweep -> claim -> commit", { threads: summarizedThreads.size, expectedThreads: expectedSummaryThreadIds.size });
    } catch (error) {
      summaryEvidence = status("BL083.summary", "FAIL", "real stdio sweep -> claim -> commit", errorText(error));
    }
    const phase6 = await runPhase6Acceptance(call, dbPath);
    return { matrix: legs, directed, summary: summaryEvidence, phase6 };
  } finally {
    await call.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runPhase6Acceptance(call, dbPath) {
  const tenantId = "phase7-phase6-tenant";
  const principalId = "phase7-phase6-principal";
  const agentId = "phase7-phase6-agent";
  const workspaceId = "phase7-phase6-workspace";
  const room = "phase7-phase6-direct";
  const claims = makeClaims({
    tenantId,
    principalId,
    agentId,
    workspaceId,
    room,
    audienceKind: "DIRECT",
    readPrivate: true,
    writePrivate: true,
    confirmMemory: true,
    assertParticipants: true,
    assertAgents: true,
    allowPassport: true,
    dataSubjectAccess: true,
  });

  try {
    const vault = await call(
      "msp_vault_resolve",
      signed(
        "msp_vault_resolve",
        {
          actor: "phase7-phase6-acceptance",
          access_context: {
            tenant_id: tenantId,
            principal_id: principalId,
            agent_id: agentId,
            workspace_id: workspaceId,
            project_id: "phase7-phase6-project",
            policy_version: policyRevision,
          },
          authorization: {
            allowed: true,
            read: true,
            write_private: true,
            write_shared: false,
            allow_passport: true,
          },
        },
        claims,
      ),
    );
    assert(vault.principalPrivateVaultId, "Phase6 acceptance must resolve a principal private vault");

    const resolved = await call(
      "msp_thread_resolve",
      signed(
        "msp_thread_resolve",
        {
          thread_kind: "DIRECT",
          audience_kind: "DIRECT",
          channel_type: "TEST",
          channel_account_id: `phase7-${tenantId}`,
          external_room_ref: room,
          tenant_id: tenantId,
        },
        claims,
      ),
    );
    const threadId = resolved.thread?.threadId;
    assert(threadId, "Phase6 acceptance must resolve a DIRECT thread");

    const inbound = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: threadId,
          source_event_id: "phase7-phase6-source-event",
          speaker_id: principalId,
          speaker_kind: "HUMAN",
          identity_assurance: "VERIFIED",
          person_id: principalId,
          direction: "INBOUND",
          text: "phase7 phase6 source",
        },
        claims,
      ),
    );
    const sessionId = inbound.session?.sessionId;
    const messageId = inbound.message?.messageId;
    assert(sessionId && messageId, "Phase6 acceptance must create a source session and message");

    const record = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        {
          thread_id: threadId,
          session_id: sessionId,
          kind: "PREFERENCE",
          asserted_by_speaker_id: principalId,
          subject_person_id: principalId,
          body: { phase7: "consolidation-source" },
          scope: {},
          source_message_refs: [messageId],
          verification_state: "CONFIRMED",
          visibility: "AGENT",
          confidence: 0.95,
        },
        claims,
      ),
    );
    assert(record.recordId, "Phase6 acceptance must create a protected source record");

    const consolidationInput = {
      source_record_id: record.recordId,
      target_vault_id: vault.principalPrivateVaultId,
      entity_category: "preference",
      entity_key: "phase7",
      idempotency_key: "phase7-phase6-consolidation",
    };
    const consolidated = await call(
      "msp_memory_consolidate",
      signed("msp_memory_consolidate", consolidationInput, claims),
    );
    assert(consolidated.decision === "consolidated" && consolidated.entity_id, "Phase6 acceptance must consolidate the DIRECT source");

    const digest = await call(
      "msp_memory_context_digest",
      signed("msp_memory_context_digest", { limit: 50 }, claims),
    );
    assert(digest.items.some((item) => item.entity_id === consolidated.entity_id), "Phase6 digest must expose the consolidated entity before erasure");

    const erased = await call(
      "msp_thread_principal_erase",
      signed(
        "msp_thread_principal_erase",
        { idempotency_key: "phase7-phase6-erasure", erase_vault: true },
        claims,
      ),
    );
    assert(erased.replay === false, "Phase6 vault erasure must be a first execution");

    const db = openDatabase(dbPath);
    try {
      const vaultRows = db.prepare("SELECT status, tenant_id, principal_id, agent_id, workspace_id FROM vaults WHERE vault_id IN (?, ?)")
        .all(vault.principalPrivateVaultId, vault.principalPassportVaultId);
      assert(vaultRows.length >= 1 && vaultRows.every((row) => row.status === "erased" && row.tenant_id === null && row.principal_id === null && row.agent_id === null && row.workspace_id === null), "vault erasure must clear every principal owner tuple");

      const entity = db.prepare("SELECT lifecycle_state, body_json, epistemic_state, confidence FROM entities WHERE entity_id=?")
        .get(consolidated.entity_id);
      assert(entity && entity.lifecycle_state === "forgotten" && entity.body_json === "{}" && entity.epistemic_state === "deprecated" && entity.confidence === 0, "vault erasure must forget the consolidated entity");

      const history = db.prepare("SELECT redaction_state, body_json, epistemic_state, confidence FROM entity_history WHERE entity_id=?")
        .all(consolidated.entity_id);
      assert(history.length > 0 && history.every((row) => row.redaction_state === "tombstoned" && row.body_json === "{}" && row.epistemic_state === "deprecated" && row.confidence === 0), "vault erasure must tombstone every entity history row");

      const provenance = db.prepare("SELECT redaction_state, source_message_refs_json FROM entity_provenance WHERE provenance_id=?")
        .get(consolidated.provenance_id);
      assert(provenance && provenance.redaction_state === "tombstoned" && provenance.source_message_refs_json === "[]", "vault erasure must tombstone provenance and clear message references");

      const sourceRow = db.prepare("SELECT redaction_state, body_json, scope_json FROM protected_memory_records WHERE record_id=?")
        .get(record.recordId);
      assert(sourceRow && sourceRow.redaction_state === "tombstoned" && sourceRow.body_json === "{}" && sourceRow.scope_json === "{}", "principal erasure must tombstone the source record");
      assert(db.prepare("SELECT COUNT(*) AS count FROM entities_fts WHERE entity_id=?").get(consolidated.entity_id).count === 0, "vault erasure must remove the FTS projection");

      return status("BL083.phase6.consolidation-erasure", "PASS", "real stdio consolidation + digest + principal erase + direct DB tombstones", {
        entityId: consolidated.entity_id,
        provenanceId: consolidated.provenance_id,
        vaults: vaultRows.length,
        historyRows: history.length,
        eraseTables: erased.tablesAffected,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    return status("BL083.phase6.consolidation-erasure", "FAIL", "real stdio Phase6 tools", errorText(error));
  }
}

function dependencyStatuses() {
  return [
    status("BL084.gate-a-rebaseline", "NOT_RUN", "BL083", "blocked until the complete BL083 matrix is green"),
    status("BL085.client-release", "NOT_RUN", "BL083", "release/package evidence waits for the complete matrix and phase5 env allowlist integration"),
    status("BL086.documentation-closure", "NOT_RUN", "BL083", "README/architecture closure waits for the complete matrix"),
    status("BL088.release-review", "NOT_RUN", "BL083..087", "no tag or publication is permitted from this harness"),
  ];
}

async function main() {
  assert(existsSync(binPath), `server entrypoint is missing: ${binPath}`);
  const results = [legacyShapeEvidence(), await runLegacyVaultCase()];
  const threadRun = await runThreadMatrix();
  results.push(...threadRun.matrix, ...threadRun.directed, threadRun.summary, threadRun.phase6, ...dependencyStatuses());

  const counts = results.reduce((out, row) => {
    out[row.result] = (out[row.result] ?? 0) + 1;
    return out;
  }, {});
  const report = {
    harness: "BL-MEMOS-083",
    generatedAt: new Date().toISOString(),
    matrix: { tenants, principals, agents, audiences, expectedLegs: tenants.length * principals.length * agents.length * audiences.length },
    counts,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if ((counts.FAIL ?? 0) > 0 || (counts.NOT_RUN ?? 0) > 0) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`phase7 acceptance harness failed before producing its matrix: ${errorText(error)}\n`);
  process.exitCode = 2;
});
