---
version: "1.0.0b"
status: beta
created_at: "2026-09-07T22:18:44+07:00,RWANG"
last_update: "2026-09-07T22:18:44+07:00,RWANG"
---

# Isolated MSP native test runtime

## Symptom

Fresh isolated install on Node24.19.0 intermittently aborted memory CRUD/link/decay tests with `node::RemoveEnvironmentCleanupHook` asserting `(env) != nullptr` from a Statement destructor. The new pipeline scope tests passed; rerunning only the failing existing suites reproduced the abort.

## Evidence

The local24.19 header `node_object_wrap.h` adds AddCleanupHook in ObjectWrap construction and RemoveCleanupHook in destruction. The24.18 header downloaded by node-gyp lacks those calls. Both installs used better-sqlite3 11.10.0 but their native binary hashes differed. Switching the Node executable alone while retaining the newly compiled binding still aborted. Rebuilding the binding with `node-gyp rebuild --release --target=24.18.0` and running Node24.18 produced185/185 Vitest passes; the full npm test then also passed42 security tests. Additional real-process pipeline scope coverage passed afterward.

## Root cause

The failing native binding had compiled the24.19 ObjectWrap cleanup-hook behavior into Statement destruction. A compatible header/runtime rebuild removes that crashing cleanup path. The exact upstream V8 cleanup context lifetime is not reimplemented or patched here.

## Why it escaped detection

A one-statement in-memory SQLite smoke test passed. The abort surfaced under the real subprocess memory suite and garbage collection, so loadability alone did not establish runtime compatibility.

## Prevention

Use the isolated pinned Node24.18.0 runtime for this acceptance run and rebuild legacy native dependencies against the same headers. Verify the downloaded Windows node.exe against official release SHASUMS256.txt before use. Record runtime and dependency build target in the acceptance report; never count a smoke test as proof of the process suite. No host Node installation or production runtime was changed.
