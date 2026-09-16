// transport/handlers/context-handlers: msp_context_resolve,
// msp_context_diff, msp_context_audit, msp_context_replay,
// msp_context_injection_record (WP-13 Bounded Scope item 5).
//
// This file owns a small set of its own prepared statements against the
// `contexts` and `state` tables (0002_phase2.sql) rather than introducing an
// unlisted domain/context-store.mjs: WP-13's Bounded Scope names exactly two
// new domain/ modules (vault-registry.mjs, journal.mjs), and ADR-027's
// layering rule permits transport/handlers/*.mjs to import db/ directly
// ("{db, domain, retrieval, contracts} <- transport"). Keeping this
// bookkeeping local to the handler that owns it avoids inventing a module
// this packet's spec does not ask for.
import { createHash, randomUUID } from "node:crypto";

import { requireNoGksRefs } from "@freshair129/msp-contracts/namespace-guard";
import { ValidationError } from "@freshair129/msp-contracts/errors";
import {
  assertContextAccess,
  assertPayloadNotRequestedForScopedDiff,
  assertScopeColumnsConsistent,
  classifyContextAccess,
} from "@freshair129/msp-contracts/context-scope-guard";
import {
  contextAuditRef,
  contextDiffRef,
  contextInjectionRef,
  contextRef,
  replayRef,
} from "@freshair129/msp-contracts/refs";

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${label} is required.`);
  }
  return value.trim();
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Same convention as domain/entity-store.mjs's stableStringify: sorted-key
// JSON so the same logical refs object always hashes the same way
// regardless of construction order.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function createContextHandlers({ db, journal }) {
  // PH-MEMOS-5 (design §5.4, BL-MEMOS-064): tenant_id/principal_id added to
  // this statement's own column/placeholder list -- an in-place edit to an
  // existing statement (unlike §5.2's principal vaults, `contexts` needs
  // no *new* prepared statement, since it was never a fixed three-legacy-
  // type insert to begin with). Both are null for a legacy (unscoped) row.
  const insertContext = db.prepare(`
    INSERT INTO contexts (context_id, cache_id, workspace_id, agent_id, tenant_id, principal_id, refs_json, source_hash, policy_decision, recorded_at)
    VALUES (@context_id, @cache_id, @workspace_id, @agent_id, @tenant_id, @principal_id, @refs_json, @source_hash, @policy_decision, @recorded_at)
  `);
  const selectContext = db.prepare("SELECT * FROM contexts WHERE context_id = ?");
  // RKOI round-1 CRITICAL 1 fix: msp_context_audit's own cache_id/injection_id
  // ownership check (below) needs to resolve an injection_id back to the
  // context_id it was actually recorded against, straight from the same
  // `state` row msp_context_injection_record writes -- never trusting the
  // caller's own claim that a given injection_id belongs to a given
  // context_id.
  const selectStateByKey = db.prepare("SELECT value_json FROM state WHERE state_key = ?");
  const upsertState = db.prepare(`
    INSERT INTO state (state_key, value_json, expires_at, updated_at)
    VALUES (@state_key, @value_json, @expires_at, @updated_at)
    ON CONFLICT(state_key) DO UPDATE SET
      value_json = excluded.value_json,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `);

  return {
    // Request fields as built by resolveContext in msp-client.mjs:
    // workspace_root, workspace_id, agent_id, context_profile,
    // parent_context_id, workflow_ref, mode, state_keys, knowledge_refs,
    // context_authority, bounded_graph_query. context_authority carries the
    // stricter identity/sources/budget/lineage payload
    // scripts/mcp/context-authority-contract.mjs's validateContextAuthorityResponse
    // separately checks once vault-context-surface-v2.mjs normalizes this
    // call's return value -- see this handler's design-decision note in the
    // WP-13 final report for how both are satisfied at once.
    async msp_context_resolve(args = {}) {
      const workspaceId = requireString(args.workspace_id, "workspace_id");
      const agentId = requireString(args.agent_id, "agent_id");
      requireString(args.workspace_root, "workspace_root");
      requireNoGksRefs(args.knowledge_refs ?? [], "knowledge_refs");

      // PH-MEMOS-5 (design §5.4, BL-MEMOS-064): new, optional
      // access_context field -- {tenant_id, principal_id} both-or-neither,
      // straight from one object. agent_id/workspace_id/allow_passport are
      // NOT read here (unchanged from the design's own reasoning): a
      // contexts row is not itself owned by an agent/workspace tuple the
      // way a principal_private VAULT is. This is a self-asserted scope,
      // not verified against an actual vaults row -- the same stdio-only
      // trust boundary every other unsigned tool in this surface already
      // accepts.
      let scopeTenantId = null;
      let scopePrincipalId = null;
      if (args.access_context !== undefined && args.access_context !== null) {
        if (typeof args.access_context !== "object") {
          throw new ValidationError("access_context must be an object.");
        }
        scopeTenantId = requireString(args.access_context.tenant_id, "access_context.tenant_id");
        scopePrincipalId = requireString(args.access_context.principal_id, "access_context.principal_id");
      }
      assertScopeColumnsConsistent(scopeTenantId, scopePrincipalId);

      const contextId = contextRef(randomUUID());
      const cacheId = `cache_${randomUUID()}`;

      // ADR-027's explicit invariant: no GKS provider exists in v1, so
      // shared_vault_refs is always [] -- an honest empty answer, never a
      // placeholder that silently starts returning fabricated gks:
      // references later (WP-13 AC-02). global/workspace-private vault refs
      // are likewise empty in this phase: msp_context_resolve persists a
      // real `contexts` row for diff/audit/replay to act on, but does not
      // itself walk the vault registry to enumerate live entity refs --
      // that is msp_memory_promote/entity-store's job, not context
      // resolution's, and is out of this packet's bounded scope beyond the
      // global_private promotion path.
      const refs = {
        global_private_vault_refs: [],
        workspace_private_vault_refs: [],
        shared_vault_refs: [],
        workflow_ref: args.workflow_ref ?? null,
        knowledge_refs: args.knowledge_refs ?? [],
        state_keys: args.state_keys ?? [],
        mode: args.mode ?? "codev",
        context_profile: args.context_profile ?? "T-ctx",
        parent_context_id: args.parent_context_id ?? null,
      };
      const refsJson = stableStringify(refs);
      const sourceHash = sha256Hex(refsJson);
      const recordedAt = new Date().toISOString();

      insertContext.run({
        context_id: contextId,
        cache_id: cacheId,
        workspace_id: workspaceId,
        agent_id: agentId,
        tenant_id: scopeTenantId,
        principal_id: scopePrincipalId,
        refs_json: refsJson,
        source_hash: sourceHash,
        policy_decision: "allow",
        recorded_at: recordedAt,
      });

      journal.append({
        actor: agentId,
        toolName: "msp_context_resolve",
        ref: contextId,
        workspaceId,
        payload: {
          context_id: contextId,
          cache_id: cacheId,
          workspace_id: workspaceId,
          agent_id: agentId,
          scoped: scopeTenantId !== null,
        },
        policyDecision: "allow",
      });

      return {
        context_id: contextId,
        cache_id: cacheId,
        policy_decision: "allow",
        global_private_vault_refs: refs.global_private_vault_refs,
        workspace_private_vault_refs: refs.workspace_private_vault_refs,
        shared_vault_refs: refs.shared_vault_refs,
        workflow_ref: refs.workflow_ref,
        diff_ref: null,
        policy_decisions: [
          { decision: "allow", ref: contextId, reason: "msp-runtime v1 fixed-allow policy (no policy engine in this phase)" },
        ],
        diagnostics: [],
        // Not read by any known consumer's require*/requireRef validators --
        // exposed so a caller (and this packet's own contract-conformance
        // test) can exercise msp_context_replay's real hash comparison
        // against the exact value this call persisted.
        source_hash: sourceHash,
      };
    },

    // Request fields as built by diffContext in
    // msp-vault-context-contracts.mjs: actor, base_context_id,
    // target_context_id, include_payload.
    async msp_context_diff(args = {}) {
      const actor = requireString(args.actor, "actor");
      const baseContextId = requireString(args.base_context_id, "base_context_id");
      const targetContextId = requireString(args.target_context_id, "target_context_id");

      const baseRow = selectContext.get(baseContextId);
      const targetRow = selectContext.get(targetContextId);
      if (!baseRow) throw new ValidationError(`Unknown base_context_id "${baseContextId}".`, "not_found");
      if (!targetRow) throw new ValidationError(`Unknown target_context_id "${targetContextId}".`, "not_found");

      // PH-MEMOS-5 (design §5.4, BL-MEMOS-064): the check applies
      // INDEPENDENTLY to each named row -- a legacy row (both columns
      // null) is unaffected; a scoped row requires a matching
      // access_context. If base and target are scoped to DIFFERENT
      // principals, no single access_context can match both, so the
      // mismatch fires naturally on whichever row it does not match -- no
      // separate cross-principal-diff rule is needed.
      const baseOutcome = classifyContextAccess(baseRow, args.access_context);
      assertContextAccess(
        baseOutcome,
        `msp_context_diff: ${baseOutcome}: access_context is required for, and must match, base_context_id's own scoped context.`,
      );
      const targetOutcome = classifyContextAccess(targetRow, args.access_context);
      assertContextAccess(
        targetOutcome,
        `msp_context_diff: ${targetOutcome}: access_context is required for, and must match, target_context_id's own scoped context.`,
      );
      // include_payload is refused UNCONDITIONALLY for a scoped row, even
      // with a correctly-matching access_context (design §5.4) -- defense
      // in depth, not a fallback for an unauthorized caller.
      const eitherRowScoped = Boolean(baseRow.tenant_id) || Boolean(targetRow.tenant_id);
      assertPayloadNotRequestedForScopedDiff(args.include_payload === true, eitherRowScoped);

      const baseRefs = JSON.parse(baseRow.refs_json);
      const targetRefs = JSON.parse(targetRow.refs_json);
      const changedRefs = diffRefSets(baseRefs, targetRefs);
      const diffId = randomUUID();
      const diffRef = contextDiffRef(diffId);
      const sourceHash = sha256Hex(stableStringify({ base: baseRefs, target: targetRefs }));

      journal.append({
        actor,
        toolName: "msp_context_diff",
        ref: diffRef,
        workspaceId: targetRow.workspace_id,
        payload: { base_context_id: baseContextId, target_context_id: targetContextId, changed_count: changedRefs.length },
        policyDecision: "allow",
      });

      const response = {
        diff_ref: diffRef,
        base_context_id: baseContextId,
        target_context_id: targetContextId,
        changed_refs: changedRefs,
        source_hash: sourceHash,
      };
      if (args.include_payload === true) {
        response.payload = { base: baseRefs, target: targetRefs };
      }
      return response;
    },

    // Request fields as built by auditContext in
    // msp-vault-context-contracts.mjs: actor, context_id, cache_id,
    // injection_id.
    async msp_context_audit(args = {}) {
      const actor = requireString(args.actor, "actor");
      const contextId = requireString(args.context_id, "context_id");
      const cacheId = typeof args.cache_id === "string" && args.cache_id.trim() ? args.cache_id.trim() : null;
      const injectionId = typeof args.injection_id === "string" && args.injection_id.trim() ? args.injection_id.trim() : null;

      const contextRow = selectContext.get(contextId);
      // PH-MEMOS-5 (design §5.4, BL-MEMOS-064): the identical single-row
      // check as msp_memory_*'s own principal_private branch (§5.1),
      // applied to this one context_id. An UNKNOWN context_id is
      // unaffected -- classifyContextAccess only ever runs against a row
      // that was actually found, mirroring requireKnownVault's own
      // existence-first precedent.
      if (contextRow) {
        const outcome = classifyContextAccess(contextRow, args.access_context);
        assertContextAccess(
          outcome,
          `msp_context_audit: ${outcome}: access_context is required for, and must match, this scoped context.`,
        );
      }

      // RKOI round-1 CRITICAL 1: the gate immediately above only ever runs
      // against contextId's OWN row -- but journal.read() below (by design,
      // for the injection-record lookup this function needs) ORs cache_id
      // and injection_id in as ADDITIONAL, independently-matched search
      // terms, each also a substring match against payload_json. Passing
      // either straight through from the caller would let the gate be
      // stepped around completely just by moving the id someone does not
      // own into cache_id or injection_id -- with a real, resolving
      // context_id (defeating the gate's own match check) or, worse, with a
      // context_id that does not resolve at all (skipping the gate
      // entirely, since it only runs `if (contextRow)`).
      //
      // Both ids are therefore verified to belong to THIS SAME contextId --
      // the one the gate above just authorized, or refused to authorize --
      // before either is allowed anywhere near journal.read()'s filter.
      // cache_id is checked against the contexts row's OWN cache_id column
      // (never the caller's claim); injection_id is resolved back to the
      // context_id its msp_context_injection_record call actually recorded,
      // straight from the persisted `state` row, never the caller's claim
      // either. This holds even when context_id itself does not resolve:
      // an unresolvable context_id has no cache_id/injection_id it could
      // ever legitimately own, so supplying either alongside one is refused
      // outright, not silently ignored -- closing the exact "bogus
      // context_id + a real cache_id/injection_id" shape RKOI's probe used.
      if (cacheId !== null && (!contextRow || cacheId !== contextRow.cache_id)) {
        throw new ValidationError(
          "msp_context_audit: context_identifier_mismatch: cache_id must be the cache_id msp_context_resolve returned for this same context_id.",
          "context_identifier_mismatch",
        );
      }
      if (injectionId !== null) {
        const stateRow = selectStateByKey.get(`injection:${injectionId}`);
        let recordedContextId = null;
        if (stateRow) {
          try {
            recordedContextId = JSON.parse(stateRow.value_json)?.context_id ?? null;
          } catch {
            recordedContextId = null;
          }
        }
        if (!contextRow || recordedContextId !== contextId) {
          throw new ValidationError(
            "msp_context_audit: context_identifier_mismatch: injection_id must name an injection record recorded against this same context_id.",
            "context_identifier_mismatch",
          );
        }
      }

      // Independent-review finding (fold-in, same round): the gate above
      // only ever constrains what happens when contextId DOES resolve to a
      // real `contexts` row -- but journal.read()'s WHERE is
      // `(ref = ? OR payload_json LIKE ?)` over the WHOLE journal table,
      // matched against RAW contextId with no ownership check of any kind.
      // A `contexts.context_id` is never the only thing that can sit in
      // that column: a principal vault's vault_id equality-matches a
      // msp_vault_resolve receipt's own `ref` directly (journal.append's
      // `ref: principalPrivateVault.vault_id`), and a bare guessable
      // string (a tenant id, an entity id, any msp_memory_* ref) LIKE-
      // matches any payload_json that happens to mention it -- for EVERY
      // tool that ever journals, not just this one. None of that is
      // "moving an id into another field" (CRITICAL 1's original shape,
      // fixed above); it is contextId itself, unverified, doing the
      // damage alone, with cache_id/injection_id both left null. The
      // cache_id/injection_id ownership checks above cannot catch this --
      // they only run when one of those two fields is non-null.
      //
      // The only correct constraint: journal.read() must never run against
      // an unverified contextId at all. contextId's sole legitimate job is
      // naming a `contexts` row; when it does not (contextRow is null),
      // there is nothing it was ever entitled to search, so the search
      // itself does not happen -- not "search anyway and hope nothing
      // matches." A real, resolved contextId (legacy, or scoped and
      // already gated above) is the only value ever handed to journal.read().
      let entries = [];
      let hashValid = false;
      if (contextRow) {
        entries = journal.read({ contextId, cacheId, injectionId });
        // A real hash check, not a fabricated boolean: recompute the
        // source hash of the persisted refs_json and compare against the
        // stored column.
        hashValid = sha256Hex(contextRow.refs_json) === contextRow.source_hash;
      }

      const auditRef = contextAuditRef(randomUUID());

      journal.append({
        actor,
        toolName: "msp_context_audit",
        ref: auditRef,
        workspaceId: contextRow?.workspace_id ?? null,
        payload: { context_id: contextId, cache_id: cacheId, injection_id: injectionId, finding_count: entries.length },
        policyDecision: "allow",
      });

      return {
        audit_ref: auditRef,
        context_id: contextId,
        replayable: Boolean(contextRow),
        hash_valid: hashValid,
        policy_decision: "allow",
        findings: entries.map((entry) => ({
          journal_id: entry.journalId,
          occurred_at: entry.occurredAt,
          actor: entry.actor,
          tool_name: entry.toolName,
          ref: entry.ref,
          policy_decision: entry.policyDecision,
          reason: entry.reason,
        })),
      };
    },

    // Request fields as actually sent when reached through
    // scripts/mcp/vault-context-surface-v2.mjs's govibe.context.replay
    // handler, which is the one real caller of MspClient.replayContext:
    // actor, context_id, cache_id, run_id, turn_id. replayContext in
    // msp-client.mjs forwards whatever object it is given verbatim (no
    // request-shape transformation of its own), so this handler also
    // accepts an optional source_hash field this packet's own
    // contract-conformance test uses to exercise the tampered-hash case
    // required by AC-05.
    async msp_context_replay(args = {}) {
      const contextId = requireString(args.context_id, "context_id");
      const contextRow = selectContext.get(contextId);
      // PH-MEMOS-5 (design §5.4, BL-MEMOS-064): identical single-row check.
      if (contextRow) {
        const outcome = classifyContextAccess(contextRow, args.access_context);
        assertContextAccess(
          outcome,
          `msp_context_replay: ${outcome}: access_context is required for, and must match, this scoped context.`,
        );
      }

      // context_reproducible is a real hash comparison against the
      // persisted contexts row (WP-13 Bounded Scope item 5 / AC-05): if the
      // caller supplies source_hash, it must match what was actually
      // recorded; if the context itself is unknown, reproducibility cannot
      // be claimed.
      let contextReproducible = false;
      let diagnosticReason;
      if (!contextRow) {
        diagnosticReason = "context_not_found: no persisted context matches context_id.";
      } else if (typeof args.source_hash === "string" && args.source_hash) {
        contextReproducible = args.source_hash.toLowerCase() === contextRow.source_hash.toLowerCase();
        diagnosticReason = contextReproducible
          ? "context_hash_match: supplied source_hash matches the persisted context's source_hash."
          : "context_hash_mismatch: supplied source_hash does not match the persisted context's source_hash.";
      } else {
        contextReproducible = true;
        diagnosticReason = "context_hash_match: no source_hash supplied to compare, persisted context exists as recorded.";
      }

      const ref = replayRef(randomUUID());

      journal.append({
        actor: typeof args.actor === "string" && args.actor.trim() ? args.actor.trim() : "system",
        toolName: "msp_context_replay",
        ref,
        workspaceId: contextRow?.workspace_id ?? null,
        payload: { context_id: contextId, context_reproducible: contextReproducible },
        policyDecision: "allow",
      });

      return {
        replay_ref: ref,
        context_reproducible: contextReproducible,
        // ADR-027 "What this ADR does not claim": the MSP runtime has no
        // execution authority, so these are hard-coded false in every case,
        // never derived from any code path that could flip them to true
        // (WP-13 AC-05).
        execution_reproducible: false,
        output_identical: false,
        diagnostics: [
          diagnosticReason,
          "execution_reproducible and output_identical are always false: this runtime has no execution authority (ADR-027).",
        ],
      };
    },

    // Request fields as actually sent by the one real producer,
    // packages/govibe-core/src/continue.mjs (via persistContextInjection in
    // context-store.mjs): schema, injection_id, context_id, cache_id,
    // kv_id, parent_context_id, agent_id, project_id, workspace_id,
    // session_id, run_id, turn_id, context_profile, injected_at,
    // source_manifest_hash, context_hash, packet_hash, cache_path, diff_ref,
    // replay. recordContextInjection in msp-client.mjs forwards this object
    // verbatim.
    async msp_context_injection_record(args = {}) {
      const injectionId =
        typeof args.injection_id === "string" && args.injection_id.trim() ? args.injection_id.trim() : `inject_${randomUUID()}`;
      const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id : null;
      const agentId = typeof args.agent_id === "string" && args.agent_id.trim() ? args.agent_id.trim() : "system";

      const injectionRef = contextInjectionRef(injectionId);

      upsertState.run({
        state_key: `injection:${injectionId}`,
        value_json: JSON.stringify(args),
        expires_at: null,
        updated_at: new Date().toISOString(),
      });

      journal.append({
        actor: agentId,
        toolName: "msp_context_injection_record",
        ref: injectionRef,
        workspaceId,
        payload: {
          injection_id: injectionId,
          context_id: args.context_id ?? null,
          cache_id: args.cache_id ?? null,
        },
        policyDecision: "allow",
      });

      return { injection_ref: injectionRef };
    },
  };
}

