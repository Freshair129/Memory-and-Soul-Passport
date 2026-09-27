// BL-MEMOS-105: exercise the consumer's actual resolver and response validator.
// MSP_TEST_ZURI_ROOT must point at a source checkout or an immutable Git extract;
// report the tested consumer revision separately from MSP's local evidence.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';

it.each(['read', 'write'])(
  'the unmodified zuri-ai vault resolver is refused for legacy %s until it signs legacy_access',
  async (operation) => {
    if (!process.env.MSP_TEST_ZURI_ROOT) throw new Error('MSP_TEST_ZURI_ROOT is required for test:cross-zuri');
    const modulePath = resolve(process.env.MSP_TEST_ZURI_ROOT, 'apps/server/src/modules/agent/msp-vault-resolver.js');
    const { createMspVaultResolver } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    const tempRoot = mkdtempSync(join(tmpdir(), 'msp-zuri-vault-contract-'));
    let server;
    try {
      server = createServer({ dbPath: join(tempRoot, 'test.sqlite'), env: {} });
      const calls = [];
      const resolver = createMspVaultResolver({
        transport: async (name, args) => {
          calls.push({ name, args });
          return server.toolRegistry.dispatch(name, args);
        },
      });
      const scope = {
        tenantId: 'synthetic-tenant', principalId: 'synthetic-principal',
        agentId: 'synthetic-agent', workspaceId: 'synthetic-workspace', projectId: 'synthetic-project',
      };
      const authorization = {
        authContext: {
          scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId },
          actor: { principalId: scope.principalId },
          request: { agentId: scope.agentId },
          policy: {
            decision: 'ALLOW', privateMemoryAllowed: true, version: 'synthetic-policy-v1',
            mspAuthorization: { allowGlobalPrivate: true, allowShared: true, writePrivate: true },
          },
        },
        authorizedVaults: [{ scope: 'private', ...scope }],
      };
      await expect(resolver.resolve(authorization, { operation })).rejects.toMatchObject({ code: 'grant_required' });
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('msp_vault_resolve');
      expect(calls[0].args).not.toHaveProperty('access');
      expect(calls[0].args).not.toHaveProperty('legacy_access');
      expect(server.db.prepare('SELECT COUNT(*) AS count FROM vaults').get().count).toBe(0);
      expect(server.db.prepare('SELECT COUNT(*) AS count FROM journal').get().count).toBe(0);
      expect(server.db.prepare("SELECT COUNT(*) AS count FROM vaults WHERE vault_type IN ('principal_private', 'principal_passport')").get().count).toBe(0);
    } finally {
      server?.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
