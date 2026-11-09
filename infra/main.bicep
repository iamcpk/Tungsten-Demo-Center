// Tungsten Demo Center: full Azure environment.
// Compile to ARM for the Deploy to Azure button:  az bicep build -f infra/main.bicep --outfile infra/azuredeploy.json
//
// Security model
// - No secrets: every service-to-service call uses a user-assigned managed identity + Entra RBAC.
// - Cosmos DB key auth disabled; Storage shared-key auth disabled (uploads use user-delegation SAS).
// - Only the "media" blob container is public (served through Azure Front Door); raw uploads stay private.
// - Admin portal is a separate web app behind App Service Authentication (Entra ID, app roles).

targetScope = 'resourceGroup'

@description('Azure region for all regional resources.')
param location string = resourceGroup().location

@description('Short prefix used in resource names (lowercase letters/numbers, max 8).')
@maxLength(8)
param namePrefix string = 'tdc'

@description('App Service plan SKU. B1 is fine for testing; P0v3 or higher recommended for production.')
@allowed(['B1', 'B2', 'B3', 'P0v3', 'P1v3', 'P2v3'])
param appServiceSku string = 'B1'

@description('Container image for the public site.')
param webImage string = 'ghcr.io/iamcpk/tungsten-demo-center-web:latest'

@description('Container image for the admin portal.')
param adminImage string = 'ghcr.io/iamcpk/tungsten-demo-center-admin:latest'

@description('Container image for the HLS encoder job.')
param encoderImage string = 'ghcr.io/iamcpk/tungsten-demo-center-encoder:latest'
param importerImage string = 'ghcr.io/iamcpk/tungsten-demo-center-importer:latest'

@description('Entra ID tenant for admin sign-in. Defaults to the tenant you deploy from.')
param entraTenantId string = subscription().tenantId

@description('Client (application) ID of the admin portal app registration. Leave empty to deploy with the admin portal locked, then run scripts/configure-admin-auth.ps1.')
param entraClientId string = ''

@description('Mailbox(es) that receive contact / suggestion / demo form submissions (comma separated). Optional.')
param formsTo string = ''

@description('Object ID of a user or group that should be able to run the data importer from a workstation (Cosmos + Blob data access). Optional.')
param operatorPrincipalId string = ''

@description('Optional IP ranges (CIDR) allowed to reach the admin portal. Empty = reachable from anywhere (still requires Entra sign-in).')
param adminAllowedIpRanges array = []

@description('Data residency for Azure Communication Services.')
@allowed(['Europe', 'UK', 'United States'])
param emailDataLocation string = 'Europe'

@description('Region for Cosmos DB. Defaults to the resource group region. Set another region (for example northeurope) if Cosmos DB reports no capacity for your subscription.')
param cosmosLocation string = location

var suffix = uniqueString(resourceGroup().id)
var short = take(suffix, 6)
var names = {
  logs: '${namePrefix}-logs-${short}'
  insights: '${namePrefix}-ai-${short}'
  storage: take('${namePrefix}media${suffix}', 24)
  cosmos: '${namePrefix}-cosmos-${short}'
  plan: '${namePrefix}-plan-${short}'
  web: '${namePrefix}-web-${short}'
  admin: '${namePrefix}-admin-${short}'
  cae: '${namePrefix}-cae-${short}'
  job: '${namePrefix}-encoder-${short}'
  importJob: '${namePrefix}-import-${short}'
  afd: '${namePrefix}-afd-${short}'
  acs: '${namePrefix}-acs-${short}'
  email: '${namePrefix}-email-${short}'
}
var webUrl = 'https://${names.web}.azurewebsites.net'
var adminUrl = 'https://${names.admin}.azurewebsites.net'
var dbName = 'tdc'
var containerNames = ['videos', 'meta', 'subscribers', 'submissions']
var encodeQueue = 'encode-jobs'

