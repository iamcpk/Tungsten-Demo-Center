import { DefaultAzureCredential, ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import type { CoreConfig } from './config.js';

let cached: TokenCredential | undefined;

/**
 * Managed identity in Azure (user-assigned when AZURE_CLIENT_ID is set),
 * developer sign-in (az login / VS Code) locally.
 */
export function getCredential(config: CoreConfig): TokenCredential {
  if (!cached) {
    cached = config.managedIdentityClientId
      ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
      : new DefaultAzureCredential();
  }
  return cached;
}
