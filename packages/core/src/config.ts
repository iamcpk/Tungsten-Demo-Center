/**
 * Central configuration read from environment variables.
 * In Azure every value is set by the Bicep template; no secrets are needed because
 * all service access uses managed identity.
 */
export interface CoreConfig {
  /** "cosmos" in Azure, "local" for a JSON file database during development. */
  dataMode: 'cosmos' | 'local';
  localDataDir: string;
  cosmosEndpoint?: string;
  cosmosDatabase: string;
  storageAccount?: string;
  /** Public base URL that serves the "media" container (Front Door endpoint). */
  mediaBaseUrl: string;
  /** Client id of the user-assigned managed identity, when one is used. */
  managedIdentityClientId?: string;
  acsEndpoint?: string;
  mailFrom?: string;
  formsTo?: string;
  publicSiteUrl: string;
}

export const CONTAINERS = {
  videos: 'videos',
  meta: 'meta',
  subscribers: 'subscribers',
  submissions: 'submissions',
  analytics: 'analytics',
} as const;

export const BLOB_CONTAINERS = {
  uploads: 'uploads',
  media: 'media',
} as const;

export const ENCODE_QUEUE = 'encode-jobs';

export function isRunningInAzure(): boolean {
  return Boolean(process.env.WEBSITE_SITE_NAME || process.env.CONTAINER_APP_NAME || process.env.CONTAINER_APP_JOB_NAME);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const dataMode = (env.DATA_MODE ?? (env.COSMOS_ENDPOINT ? 'cosmos' : 'local')) as CoreConfig['dataMode'];
  if (dataMode !== 'cosmos' && dataMode !== 'local') throw new Error(`Invalid DATA_MODE "${dataMode}"`);
  if (dataMode === 'local' && isRunningInAzure()) {
    throw new Error('DATA_MODE=local is not allowed when running in Azure');
  }
  if (dataMode === 'cosmos' && !env.COSMOS_ENDPOINT) throw new Error('COSMOS_ENDPOINT is required when DATA_MODE=cosmos');
  return {
    dataMode,
    localDataDir: env.LOCAL_DATA_DIR ?? 'data',
    cosmosEndpoint: env.COSMOS_ENDPOINT,
    cosmosDatabase: env.COSMOS_DATABASE ?? 'tdc',
    storageAccount: env.STORAGE_ACCOUNT,
    mediaBaseUrl: (env.MEDIA_BASE_URL ?? 'http://localhost:4000/media').replace(/\/$/, ''),
    managedIdentityClientId: env.AZURE_CLIENT_ID,
    acsEndpoint: env.ACS_ENDPOINT,
    mailFrom: env.MAIL_FROM,
    formsTo: env.FORMS_TO,
    publicSiteUrl: (env.PUBLIC_SITE_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  };
}
