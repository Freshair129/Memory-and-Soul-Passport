import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { open } from '@freshair129/msp-storage/connection';
import { consumeGrantNonce } from '@freshair129/msp-core/grant-nonces';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
it('0013 preserves populated tenant nonces, isolates NULL, and enforces replay atomically with bounded pruning', () => {
  const db = open(':memory:');
  try {
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 12).sort()) {
      db.exec(readFileSync(`${migrations}/${name}`, 'utf8'));
    }
    const expiry = new Date(Date.now() + 60_000).toISOString();
    db.prepare('INSERT INTO grant_nonces VALUES (?, ?, ?)').run('tenant-A', 'same', expiry);
    db.transaction(() => db.exec(readFileSync(`${migrations}/0013_grant_nonce_global_scope.sql`, 'utf8')))();
    expect(db.prepare('SELECT * FROM grant_nonces').all()).toEqual([{ tenant_id: 'tenant-A', nonce: 'same', expires_at: expiry }]);
    const consume = (tenantId, nonce) => consumeGrantNonce(db, { tenantId, nonce, expiresAt: Date.now() + 60_000 });
    db.transaction(() => { consume(null, 'same'); consume('tenant-B', 'same'); })();
    for (const tenant of [null, 'tenant-A', 'tenant-B']) {
      expect(() => db.transaction(() => consume(tenant, 'same'))()).toThrow(expect.objectContaining({ code: 'grant_replayed' }));
    }
    expect(() => db.transaction(() => { consume(null, 'rollback'); throw new Error('forced mutation failure'); })()).toThrow('forced mutation failure');
    expect(db.prepare("SELECT * FROM grant_nonces WHERE nonce = 'rollback'").get()).toBeUndefined();
    db.transaction(() => consume(null, 'rollback'))();
    const insert = db.prepare('INSERT INTO grant_nonces VALUES (?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < 205; i++) insert.run('expired', `nonce-${i}`, '2000-01-01T00:00:00.000Z'); })();
    db.transaction(() => consume(null, 'prune'))();
    expect(db.prepare("SELECT COUNT(*) AS n FROM grant_nonces WHERE tenant_id = 'expired'").get().n).toBe(5);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close(); }
});
