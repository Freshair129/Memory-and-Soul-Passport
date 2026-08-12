// Composition root: wires db -> domain -> contracts -> transport together.
// This is the one module allowed to import from every layer (db/, domain/,
// contracts/, transport/); it is excluded from
// test/dependency-boundaries.test.mjs, mirroring how
// scripts/mcp/runtime/runtime-core.mjs / sidecar-server.mjs /
// govibe-mcp-server.mjs are excluded from
// scripts/mcp/runtime/dependency-boundaries.test.mjs.
//
// Phase 0/1 (WP-12) registered only a diagnostic `msp_ping`. WP-13 Phase 2
// adds the eleven-tool `msp_*` contract surface (vault registry, context
// tools, promotion tools) that packages/govibe-core/src/msp-client.mjs and
// scripts/mcp/msp-vault-context-contracts.mjs already call today. `msp_ping`
// stays registered alongside them. WP-15 Phase 3 adds the six-tool
// `msp_memory_*` CRUD/search surface, backed by the new retrieval/ layer
// (FTS5 + bge-m3 vectors + RRF fusion).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { open } from "@freshair129/msp-storage/connection";
import { runMigrations } from "@freshair129/msp-storage/migrate";
import { EntityStore } from "@freshair129/msp-core/entity-store";
import { Journal } from "@freshair129/msp-core/journal";
import { LinksStore } from "@freshair129/msp-core/links";
import { VaultRegistry } from "@freshair129/msp-core/vault-registry";
import { createRetrievalService } from "@freshair129/msp-retrieval/retrieval-service";
import { createVectorClient } from "@freshair129/msp-retrieval/vector";
import { createContextHandlers } from "./transport/handlers/context-handlers.mjs";
import { createLifecycleHandlers } from "./transport/handlers/lifecycle-handlers.mjs";
import { createMemoryHandlers } from "./transport/handlers/memory-handlers.mjs";
import { createGksProviderFromEnvironment } from "./providers/gks-stdio-provider.mjs";
import { createVaultHandlers } from "./transport/handlers/vault-handlers.mjs";
import { createStdioJsonRpcServer } from "./transport/stdio-jsonrpc-server.mjs";
import { ToolRegistry } from "./transport/tool-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(here, "..", "..", "..", "migrations");

/**
 * @param {object} options
 * @param {string} options.dbPath absolute path to the SQLite database file (MSP_DB_PATH).
 * @param {string} [options.migrationsDir] override for testing.
 * @param {NodeJS.ReadableStream} [options.input] override for testing.
 * @param {NodeJS.WritableStream} [options.output] override for testing.
 */
export function createServer({ dbPath, migrationsDir = DEFAULT_MIGRATIONS_DIR, input, output, env = process.env } = {}) {
  if (!dbPath) {
    throw new TypeError("createServer requires dbPath (MSP_DB_PATH).");
  }

  const db = open(dbPath);
  runMigrations(db, migrationsDir);

  const entityStore = new EntityStore(db);
  const journal = new Journal(db);
  const vaultRegistry = new VaultRegistry(db);
  const linksStore = new LinksStore(db);
  const vectorClient = createVectorClient();
  const retrievalService = createRetrievalService({ db, vectorClient });
  const gksProvider = createGksProviderFromEnvironment(env);

  const vaultHandlers = createVaultHandlers({ vaultRegistry, journal });
  const contextHandlers = createContextHandlers({ db, journal });
  const lifecycleHandlers = createLifecycleHandlers({ db, entityStore, vaultRegistry, journal, gksProvider });
  const memoryHandlers = createMemoryHandlers({ db, entityStore, vaultRegistry, journal, retrievalService, vectorClient, linksStore });

  const toolRegistry = new ToolRegistry();
  toolRegistry.register("msp_ping", async () => ({ ok: true, timestamp: new Date().toISOString() }));
  for (const [name, handler] of Object.entries(vaultHandlers)) toolRegistry.register(name, handler);
  for (const [name, handler] of Object.entries(contextHandlers)) toolRegistry.register(name, handler);
  for (const [name, handler] of Object.entries(lifecycleHandlers)) toolRegistry.register(name, handler);
  for (const [name, handler] of Object.entries(memoryHandlers)) toolRegistry.register(name, handler);

  const transport = createStdioJsonRpcServer({ toolRegistry, input, output });

  function close() {
    transport.close();
    db.close();
  }

  return { db, entityStore, journal, vaultRegistry, linksStore, retrievalService, vectorClient, toolRegistry, transport, close };
}
