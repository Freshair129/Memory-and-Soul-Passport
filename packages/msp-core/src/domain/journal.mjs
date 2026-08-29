// domain/journal: append-only audit log backing msp_context_audit (WP-13
// Phase 2, Bounded Scope item 2). Every mutating tool in this packet's scope
// writes exactly one row per call via append(). Immutability is enforced by
// the BEFORE UPDATE / BEFORE DELETE triggers in 0002_phase2.sql
// (RAISE(ABORT)), not just by this module never issuing UPDATE/DELETE --
// mirroring WP-12's entity_history precedent of enforcing an append-only
// invariant so even a future application-layer bug cannot silently rewrite
// audit history.
export class Journal {
  #db;
  #insert;
  #selectLastRowId;

  constructor(db) {
    this.#db = db;
    this.#insert = db.prepare(`
      INSERT INTO journal (occurred_at, actor, tool_name, ref, workspace_id, payload_json, policy_decision, reason)
      VALUES (@occurred_at, @actor, @tool_name, @ref, @workspace_id, @payload_json, @policy_decision, @reason)
    `);
    this.#selectLastRowId = db.prepare("SELECT last_insert_rowid() AS id");
  }

  /**
   * @param {object} entry
   * @param {string} entry.actor
   * @param {string} entry.toolName
   * @param {string|null} [entry.ref] the primary msp:*-namespaced ref this call produced or acted on.
   * @param {string|null} [entry.workspaceId]
   * @param {object} [entry.payload] a plain-object summary of the call; stored as JSON.
   * @param {string} entry.policyDecision "allow" | "deny" | "shadow".
   * @param {string|null} [entry.reason]
   */
  append({ actor, toolName, ref = null, workspaceId = null, payload = {}, policyDecision, reason = null }) {
    if (!actor) throw new TypeError("journal.append requires actor.");
    if (!toolName) throw new TypeError("journal.append requires toolName.");
    if (!policyDecision) throw new TypeError("journal.append requires policyDecision.");

    const row = {
      occurred_at: new Date().toISOString(),
      actor,
      tool_name: toolName,
      ref,
      workspace_id: workspaceId,
      payload_json: JSON.stringify(payload ?? {}),
      policy_decision: policyDecision,
      reason,
    };
    this.#insert.run(row);
    const { id } = this.#selectLastRowId.get();
    return rowToEntry({ journal_id: id, ...row });
  }

  /**
   * Read journal rows matching any of the given identifiers. contextId,
   * cacheId, and injectionId are matched two ways per candidate: an exact
   * match against the row's own `ref` column (the primary ref that call
   * produced), OR a substring match against payload_json (so, e.g., a
   * msp_context_injection_record row -- whose own `ref` is its injection
   * ref, not the context_id it was recorded against -- is still found when
   * auditing by context_id, since its payload always includes context_id).
   * refPrefix additionally scopes to rows whose own ref starts with a given
   * namespace (e.g. "msp:proof/"). Returns newest-first.
   */
  read({ contextId = null, cacheId = null, injectionId = null, refPrefix = null } = {}) {
    const identifiers = [contextId, cacheId, injectionId].filter(Boolean);
    const conditions = [];
    const params = [];

    for (const id of identifiers) {
      conditions.push("(ref = ? OR payload_json LIKE ?)");
      params.push(id, `%${id}%`);
    }
    if (refPrefix) {
      conditions.push("ref LIKE ?");
      params.push(`${refPrefix}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" OR ")}` : "";
    return this.#db
      .prepare(`SELECT * FROM journal ${where} ORDER BY journal_id DESC`)
      .all(...params)
      .map(rowToEntry);
  }
}

function rowToEntry(row) {
  return {
    journalId: row.journal_id,
    occurredAt: row.occurred_at,
    actor: row.actor,
    toolName: row.tool_name,
    ref: row.ref,
    workspaceId: row.workspace_id,
    payload: JSON.parse(row.payload_json),
    policyDecision: row.policy_decision,
    reason: row.reason,
  };
}
