import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';
import { signThreadRequest } from '../../packages/msp-contracts/src/contracts/thread-access.mjs';
import { runThreadSummaryJob } from '../../apps/msp-server/src/thread-summary-worker.mjs';

// Explicit cross-repository gate, never a silently skipped default test.
// MSP_TEST_ZURI_ROOT must identify the Zuri checkout under review.
it('real MSP responses survive the Zuri adapter, signed transport, and model packet', async () => {
  if (!process.env.MSP_TEST_ZURI_ROOT) throw new Error('MSP_TEST_ZURI_ROOT is required for test:cross-zuri');
  const adapterPath = resolve(process.env.MSP_TEST_ZURI_ROOT, 'apps/server/src/modules/agent/msp-thread-memory-port.js');
  const { createMspThreadMemoryPort } = await import(/* @vite-ignore */ pathToFileURL(adapterPath).href);
  const root = mkdtempSync(join(tmpdir(), 'msp-zuri-contract-'));
  const key = 'synthetic-test-service-key-32-bytes-only';
  const server = createServer({ dbPath: join(root, 'test.sqlite'), env: { MSP_THREAD_SERVICE_KEY: key } });
  try {
    const port = createMspThreadMemoryPort({ serviceKey: key, transport: (name, args) => server.toolRegistry.dispatch(name, args) });
    const route = { tenantId: 't', businessId: 'b', channelAccountId: 'oa', externalRoomRef: 'opaque-dm', threadKind: 'DIRECT', audienceKind: 'DIRECT', channelType: 'LINE' };
    const authorization = { authContext: { actor: { principalId: 'person-a' }, scope: { tenantId: 't', businessId: 'b' }, policy: { decision: 'ALLOW', privateMemoryAllowed: true, version: 'v1', mspAuthorization: { read: true, writePrivate: true } } } };
    let first, last;
    for (let n = 0; n < 8; n++) {
      last = await port.appendInbound({ route, speaker: { speakerId: 'person-a', personId: 'person-a', identityAssurance: 'VERIFIED' }, text: `question-${n}`, sourceEventId: `in-${n}`, now: `2026-09-08T00:0${n}:00.000Z` });
      first ??= last;
      await port.appendMessage({ threadId: last.thread.threadId, sessionId: last.session.sessionId, exchangeId: last.message.exchangeId,
        replyToMessageId: last.message.messageId, direction: 'OUTBOUND', speakerId: 'agent', speakerKind: 'AGENT', identityAssurance: 'VERIFIED',
        text: `answer-${n}`, sourceEventId: `${last.message.messageId}:assistant`, deliveryState: 'QUEUED', now: `2026-09-08T00:0${n}:01.000Z`, authorization, requesterId: 'person-a' });
      await port.recordDelivery({ route, inboundMessageId: last.message.messageId, text: `answer-${n}`, receiptId: `receipt-${n}` });
    }
    const write = { threadId: first.thread.threadId, kind: 'CONSTRAINT', assertedBySpeakerId: 'person-a', subjectPersonId: 'person-a',
      body: { text: 'Never disclose my private details' }, sourceMessageRefs: [first.message.messageId], authorization };
    const constraint = await port.recordProtectedMemory(write);
    expect((await port.recordProtectedMemory(write)).recordId).toBe(constraint.recordId);
    const before = await port.context({ threadId: first.thread.threadId, authorization });
    expect(before.recentExchanges).toHaveLength(6);
    expect(port.buildContextPacket({ threadContext: before, authorization }).manifest.coverageGap).toBe(true);
    const workerClaims = { ...route, principalId: 'worker', policyRevision: 'v1', operator: true };
    const workerCall = async (name, input) => (await server.toolRegistry.dispatch(name, signThreadRequest(name, input, workerClaims, key))).structuredContent;
    const sweep = await workerCall('msp_session_sweep', { now: '2026-09-08T01:00:00Z' });
    await runThreadSummaryJob({ call: workerCall, jobId: sweep.jobs[0].jobId, workerId: 'worker', policyRevision: 'v1', summarizerVersion: 'test',
      summarize: async () => ({ invocationState: 'TERMINAL', summary: {
        topics: [{ text: 'kept-prefix', speakerId: 'person-a', sourceMessageRefs: [first.message.messageId] }],
        decisions: [], openQuestions: [], pendingActions: [], corrections: [], outcomes: [], participants: [] } }) });
    const pending = await port.appendInbound({ route, speaker: { speakerId: 'person-a', personId: 'person-a', identityAssurance: 'VERIFIED' },
      text: 'current question', sourceEventId: 'pending', now: '2026-09-08T01:01:00Z' });
    const context = await port.context({ threadId: first.thread.threadId, currentExchangeId: pending.message.exchangeId, authorization });
    const packet = port.buildContextPacket({ threadContext: context, authorization });
    expect(packet.memory.recentExchanges).toHaveLength(7);
    expect(packet.memory.summaries[0].summary.topics[0]).toMatchObject({ text: 'kept-prefix', verificationState: 'CANDIDATE' });
    expect(packet.memory.protectedMemory[0].recordId).toBe(constraint.recordId);
    expect(packet.manifest.coverageGap).toBe(false);
    const { createModelProviderPort } = await import(/* @vite-ignore */ pathToFileURL(resolve(process.env.MSP_TEST_ZURI_ROOT, 'apps/server/src/modules/agent/model-provider.js')).href);
    let modelCapture;
    const model = createModelProviderPort({ provider: 'openai', model: 'synthetic-test-model', credential: 'synthetic-key',
      fetchFn: async (_url, request) => { modelCapture = JSON.parse(request.body).input; return { ok: true, json: async () => ({ output_text: 'test answer' }) }; } });
    const wrapped = port.withInjectionReceipt({ model, contextPacket: packet, threadId: first.thread.threadId,
      exchangeId: pending.message.exchangeId, authorization, requesterId: 'person-a' });
    await wrapped.generate({ question: 'current question', evidence: {}, contextPacket: packet });
    expect(modelCapture).toContain('Never disclose my private details');
    expect(modelCapture).toContain('current question');
    expect(modelCapture).toContain('kept-prefix');
    expect(server.db.prepare('SELECT state FROM thread_injection_receipts WHERE injection_id=?').get(packet.injectionId).state).toBe('COMPLETED');
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
