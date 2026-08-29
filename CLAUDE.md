# CLAUDE.md — working guide for this repository

## What this repo is

Standalone Mission State Protocol (MSP) — the memory/context runtime
extracted from GoVibe, wire protocol and storage schema unchanged. See
`README.md`, `docs/GATE-A.md` (the extraction's verification bar), and
`docs/API-009-Persistent-Memory-Contract.md`.

Remote: `origin` → https://github.com/Freshair129/Memory-and-Soul-Passport
(renamed from `msp`; the URL, not the local folder name, changed). Local
path in cross-repo references is `D:\msp`.

**Call direction:** `Zuri / GoVibe -> MSP -> GKS`. MSP is the sole caller of
GKS (`D:\gks`); GoVibe and Zuri never call GKS directly. **Vault isolation is
the whole product** — every read/write/search/link/decay/promotion path is
vault-scoped, and a request naming vault A must never observe or mutate
vault B's data (30/30 security checks at Gate A).

## Toolchain

```bash
npm install
npm test                    # test:vitest (contract + integration) + test:security
npm run test:contract       # tests/contract only
npm run test:integration    # includes tests/integration/gks-provider-bridge.test.mjs
npm run test:security       # tests/security/*.security.mjs — vault isolation proofs
npm run pack:client         # dry-run pack of the publishable client
```

Start (no implicit database path — ever):
```powershell
$env:MSP_DB_PATH = (Join-Path $env:TEMP 'msp.sqlite')
npm start
```

## Working roster

This repo has a role-based subagent roster in `.claude/agents/`, following
the same coordination pattern GoVibe (`D:\GoVibe\.agents\`) already uses —
scoped down to what's real here: no GoVibe task board, no hooks, plain
branch → PR → review.

| Agent | Role | Use for |
|---|---|---|
| `rkoi` | Tech lead / architecture reviewer | Reviewing any change before merge — layering, vault isolation, GKS-bridge fail-closed behavior |
| `kin` | Backend implementer | Writing code in `apps/msp-server` or `packages/msp-*` |
| `janus` | DevOps | Workspace, `package.json`, migrations, packaging, runtime config |
| `ghost` | QA | Running/extending the test suite, finding vault-scoping coverage gaps |
| `ather` | Auditor / doc writer | Auditing against Gate A, keeping `README.md`/`docs/*.md` current |

Each agent file states exactly what it checks and what it does not — read
the one you're delegating to before assuming its scope.

## Hard rules

- **Vault isolation is never optional.** A new mutation or read path with
  no matching `*-vault-scoping.security.mjs` case is unproven, not
  "covered by the general pattern."
- **The GKS bridge fails closed.** `msp_knowledge_promote` and
  `msp_memory_promote` must answer `gks_provider_unconfigured` when no
  provider is configured — never silently no-op, never throw an unrelated
  error, never assume GKS is present.
- **Package layering is enforced by a test, not a convention:**
  `msp-storage` and `msp-core` are leaves; `msp-contracts` and
  `msp-retrieval` depend only on `msp-core`; `msp-client-js` is standalone;
  `apps/msp-server` composes all four runtime packages. See
  `tests/contract/dependency-boundaries.test.mjs`.
- **`docs/GATE-A.md` is the baseline, not a historical record.** A change
  that would make any of its rows false again is a regression, whether or
  not a test currently catches it.

## The seventeen-stage pipeline: MSP owns no stage

zuri-ai's ADR-050 assigns all seventeen knowledge-ingestion stages to Tier 1
(zuri-ai), Tier 3 (GKS) or Tier 4 (GenesisBlockDB). **MSP is Tier 2 — session
control, thread-id authority and memory policy — and owns none of them.**

MSP is on the path as the sole caller of GKS, which is why the fail-closed rule
above matters more as stages appear behind that bridge: a stage that silently
no-ops through an unconfigured provider would let a tracked count move on
nothing. Work framed as "MSP's part of stage N" is misfiled — see
`docs/TIER-BOUNDARY-17-STAGE.md`.
