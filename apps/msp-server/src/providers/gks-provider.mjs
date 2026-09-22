import { GksProviderUnavailableError } from "@freshair129/msp-contracts/errors";
import { createGksHttpProviderFromEnvironment } from "./gks-http-provider.mjs";
import { createGksProviderFromEnvironment as createGksStdioProviderFromEnvironment } from "./gks-stdio-provider.mjs";

export function createGksProviderFromEnvironment(env = process.env) {
  const transport = env.MSP_GKS_TRANSPORT?.trim().toLowerCase() || "stdio";
  if (transport === "stdio") return createGksStdioProviderFromEnvironment(env);
  if (transport === "http") return createGksHttpProviderFromEnvironment(env);
  throw new GksProviderUnavailableError("gks_provider_unavailable: MSP_GKS_TRANSPORT must be stdio or http.");
}
