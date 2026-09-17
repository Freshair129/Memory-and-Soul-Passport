// API-011 thread memory (TASK-MEMOS-002): a cross-repository gate against
// zuri-ai's own adapter, never a mock of it. Explicit and never silently
// skipped: MSP_TEST_ZURI_ROOT must name the Zuri checkout under review, or
// this throws immediately. Owner direction for this stage: do not touch
// zuri-ai -- this file only READS its adapter module (never edits it) and
// is dormant (excluded from `npm test`/`npm run test:integration`; only
// `npm run test:cross-zuri` runs it) unless that env var is set.
//
// PH-MEMOS-3 stage 2 (BL-MEMOS-046, DEC-MEMOS-17, RKOI-approved spec
// docs/memos-002-stage2-spec@b090a51): every API-011 tool requires
// agentId/workspaceId/nonce on the signed grant (BL-MEMOS-040). The real
// zuri-ai adapter is read from the checkout named by MSP_TEST_ZURI_ROOT and
// exercised against the real MSP server. Current zuri-ai supplies the stage-2
// claims; this test therefore proves the live adapter can resolve a thread and
// that MSP accepts the complete grant instead of relying on a stale refusal
// fixture from before the zuri-ai caller was upgraded.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';
import { signThreadRequest } from '../../packages/msp-contracts/src/contracts/thread-access.mjs';

