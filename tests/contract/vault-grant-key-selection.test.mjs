import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyVaultGrant } from '@freshair129/msp-contracts/vault-grant-guard';

const defaultKey = 'default-key-'.repeat(4), tenantKey = 'tenant-key-'.repeat(4);
const name = 'msp_vault_status', input = { actor: 'test', agent_id: 'agent' }, now = 100_000;
function envelope(key, extras = {}) {
  const grant = { operation: name, agentId: 'agent', expiresAt: now + 60_000,
    payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), ...extras };
  return { grant, signature: createHmac('sha256', key).update(JSON.stringify(grant)).digest('hex') };
}
const keyFor = (tenant) => tenant === 'tenant-A' ? tenantKey : defaultKey;
it('a global grant cannot select a tenant key by adding irrelevant tenant metadata', () => {
  expect(() => verifyVaultGrant(name, input, envelope(tenantKey, { tenantId: 'tenant-A' }), keyFor, { vaultType: 'global_private', now }))
    .toThrow(expect.objectContaining({ code: 'grant_signature_invalid' }));
});
it('global grants ignore non-authorizing tuple and passport metadata while retaining signature binding', () => {
  const access = envelope(defaultKey, { tenantId: 'tenant-A', principalId: 9, workspaceId: {}, allowPassport: 'irrelevant' });
  expect(verifyVaultGrant(name, input, access, keyFor, { vaultType: 'global_private', now })).toEqual(access.grant);
  access.grant.agentId = 'changed';
  expect(() => verifyVaultGrant(name, input, access, keyFor, { vaultType: 'global_private', now })).toThrow();
});
