import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { open } from '@freshair129/msp-storage/connection';
import { runMigrations } from '@freshair129/msp-storage/migrate';
import { VaultRegistry, PROVISION_ID_MINT_RETRY_LIMIT } from '@freshair129/msp-core/vault-registry';
import { mintVaultId } from '../../packages/msp-core/src/domain/ids.mjs';

vi.mock('../../packages/msp-core/src/domain/ids.mjs', async (original) => {
  const actual = await original();
  return { ...actual, mintVaultId: vi.fn(actual.mintVaultId) };
});

const migrations = fileURLToPath(new URL('../../migrations', import.meta.url));
const worker = fileURLToPath(new URL('./fixtures/principal-vault-concurrent-worker.mjs', import.meta.url));
const cleanups = [];
afterEach(() => {
  vi.mocked(mintVaultId).mockReset();
  while (cleanups.length) cleanups.pop()();
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'msp-principal-race-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'msp.db');
  const db = open(dbPath);
  cleanups.push(() => db.close());
  runMigrations(db, migrations);
  return { db, dbPath, registry: new VaultRegistry(db) };
}

function contender(dbPath, kind, principalId) {
  const child = fork(worker, [dbPath, kind, principalId], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let result;
  let stderr = '';
  let readyResolve;
  let attemptingResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const attempting = new Promise((resolve) => { attemptingResolve = resolve; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => {
    if (message.state === 'ready') readyResolve();
    if (message.state === 'attempting') attemptingResolve();
    if (message.state === 'result') result = message;
  });
  const done = new Promise((resolve) => {
    child.on('error', (error) => { result = { error: { message: error.message } }; });
    child.on('close', (code) => { readyResolve(); attemptingResolve(); resolve({ code, result, stderr }); });
  });
  return { child, ready, attempting, done };
}

it.each(['private', 'passport'])('two real processes concurrently provision one %s vault without a loser error', async (kind) => {
  const { db, dbPath } = database();
  for (let round = 0; round < 3; round++) {
    const principalId = `principal-${round}`;
    const workers = [contender(dbPath, kind, principalId), contender(dbPath, kind, principalId)];
    const timer = setTimeout(() => workers.forEach(({ child }) => child.kill()), 10_000);
    try {
      await Promise.all(workers.map(({ ready }) => ready));
      // Hold the writer lock until both separate connections attempt entry.
      // A deferred read-then-write transaction would now lose with BUSY_SNAPSHOT.
      db.exec('BEGIN IMMEDIATE');
      workers.forEach(({ child }) => { if (child.connected) child.send('go'); });
      await Promise.all(workers.map(({ attempting }) => attempting));
      db.exec('COMMIT');
      const outcomes = await Promise.all(workers.map(({ done }) => done));
      for (const outcome of outcomes) {
        expect(outcome.code, JSON.stringify(outcome)).toBe(0);
        expect(outcome.result.error).toBeUndefined();
        expect(outcome.result.vaultId).toMatch(/^vault_[0-9a-f-]{36}$/);
      }
      expect(outcomes[0].result.vaultId).toBe(outcomes[1].result.vaultId);
      expect(db.prepare('SELECT COUNT(*) AS n FROM vaults WHERE principal_id = ?').get(principalId).n).toBe(1);
    } finally {
      clearTimeout(timer);
      if (db.inTransaction) db.exec('ROLLBACK');
      workers.forEach(({ child }) => { if (child.exitCode === null) child.kill(); });
      await Promise.all(workers.map(({ done }) => done));
    }
  }
});

it('a forced UUID primary-key collision re-mints without returning the other principal vault', () => {
  const { db, registry } = database();
  vi.mocked(mintVaultId).mockReturnValueOnce('vault_collision').mockReturnValueOnce('vault_collision').mockReturnValueOnce('vault_fresh');
  const first = registry.provisionPrincipalPassportVault({ tenantId: 'tenant', principalId: 'first' });
  const second = registry.provisionPrincipalPassportVault({ tenantId: 'tenant', principalId: 'second' });
  expect(first.vault_id).toBe('vault_collision');
  expect(second.vault_id).toBe('vault_fresh');
  expect(db.prepare('SELECT COUNT(*) AS n FROM vaults').get().n).toBe(2);
  expect(mintVaultId).toHaveBeenCalledTimes(3);
});

it('repeated UUID collisions exhaust the five retries with a typed refusal and no extra row', () => {
  const { db, registry } = database();
  vi.mocked(mintVaultId).mockReturnValue('vault_collision');
  registry.provisionPrincipalPassportVault({ tenantId: 'tenant', principalId: 'first' });
  vi.mocked(mintVaultId).mockClear();
  expect(() => registry.provisionPrincipalPassportVault({ tenantId: 'tenant', principalId: 'second' }))
    .toThrow(expect.objectContaining({ code: 'vault_provision_conflict' }));
  expect(mintVaultId).toHaveBeenCalledTimes(1 + PROVISION_ID_MINT_RETRY_LIMIT);
  expect(db.prepare('SELECT COUNT(*) AS n FROM vaults').get().n).toBe(1);
});
