import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';

const key = 'synthetic-principal-grant-key-32-bytes';
const claims = { tenantId: 'tenant', principalId: 'principal', agentId: 'agent', workspaceId: 'workspace', allowPassport: true };
function signed(name, input, extra = {}) {
  const grant = { ...claims, operation: name, expiresAt: Date.now() + 60_000,
    payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), nonce: randomUUID(), ...extra };
  return { ...input, access: { grant, signature: createHmac('sha256', key).update(JSON.stringify(grant)).digest('hex') } };
}
it('principal memory refusals match unknown targets, replay rolls back all writes, and API-011 shares nonce protection', async () => {
  const server = createServer({ dbPath: ':memory:', env: { MSP_THREAD_SERVICE_KEY: key, MSP_IDENTITY_HMAC_KEY: key } });
  const call = async (name, input) => (await server.toolRegistry.dispatch(name, input)).structuredContent;
  try {
    const resolve = { access_context: { tenant_id: 'tenant', principal_id: 'principal', agent_id: 'agent', workspace_id: 'workspace', project_id: 'project' }, authorization: { allowed: true, allow_passport: true } };
    const vaults = await call('msp_vault_resolve', signed('msp_vault_resolve', resolve));
    const vaultId = vaults.principalPrivateVaultId;
    const upsert = { vault: { vault_id: vaultId }, category: 'note', key: 'first', body_json: { value: 'test' } };
    const first = await call('msp_memory_upsert', signed('msp_memory_upsert', upsert));
    const second = await call('msp_memory_upsert', signed('msp_memory_upsert', { ...upsert, key: 'second' }));
    const entityId = first.entity.entity_id;
    const cases = [
      ['msp_memory_upsert', upsert], ['msp_memory_get', { vault_id: vaultId, category: 'note', key: 'first' }],
      ['msp_memory_list', { vault_id: vaultId }], ['msp_memory_search', { vault_id: vaultId, query: 'test' }],
      ['msp_memory_history', { entity_id: entityId }], ['msp_memory_forget', { entity_id: entityId, reason: 'test' }],
      ['msp_memory_decay_tick', { vault_id: vaultId, dry_run: false }], ['msp_memory_links_list', { entity_id: entityId }],
      ['msp_memory_links_create', { from_entity_id: entityId, to_entity_id: second.entity.entity_id, link_type: 'relates_to' }],
    ];
    for (const [name, input] of cases) {
      const targetId = input.entity_id ?? input.from_entity_id;
      const expectedMessage = targetId ? `No memory entity found for entity_id "${targetId}".` :
        `msp_memory_*: unknown vault_id "${vaultId}". Provision it first via msp_workspace_register / msp_vault_status / msp_memory_promote before referencing it here.`;
      const invalid = signed(name, input); invalid.access.signature = '00';
      for (const request of [input, invalid, signed(name, input, { principalId: 'other' }), signed(name, input, { expiresAt: 1 })]) {
        await expect(call(name, request)).rejects.toMatchObject({ code: 'not_found', message: expectedMessage });
      }
    }
    for (const [name, input] of cases.filter(([name]) => ['msp_memory_upsert', 'msp_memory_forget', 'msp_memory_decay_tick', 'msp_memory_links_create'].includes(name))) {
      const request = signed(name, input);
      await call(name, request);
      const snapshot = JSON.stringify(server.db.prepare('SELECT * FROM entities ORDER BY entity_id').all());
      await expect(call(name, request)).rejects.toMatchObject({ code: 'not_found' });
      expect(JSON.stringify(server.db.prepare('SELECT * FROM entities ORDER BY entity_id').all())).toBe(snapshot);
    }
    // The payload is valid and signed for each operation, but the nonce
    // already belongs to a successful API-011 resolve in this same tenant.
    const threadInput = { tenant_id: 'tenant', business_id: 'business', channel_account_id: 'oa', external_room_ref: 'dm', thread_kind: 'DIRECT', audience_kind: 'DIRECT', channel_type: 'LINE' };
    const nonce = randomUUID();
    await call('msp_thread_resolve', signed('msp_thread_resolve', threadInput, { nonce, businessId: 'business', channelAccountId: 'oa', externalRoomRef: 'dm', policyRevision: 'v1', audienceKind: 'DIRECT', readPrivate: true }));
    await expect(call('msp_memory_upsert', signed('msp_memory_upsert', { ...upsert, key: 'cross-replay' }, { nonce }))).rejects.toMatchObject({ code: 'not_found' });
    expect(server.db.prepare("SELECT * FROM entities WHERE key = 'cross-replay'").get()).toBeUndefined();
    // Passport ownership ignores agent/workspace metadata after subject authorization.
    const passportRead = { vault_id: vaults.principalPassportVaultId };
    await expect(call('msp_memory_list', signed('msp_memory_list', passportRead, { agentId: 'other', workspaceId: 'other' }))).resolves.toMatchObject({ entities: [] });
  } finally { server.close(); }
});
