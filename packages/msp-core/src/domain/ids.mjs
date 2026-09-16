// Stable sha256-based id/ref minting.
//
// stableId deliberately matches packages/govibe-core/src/vaults.mjs's
// stableId(prefix, ...parts) scheme exactly: same hash input ordering
// (parts joined with a NUL byte separator), same digest algorithm (sha256),
// same truncation (first 24 hex chars). This means ids minted here agree
// with vault-registry ids if/when vault-registry is added in a later phase.
import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function stableId(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

export function mintRef(prefix, id) {
  return `msp:${prefix}/${id}`;
}

/**
 * Mint an opaque principal-vault id. Principal ownership is stored in the
 * vault row and must never be recoverable from the id itself.
 */
export function mintVaultId() {
  return `vault_${randomUUID()}`;
}