// Built-in role definition IDs
var roles = {
  blobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  queueMessageSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
  queueMessageProcessor: '8a0f0c08-91a1-4084-bc3d-661d67233fed'
  queueDataReader: '19e7f393-937e-4f77-808e-94535e297925'
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
  cosmosReader: '00000000-0000-0000-0000-000000000001'
  cosmosContributor: '00000000-0000-0000-0000-000000000002'
}

// ---------------- Monitoring ----------------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.logs
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: names.insights
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id, DisableLocalAuth: false }
}

// ---------------- Identities ----------------
resource webId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: '${namePrefix}-id-web-${short}', location: location }
resource adminId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: '${namePrefix}-id-admin-${short}', location: location }
resource encoderId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: '${namePrefix}-id-encoder-${short}', location: location }

// ---------------- Storage (video masters, HLS output, thumbnails, attachments) ----------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: names.storage
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false
    allowBlobPublicAccess: true // required only for the "media" container behind Front Door
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 14 }
    containerDeleteRetentionPolicy: { enabled: true, days: 14 }
    cors: {
      corsRules: [
        {
          // Direct-to-blob uploads from the admin portal (SAS-authorised).
          allowedOrigins: [adminUrl]
          allowedMethods: ['PUT', 'GET', 'HEAD', 'OPTIONS']
          allowedHeaders: ['*']
          exposedHeaders: ['etag', 'x-ms-request-id', 'x-ms-version']
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource uploadsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'uploads'
  properties: { publicAccess: 'None' }
}

// Site backups made from the admin portal (Backup & restore page). Private: they hold internal notes and form data.
resource backupsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'backups'
  properties: { publicAccess: 'None' }
}

resource mediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'media'
  properties: { publicAccess: 'Blob' } // individual blobs readable, listing disabled
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: encodeQueue
}

// Source masters are rarely read after encoding: move them to Cool after 30 days.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'uploads-to-cool'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['uploads/'] }
            actions: { baseBlob: { tierToCool: { daysAfterModificationGreaterThan: 30 } } }
          }
        }
      ]
    }
  }
}

// ---------------- Cosmos DB (serverless, Entra-only) ----------------
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: names.cosmos
  location: cosmosLocation
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [{ locationName: cosmosLocation, failoverPriority: 0 }]
    capabilities: [{ name: 'EnableServerless' }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
    backupPolicy: { type: 'Continuous', continuousModeProperties: { tier: 'Continuous7Days' } }
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: dbName
  properties: { resource: { id: dbName } }
}

resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [for c in containerNames: {
  parent: db
  name: c
  properties: { resource: { id: c, partitionKey: { paths: ['/id'], kind: 'Hash' } } }
}]

// Anonymous video analytics: daily totals per video. Per-document TTL removes days older than 25 months.
resource analyticsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: db
  name: 'analytics'
  properties: { resource: { id: 'analytics', partitionKey: { paths: ['/id'], kind: 'Hash' }, defaultTtl: -1 } }
}

var dbScope = '${cosmos.id}/dbs/${dbName}'

