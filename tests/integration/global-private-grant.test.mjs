import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';

const key = 'synthetic-global-service-key-32-bytes';
function signed(name, input, overrides = {}) {
  const grant = { operation: name, agentId: 'owner', expiresAt: Date.now() + 60_000,
    payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), nonce: randomUUID(), ...overrides };
  return { ...input, access: { grant, signature: createHmac('sha256', key).update(JSON.stringify(grant)).digest('hex') } };
}

it.each([false, true])('global gate=%s protects all nine memory tools, promotion and status; metadata cannot change nonce partition', async (required) => {
  const server = createServer({ dbPath: ':memory:', env: { MSP_THREAD_SERVICE_KEY: key, MSP_GLOBAL_PRIVATE_GRANT_REQUIRED: required ? '1' : '0' } });
  const call = async (name, input) => (await server.toolRegistry.dispatch(name, input)).structuredContent;
  try {
    const statusInput = { actor: 'test', agent_id: 'owner' };
    const unsigned = await call('msp_vault_status', statusInput);
    expect(unsigned.vaults.length).toBe(required ? 0 : 1);
    expect(server.db.prepare("SELECT COUNT(*) AS n FROM vaults WHERE vault_type = 'global_private'").get().n).toBe(required ? 0 : 1);
    const status = await call('msp_vault_status', signed('msp_vault_status', statusInput));
    const vaultId = status.vaults[0].vault_id;
    const upsert = { vault: { vault_id: vaultId }, category: 'note', key: 'with spaces', body_json: { value: 'test' } };
    const request = signed('msp_memory_upsert', upsert, { tenantId: 'ignored-tenant' });
    const first = await call('msp_memory_upsert', request);
    expect(server.db.prepare('SELECT tenant_id FROM grant_nonces WHERE nonce = ?').get(request.access.grant.nonce).tenant_id).toBeNull();
    await expect(call('msp_memory_upsert', request)).rejects.toMatchObject({ code: 'grant_replayed' });
    const second = await call('msp_memory_upsert', signed('msp_memory_upsert', { ...upsert, key: 'second' }));
    const entityId = first.entity.entity_id;
    const promotion = { actor: 'test', agent_id: 'owner', workspace_id: 'workspace', source_memory_ref: 'msp:memory/source', target_scope: 'global_private', idempotency_key: 'promotion', reason: 'test', evidence_refs: ['msp:proof/test'], candidate: { text: 'test' } };
    const cases = [
      ['msp_memory_upsert', upsert], ['msp_memory_get', { vault_id: vaultId, category: 'note', key: 'with spaces' }],
      ['msp_memory_list', { vault_id: vaultId }], ['msp_memory_search', { vault_id: vaultId, query: 'test' }],
      ['msp_memory_history', { entity_id: entityId }], ['msp_memory_forget', { entity_id: entityId, reason: 'test' }],
      ['msp_memory_decay_tick', { vault_id: vaultId, dry_run: true }], ['msp_memory_links_list', { entity_id: entityId }],
      ['msp_memory_links_create', { from_entity_id: entityId, to_entity_id: second.entity.entity_id, link_type: 'relates_to' }],
      ['msp_memory_promote', promotion], ['msp_vault_status', statusInput],
    ];
    for (const [name, input] of cases) {
      await expect(call(name, signed(name, input, { agentId: 'wrong-agent' }))).rejects.toMatchObject({ code: 'vault_scope_denied' });
      const invalid = signed(name, input); invalid.access.signature = '00';
      await expect(call(name, invalid)).rejects.toMatchObject({ code: 'vault_scope_denied' });
      if (required && name !== 'msp_vault_status') await expect(call(name, input)).rejects.toMatchObject({ code: 'vault_scope_denied' });
    }
    await expect(call('msp_memory_promote', signed('msp_memory_promote', promotion))).resolves.toMatchObject({ policy_decision: 'allow' });
    const shared = { ...promotion, target_scope: 'shared' };
    await expect(call('msp_memory_promote', signed('msp_memory_promote', shared))).rejects.toMatchObject({ code: 'gks_provider_unconfigured' });
    for (const category of ['two words', ' padded', 'padded ']) {
      const input = { ...upsert, category };
      await expect(call('msp_memory_upsert', signed('msp_memory_upsert', input))).rejects.toMatchObject({ code: 'validation_failed', message: 'category must not contain spaces.' });
    }
    // Read grants consume no nonce; a literal retry still succeeds.
    const read = signed('msp_memory_list', { vault_id: vaultId });
    await call('msp_memory_list', read); await call('msp_memory_list', read);
    expect(server.db.prepare('SELECT * FROM grant_nonces WHERE nonce = ?').get(read.access.grant.nonce)).toBeUndefined();
  } finally { server.close(); }
});
