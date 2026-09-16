import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import { ThreadValidationError } from "./errors.mjs";

const contract = JSON.parse(readFileSync(new URL("../../schemas/PHASE6.tools.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
const validators = new Map(contract.tools.map((tool) => [tool.name, {
  input: ajv.compile({ ...tool.inputSchema, $defs: contract.$defs }),
  output: ajv.compile({ ...tool.outputSchema, $defs: contract.$defs }),
}]));

export function validateConsolidationContract(name, value, direction = "input") {
  const validate = validators.get(name)?.[direction];
  if (!validate || !validate(value)) throw new ThreadValidationError(`PHASE6_${direction.toUpperCase()}_CONTRACT_MISMATCH for ${name}`);
}