// Flattens a persisted refs object down to a {ref, sourceHash} list across
// every ref-bearing field and compares base vs target by ref: added,
// removed, or changed (same ref, different sourceHash). Non-ref scalar
// fields (workflow_ref, mode, context_profile, parent_context_id) are
// compared as single-entry pseudo-refs so a diff still surfaces a workflow
// or profile change even though those fields carry no sourceHash.
function diffRefSets(baseRefs, targetRefs) {
  const baseIndex = new Map(flattenRefs(baseRefs).map((entry) => [entry.ref, entry]));
  const targetIndex = new Map(flattenRefs(targetRefs).map((entry) => [entry.ref, entry]));
  const changed = [];

  for (const [ref, targetEntry] of targetIndex) {
    const baseEntry = baseIndex.get(ref);
    if (!baseEntry) {
      changed.push({ ref, change: "added", value: targetEntry.value });
    } else if (baseEntry.value !== targetEntry.value) {
      changed.push({ ref, change: "changed", from: baseEntry.value, to: targetEntry.value });
    }
  }
  for (const [ref, baseEntry] of baseIndex) {
    if (!targetIndex.has(ref)) {
      changed.push({ ref, change: "removed", value: baseEntry.value });
    }
  }
  return changed;
}

function flattenRefs(refs) {
  const entries = [];
  for (const field of ["global_private_vault_refs", "workspace_private_vault_refs", "shared_vault_refs"]) {
    for (const item of refs[field] ?? []) {
      entries.push({ ref: `${field}:${item.ref}`, value: item.sourceHash ?? item.source_hash ?? null });
    }
  }
  for (const field of ["workflow_ref", "mode", "context_profile", "parent_context_id"]) {
    entries.push({ ref: `field:${field}`, value: refs[field] ?? null });
  }
  return entries;
}
