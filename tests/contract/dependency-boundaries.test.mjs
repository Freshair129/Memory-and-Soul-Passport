import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const roots = {
  storage: path.join(repoRoot, "packages", "msp-storage", "src"),
  core: path.join(repoRoot, "packages", "msp-core", "src"),
  contracts: path.join(repoRoot, "packages", "msp-contracts", "src"),
  retrieval: path.join(repoRoot, "packages", "msp-retrieval", "src"),
  client: path.join(repoRoot, "packages", "msp-client-js", "src"),
  server: path.join(repoRoot, "apps", "msp-server", "src"),
};

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

function importSpecifiers(source) {
  return [...source.matchAll(/(?:from\s+|import\s*\()["'](.+?)["']/g)].map((match) => match[1]);
}

// Strips `//` and `/* */` comments before a source-text scan -- so a
// comment that NAMES a forbidden pattern (documenting the coupling a fix
// removed, for instance) never trips the very check it documents.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function packageImports(dir) {
  return collectFiles(dir).flatMap((file) =>
    importSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) => specifier.startsWith("@freshair129/"))
      .map((specifier) => ({ file, specifier })),
  );
}

function expectOnly(dir, allowed) {
  for (const { file, specifier } of packageImports(dir)) {
    const packageName = specifier.split("/").slice(0, 2).join("/");
    expect(allowed.has(packageName), `${file} imports forbidden package ${specifier}`).toBe(true);
  }
}

describe("standalone MSP workspace dependency boundaries", () => {
  it("all required package roots and the server composition root exist", () => {
    for (const root of Object.values(roots)) expect(existsSync(root), root).toBe(true);
    expect(existsSync(path.join(roots.server, "server.mjs"))).toBe(true);
  });

  it("msp-storage has no internal workspace-package dependencies", () => {
    expect(packageImports(roots.storage)).toEqual([]);
  });

  it("msp-core has no internal workspace-package dependencies", () => {
    expect(packageImports(roots.core)).toEqual([]);
  });

  it("msp-contracts depends only on msp-core", () => {
    expectOnly(roots.contracts, new Set(["@freshair129/msp-core"]));
  });

  it("msp-retrieval depends only on msp-core", () => {
    expectOnly(roots.retrieval, new Set(["@freshair129/msp-core"]));
  });

  it("msp-client-js has no internal workspace-package dependency", () => {
    expect(packageImports(roots.client)).toEqual([]);
  });

  it("msp-server composes only the four runtime packages", () => {
    expectOnly(
      roots.server,
      new Set([
        "@freshair129/msp-core",
        "@freshair129/msp-contracts",
        "@freshair129/msp-retrieval",
        "@freshair129/msp-storage",
      ]),
    );
  });

  it("contracts guard remains decoupled from the vault registry implementation", () => {
    const guard = readFileSync(
      path.join(roots.contracts, "contracts", "vault-scope-guard.mjs"),
      "utf8",
    );
    expect(importSpecifiers(guard)).not.toContain("@freshair129/msp-core/vault-registry");
    expect(importSpecifiers(guard)).not.toContain("../../domain/vault-registry.mjs");
  });

  it("contracts thread-access guard remains decoupled from the thread registry implementation (API-011 C-2)", () => {
    const guardPath = path.join(roots.contracts, "contracts", "thread-access.mjs");
    const guard = readFileSync(guardPath, "utf8");
    const code = stripComments(guard);
    // No DB-backed lookup at all: no msp-core import, no `db` parameter, no
    // inline SQL in actual code. This is the exact coupling the ORIGINAL
    // (unmerged) version of this file had, moved into msp-core's
    // ThreadRegistry, orchestrated by
    // apps/msp-server/src/transport/handlers/thread-guard.mjs instead.
    expect(importSpecifiers(guard)).not.toContain("@freshair129/msp-core/thread-memory");
    expect(code).not.toMatch(/\bdb\s*[,)]/);
    expect(code).not.toMatch(/\bdb\.prepare\b/);
    expect(code).not.toMatch(/\bSELECT\b/i);
  });

  // RKOI review (2nd round), WARNING 8: the `db`-parameter scan above only
  // covered thread-access.mjs by name. Extended to every msp-contracts
  // source file, matching the file-wide .prepare(/.exec(/.pragma( scan
  // just below -- an injected `db` PARAMETER on any contracts/ function,
  // even one not literally named thread-access.mjs, would be the same C-2
  // coupling.
  it("no msp-contracts source file accepts an injected db-handle parameter", () => {
    for (const file of collectFiles(roots.contracts)) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, `${file} must not take a db parameter`).not.toMatch(/\bdb\s*[,)]/);
      expect(code, `${file} must not call db.prepare`).not.toMatch(/\bdb\.prepare\b/);
    }
  });

  // RKOI review (post-implementation, item 13): scanning ONLY
  // thread-access.mjs's imports let the ORIGINAL C-2 finding pass this
  // suite, because that version's DB handle was INJECTED as a parameter
  // rather than imported -- an import-only check has nothing to see. Every
  // msp-contracts source file is now scanned for actual (non-comment)
  // `.prepare(`, `.exec(` or `.pragma(` call syntax, which catches an
  // injected-handle coupling too, not just an import-based one.
  it("no msp-contracts source file calls .prepare(/.exec(/.pragma( directly, injected handle or not (API-011 C-2, RKOI item 13)", () => {
    for (const file of collectFiles(roots.contracts)) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, `${file} must not call .prepare(`).not.toMatch(/\.prepare\s*\(/);
      expect(code, `${file} must not call .exec(`).not.toMatch(/\.exec\s*\(/);
      expect(code, `${file} must not call .pragma(`).not.toMatch(/\.pragma\s*\(/);
    }
  });

  it("contains no relative-import cycles within core or contracts", () => {
    for (const root of [roots.core, roots.contracts]) {
      const files = collectFiles(root);
      const graph = new Map();
      for (const file of files) {
        const dependencies = importSpecifiers(readFileSync(file, "utf8"))
          .filter((specifier) => specifier.startsWith("."))
          .map((specifier) => path.resolve(path.dirname(file), specifier));
        graph.set(file, dependencies);
      }
      const visiting = new Set();
      const visited = new Set();
      function visit(file) {
        if (visiting.has(file)) throw new Error(`import cycle detected at ${file}`);
        if (visited.has(file)) return;
        visiting.add(file);
        for (const dependency of graph.get(file) ?? []) visit(dependency);
        visiting.delete(file);
        visited.add(file);
      }
      expect(() => files.forEach(visit)).not.toThrow();
    }
  });
});
