// Vendored port of scripts/mcp/temporal-versioning.mjs's bitemporal
// semantics, per WP-12 Bounded Scope item 2 and ADR-027 (packages/msp-runtime
// must not import scripts/mcp/* at runtime). This is a PORT, not a re-export:
// the logic below is copied from the source module, not imported from it.
// test/temporal-engine.parity.test.mjs asserts these two implementations
// stay behaviorally identical (AC-05); if you change this file, that test
// will catch drift.
//
// Only the four functions WP-12 names as required
// (createTemporalVersion, isTemporalVisible, compareTemporalOrder,
// nextVersion) are ported. The source module's `temporalColumns` /
// `readTemporalColumns` are UI-table-reading helpers with no consumer in
// this packet's domain layer and are intentionally not vendored.

export function createTemporalVersion(input = {}, now = new Date().toISOString()) {
  return {
    version: String(input.version ?? "1"),
    validFrom: input.validFrom || now,
    validTo: input.validTo || undefined,
    recordedAt: input.recordedAt || now,
    supersededAt: input.supersededAt || undefined,
  };
}

export function isTemporalVisible(item = {}, options = {}) {
  const asOfValidAt = Date.parse(options.asOfValidAt ?? new Date().toISOString());
  const asOfRecordedAt = Date.parse(options.asOfRecordedAt ?? new Date().toISOString());
  const validFrom = Date.parse(item.validFrom ?? item.recordedAt ?? new Date(0).toISOString());
  const validTo = item.validTo ? Date.parse(item.validTo) : undefined;
  const recordedAt = Date.parse(item.recordedAt ?? new Date(0).toISOString());
  const supersededAt = item.supersededAt ? Date.parse(item.supersededAt) : undefined;

  if ([asOfValidAt, asOfRecordedAt, validFrom, recordedAt].some((value) => Number.isNaN(value))) {
    return false;
  }
  if (asOfValidAt < validFrom) return false;
  if (validTo !== undefined && !Number.isNaN(validTo) && asOfValidAt > validTo) return false;
  if (asOfRecordedAt < recordedAt) return false;
  if (supersededAt !== undefined && !Number.isNaN(supersededAt) && asOfRecordedAt >= supersededAt) return false;
  return true;
}

export function compareTemporalOrder(item = {}) {
  const errors = [];
  const validFrom = item.validFrom ? Date.parse(item.validFrom) : undefined;
  const validTo = item.validTo ? Date.parse(item.validTo) : undefined;
  const recordedAt = item.recordedAt ? Date.parse(item.recordedAt) : undefined;
  const supersededAt = item.supersededAt ? Date.parse(item.supersededAt) : undefined;

  if (validFrom !== undefined && Number.isNaN(validFrom)) errors.push("validFrom is not a valid ISO timestamp.");
  if (validTo !== undefined && Number.isNaN(validTo)) errors.push("validTo is not a valid ISO timestamp.");
  if (recordedAt !== undefined && Number.isNaN(recordedAt)) errors.push("recordedAt is not a valid ISO timestamp.");
  if (supersededAt !== undefined && Number.isNaN(supersededAt)) errors.push("supersededAt is not a valid ISO timestamp.");
  if (validFrom !== undefined && validTo !== undefined && !Number.isNaN(validFrom) && !Number.isNaN(validTo) && validFrom > validTo) {
    errors.push("validFrom must be before or equal to validTo.");
  }
  if (recordedAt !== undefined && supersededAt !== undefined && !Number.isNaN(recordedAt) && !Number.isNaN(supersededAt) && recordedAt > supersededAt) {
    errors.push("recordedAt must be before or equal to supersededAt.");
  }

  return errors;
}

export function nextVersion(records = []) {
  const numeric = records
    .map((record) => Number(record.version))
    .filter((value) => Number.isFinite(value));
  return String((numeric.length ? Math.max(...numeric) : 0) + 1);
}
