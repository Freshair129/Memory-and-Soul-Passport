import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../apps/msp-server/src/server.mjs';
import { signThreadRequest } from '../../packages/msp-contracts/src/contracts/thread-access.mjs';

test('API-010 authenticates scope and denies forged, expired, cross-person and group private reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'msp-thread-access-'));
  const key = 'synthetic-service-secret-over-32-bytes';
  const server = createServer({ dbPath: join(root, 'test.sqlite'), env: { MSP_THREAD_SERVICE_KEY: key } });
  try {
    const claims = { tenantId: 'tenant-a', businessId: 'business-a', channelAccountId: 'oa', externalRoomRef: 'dm-a',
      principalId: 'alice', policyRevision: 'v1', audienceKind: 'DIRECT', readPrivate: true, writePrivate: true };
    const call = (name, input, scope = claims) => server.toolRegistry.dispatch(name, signThreadRequest(name, input, scope, key));
    const resolve = { tenant_id: 'tenant-a', business_id: 'business-a', channel_account_id: 'oa', external_room_ref: 'dm-a', thread_kind: 'DIRECT', audience_kind: 'DIRECT', channel_type: 'LINE' };
    await assert.rejects(server.toolRegistry.dispatch('msp_thread_resolve', resolve), /ACCESS_DENIED/);
    const thread = (await call('msp_thread_resolve', resolve)).structuredContent.thread;
    const inbound = { thread_id: thread.threadId, speaker_id: 'alice', speaker_kind: 'HUMAN', identity_assurance: 'VERIFIED', person_id: 'alice', direction: 'INBOUND', text: 'Do not disclose cost', source_event_id: 'a1' };
    const message = (await call('msp_thread_message_append', inbound)).structuredContent.message;
    const read = { thread_id: thread.threadId };
    await call('msp_thread_context', read);
    for (const change of [{tenantId:'other'}, {businessId:'other'}, {externalRoomRef:'other'}, {principalId:'bob'}, {readPrivate:false}, {audienceKind:'GROUP'}]) {
      await assert.rejects(call('msp_thread_context', read, { ...claims, ...change }), /ACCESS_DENIED/);
    }
    const expired = signThreadRequest('msp_thread_context', read, claims, key, Date.now() - 120000);
    await assert.rejects(server.toolRegistry.dispatch('msp_thread_context', expired), /ACCESS_DENIED/);
    const tampered = signThreadRequest('msp_thread_context', read, claims, key);
    tampered.access.grant.tenantId = 'other';
    await assert.rejects(server.toolRegistry.dispatch('msp_thread_context', tampered), /ACCESS_DENIED/);
    const record = { thread_id: thread.threadId, asserted_by_speaker_id: 'alice', subject_person_id: 'alice', kind:'CONSTRAINT', body:{text:'no cost'}, source_message_refs:[message.messageId] };
    const stored = (await call('msp_thread_memory_record', record)).structuredContent;
    assert.equal((await call('msp_thread_memory_record', record)).structuredContent.recordId, stored.recordId);
    const bob = (await call('msp_thread_message_append', {...inbound, speaker_id:'bob', person_id:'bob', source_event_id:'b1'}, {...claims,principalId:'bob'})).structuredContent.message;
    await assert.rejects(call('msp_thread_memory_record', {...record,asserted_by_speaker_id:'bob'}, {...claims,principalId:'bob'}), /Source author/);
    await assert.rejects(call('msp_thread_memory_record', {...record,asserted_by_speaker_id:'bob',source_message_refs:[bob.messageId],supersedes_record_id:stored.recordId}, {...claims,principalId:'bob'}), /same speaker/);
    const group = (await call('msp_thread_resolve', {...resolve,external_room_ref:'group',thread_kind:'GROUP',audience_kind:'GROUP'}, {...claims,externalRoomRef:'group',audienceKind:'GROUP'})).structuredContent.thread;
    await assert.rejects(call('msp_thread_context', {thread_id:group.threadId}, {...claims,externalRoomRef:'group',audienceKind:'GROUP'}), /ACCESS_DENIED/);
  } finally { server.close(); rmSync(root, {recursive:true,force:true}); }
});