// Public site: read everything, write only subscribers, submissions and analytics.
resource cosmosWebRead 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, webId.id, 'reader')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosReader}', principalId: webId.properties.principalId, scope: dbScope }
}
resource cosmosWebSubs 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, webId.id, 'subscribers')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosContributor}', principalId: webId.properties.principalId, scope: '${dbScope}/colls/subscribers' }
  dependsOn: [containers]
}
resource cosmosWebForms 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, webId.id, 'submissions')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosContributor}', principalId: webId.properties.principalId, scope: '${dbScope}/colls/submissions' }
  dependsOn: [containers]
}
resource cosmosWebAnalytics 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, webId.id, 'analytics')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosContributor}', principalId: webId.properties.principalId, scope: '${dbScope}/colls/analytics' }
  dependsOn: [analyticsContainer]
}
resource cosmosAdmin 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, adminId.id, 'contributor')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosContributor}', principalId: adminId.properties.principalId, scope: dbScope }
}
resource cosmosEncoder 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, encoderId.id, 'videos')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosContributor}', principalId: encoderId.properties.principalId, scope: '${dbScope}/colls/videos' }
  dependsOn: [containers]
}
resource cosmosOperator 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = if (!empty(operatorPrincipalId)) {
  parent: cosmos
  name: guid(cosmos.id, operatorPrincipalId, 'operator')
  properties: { roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${roles.cosmosContributor}', principalId: operatorPrincipalId, scope: dbScope }
}

// ---------------- Storage RBAC ----------------
resource adminBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, adminId.id, roles.blobDataContributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataContributor), principalId: adminId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource adminQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, adminId.id, roles.queueMessageSender)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueMessageSender), principalId: adminId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource encoderBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, encoderId.id, roles.blobDataContributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataContributor), principalId: encoderId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource encoderQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, encoderId.id, roles.queueMessageProcessor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueMessageProcessor), principalId: encoderId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource encoderQueueRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, encoderId.id, roles.queueDataReader)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueDataReader), principalId: encoderId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource operatorBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  scope: storage
  name: guid(storage.id, operatorPrincipalId, roles.blobDataContributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataContributor), principalId: operatorPrincipalId }
}

// ---------------- Email (Azure Communication Services, Azure-managed domain) ----------------
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: names.email
  location: 'global'
  properties: { dataLocation: emailDataLocation }
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  properties: { domainManagement: 'AzureManaged', userEngagementTracking: 'Disabled' }
}

resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: names.acs
  location: 'global'
  properties: { dataLocation: emailDataLocation, linkedDomains: [emailDomain.id] }
}

// Scoped to this one ACS resource; used for Entra-authenticated email sending.
resource webAcs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acs
  name: guid(acs.id, webId.id, roles.contributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor), principalId: webId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource adminAcs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acs
  name: guid(acs.id, adminId.id, roles.contributor)
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor), principalId: adminId.properties.principalId, principalType: 'ServicePrincipal' }
}

// ---------------- Azure Front Door (global CDN for HLS + images) ----------------
resource afd 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: names.afd
  location: 'global'
  sku: { name: 'Standard_AzureFrontDoor' }
}

resource afdEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: afd
  name: '${namePrefix}-media-${short}'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}

resource afdOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: afd
  name: 'media-storage'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 }
    sessionAffinityState: 'Disabled'
  }
}

resource afdOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: afdOriginGroup
  name: 'blob'
  properties: {
    hostName: '${storage.name}.blob.${environment().suffixes.storage}'
    originHostHeader: '${storage.name}.blob.${environment().suffixes.storage}'
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
  }
}

// HLS players fetch playlists/segments with XHR, so responses need a CORS header. Content is public.
resource afdRules 'Microsoft.Cdn/profiles/ruleSets@2024-02-01' = {
  parent: afd
  name: 'mediaheaders'
}

resource afdCorsRule 'Microsoft.Cdn/profiles/ruleSets/rules@2024-02-01' = {
  parent: afdRules
  name: 'cors'
  properties: {
    order: 1
    conditions: []
    actions: [
      { name: 'ModifyResponseHeader', parameters: { typeName: 'DeliveryRuleHeaderActionParameters', headerAction: 'Overwrite', headerName: 'Access-Control-Allow-Origin', value: '*' } }
      { name: 'ModifyResponseHeader', parameters: { typeName: 'DeliveryRuleHeaderActionParameters', headerAction: 'Overwrite', headerName: 'X-Content-Type-Options', value: 'nosniff' } }
    ]
  }
}

