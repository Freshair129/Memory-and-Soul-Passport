// domain/decay-engine: Ebbinghaus-style decay scoring and the
// active -> decayed -> archived lifecycle sweep (WP-16 Bounded Scope item 2).
// Pure, deterministic, no wall-clock reads -- every function that needs "now"
// takes it as an explicit argument so tests run under a fake clock rather
// than being timing-dependent. Depends only on domain/ (nothing here reaches
// into retrieval/ or contracts/, per ADR-027's layering rule --
// test/dependency-boundaries.test.mjs's generic domain/ sweep already
// enforces this for every file under domain/, this one included).
//
// Reconciliation with entity-store.mjs's forget() (WP-16 Bounded Scope item
// 4, resolution (a), the packet's recommended choice): runDecayTick's
// transition table below stops at 'archived' and NEVER writes 'forgotten'.
// The decay lifecycle's terminal state is 'archived'; 'forgotten' remains
// exclusively the manual, explicit-intent state entity-store.mjs's forget()
// writes. This keeps an automatic process from ever masquerading as
// deliberate deletion -- see WP-16's Bounded Scope item 4 for the full
// reasoning. test/decay-engine.test.mjs asserts this directly: even an
// entity decayed far past the archived threshold never transitions to
// 'forgotten', and forgotten entities are excluded from the sweep entirely.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Reinforcement: each recorded access extends the retention "stability" (in
// days) by this many days, uncapped. A high-access_count entity therefore
// decays more slowly than a low-access_count entity of the same elapsed
// time -- AC-02's explicit coverage requirement.
const BASE_STABILITY_DAYS = 3;
const REINFORCEMENT_DAYS_PER_ACCESS = 2;

export const DEFAULT_DECAY_THRESHOLDS = Object.freeze({
  decayed: 0.5,
  archived: 0.15,
});

/**
 * Ebbinghaus-style retention score: R = e^(-t/S), where t is elapsed time
 * (days) since the entity was last read and S ("stability") grows with
 * access_count (reinforcement on repeated access).
 *
 * @param {object} entity
 * @param {string|null} [entity.lastAccessedAt] ISO-8601, or null/undefined if
 *   never read since creation.
 * @param {string} entity.createdAt ISO-8601 -- used as the decay reference
 *   point when lastAccessedAt is null (never coerced to epoch zero).
 * @param {number} [entity.accessCount]
 * @param {string} now ISO-8601, explicitly injected -- this function never
 *   reads the wall clock itself.
 * @returns {number} a score in [0, 1].
 */
export function recomputeDecayScore(entity, now) {
  if (!entity || typeof entity !== "object") {
    throw new TypeError("recomputeDecayScore requires an entity object.");
  }
  if (!now) {
    throw new TypeError("recomputeDecayScore requires an explicit `now` (no internal Date.now()).");
  }

  const referenceTime = entity.lastAccessedAt ?? entity.createdAt;
  if (!referenceTime) {
    throw new TypeError(
      "recomputeDecayScore requires entity.lastAccessedAt or entity.createdAt as a decay reference point.",
    );
  }

  const elapsedMs = new Date(now).getTime() - new Date(referenceTime).getTime();
  const elapsedDays = Math.max(0, elapsedMs / MS_PER_DAY);

  const accessCount = Number.isFinite(entity.accessCount) ? Math.max(0, entity.accessCount) : 0;
  const stabilityDays = BASE_STABILITY_DAYS + accessCount * REINFORCEMENT_DAYS_PER_ACCESS;

  const score = Math.exp(-elapsedDays / stabilityDays);
  // Numeric guard only (Math.exp of a finite non-positive exponent is always
  // in (0, 1]) -- clamped defensively so this can never report outside the
  // documented [0, 1] range.
  return Math.min(1, Math.max(0, score));
}

