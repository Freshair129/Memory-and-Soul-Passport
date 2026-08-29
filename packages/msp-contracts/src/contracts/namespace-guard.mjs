// contracts/namespace-guard: server-side re-check of the exact
// gks:-namespace rule scripts/mcp/msp-vault-context-contracts.mjs's
// rejectCanonicalCandidate already enforces client-side, plus a small
// helper reused by both promotion handlers (WP-13 Bounded Scope item 3 /
// AC-06). This is defense in depth, not trust in the caller: GoVibe's own
// client already runs this check before the request ever reaches this
// process, but a future or misbehaving caller that skips it must still be
// rejected here.
import { NamespaceViolationError } from "./errors.mjs";

const CANONICAL_KEY_PATTERN = /^(canonical_?id|gks_?id|target_?ref)$/i;

/**
 * Mirrors scripts/mcp/msp-vault-context-contracts.mjs's rejectCanonicalCandidate
 * exactly: a candidate object must not have a key matching
 * /^(canonical_?id|gks_?id|target_?ref)$/i, nor any string value starting
 * with "gks:" (case-insensitive).
 */
export function rejectCanonicalCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new NamespaceViolationError("candidate must be an object.");
  }
  for (const [key, value] of Object.entries(candidate)) {
    const canonicalKey = CANONICAL_KEY_PATTERN.test(key);
    const canonicalValue = typeof value === "string" && value.toLowerCase().startsWith("gks:");
    if (canonicalKey || canonicalValue) {
      throw new NamespaceViolationError("Provider candidate must not assign a canonical GKS identity.");
    }
  }
  return candidate;
}

/**
 * Rejects any gks:-prefixed string found in a list of refs (e.g.
 * evidence_refs, source_memory_ref). Reused by both
 * transport/handlers/lifecycle-handlers.mjs promotion handlers
 * (msp_memory_promote, and defensively by msp_knowledge_promote before its
 * fail-closed throw) so a caller cannot smuggle a fabricated gks: reference
 * through as "evidence" for a promotion this runtime has no authority to
 * grant.
 */
export function requireNoGksRefs(refs, label) {
  for (const ref of refs ?? []) {
    if (typeof ref === "string" && ref.toLowerCase().startsWith("gks:")) {
      throw new NamespaceViolationError(`${label} must not contain a gks:-namespaced reference.`);
    }
  }
  return refs;
}