resource afdRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: afdEndpoint
  name: 'media'
  properties: {
    originGroup: { id: afdOriginGroup.id }
    originPath: '/media'
    ruleSets: [{ id: afdRules.id }]
    supportedProtocols: ['Http', 'Https']
    patternsToMatch: ['/*']
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    cacheConfiguration: {
      queryStringCachingBehavior: 'IgnoreQueryString'
      compressionSettings: {
        isCompressionEnabled: true
        contentTypesToCompress: ['application/vnd.apple.mpegurl', 'application/x-mpegURL', 'text/plain']
      }
    }
  }
  dependsOn: [afdOrigin, afdCorsRule]
}

var mediaBaseUrl = 'https://${afdEndpoint.properties.hostName}'

// ---------------- App Service (public site + admin portal) ----------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: names.plan
  location: location
  kind: 'linux'
  sku: { name: appServiceSku }
  properties: { reserved: true }
}

var commonSettings = [
  { name: 'WEBSITES_PORT', value: '8080' }
  { name: 'PORT', value: '8080' }
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DATA_MODE', value: 'cosmos' }
  { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
  { name: 'COSMOS_DATABASE', value: dbName }
  { name: 'MEDIA_BASE_URL', value: mediaBaseUrl }
  { name: 'PUBLIC_SITE_URL', value: webUrl }
  { name: 'ACS_ENDPOINT', value: 'https://${acs.properties.hostName}' }
  { name: 'MAIL_FROM', value: 'DoNotReply@${emailDomain.properties.mailFromSenderDomain}' }
  { name: 'FORMS_TO', value: formsTo }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
  { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
]

var siteBase = {
  httpsOnly: true
  clientAffinityEnabled: false
}
var siteConfigBase = {
  alwaysOn: true
  ftpsState: 'Disabled'
  minTlsVersion: '1.2'
  scmMinTlsVersion: '1.2'
  http20Enabled: true
  healthCheckPath: '/healthz'
  remoteDebuggingEnabled: false
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: names.web
  location: location
  kind: 'app,linux,container'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${webId.id}': {} } }
  properties: union(siteBase, {
    serverFarmId: plan.id
    siteConfig: union(siteConfigBase, {
      linuxFxVersion: 'DOCKER|${webImage}'
      appSettings: concat(commonSettings, [
        { name: 'AZURE_CLIENT_ID', value: webId.properties.clientId }
      ])
    })
  })
  dependsOn: [cosmosWebRead, cosmosWebSubs, cosmosWebForms, webAcs]
}

var adminIpRules = [for (cidr, i) in adminAllowedIpRanges: {
  ipAddress: cidr
  action: 'Allow'
  priority: 100 + i
  name: 'allow-${i}'
}]

resource adminSite 'Microsoft.Web/sites@2023-12-01' = {
  name: names.admin
  location: location
  kind: 'app,linux,container'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${adminId.id}': {} } }
  properties: union(siteBase, {
    serverFarmId: plan.id
    siteConfig: union(siteConfigBase, {
      linuxFxVersion: 'DOCKER|${adminImage}'
      ipSecurityRestrictions: adminIpRules
      ipSecurityRestrictionsDefaultAction: empty(adminAllowedIpRanges) ? 'Allow' : 'Deny'
      appSettings: concat(commonSettings, [
        { name: 'AZURE_CLIENT_ID', value: adminId.properties.clientId }
        { name: 'STORAGE_ACCOUNT', value: storage.name }
        { name: 'AUTH_MODE', value: 'easyauth' }
      ])
    })
  })
  dependsOn: [cosmosAdmin, adminBlob, adminQueue, adminAcs]
}

// Entra ID sign-in. Until a client ID is supplied the portal returns 401 to everyone (locked by default).
resource adminAuth 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: adminSite
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: empty(entraClientId) ? 'Return401' : 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/healthz']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: !empty(entraClientId)
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
          clientId: empty(entraClientId) ? null : entraClientId
        }
        validation: { allowedAudiences: empty(entraClientId) ? [] : [entraClientId, 'api://${entraClientId}'] }
      }
    }
    login: {
      tokenStore: { enabled: false }
      preserveUrlFragmentsForLogins: true
      cookieExpiration: { convention: 'FixedTime', timeToExpiration: '08:00:00' }
    }
    httpSettings: { requireHttps: true, forwardProxy: { convention: 'NoProxy' } }
  }
}

