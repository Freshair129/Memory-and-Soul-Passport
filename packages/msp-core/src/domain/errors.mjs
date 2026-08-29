// Typed domain error classes with a stable `.code`, matching the error
// vocabulary recorded in docs/api/API-009-Persistent-Memory-Contract.md §5
// (this packet does not implement the tool surface that raises these over
// the wire -- that is Phase 2 -- but the domain layer's own error shapes are
// built to that vocabulary now so Phase 2 does not need to re-map them).

export class MspRuntimeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class MemoryNotFoundError extends MspRuntimeError {
  constructor(message = "Memory entity not found.") {
    super(message, "not_found");
  }
}

export class MemoryConflictError extends MspRuntimeError {
  constructor(message = "Concurrent write conflict on this (category, key).") {
    super(message, "conflict");
  }
}

// Raised by db/migrate.mjs's checksum-drift guard and downgrade guard. Both
// are startup-fatal: the process must refuse to start rather than run
// against a schema it cannot trust.
export class SchemaVersionError extends MspRuntimeError {
  constructor(message) {
    super(message, "db_unavailable");
  }
}