function withServer(run) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'msp-zuri-contract-'));
    const key = 'synthetic-test-service-key-32-bytes-only';
    const identityKey = 'synthetic-test-identity-hmac-key-32-bytes';
    const server = createServer({ dbPath: join(root, 'test.sqlite'), env: { MSP_THREAD_SERVICE_KEY: key, MSP_IDENTITY_HMAC_KEY: identityKey, MSP_TEST_CLOCK: '1' } });
    try {
      await run({ server, key });
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

it(
  "current zuri-ai adapter sends the complete stage-2 grant and resolves a thread",
  withServer(async ({ server, key }) => {
    if (!process.env.MSP_TEST_ZURI_ROOT) throw new Error('MSP_TEST_ZURI_ROOT is required for test:cross-zuri');
    const adapterPath = resolve(process.env.MSP_TEST_ZURI_ROOT, 'apps/server/src/modules/agent/msp-thread-memory-port.js');
    const { createMspThreadMemoryPort } = await import(/* @vite-ignore */ pathToFileURL(adapterPath).href);
    const calls = [];
    const port = createMspThreadMemoryPort({
      serviceKey: key,
      workspaceId: 'workspace-zuri-contract',
      transport: (name, args) => {
        calls.push({ name, args });
        return server.toolRegistry.dispatch(name, args);
      },
    });
    const route = { tenantId: 't', businessId: 'b', channelAccountId: 'oa', externalRoomRef: 'opaque-dm', threadKind: 'DIRECT', audienceKind: 'DIRECT', channelType: 'LINE' };
    const resolved = await port.resolveThread(route);
    expect(resolved?.thread?.threadId).toEqual(expect.any(String));
    expect(calls[0]?.name).toBe('msp_thread_resolve');
    expect(calls[0]?.args?.access?.grant).toMatchObject({
      agentId: 'zuri-line-agent',
      workspaceId: 'workspace-zuri-contract',
      operation: 'msp_thread_resolve',
    });
    expect(calls[0]?.args?.access?.grant?.nonce).toEqual(expect.any(String));
    expect(calls[0]?.args?.access?.signature).toEqual(expect.any(String));
  }),
);

it(
  'shape-only: MSP responses still satisfy every shape check zuri-ai\'s own adapter code performs, once agentId/workspaceId/nonce are added to the exact same wire requests',
  withServer(async ({ server, key }) => {
    // Deliberately does NOT call the adapter for this shape matrix. It proves
    // the exact response shapes the real zuri-ai port reads after the three
    // stage-2 claims are added, while the first case above exercises that port
    // end-to-end against MSP.
    if (!process.env.MSP_TEST_ZURI_ROOT) throw new Error('MSP_TEST_ZURI_ROOT is required for test:cross-zuri');
    const adapterPath = resolve(process.env.MSP_TEST_ZURI_ROOT, 'apps/server/src/modules/agent/msp-thread-memory-port.js');
    const adapterSource = await import('node:fs').then((fs) => fs.promises.readFile(adapterPath, 'utf8'));
    // A light, load-bearing structural check that the port this test is
    // shaping itself against has not silently changed its own wire field
    // names since this file was last reviewed -- if zuri-ai's real source
    // ever renames one of these, this test must fail loudly here, not
    // pass by accident.
    for (const marker of ['msp_thread_resolve', 'msp_thread_message_append', 'msp_thread_context', 'msp_thread_memory_record', 'msp_thread_delivery_record', 'thread_kind:', 'channel_account_id:', 'external_room_ref:']) {
      expect(adapterSource).toContain(marker);
    }

    const call = async (name, input, claims) =>
      (await server.toolRegistry.dispatch(name, signThreadRequest(name, input, claims, key))).structuredContent;

    const zuriAgentId = 'zuri-shape-agent';
    const zuriWorkspaceId = 'zuri-shape-workspace';
    const baseClaims = {
      tenantId: 't', businessId: 'b', channelAccountId: 'oa', externalRoomRef: 'opaque-dm-shape',
      audienceKind: 'DIRECT', principalId: 'person-a', policyRevision: 'route-v1',
      agentId: zuriAgentId, workspaceId: zuriWorkspaceId,
    };

    // msp_thread_resolve -- exact request shape from resolveThread() above.
    const resolved = await call(
      'msp_thread_resolve',
      { actor: 'zuri-line-agent', thread_kind: 'DIRECT', audience_kind: 'DIRECT', channel_type: 'LINE', channel_account_id: 'oa', external_room_ref: 'opaque-dm-shape', tenant_id: 't', business_id: 'b' },
      baseClaims,
    );
    // zuri-ai's own post-condition: `if (!result?.thread?.threadId) throw ...`
    expect(resolved?.thread?.threadId).toEqual(expect.any(String));

    // msp_thread_message_append (INBOUND) -- exact shape from
    // appendMessage()/appendInbound() above.
    const inbound = await call(
      'msp_thread_message_append',
      { thread_id: resolved.thread.threadId, speaker_id: 'person-a', speaker_kind: 'HUMAN', identity_assurance: 'VERIFIED', direction: 'INBOUND', text: 'question-0', idle_timeout_minutes: 30, policy_revision: 'default', person_id: 'person-a', source_event_id: 'in-0' },
      baseClaims,
    );
    // zuri-ai's own post-condition:
    // `if (!result?.message?.messageId || !result?.session?.sessionId) throw ...`
    expect(inbound?.message?.messageId).toEqual(expect.any(String));
    expect(inbound?.session?.sessionId).toEqual(expect.any(String));

    // msp_thread_context -- exact shape from context() above.
    const contextClaims = { ...baseClaims, readPrivate: true };
    const context = await call('msp_thread_context', { thread_id: resolved.thread.threadId, recent_exchange_count: 6 }, contextClaims);
    // zuri-ai's own post-condition: `if (!result?.thread?.threadId) throw ...`
    expect(context?.thread?.threadId).toBe(resolved.thread.threadId);

    // msp_thread_memory_record -- exact shape from recordProtectedMemory()
    // above.
    const recordClaims = { ...baseClaims, writePrivate: true };
    const record = await call(
      'msp_thread_memory_record',
      { thread_id: resolved.thread.threadId, kind: 'CONSTRAINT', asserted_by_speaker_id: 'person-a', subject_person_id: 'person-a', scope: {}, body: { text: 'shape check' }, source_message_refs: [inbound.message.messageId] },
      recordClaims,
    );
    // zuri-ai's own post-condition: `if (!result?.recordId) throw ...`
    expect(record?.recordId).toEqual(expect.any(String));

    // msp_thread_delivery_record -- exact shape from recordDelivery()
    // above (its own claimsFor call is bypassed by route/deliveryWriter,
    // exactly like the real port's own recordDelivery does).
    const deliveryClaims = {
      tenantId: 't', businessId: 'b', channelAccountId: 'oa', externalRoomRef: 'opaque-dm-shape',
      principalId: 'zuri-line-agent', policyRevision: 'line-delivery-v1', deliveryWriter: true,
      agentId: zuriAgentId, workspaceId: zuriWorkspaceId,
    };
    const delivery = await call(
      'msp_thread_delivery_record',
      { inbound_message_id: inbound.message.messageId, source_event_id: `${inbound.message.messageId}:assistant`, receipt_id: 'receipt-shape-0', outcome: 'ACCEPTED', text: 'answer-0' },
      deliveryClaims,
    );
    expect(delivery?.receiptId).toBe('receipt-shape-0');
  }),
);
