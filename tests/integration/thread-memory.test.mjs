import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../apps/msp-server/src/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [];
const servers = [];

function timestamp(minutes) {
  return new Date(Date.parse("2026-09-08T00:00:00.000Z") + minutes * 60_000).toISOString();
}

function summary() {
  return {
    topics: ["onboarding"],
    decisions: ["use the registered workspace"],
    openQuestions: ["confirm the next owner"],
    pendingActions: ["send the setup link"],
    corrections: ["keep the speaker attached to each fact"],
    outcomes: ["thread memory is scoped"],
    participants: ["person:alice", "person:bob"],
  };
}

function makeServer() {
  const root = mkdtempSync(path.join(tmpdir(), "msp-thread-memory-test-"));
  roots.push(root);
  const server = createServer({ dbPath: path.join(root, "msp.sqlite3") });
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length) servers.pop().close();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("unified thread, speaker and session memory", () => {
  it("keeps a stable thread, records speakers, retains six exchanges and queues compaction", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const resolved = await tools.msp_thread_resolve({
      actor: "zuri-integration",
      thread_kind: "GROUP",
      audience_kind: "GROUP",
      channel_type: "LINE_GROUP",
      channel_account_id: "oa-zuri",
      external_room_ref: "line-group-hash",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
      now: timestamp(0),
    });
    const again = await tools.msp_thread_resolve({
      actor: "zuri-integration",
      thread_kind: "GROUP",
      audience_kind: "GROUP",
      channel_type: "LINE_GROUP",
      channel_account_id: "oa-zuri",
      external_room_ref: "line-group-hash",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
      now: timestamp(1),
    });
    expect(again.created).toBe(false);
    expect(again.thread.threadId).toBe(resolved.thread.threadId);

    let sessionId;
    let firstInbound;
    for (let index = 0; index < 7; index += 1) {
      const exchangeId = `exchange-${index + 1}`;
      const inbound = await tools.msp_thread_message_append({
        thread_id: resolved.thread.threadId,
        session_id: sessionId,
        exchange_id: exchangeId,
        source_event_id: `event-in-${index + 1}`,
        speaker_id: index % 2 === 0 ? "line-speaker-alice" : "line-speaker-bob",
        speaker_kind: "HUMAN",
        person_id: index % 2 === 0 ? "person:alice" : "person:bob",
        identity_assurance: "VERIFIED",
        direction: "INBOUND",
        text: `คำถามรอบที่ ${index + 1}`,
        now: timestamp(index),
        occurred_at: timestamp(index),
        idle_timeout_minutes: 30,
        policy_revision: "line-memory-v1",
      });
      sessionId = inbound.session.sessionId;
      firstInbound ??= inbound.message;
      const outbound = await tools.msp_thread_message_append({
        thread_id: resolved.thread.threadId,
        session_id: sessionId,
        exchange_id: exchangeId,
        source_event_id: `event-out-${index + 1}`,
        speaker_id: "zuri-agent",
        speaker_kind: "AGENT",
        identity_assurance: "VERIFIED",
        direction: "OUTBOUND",
        text: `คำตอบรอบที่ ${index + 1}`,
        now: timestamp(index),
        delivery_state: "DELIVERED",
      });
      expect(outbound.message.exchangeId).toBe(exchangeId);
    }

    const memory = await tools.msp_thread_memory_record({
      thread_id: resolved.thread.threadId,
      session_id: sessionId,
      kind: "CONSTRAINT",
      asserted_by_speaker_id: "line-speaker-alice",
      subject_person_id: "person:alice",
      scope: { audience: "GROUP", business_id: "business-smartgift" },
      body: { text: "ตอบเป็นหลาย bubble" },
      source_message_refs: [firstInbound.messageId],
      verification_state: "CONFIRMED",
      now: timestamp(7),
    });
    expect(memory.kind).toBe("CONSTRAINT");

    const beforeClose = await tools.msp_thread_context({ thread_id: resolved.thread.threadId, recent_exchange_count: 6, now: timestamp(7) });
    expect(beforeClose.recentExchangeCount).toBe(6);
    await expect(tools.msp_thread_context({ thread_id: resolved.thread.threadId, recent_exchange_count: 7, now: timestamp(7) })).rejects.toThrow(/policy ceiling/i);
    expect(beforeClose.participants.map((entry) => entry.speakerId).sort()).toEqual(["line-speaker-alice", "line-speaker-bob", "zuri-agent"].sort());
    expect(beforeClose.protectedRecords[0].subjectPersonId).toBe("person:alice");
    expect(beforeClose.recentExchanges[0].messages[0].speakerId).toBe("line-speaker-bob");

    const sweep = await tools.msp_session_sweep({ now: timestamp(40) });
    expect(sweep.closed).toBe(1);
    expect(sweep.jobs[0].sourceStartSequence).toBe(1);
    expect(sweep.jobs[0].sourceEndSequence).toBe(14);

    const duplicate = await tools.msp_thread_message_append({
      thread_id: resolved.thread.threadId,
      source_event_id: "event-in-7",
      speaker_id: "line-speaker-alice",
      speaker_kind: "HUMAN",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: "ซ้ำจาก provider",
      now: timestamp(40),
    });
    expect(duplicate.deduplicated).toBe(true);

    const nextWhileCompacting = await tools.msp_thread_message_append({
      thread_id: resolved.thread.threadId,
      exchange_id: "exchange-8",
      source_event_id: "event-in-8",
      speaker_id: "line-speaker-alice",
      speaker_kind: "HUMAN",
      person_id: "person:alice",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: "ข้อความใน session ใหม่ระหว่างสรุป",
      now: timestamp(40),
      idle_timeout_minutes: 30,
      policy_revision: "line-memory-v1",
    });
    expect(nextWhileCompacting.session.sessionId).not.toBe(sessionId);
    expect(nextWhileCompacting.session.summaryWatermark).toBe(0);

    const compactInput = {
      session_id: sessionId,
      job_id: sweep.jobs[0].jobId,
      source_start_sequence: 1,
      source_end_sequence: 14,
      summary: summary(),
      policy_revision: "line-memory-v1",
      summarizer_version: "zuri-summary-v1",
      now: timestamp(41),
    };
    await expect(tools.msp_session_compaction_commit({ ...compactInput, invocation_state: "RUNNING" })).rejects.toThrow(/terminal model invocation/i);
    const committed = await tools.msp_session_compaction_commit({ ...compactInput, invocation_state: "TERMINAL" });
    expect(committed.summary.coveredThroughSequence).toBe(14);

    const afterClose = await tools.msp_thread_context({ thread_id: resolved.thread.threadId, recent_exchange_count: 6, now: timestamp(42) });
    expect(afterClose.threadSummaries).toHaveLength(1);
    expect(afterClose.threadSummaries[0].overlapsRecent).toBe(true);
    expect(afterClose.coverageGap).toBeNull();

    const next = await tools.msp_thread_message_append({
      thread_id: resolved.thread.threadId,
      session_id: nextWhileCompacting.session.sessionId,
      exchange_id: "exchange-8",
      source_event_id: "event-in-9",
      speaker_id: "line-speaker-alice",
      speaker_kind: "HUMAN",
      person_id: "person:alice",
      identity_assurance: "VERIFIED",
      direction: "INBOUND",
      text: "ข้อความต่อเนื่องใน session ใหม่",
      now: timestamp(42),
      idle_timeout_minutes: 30,
      policy_revision: "line-memory-v1",
    });
    expect(next.session.sessionId).toBe(nextWhileCompacting.session.sessionId);
    expect(next.session.summaryWatermark).toBe(14);
  });

  it("does not let a different business reuse an existing channel binding", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const input = {
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE_DM",
      channel_account_id: "oa-zuri",
      external_room_ref: "user-hash",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
    };
    await tools.msp_thread_resolve(input);
    await expect(tools.msp_thread_resolve({ ...input, business_id: "business-emc" })).rejects.toThrow(/different thread scope/i);
  });

  it("does not replay one provider event into a different thread", async () => {
    const server = makeServer();
    const tools = server.threadHandlers;
    const base = {
      actor: "zuri-integration",
      thread_kind: "DIRECT",
      audience_kind: "DIRECT",
      channel_type: "LINE_DM",
      channel_account_id: "oa-zuri",
      tenant_id: "tenant-01",
      business_id: "business-smartgift",
    };
    const first = await tools.msp_thread_resolve({ ...base, external_room_ref: "dm-one" });
    const second = await tools.msp_thread_resolve({ ...base, external_room_ref: "dm-two" });
    await tools.msp_thread_message_append({
      thread_id: first.thread.threadId,
      source_event_id: "source-shared",
      speaker_id: "line-speaker",
      speaker_kind: "HUMAN",
      identity_assurance: "PENDING",
      direction: "INBOUND",
      text: "ครั้งแรก",
    });
    await expect(tools.msp_thread_message_append({
      thread_id: second.thread.threadId,
      source_event_id: "source-shared",
      speaker_id: "line-speaker",
      speaker_kind: "HUMAN",
      identity_assurance: "PENDING",
      direction: "INBOUND",
      text: "ไม่ควรถูกย้าย thread",
    })).rejects.toThrow(/different thread/i);
  });
});
