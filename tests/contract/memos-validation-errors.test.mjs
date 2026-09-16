import { expect, it } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';

it('MEMOS-008 rejects malformed resolve and mount control characters with the specified validation_failed code', async () => {
  const server = createServer({ dbPath: ':memory:', env: {} });
  try {
    for (const field of ['workspace_id', 'mount_alias']) {
      for (const character of ['\u0000', '\u0001', '\u001f']) {
        const input = { actor: 'test', workspace_id: 'workspace', workspace_path: 'C:/synthetic', vault_id: 'unknown', mount_alias: 'alias', reason: 'test', [field]: `bad${character}segment` };
        await expect(server.toolRegistry.dispatch('msp_vault_mount', input)).rejects.toMatchObject({ code: 'validation_failed', message: `${field} must not contain control characters.` });
      }
    }
    await expect(server.toolRegistry.dispatch('msp_vault_resolve', {})).rejects.toMatchObject({ code: 'validation_failed' });
    expect(server.db.prepare('SELECT COUNT(*) AS n FROM vaults').get().n).toBe(0);
  } finally { server.close(); }
});
