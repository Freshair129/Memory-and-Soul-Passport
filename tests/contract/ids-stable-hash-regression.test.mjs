// RKOI round-1 WARNING 7: domain/ids.mjs's stableId() used to join `parts`
// with a LITERAL, embedded U+0000 byte (not the two-character `\0` escape
// sequence), which made git treat the whole file as binary and hide every
// future diff to this function -- including the hand-copy mismatch RKOI's
// own review round could not root-cause. The fix replaces the literal byte
// with the `"\0"` escape; the two must be byte-identical at runtime (both
// parse to the same single NUL character), so every id this function has
// ever minted must still hash identically.
//
// These expected values are NOT copied from stableId()'s own output --
// that would just prove the function agrees with itself after being
// edited. Each one is independently recomputed here with Node's own
// crypto, joining on `String.fromCharCode(0)` (a real NUL character built
// at runtime, never typed as a literal byte in this source file either),
// sha256, first 24 hex chars -- the exact algorithm the file's own header
// comment documents, verified against a second implementation.
import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { stableId } from "@freshair129/msp-core/ids";

function referenceStableId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(parts.join(String.fromCharCode(0)), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

const cases = [
  { args: ["vault", "shared", "project-abc"], expected: "vault_1104c19bbbb67d2ebfad921a" },
  { args: ["vault", "workspace-private", "workspace-xyz"], expected: "vault_c6d28869f984897fe9a1caeb" },
  { args: ["vault", "global-private", "agent-123"], expected: "vault_b6645e216269ffbb767174f9" },
  {
    args: ["vault", "principal-private", "tenant-1", "principal-1", "agent-1", "workspace-1", "0"],
    expected: "vault_c6511f5b5101a0b3b747261e",
  },
  { args: ["vault-mount", "vault_deadbeef", "workspace-1", "alias-1"], expected: "vault-mount_46e1a479b3f7307775d2a063" },
];

for (const { args, expected } of cases) {
  it(`stableId(${args.map((a) => JSON.stringify(a)).join(", ")}) is unchanged by the \\0-escape edit`, () => {
    // Sanity: this file's own independent reference implementation agrees
    // with the pinned literal (catches a typo in the pinned value itself).
    expect(referenceStableId(...args)).toBe(expected);
    // The real check: the shipped stableId() -- post-edit -- produces the
    // exact same id it always did.
    expect(stableId(...args)).toBe(expected);
  });
}
