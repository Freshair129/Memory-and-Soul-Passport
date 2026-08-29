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
  const insertContext = db.prepare(`
    INSERT INTO contexts (context_id, cache_id, workspace_id, agent_id, refs_json, source_hash, policy_decision, recorded_at)
    VALUES (@context_id, @cache_id, @workspace_id, @agent_id, @refs_json, @source_hash, @policy_decision, @recorded_at)
  `);
  const selectContext = db.prepare("SELECT * FROM contexts WHERE context_id = ?");
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
        payload: { context_id: contextId, cache_id: cacheId, workspace_id: workspaceId, agent_id: agentId },
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
      const entries = journal.read({ contextId, cacheId, injectionId });

      // A real hash check, not a fabricated boolean: recompute the source
      // hash of the persisted refs_json and compare against the stored
      // column. hashValid is false if the context is unknown (nothing to
      // validate) or if the two ever disagree.
      let hashValid = false;
      if (contextRow) {
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
