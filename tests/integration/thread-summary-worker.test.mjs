import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';
import { signThreadRequest } from '../../packages/msp-contracts/src/contracts/thread-access.mjs';
import { runThreadSummaryJob, runThreadSummarySweep } from '../../apps/msp-server/src/thread-summary-worker.mjs';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'msp-summary-worker-'));
  const key = 'test-worker-synthetic-key-over-32-bytes';
  const server = createServer({ dbPath: join(root, 'test.sqlite'), env: { MSP_THREAD_SERVICE_KEY: key } });
  let time = '2026-09-08T00:00:00.000Z';
  const claims = { tenantId: 'tenant', businessId: 'business', channelAccountId: 'oa', externalRoomRef: 'dm',
    principalId: 'alice', policyRevision: 'v1', audienceKind: 'DIRECT', operator: true, readPrivate: true, deliveryWriter: true };
  const call = async (name, input = {}, scope = claims) => (await server.toolRegistry.dispatch(name,
    signThreadRequest(name, { ...input, now: time }, scope, key))).structuredContent;
  try {
    const { thread } = await call('msp_thread_resolve', { tenant_id: 'tenant', business_id: 'business',
      channel_account_id: 'oa', external_room_ref: 'dm', thread_kind: 'DIRECT', audience_kind: 'DIRECT', channel_type: 'LINE' });
    const inbound = await call('msp_thread_message_append', { thread_id: thread.threadId, speaker_id: 'alice', speaker_kind: 'HUMAN',
      person_id: 'alice', identity_assurance: 'VERIFIED', direction: 'INBOUND', text: 'Do not share my costs', source_event_id: 'in' });
    const out = () => call('msp_thread_message_append', { thread_id: thread.threadId, session_id: inbound.session.sessionId,
      exchange_id: inbound.message.exchangeId, reply_to_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`,
      speaker_id: 'agent', speaker_kind: 'AGENT', identity_assurance: 'VERIFIED', direction: 'OUTBOUND', text: 'generated only', delivery_state: 'QUEUED' });
    const summary = () => ({ topics: [{ text: 'User requests privacy', speakerId: 'alice', sourceMessageRefs: [inbound.message.messageId] }],
      decisions: [], openQuestions: [], pendingActions: [], corrections: [], outcomes: [], participants: [] });
    await run({ server, call, claims, thread, inbound, out, summary, setTime: (value) => { time = value; } });
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}

describe('authorized durable thread summary worker', () => {
  it('waits for an active answer across idle timeout, then captures the answer in the original session', () => fixture(async ({ server, call, thread, inbound, out, setTime }) => {
    setTime('2026-09-08T00:30:00.000Z');
    const injection = { thread_id: thread.threadId, exchange_id: inbound.message.exchangeId, injection_id: 'active-answer',
      packet_hash: 'a'.repeat(64), policy_revision: 'v1', model_ref: 'test-model' };
    await call('msp_thread_injection_record', { ...injection, state: 'RESOLVED' });
    await call('msp_thread_injection_record', { ...injection, state: 'SUBMITTED' });
    setTime('2026-09-08T00:31:00.000Z');
    const { jobs } = await call('msp_session_sweep');
    await expect(call('msp_session_compaction_claim', { job_id: jobs[0].jobId, worker_id: 'worker' })).rejects.toThrow(/still active/);
    await call('msp_thread_injection_record', { ...injection, state: 'COMPLETED' });
    expect((await out()).session.sessionId).toBe(inbound.session.sessionId);
    await expect(call('msp_session_compaction_claim', { job_id: jobs[0].jobId, worker_id: 'worker' })).rejects.toThrow(/deadline/);
    await call('msp_thread_delivery_record', { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`,
      receipt_id: 'answer-receipt', outcome: 'ACCEPTED', text: 'actual answer' });
    const job = await call('msp_session_compaction_claim', { job_id: jobs[0].jobId, worker_id: 'worker' });
    expect(job.sources[1].text).toBe('actual answer');
    expect(server.db.prepare('SELECT status FROM chat_sessions WHERE session_id=?').get(inbound.session.sessionId).status).toBe('CLOSING');
  }));

  it('queues fallback before inbound exists, then reconciles it once without trusting another scope', () => fixture(async ({ server, call, thread }) => {
    const receipt = { inbound_message_id: 'delayed-inbound', source_event_id: 'delayed-inbound:assistant', receipt_id: 'fallback-receipt', outcome: 'ACCEPTED', text: 'transport fallback' };
    expect((await call('msp_thread_delivery_record', receipt)).status).toBe('PENDING_INBOUND');
    expect((await call('msp_thread_delivery_record', receipt)).status).toBe('PENDING_INBOUND');
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM thread_pending_deliveries').get().n).toBe(1);
    await call('msp_thread_message_append', { thread_id: thread.threadId, message_id: 'delayed-inbound', source_event_id: 'delayed-source',
      speaker_id: 'alice', speaker_kind: 'HUMAN', identity_assurance: 'VERIFIED', direction: 'INBOUND', text: 'original question' });
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM thread_pending_deliveries').get().n).toBe(0);
    expect((await call('msp_thread_delivery_record', receipt)).deduplicated).toBe(true);
    const context = await call('msp_thread_context', { thread_id: thread.threadId });
    expect(context.recentExchanges.flatMap((x) => x.messages).find((m) => m.direction === 'OUTBOUND').text).toBe('transport fallback');
  }));

  it('records a late fallback after timeout/seal and invalidates the old derived summary without deleting evidence', () => fixture(async ({ server, call, thread, inbound, summary, setTime }) => {
    setTime('2026-09-08T00:31:00.000Z');
    await runThreadSummarySweep({ call, workerId: 'worker', policyRevision: 'v1', summarizerVersion: 'test',
      summarize: async () => ({ invocationState: 'TERMINAL', summary: summary() }) });
    expect(server.db.prepare('SELECT status FROM chat_sessions').get().status).toBe('CLOSED');
    setTime('2026-09-08T00:32:00.000Z');
    await call('msp_thread_delivery_record', { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`,
      receipt_id: 'late-fallback', outcome: 'ACCEPTED', text: 'late fallback' });
    expect(server.db.prepare('SELECT status FROM chat_sessions').get().status).toBe('CLOSING');
    expect((await call('msp_thread_context', { thread_id: thread.threadId })).threadSummaries).toHaveLength(0);
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get().n).toBe(1);
    const next = await runThreadSummarySweep({ call, workerId: 'worker', policyRevision: 'v1', summarizerVersion: 'test',
      summarize: async ({ sources }) => { expect(sources[1].text).toBe('late fallback'); return { invocationState: 'TERMINAL', summary: summary() }; } });
    expect(next.results[0].status).toBe('COMMITTED');
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get().n).toBe(2);
    expect((await call('msp_thread_context', { thread_id: thread.threadId })).threadSummaries).toHaveLength(1);
  }));

  it('reclaims a crashed lease and rejects parallel/stale workers, wrong digest, missing terminal and foreign attribution', () => fixture(async ({ server, call, inbound, summary, setTime }) => {
    setTime('2026-09-08T00:31:00.000Z');
    const sweep = await call('msp_session_sweep');
    const job = await call('msp_session_compaction_claim', { job_id: sweep.jobs[0].jobId, worker_id: 'first', lease_seconds: 30 });
    await expect(call('msp_session_compaction_claim', { job_id: job.jobId, worker_id: 'parallel' })).rejects.toThrow(/already leased/);
    const input = { job_id: job.jobId, session_id: inbound.session.sessionId, lease_token: job.leaseToken,
      source_start_sequence: job.sourceStartSequence, source_end_sequence: job.sourceEndSequence, source_digest: job.sourceDigest,
      policy_revision: 'v1', summarizer_version: 'test-v1', invocation_state: 'TERMINAL', summary: summary() };
    await expect(call('msp_session_compaction_commit', { ...input, invocation_state: undefined })).rejects.toThrow(/CONTRACT/);
    await expect(call('msp_session_compaction_commit', { ...input, source_digest: '0'.repeat(64) })).rejects.toThrow(/source_digest/);
    const foreign = summary(); foreign.topics[0].sourceMessageRefs = ['another-thread-message'];
    await expect(call('msp_session_compaction_commit', { ...input, summary: foreign })).rejects.toThrow(/outside/);
    const impersonated = summary(); impersonated.topics[0].speakerId = 'bob';
    await expect(call('msp_session_compaction_commit', { ...input, summary: impersonated })).rejects.toThrow(/outside/);
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get().n).toBe(0);
    setTime('2026-09-08T00:32:00.000Z');
    expect((await call('msp_session_sweep')).jobs[0].jobId).toBe(job.jobId);
    const next = await call('msp_session_compaction_claim', { job_id: job.jobId, worker_id: 'recovery' });
    await expect(call('msp_session_compaction_commit', input)).rejects.toThrow(/lease/);
    const valid = { ...input, lease_token: next.leaseToken };
    const saved = await call('msp_session_compaction_commit', valid);
    expect((await call('msp_session_compaction_commit', valid)).summary.summaryId).toBe(saved.summary.summaryId);
    expect(saved.summary.summary.topics[0].verificationState).toBe('CANDIDATE');
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get().n).toBe(1);
  }));

  it('failed summarization preserves sources and a subsequent sweep commits the retry', () => fixture(async ({ server, call, summary, setTime }) => {
    setTime('2026-09-08T00:31:00.000Z');
    const { jobs } = await call('msp_session_sweep');
    const options = { call, jobId: jobs[0].jobId, workerId: 'worker', policyRevision: 'v1', summarizerVersion: 'test-v1' };
    await expect(runThreadSummaryJob({ ...options, summarize: async () => { throw new Error('private provider details'); } })).rejects.toThrow();
    const failed = server.db.prepare('SELECT * FROM session_compaction_jobs').get();
    expect(failed.status).toBe('RETRYABLE');
    expect(failed.last_error).toBe('SUMMARY_ATTEMPT_FAILED');
    expect(server.db.prepare('SELECT summary_watermark FROM chat_sessions').get().summary_watermark).toBe(0);
    const result = await runThreadSummarySweep({ ...options, summarize: async ({ sources }) => {
      expect(sources[0]).toMatchObject({ speaker_id: 'alice', direction: 'INBOUND' });
      return { invocationState: 'TERMINAL', summary: summary() };
    } });
    expect(result.results[0].status).toBe('COMMITTED');
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM thread_messages').get().n).toBe(1);
  }));

  it('keeps late outbound in its original session, incorporates actual sent text, and rejects stale source snapshots', () => fixture(async ({ call, thread, inbound, out, summary, setTime }) => {
    setTime('2026-09-08T00:31:00.000Z');
    const { jobs } = await call('msp_session_sweep');
    await call('msp_thread_message_append', { thread_id: thread.threadId, speaker_id: 'alice', speaker_kind: 'HUMAN',
      identity_assurance: 'VERIFIED', direction: 'INBOUND', text: 'new session', source_event_id: 'next' });
    const outbound = await out();
    expect(outbound.session.sessionId).toBe(inbound.session.sessionId);
    setTime('2026-09-08T00:34:00.000Z');
    const claim = await call('msp_session_compaction_claim', { job_id: jobs[0].jobId, worker_id: 'worker' });
    expect(claim.sources.map((row) => row.sequence)).toEqual([1, 3]);
    expect(claim.sources[1].delivery_state).toBe('QUEUED');
    const delivery = { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`, receipt_id: 'receipt', outcome: 'ACCEPTED', text: 'actual fallback' };
    await call('msp_thread_delivery_record', delivery);
    expect((await call('msp_thread_delivery_record', delivery)).deduplicated).toBe(true);
    await expect(call('msp_thread_delivery_record', { ...delivery, text: 'rewritten' })).rejects.toThrow(/retry differs/);
    await expect(call('msp_session_compaction_commit', { session_id: inbound.session.sessionId, job_id: claim.jobId,
      lease_token: claim.leaseToken, source_digest: claim.sourceDigest, source_start_sequence: 1, source_end_sequence: 3,
      policy_revision: 'v1', summarizer_version: 'test', invocation_state: 'TERMINAL', summary: summary() })).rejects.toThrow(/lease/);
    const retry = await call('msp_session_compaction_claim', { job_id: claim.jobId, worker_id: 'worker' });
    expect(retry.sources[1]).toMatchObject({ text: 'actual fallback', delivery_state: 'ACCEPTED' });
  }));

  it('limits sweep to the signed business/account/room', () => fixture(async ({ call, claims, setTime }) => {
    setTime('2026-09-08T00:31:00.000Z');
    expect((await call('msp_session_sweep', {}, { ...claims, externalRoomRef: 'different-room' })).jobs).toHaveLength(0);
    expect((await call('msp_session_sweep')).jobs).toHaveLength(1);
  }));

  it('invalidates an old lease even when a new receipt leaves the effective source unchanged', () => fixture(async ({ call, inbound, out, summary, setTime }) => {
    await out();
    const receipt = { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`,
      receipt_id: 'first-acceptance', text: 'accepted text', outcome: 'ACCEPTED' };
    await call('msp_thread_delivery_record', receipt);
    setTime('2026-09-08T00:31:00.000Z');
    const { jobs } = await call('msp_session_sweep');
    const job = await call('msp_session_compaction_claim', { job_id: jobs[0].jobId, worker_id: 'worker' });
    await call('msp_thread_delivery_record', { ...receipt, receipt_id: 'second-acceptance' });
    await expect(call('msp_session_compaction_retry', { job_id: job.jobId, lease_token: job.leaseToken, error: 'old-worker' })).rejects.toThrow(/lease/);
    await expect(call('msp_session_compaction_commit', { job_id: job.jobId, session_id: job.sessionId, lease_token: job.leaseToken,
      source_start_sequence: job.sourceStartSequence, source_end_sequence: job.sourceEndSequence, source_digest: job.sourceDigest,
      policy_revision: 'v1', summarizer_version: 'test', invocation_state: 'TERMINAL', summary: summary() })).rejects.toThrow(/lease/);
    const replacement = await call('msp_session_compaction_claim', { job_id: job.jobId, worker_id: 'replacement' });
    expect(replacement.sourceDigest).toBe(job.sourceDigest);
    expect(replacement.leaseToken).not.toBe(job.leaseToken);
  }));
});
