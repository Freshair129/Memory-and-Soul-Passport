// API-011 thread memory (TASK-MEMOS-002): RKOI code review round 2, WARNING
// 8 -- schemas/API-011.tools.json's `outputSchema` is compiled by ajv
// (packages/msp-contracts/src/contracts/thread-schema.mjs) but was never
// actually run against anything after the guard's post-commit output check
// was deliberately removed (thread-guard.mjs's header comment explains why:
// it only ran AFTER the domain's write had already committed, so it was
// never fail-closed, only a late diagnostic). RKOI was explicit: do NOT
// re-add that check to the guard -- instead prove the schema itself is
// still an accurate description of what the real tool returns, through a
// CONTRACT test against the real running process. If this test ever finds
// a mismatch, the fix is to correct the SCHEMA, never to make the guard
// validate output again.
//
// Only two of API-011's ten tools declare an `outputSchema` at all
// (msp_thread_memory_record, msp_thread_context) -- the other eight have
// none, so there is nothing for validateThreadContract's "output" direction
// to check for them (see thread-schema.mjs: `tool.outputSchema ? ajv.compile(...) : null`).
// This test drives both of the tools that DO declare one through the real
// spawned msp-server binary and validates their real responses.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMspStdioCaller } from "@freshair129/msp-client-js";
import { signThreadRequest } from "../../packages/msp-contracts/src/contracts/thread-access.mjs";
import { validateThreadContract } from "../../packages/msp-contracts/src/contracts/thread-schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const binPath = path.join(packageRoot, "apps", "msp-server", "bin", "msp-server.mjs");
const SERVICE_KEY = "api-011-output-schema-contract-test-key-32";
const IDENTITY_KEY = "api-011-output-schema-contract-test-hmac-key";

function signed(name, input, claims) {
  return signThreadRequest(name, input, claims, SERVICE_KEY);
}

describe("API-011 outputSchema: real tool output against its own contract schema", () => {
  let call;
  let dbPath;
  let tempDir;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "msp-api011-output-schema-"));
    dbPath = path.join(tempDir, "msp.sqlite3");
    call = createMspStdioCaller({
      command: process.execPath,
      args: [binPath],
      env: { ...process.env, MSP_DB_PATH: dbPath, MSP_THREAD_SERVICE_KEY: SERVICE_KEY, MSP_IDENTITY_HMAC_KEY: IDENTITY_KEY },
      timeoutMs: 10_000,
    });
  });

  afterAll(async () => {
    await call.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("msp_thread_context and msp_thread_memory_record's real responses satisfy their own outputSchema", async () => {
    const room = { channelAccountId: "oa-out", tenantId: "tenant-out" };
    // PH-MEMOS-3 stage 2: agentId/workspaceId are now required on every one
    // of the ten API-011 tools.
    const claims = { ...room, externalRoomRef: "dm-out-1", audienceKind: "DIRECT", principalId: "alice", policyRevision: "v1", agentId: "agent-out", workspaceId: "workspace-out" };

    const { thread } = await call(
      "msp_thread_resolve",
      signed(
        "msp_thread_resolve",
        { thread_kind: "DIRECT", audience_kind: "DIRECT", channel_type: "LINE", channel_account_id: "oa-out", external_room_ref: "dm-out-1", tenant_id: "tenant-out" },
        claims,
      ),
    );

    const appendResult = await call(
      "msp_thread_message_append",
      signed(
        "msp_thread_message_append",
        {
          thread_id: thread.threadId,
          source_event_id: "out-in-1",
          speaker_id: "alice",
          speaker_kind: "HUMAN",
          identity_assurance: "VERIFIED",
          person_id: "alice",
          direction: "INBOUND",
          text: "remember I like tea",
        },
        claims,
      ),
    );

    // msp_thread_memory_record -- real response validated against its
    // outputSchema (recordId, threadId, assertedBySpeakerId,
    // sourceMessageRefs, verificationState all required).
    const recordResponse = await call(
      "msp_thread_memory_record",
      signed(
        "msp_thread_memory_record",
        {
          thread_id: thread.threadId,
          kind: "PREFERENCE",
          asserted_by_speaker_id: "alice",
          subject_person_id: "alice",
          scope: {},
          body: { drink: "tea" },
          source_message_refs: [appendResult.message.messageId],
        },
        { ...claims, writePrivate: true },
      ),
    );
    expect(() => validateThreadContract("msp_thread_memory_record", recordResponse, "output")).not.toThrow();
    expect(recordResponse).toMatchObject({
      recordId: expect.any(String),
      threadId: thread.threadId,
      assertedBySpeakerId: "alice",
      sourceMessageRefs: [appendResult.message.messageId],
      verificationState: expect.any(String),
    });

    // msp_thread_context -- real response validated against its
    // outputSchema (thread, recentExchanges, threadSummaries,
    // protectedRecords, participants, coverageGap all required).
    const contextResponse = await call(
      "msp_thread_context",
      signed("msp_thread_context", { thread_id: thread.threadId }, { ...claims, readPrivate: true }),
    );
    expect(() => validateThreadContract("msp_thread_context", contextResponse, "output")).not.toThrow();
    expect(contextResponse).toMatchObject({
      thread: { threadId: thread.threadId, audienceKind: "DIRECT" },
      recentExchanges: expect.any(Array),
      threadSummaries: expect.any(Array),
      protectedRecords: expect.any(Array),
      participants: expect.any(Array),
    });
    expect(contextResponse).toHaveProperty("coverageGap");
  });

  it("every other API-011 tool declares no outputSchema today -- documented, not silently assumed", async () => {
    const contract = JSON.parse(
      await import("node:fs").then((fs) => fs.promises.readFile(new URL("../../packages/msp-contracts/schemas/API-011.tools.json", import.meta.url), "utf8")),
    );
    const withOutputSchema = contract.tools.filter((tool) => tool.outputSchema).map((tool) => tool.name);
    expect(withOutputSchema.sort()).toEqual(["msp_thread_context", "msp_thread_memory_record"]);
  });
});
