// BL-MEMOS-105: exercise the consumer's actual API-010 signer and validator.
// MSP_TEST_ZURI_ROOT must point at an explicit checkout or immutable Git extract;
// report that consumer revision separately from MSP's local evidence.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createServer } from '../../apps/msp-server/src/server.mjs';

const SERVICE_KEY = 'synthetic-test-service-key-32-bytes-only';

async function withConsumer(run) {
  if (!process.env.MSP_TEST_ZURI_ROOT) throw new Error('MSP_TEST_ZURI_ROOT is required for test:cross-zuri');
  const modulePath = resolve(process.env.MSP_TEST_ZURI_ROOT, 'apps/server/src/modules/agent/msp-vault-resolver.js');
  const { createMspVaultResolver } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
  const server = createServer({ dbPath: ':memory:', env: { MSP_THREAD_SERVICE_KEY: SERVICE_KEY, MSP_VECTOR_ENABLED: '0' } });
  const calls = [];
  const transport = (name, args) => {
    calls.push({ name, args });
    return server.toolRegistry.dispatch(name, args);
  };
  try {
    await run({ server, calls, transport, createMspVaultResolver });
  } finally {
    server.close();
  }
}

function authorization({ writePrivate = false } = {}) {
  const scope = {
    tenantId: 'synthetic-tenant', principalId: 'synthetic-principal',
    agentId: 'synthetic-agent', workspaceId: 'synthetic-workspace', projectId: 'synthetic-project',
  };
  return {
    authContext: {
      transport: { signatureVerified: true },
      actor: { principalId: scope.principalId, identityVerified: true },
      scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId },
      request: { agentId: scope.agentId },
      conversation: { threadId: 'synthetic-thread' },
      policy: {
        decision: 'ALLOW', episodicMemoryAllowed: true, version: 'synthetic-policy-v1',
        ...(writePrivate ? { mspAuthorization: { writePrivate: true } } : {}),
      },
    },
    authorizedVaults: [{ scope: 'private', ...scope }],
  };
}

function counts(server) {
  return {
    vaults: server.db.prepare('SELECT COUNT(*) AS count FROM vaults').get().count,
    journal: server.db.prepare('SELECT COUNT(*) AS count FROM journal').get().count,
  };
}

it.each(['read', 'write'])(
  'the signed zuri-ai API-010 %s request is accepted by MSP v0.3.0b',
  async (operation) => withConsumer(async ({ server, calls, transport, createMspVaultResolver }) => {
    const resolver = createMspVaultResolver({ transport, serviceKey: SERVICE_KEY });
    const vaultSet = await resolver.resolve(authorization({ writePrivate: operation === 'write' }), { operation });
    expect(vaultSet.workspacePrivateVaultId).toEqual(expect.any(String));
    expect(vaultSet.permissions.read).toBe(true);
    expect(vaultSet.permissions.writePrivate).toBe(operation === 'write');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('msp_vault_resolve');
    expect(calls[0].args.legacy_access).toMatchObject({
      grant: { operation: 'msp_vault_resolve_legacy', tenantId: 'synthetic-tenant' },
      signature: expect.any(String),
    });
    expect(counts(server).journal).toBe(1);
    expect(server.db.prepare("SELECT COUNT(*) AS count FROM vaults WHERE vault_type IN ('principal_private', 'principal_passport')").get().count).toBe(0);
  }),
);

it.each(['read', 'write'])(
  'the zuri-ai API-010 %s caller refuses denied episodic policy before transport',
  async (operation) => withConsumer(async ({ server, calls, transport, createMspVaultResolver }) => {
    const resolver = createMspVaultResolver({ transport, serviceKey: SERVICE_KEY });
    const denied = authorization({ writePrivate: operation === 'write' });
    denied.authContext.policy.episodicMemoryAllowed = false;
    await expect(resolver.resolve(denied, { operation })).rejects.toThrow(/episodic-memory ALLOW AuthContext/);
    expect(calls).toHaveLength(0);
    expect(counts(server)).toEqual({ vaults: 0, journal: 0 });
  }),
);

it('MSP refuses a wrong zuri-ai service key without vault or journal writes', async () =>
  withConsumer(async ({ server, calls, transport, createMspVaultResolver }) => {
    const resolver = createMspVaultResolver({ transport, serviceKey: 'different-synthetic-service-key-32-bytes' });
    await expect(resolver.resolve(authorization())).rejects.toMatchObject({ code: 'grant_signature_invalid' });
    expect(calls).toHaveLength(1);
    expect(counts(server)).toEqual({ vaults: 0, journal: 0 });
  }));

it('the zuri-ai caller rejects a signed response without private write permission', async () =>
  withConsumer(async ({ server, calls, transport, createMspVaultResolver }) => {
    const resolver = createMspVaultResolver({ transport, serviceKey: SERVICE_KEY });
    await expect(resolver.resolve(authorization(), { operation: 'write' })).rejects.toThrow(/denied private write permission/);
    expect(calls.map((call) => call.name)).toEqual(['msp_vault_resolve']);
    expect(counts(server).journal).toBe(1);
  }));
