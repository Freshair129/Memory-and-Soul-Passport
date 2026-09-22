// contracts/errors: typed error classes for the contracts/ layer. Per
// WP-13's dependency-boundary rule (Bounded Scope item 7), contracts/ may
// import domain/ids.mjs and domain/errors.mjs ONLY -- never
// domain/entity-store.mjs or domain/vault-registry.mjs directly. This file
// re-exports domain/errors.mjs's existing vocabulary unchanged and adds the
// error shapes this packet's contract-shaping/validation logic needs that
// WP-12 had no occasion to define yet.
export {
  AgentNotCurrentError,
  CompactionLeaseConflictError,
  GrantNonceRequiredError,
  GrantReplayedError,
  IdentityHmacUnconfiguredError,
  MemoryConflictError,
  MemoryNotFoundError,
  MspRuntimeError,
  PrincipalErasedError,
  RecordSubjectMismatchError,
  SchemaVersionError,
  ThreadAudienceMismatchError,
  ThreadConflictError,
  ThreadNotFoundError,
  ThreadPayloadTooLargeError,
  ThreadValidationError,
  // PH-MEMOS-5 (design §5.2/§5.3): raised by domain/vault-registry.mjs's
  // #provisionPrincipalVault, re-exported here (not defined here) since it
  // is a domain-layer error -- msp-vault-resolve-handler.mjs and
  // memory-handlers.mjs import it from this package the same way every
  // other domain error class already re-exported above is imported.
  VaultProvisionConflictError,
} from "@freshair129/msp-core/errors";

import { MspRuntimeError } from "@freshair129/msp-core/errors";

/** A request failed contracts/'s own shape validation before reaching domain/. */
export class ValidationError extends MspRuntimeError {
  constructor(message, code = "invalid_request") {
    super(message, code);
  }
}

/**
 * A candidate or ref tried to assign or reference gks:-namespaced canonical
 * identity. Raised by contracts/namespace-guard.mjs's rejectCanonicalCandidate
 * / requireNoGksRefs -- defense in depth, independent of the GoVibe-side
 * rejectCanonicalCandidate guard in scripts/mcp/msp-vault-context-contracts.mjs
 * (WP-13 AC-06).
 */
export class NamespaceViolationError extends MspRuntimeError {
  constructor(message = "Candidate must not assign or reference a canonical GKS identity.") {
    super(message, "provider_canonical_identity_forbidden");
  }
}

/**
 * Fail-closed reason for an absent GKS provider and for
 * msp_memory_promote(target_scope=shared), whose shared-memory path remains
 * outside the configured GKS provider boundary (ADR-027). Never caught and
 * converted into a fabricated success envelope anywhere in this packet
 * (WP-13 AC-03).
 */
export class GksProviderUnconfiguredError extends MspRuntimeError {
  constructor(message = "No GKS provider is configured; shared-scope promotion is fail-closed.") {
    super(message, "gks_provider_unconfigured");
  }
}

export class GksProviderUnavailableError extends MspRuntimeError {
  constructor(message = "gks_provider_unavailable: GKS provider could not be reached.") {
    super(message, "gks_provider_unavailable");
  }
}

export class GksProviderInvalidResponseError extends MspRuntimeError {
  constructor(message = "gks_provider_invalid_response: GKS provider returned an invalid promotion result.") {
    super(message, "gks_provider_invalid_response");
  }
}

/**
 * WP-14 AC-04: the caller's vault_id is not mounted/owned for them. The
 * `.code` and the literal string "vault_scope_denied" in the message both
 * matter -- transport/stdio-jsonrpc-server.mjs's tool-call error envelope
 * only carries the error's .message text on the wire (structuredContent.code
 * there is a fixed JSON-RPC -32601, not this domain code), so every test
 * asserting this rejection (mirroring how gks_provider_unconfigured is
 * already asserted elsewhere in this packet) matches on the message text.
 * Documented in docs/api/API-009-Persistent-Memory-Contract.md §5.
 */
