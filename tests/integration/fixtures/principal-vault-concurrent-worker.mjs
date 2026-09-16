import { open } from '@freshair129/msp-storage/connection';
import { VaultRegistry } from '@freshair129/msp-core/vault-registry';

const [dbPath, kind, principalId] = process.argv.slice(2);
const db = open(dbPath);
const registry = new VaultRegistry(db);
process.once('message', () => {
  process.send({ state: 'attempting' });
  try {
    const tuple = { tenantId: 'tenant-race', principalId, agentId: 'agent-race', workspaceId: 'workspace-race' };
    const vault = kind === 'private'
      ? registry.provisionPrincipalPrivateVault(tuple)
      : registry.provisionPrincipalPassportVault(tuple);
    process.send({ state: 'result', vaultId: vault.vault_id });
  } catch (error) {
    process.send({ state: 'result', error: { code: error.code, message: error.message } });
    process.exitCode = 1;
  } finally {
    db.close();
    process.disconnect();
  }
});
process.send({ state: 'ready' });