// Disable basic-auth publishing (FTP / SCM) on both sites.
resource webFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = { parent: web, name: 'ftp', properties: { allow: false } }
resource webScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = { parent: web, name: 'scm', properties: { allow: false } }
resource adminFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = { parent: adminSite, name: 'ftp', properties: { allow: false } }
resource adminScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = { parent: adminSite, name: 'scm', properties: { allow: false } }

// ---------------- Encoder (Container Apps Job, queue-triggered) ----------------
resource cae 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: names.cae
  location: location
  properties: {
    // Workload-profiles environment: its Consumption profile allows up to 4 vCPU / 8 GiB per replica
    // (a consumption-only environment caps at 2 vCPU / 4 GiB) and still scales to zero.
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

resource encoderJob 'Microsoft.App/jobs@2025-01-01' = {
  name: names.job
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${encoderId.id}': {} } }
  properties: {
    environmentId: cae.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Event'
      replicaTimeout: 21600 // 6 hours
      replicaRetryLimit: 0 // retries are handled through the queue dequeue count
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: 3
          pollingInterval: 30
          rules: [
            {
              name: 'encode-queue'
              type: 'azure-queue'
              metadata: { accountName: storage.name, queueName: encodeQueue, queueLength: '1' }
              identity: encoderId.id
            }
          ]
        }
      }
    }
    template: {
      containers: [
        {
          name: 'encoder'
          image: encoderImage
          resources: { cpu: json('4.0'), memory: '8Gi' }
          env: [
            { name: 'DATA_MODE', value: 'cosmos' }
            { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
            { name: 'COSMOS_DATABASE', value: dbName }
            { name: 'STORAGE_ACCOUNT', value: storage.name }
            { name: 'MEDIA_BASE_URL', value: mediaBaseUrl }
            { name: 'AZURE_CLIENT_ID', value: encoderId.properties.clientId }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
          ]
        }
      ]
    }
  }
  dependsOn: [encoderBlob, encoderQueue, encoderQueueRead, cosmosEncoder, queue]
}

// ---------------- iVengi importer (Container Apps Job, started manually) ----------------
// Reads the Excel export from the private uploads container. Runs as the admin identity, which already
// has Cosmos DB and Blob write access. Start it with arguments, for example:
//   --blob ivengi-export.xlsx            (dry run, report saved to uploads/imports/)
//   --blob ivengi-export.xlsx --write    (import)
resource importJob 'Microsoft.App/jobs@2025-01-01' = {
  name: names.importJob
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${adminId.id}': {} } }
  properties: {
    environmentId: cae.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 10800 // 3 hours
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    }
    template: {
      containers: [
        {
          name: 'importer'
          image: importerImage
          args: ['--help']
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'DATA_MODE', value: 'cosmos' }
            { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
            { name: 'COSMOS_DATABASE', value: dbName }
            { name: 'STORAGE_ACCOUNT', value: storage.name }
            { name: 'MEDIA_BASE_URL', value: mediaBaseUrl }
            { name: 'AZURE_CLIENT_ID', value: adminId.properties.clientId }
          ]
        }
      ]
    }
  }
  dependsOn: [cosmosAdmin, adminBlob]
}

// ---------------- Outputs ----------------
output publicSiteUrl string = webUrl
output adminPortalUrl string = adminUrl
output adminRedirectUri string = '${adminUrl}/.auth/login/aad/callback'
output adminWebAppName string = adminSite.name
output mediaBaseUrl string = mediaBaseUrl
output storageAccount string = storage.name
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output importJobName string = importJob.name
output mailFrom string = 'DoNotReply@${emailDomain.properties.mailFromSenderDomain}'