export class VaultScopeDeniedError extends MspRuntimeError {
  constructor(message = "vault_scope_denied: caller's mounted vault does not include the requested vault_id.") {
    super(message, "vault_scope_denied");
  }
}

/**
 * PH-MEMOS-5 (design §5.1, DEC-MEMOS-49): the target vault is
 * principal_private/principal_passport and the request carries no
 * access_context at all. Produced exclusively by
 * contracts/vault-scope-guard.mjs's new assertAccessContext(), never by
 * assertVaultScope -- that function's own signature and meaning are
 * unchanged by this amendment. Same wire-envelope reasoning as
 * VaultScopeDeniedError above: only `.message` crosses the JSON-RPC error
 * envelope, so the literal code string lives in the default message too.
 */
export class AccessContextRequiredError extends MspRuntimeError {
  constructor(message = "access_context_required: this vault requires a matching access_context, and none was sent.") {
    super(message, "access_context_required");
  }
}

/**
 * PH-MEMOS-5 (design §5.1, §5.2, DEC-MEMOS-49): access_context was present
 * but did not match the target vault's own owner tuple -- a tuple
 * mismatch, an erased vault (§12.4 blanks only principal_id on erasure,
 * never tenant_id/agent_id/workspace_id, so #isVaultRowAccessibleTo's own
 * status gate is what refuses this case), or a principal_passport target
 * missing allow_passport: true are all this SAME code, deliberately -- no
 * new oracle a caller could use to distinguish them (mirrors the existing
 * "no new oracle" reasoning this codebase already applies to the passport
 * tuple-vs-allow_passport case).
 */
export class AccessContextDeniedError extends MspRuntimeError {
  constructor(message = "access_context_denied: access_context does not match the target vault's owner tuple.") {
    super(message, "access_context_denied");
  }
}

/**
 * API-011 thread memory (TASK-MEMOS-002), C-2: the thread/session/job/
 * participant grant does not authorize this operation. Mirrors
 * VaultScopeDeniedError exactly -- same reasoning about the wire error
 * envelope carrying only `.message`, so every test asserting this rejection
 * matches on the message text, which is why the literal string
 * "thread_scope_denied" is baked into the default message here too. Raised
 * by contracts/thread-access.mjs's assertThreadScope, never caught and
 * turned into a fabricated success envelope anywhere in this packet.
 */
export class ThreadScopeDeniedError extends MspRuntimeError {
  constructor(message = "thread_scope_denied: the grant does not authorize this thread operation.") {
    super(message, "thread_scope_denied");
  }
}

// RKOI review (post-implementation, items 9-10): thread-access.mjs's
// verifyThreadGrant now resolves its HMAC key through an injected
// `keyFor(tenantId)` (stage 2 will add a real per-tenant keyring without
// rewriting the guard). These four codes replace the generic
// thread_scope_denied specifically for grant-verification failures, so a
// caller can tell "nobody signed a key for this tenant" from "this grant
// does not authorize this scope":
//   - no key resolves for the grant's claimed tenant;
//   - the grant is missing, malformed, or names a different operation than
//     the one it was sent with, or the HMAC signature itself does not match;
//   - the grant's expiry window has passed or is implausible;
//   - the grant's payloadHash does not match this exact request body.
export class GrantUnconfiguredError extends MspRuntimeError {
  constructor(message = "No thread service key is configured for this grant's tenant.") {
    super(`grant_unconfigured: ${message}`, "grant_unconfigured");
  }
}

export class GrantSignatureInvalidError extends MspRuntimeError {
  constructor(message = "The grant is missing, malformed, or its signature does not match.") {
    super(`grant_signature_invalid: ${message}`, "grant_signature_invalid");
  }
}

export class GrantExpiredError extends MspRuntimeError {
  constructor(message = "The grant has expired or carries an implausible lifetime.") {
    super(`grant_expired: ${message}`, "grant_expired");
  }
}

export class GrantPayloadMismatchError extends MspRuntimeError {
  constructor(message = "The grant was not issued for this exact request body.") {
    super(`grant_payload_mismatch: ${message}`, "grant_payload_mismatch");
  }
}
