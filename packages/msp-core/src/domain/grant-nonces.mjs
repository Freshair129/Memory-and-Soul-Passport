import { GrantReplayedError, ThreadValidationError } from "./errors.mjs";

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Record one grant nonce inside the caller's already-open write transaction.
 * Migration 0013 gives tenantless global writes a NULL partition with its
 * own uniqueness index in the same table as API-011 and principal writes.
 */
export function consumeGrantNonce(db, { tenantId, nonce, expiresAt }) {
  if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 128) {
    throw new ThreadValidationError("nonce must be a string of 1 to 128 characters.");
  }
  if (!Number.isInteger(expiresAt) || Math.abs(expiresAt - Date.now()) > TEN_YEARS_MS) {
    throw new ThreadValidationError("grantExpiresAt must be a finite integer (epoch milliseconds) within 10 years of the server clock.");
  }
  const now = new Date().toISOString();
  db.prepare("DELETE FROM grant_nonces WHERE rowid IN (SELECT rowid FROM grant_nonces WHERE expires_at < ? LIMIT 200)").run(now);
  try {
    db.prepare("INSERT INTO grant_nonces (tenant_id, nonce, expires_at) VALUES (?, ?, ?)").run(tenantId, nonce, new Date(expiresAt).toISOString());
  } catch (error) {
    if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error?.code === "SQLITE_CONSTRAINT_UNIQUE" || String(error?.message).includes("UNIQUE")) {
      throw new GrantReplayedError(tenantId === null ? "This global-private grant's nonce has already been used." : undefined);
    }
    throw error;
  }
}