// Cascades forward through both thresholds in a single call -- a tick that
// runs after a long gap (e.g. the first tick ever run against a
// months-old entity) must land on the state the current score actually
// implies, not get stuck one step behind waiting for a second tick that
// would immediately re-cross the next threshold anyway. Never moves
// backward (a reinforced entity's score recovering does not un-decay its
// state -- that is a deliberate, separate design choice: lifecycle_state is
// a one-way ratchet forward until this packet's terminal state, matching
// how entity-store.mjs's forget() is also one-way). Deliberately never
// reaches "forgotten" -- see this file's header comment (WP-16 Bounded
// Scope item 4, resolution (a)).
function nextLifecycleState(currentState, score, thresholds) {
  let state = currentState;
  if (state === "active" && score <= thresholds.decayed) state = "decayed";
  if (state === "decayed" && score <= thresholds.archived) state = "archived";
  return state;
}

/**
 * Recomputes decay_score for every non-forgotten entity in vaultId and
 * applies threshold-crossing transitions (active -> decayed -> archived --
 * never -> forgotten). `dryRun: true` computes and returns exactly what
 * would happen without writing anything -- test/decay-engine.test.mjs's
 * AC-04 verifies this by comparing the `entities` table's full row state
 * before and after, not merely by trusting the returned counts.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {object} options
 * @param {string} options.vaultId
 * @param {boolean} [options.dryRun]
 * @param {string} options.now ISO-8601, explicitly injected.
 * @param {{decayed: number, archived: number}} [options.thresholds]
 * @returns {{
 *   evaluated: number,
 *   transitioned: Array<{entity_id: string, from: string, to: string}>,
 *   perStateCount: Record<string, number>,
 * }}
 */
export function runDecayTick(db, { vaultId, dryRun = false, now, thresholds = DEFAULT_DECAY_THRESHOLDS } = {}) {
  if (!db) throw new TypeError("runDecayTick requires db.");
  if (!vaultId) throw new TypeError("runDecayTick requires vaultId.");
  if (!now) throw new TypeError("runDecayTick requires an explicit `now` (no internal Date.now()).");

  const rows = db.prepare("SELECT * FROM entities WHERE vault_id = ? AND lifecycle_state != 'forgotten'").all(vaultId);

  const updateStatement = db.prepare(
    "UPDATE entities SET decay_score = @decay_score, lifecycle_state = @lifecycle_state, updated_at = @updated_at WHERE entity_id = @entity_id",
  );

  const transitioned = [];
  const perStateCount = { active: 0, decayed: 0, archived: 0 };

  const apply = () => {
    for (const row of rows) {
      const score = recomputeDecayScore(
        { lastAccessedAt: row.last_accessed_at, createdAt: row.created_at, accessCount: row.access_count },
        now,
      );
      const nextState = nextLifecycleState(row.lifecycle_state, score, thresholds);
      perStateCount[nextState] = (perStateCount[nextState] ?? 0) + 1;

      if (nextState !== row.lifecycle_state) {
        transitioned.push({ entity_id: row.entity_id, from: row.lifecycle_state, to: nextState });
      }

      if (!dryRun) {
        updateStatement.run({ entity_id: row.entity_id, decay_score: score, lifecycle_state: nextState, updated_at: now });
      }
    }
  };

  // dryRun never issues a single write statement (not even inside a
  // rolled-back transaction) -- apply() above only calls updateStatement.run
  // when !dryRun, so the true-branch here is trivially a no-write read pass.
  if (dryRun) {
    apply();
  } else {
    db.transaction(apply)();
  }

  return { evaluated: rows.length, transitioned, perStateCount };
}

/**
 * Reinforcement on access: bumps access_count and last_accessed_at. Called
 * from transport/handlers/memory-handlers.mjs on a successful
 * msp_memory_get (current-state reads only) and every msp_memory_search hit
 * -- domain/ may not import retrieval/ (ADR-027), so this stays a plain,
 * narrow write the transport layer wires in explicitly, not something
 * decay-engine.mjs reaches out to find on its own.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} entityId
 * @param {string} now ISO-8601, explicitly injected.
 */
export function touch(db, entityId, now) {
  if (!db) throw new TypeError("touch requires db.");
  if (!entityId) throw new TypeError("touch requires entityId.");
  if (!now) throw new TypeError("touch requires an explicit `now` (no internal Date.now()).");

  db.prepare(
    "UPDATE entities SET access_count = access_count + 1, last_accessed_at = @now, updated_at = @now WHERE entity_id = @entity_id",
  ).run({ now, entity_id: entityId });
}
