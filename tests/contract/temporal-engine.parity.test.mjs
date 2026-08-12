// AC-05: domain/temporal-engine's bitemporal behavior matches
// scripts/mcp/temporal-versioning.mjs on the same fixture inputs.
//
// This is a test-only reach-across into scripts/mcp/temporal-versioning.mjs
// (relative import out of the package), explicitly sanctioned by WP-12
// since it exists to prove parity, not to create a runtime dependency --
// packages/msp-runtime/src/domain/temporal-engine.mjs is a vendored PORT and
// never imports scripts/mcp/* itself (see that file's header comment).
import { describe, expect, it } from "vitest";

import * as reference from "../fixtures/temporal-versioning.mjs";
import * as vendored from "@freshair129/msp-core/temporal-engine";

const fixedNow = "2026-08-04T12:00:00.000Z";

describe("domain/temporal-engine parity vs scripts/mcp/temporal-versioning.mjs (AC-05)", () => {
  const createInputs = [
    {},
    { version: "3" },
    { validFrom: "2024-01-01T00:00:00Z" },
    { validFrom: "2024-01-01T00:00:00Z", validTo: "2024-06-01T00:00:00Z" },
    { recordedAt: "2024-01-01T00:00:00Z", supersededAt: "2024-02-01T00:00:00Z" },
  ];

  it("createTemporalVersion matches across fixture inputs", () => {
    for (const input of createInputs) {
      expect(vendored.createTemporalVersion(input, fixedNow)).toEqual(reference.createTemporalVersion(input, fixedNow));
    }
  });

  const visibilityCases = [
    {
      name: "no as-of given: defaults both to now",
      item: { validFrom: "2020-01-01T00:00:00Z", recordedAt: "2020-01-01T00:00:00Z" },
      options: {},
    },
    {
      name: "exact validFrom boundary is visible",
      item: { validFrom: "2024-01-01T00:00:00Z", recordedAt: "2024-01-01T00:00:00Z" },
      options: { asOfValidAt: "2024-01-01T00:00:00Z", asOfRecordedAt: "2024-01-01T00:00:00Z" },
    },
    {
      name: "just before validFrom is not visible",
      item: { validFrom: "2024-01-01T00:00:00Z", recordedAt: "2024-01-01T00:00:00Z" },
      options: { asOfValidAt: "2023-12-31T23:59:59Z", asOfRecordedAt: "2024-01-01T00:00:00Z" },
    },
    {
      name: "exact validTo boundary is visible (inclusive)",
      item: { validFrom: "2024-01-01T00:00:00Z", validTo: "2024-06-01T00:00:00Z", recordedAt: "2024-01-01T00:00:00Z" },
      options: { asOfValidAt: "2024-06-01T00:00:00Z", asOfRecordedAt: "2024-01-01T00:00:00Z" },
    },
    {
      name: "just after validTo is not visible",
      item: { validFrom: "2024-01-01T00:00:00Z", validTo: "2024-06-01T00:00:00Z", recordedAt: "2024-01-01T00:00:00Z" },
      options: { asOfValidAt: "2024-06-01T00:00:00.001Z", asOfRecordedAt: "2024-01-01T00:00:00Z" },
    },
    {
      name: "supersededAt boundary: asOfRecordedAt equal to supersededAt is NOT visible (exclusive)",
      item: {
        validFrom: "2024-01-01T00:00:00Z",
        recordedAt: "2024-01-01T00:00:00Z",
        supersededAt: "2024-03-01T00:00:00Z",
      },
      options: { asOfValidAt: "2024-02-01T00:00:00Z", asOfRecordedAt: "2024-03-01T00:00:00Z" },
    },
    {
      name: "just before supersededAt is visible",
      item: {
        validFrom: "2024-01-01T00:00:00Z",
        recordedAt: "2024-01-01T00:00:00Z",
        supersededAt: "2024-03-01T00:00:00Z",
      },
      options: { asOfValidAt: "2024-02-01T00:00:00Z", asOfRecordedAt: "2024-02-29T23:59:59Z" },
    },
    {
      name: "out-of-order recordedAt (asOfRecordedAt before recordedAt) is not visible",
      item: { validFrom: "2024-01-01T00:00:00Z", recordedAt: "2024-05-01T00:00:00Z" },
      options: { asOfValidAt: "2024-06-01T00:00:00Z", asOfRecordedAt: "2024-01-01T00:00:00Z" },
    },
    {
      name: "future-dated validFrom relative to as-of is not visible",
      item: { validFrom: "2030-01-01T00:00:00Z", recordedAt: "2024-01-01T00:00:00Z" },
      options: { asOfValidAt: "2024-06-01T00:00:00Z", asOfRecordedAt: "2024-06-01T00:00:00Z" },
    },
    {
      name: "invalid validFrom timestamp is not visible in either implementation",
      item: { validFrom: "not-a-date", recordedAt: "2024-01-01T00:00:00Z" },
      options: { asOfValidAt: "2024-06-01T00:00:00Z", asOfRecordedAt: "2024-06-01T00:00:00Z" },
    },
  ];

  it("isTemporalVisible matches across 10 fixture cases (boundaries, ordering, invalid input)", () => {
    for (const testCase of visibilityCases) {
      const vendoredResult = vendored.isTemporalVisible(testCase.item, testCase.options);
      const referenceResult = reference.isTemporalVisible(testCase.item, testCase.options);
      expect(vendoredResult, testCase.name).toBe(referenceResult);
    }
  });

  const orderCases = [
    {},
    { validFrom: "2024-01-01T00:00:00Z", validTo: "2024-06-01T00:00:00Z" },
    { validFrom: "2024-06-01T00:00:00Z", validTo: "2024-01-01T00:00:00Z" }, // invalid: validFrom after validTo
    { recordedAt: "2024-01-01T00:00:00Z", supersededAt: "2023-01-01T00:00:00Z" }, // invalid: recordedAt after supersededAt
    { validFrom: "not-a-date" },
  ];

  it("compareTemporalOrder matches across fixture inputs", () => {
    for (const input of orderCases) {
      expect(vendored.compareTemporalOrder(input)).toEqual(reference.compareTemporalOrder(input));
    }
  });

  const nextVersionCases = [
    [],
    [{ version: "1" }],
    [{ version: "1" }, { version: "2" }, { version: "5" }],
    [{ version: "not-numeric" }],
    [{ version: "3" }, { version: "3" }],
  ];

  it("nextVersion matches across fixture inputs", () => {
    for (const records of nextVersionCases) {
      expect(vendored.nextVersion(records)).toEqual(reference.nextVersion(records));
    }
  });
});
