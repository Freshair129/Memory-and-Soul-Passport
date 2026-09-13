// API-011 thread memory (TASK-MEMOS-002): ajv-backed request/response
// validation, loaded from the machine-readable contract file. Pure --
// no DB, no msp-core import. ajv/ajv-formats are third-party dependencies of
// msp-contracts (see packages/msp-contracts/package.json); they do not
// change this package's internal-workspace dependency boundary.
import { readFileSync } from "node:fs";

import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contract = JSON.parse(readFileSync(new URL("../../schemas/API-011.tools.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validators = new Map(
  contract.tools.map((tool) => [
    tool.name,
    {
      input: ajv.compile({ ...tool.inputSchema, $defs: contract.$defs }),
      output: tool.outputSchema ? ajv.compile({ ...tool.outputSchema, $defs: contract.$defs }) : null,
    },
  ]),
);

export function validateThreadContract(name, value, direction = "input") {
  const validate = validators.get(name)?.[direction];
  if (validate && !validate(value)) {
    throw new Error(`validation_failed: MSP_THREAD_${direction.toUpperCase()}_CONTRACT_MISMATCH for ${name}`);
  }
}
