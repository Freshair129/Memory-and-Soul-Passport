import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { open } from "@freshair129/msp-storage/connection";
import { signThreadRequest } from "@freshair129/msp-contracts/thread-access";

export const SERVICE_KEY = "phase6-synthetic-service-key-00000000";
export const OWNER = { tenantId: "tenant-six", principalId: "alice", agentId: "agent-six", workspaceId: "workspace-six", allowPassport: true };
export const sign = (name, input, claims = OWNER, now = Date.now()) => signThreadRequest(name, input, claims, SERVICE_KEY, now);

export async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "msp-phase6-"));
  const dbPath = path.join(dir, "msp.db");
  const options = { command: process.execPath,
    args: [fileURLToPath(new URL("../../apps/msp-server/bin/msp-server.mjs", import.meta.url))],
    env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEY: SERVICE_KEY,
      MSP_IDENTITY_HMAC_KEY: "phase6-synthetic-identity-key-00000", MSP_IDENTITY_HMAC_KEY_VERSION: "v1" }, timeoutMs: 15000 };
  const call = createMspStdioCaller(options);
  const signed = (name, input, claims = OWNER) => call(name, sign(name, input, claims));
  await call("msp_ping", {});
  const db = open(dbPath);
  const vault = async (claims = OWNER) => signed("msp_vault_resolve", {
    actor: "test", access_context: { tenant_id: claims.tenantId, principal_id: claims.principalId,
      agent_id: claims.agentId, workspace_id: claims.workspaceId, project_id: "phase6-project" },
    authorization: { allowed: true, allow_passport: true },
  }, claims);
  const source = async ({ claims = OWNER, kind = "DIRECT", confidence = 0.95, state = "CONFIRMED", visibility = "AGENT", body = { language: "Thai" } } = {}) => {
    const scope = { ...claims, channelAccountId: "phase6-channel", externalRoomRef: randomUUID(), audienceKind: kind,
      policyRevision: "v1", writePrivate: true, confirmMemory: true, readPrivate: true, assertParticipants: true };
    const { thread } = await signed("msp_thread_resolve", { channel_type: "LINE", channel_account_id: scope.channelAccountId,
      tenant_id: scope.tenantId, external_room_ref: scope.externalRoomRef, thread_kind: kind, audience_kind: kind }, scope);
    const message = await signed("msp_thread_message_append", { thread_id: thread.threadId, source_event_id: randomUUID(),
      speaker_id: scope.principalId, speaker_kind: "HUMAN", identity_assurance: "VERIFIED", person_id: scope.principalId,
      direction: "INBOUND", text: "synthetic phase6 source" }, scope);
    const input = { thread_id: thread.threadId, session_id: message.session.sessionId, kind: "PREFERENCE",
      asserted_by_speaker_id: scope.principalId, subject_person_id: scope.principalId, body, scope: {},
      source_message_refs: [message.message.messageId], verification_state: state, visibility, confidence };
    let record;
    if (kind === "DIRECT") record = await signed("msp_thread_memory_record", input, scope);
    else {
      // Historical GROUP fixture: the current producer already refuses it.
      const recordId = `record_${randomUUID()}`;
      db.prepare(`INSERT INTO protected_memory_records(record_id,tenant_id,thread_id,session_id,kind,status,
        asserted_by_speaker_id,subject_person_id,scope_json,body_json,source_message_refs_json,verification_state,
        created_at,updated_at,agent_id,visibility,confidence) VALUES(?,?,?,?,'PREFERENCE','ACTIVE',?,?,'{}',?,?,'CONFIRMED',?,?,?,?,?)`)
        .run(recordId, scope.tenantId, thread.threadId, message.session.sessionId, scope.principalId, scope.principalId,
          JSON.stringify(body), JSON.stringify(input.source_message_refs), new Date().toISOString(), new Date().toISOString(), scope.agentId, visibility, confidence);
      record = { recordId };
    }
    return { record, input, scope, thread, message };
  };
  const consolidate = (recordId, vaultId, key = "language", extra = {}, claims = OWNER) => signed("msp_memory_consolidate", {
    source_record_id: recordId, target_vault_id: vaultId, entity_category: "preference", entity_key: key, idempotency_key: randomUUID(), ...extra,
  }, claims);
  return { db, dbPath, call, signed, vault, source, consolidate, fork: () => createMspStdioCaller(options),
    async close() { db.close(); await call.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
