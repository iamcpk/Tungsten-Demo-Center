# Tungsten Demo Center

Video hosting and metadata platform for the Tungsten Automation Solutions Consulting demo library. It replaces the iVengi-hosted site at tungstendemocenter.com.

- **Public site**: browse, search and filter by product, business line (Intelligent Automation / Print & Workplace Automation), industry, language and presenter. Includes the archive, attachments, email subscriptions, and contact / suggest-a-video / request-a-demo forms.
- **Admin portal** (separate URL, Entra ID sign-in): manage metadata, upload videos, attach files, manage lists, notify subscribers and read form submissions, with **two-stage publishing** (see [Roles and approval](#roles-and-approval)).
- **Video sources**: existing Vimeo videos stay on Vimeo. New videos can be a Vimeo link, a YouTube link, or a file uploaded to Azure and streamed as adaptive HLS through Azure Front Door.

## Deploy it

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fiamcpk%2FTungsten-Demo-Center%2Fmain%2Finfra%2Fazuredeploy.json)

1. **Images.** The `Publish container images` workflow builds `ghcr.io/iamcpk/tungsten-demo-center-{web,admin,encoder}` on every push to `main`. They take the public visibility of this repo, so Azure pulls them without credentials. If you fork into a private repo, set each package to **Public** under *Packages > Package settings*.
2. **Click Deploy to Azure.** Pick a resource group and region (West Europe recommended). Every parameter has a default. `formsTo` sets the mailbox that receives form submissions.
3. **Turn on admin sign-in.** The admin portal is deployed **locked** and returns 401 until an Entra ID app registration is connected. From a terminal signed in with `az login`, run:
   ```powershell
   ./scripts/configure-admin-auth.ps1 -ResourceGroup <your-resource-group>
   ```
   The script creates the app registration with `Administrator` (`Admin`), `Approver` and `Content Creator` (`Creator`) roles, requires role assignment, assigns you `Admin`, and enables sign-in on the admin web app. To keep the app registration in a separate Entra tenant (for example a test tenant), add `-EntraTenant <tenant>.onmicrosoft.com`. On later redeploys, pass the `entraClientId` and `entraTenantId` values the script prints, or the admin portal goes back to locked.
   If Cosmos DB reports no capacity in your region, redeploy with `cosmosLocation` set to another region (for example `germanywestcentral`).
4. **Import the existing catalogue** (see [Import from iVengi](#import-from-ivengi)).

The deployment outputs give you the public site URL, the admin portal URL and the media (Front Door) URL.

### What gets created

| Resource | Purpose |
|---|---|
| App Service plan (Linux) + 2 Web Apps | Public site and admin portal, each a container from GHCR |
| Azure Cosmos DB (NoSQL, serverless) | Videos, lists, subscribers, form submissions. Key auth disabled |
| Storage account | `uploads` (private source files), `media` (HLS, thumbnails, attachments), `encode-jobs` queue. Shared-key auth disabled |
| Azure Front Door Standard | Global CDN in front of the `media` container |
| Container Apps environment + Job | ffmpeg HLS encoder, started per upload by a queue trigger, scales to zero |
| Azure Communication Services + Email | Subscription confirmations, new-video notifications, form alerts (Azure-managed sender domain) |
| 3 user-assigned managed identities | One per workload, least-privilege RBAC. No secrets anywhere |
| Log Analytics + Application Insights | Logs, metrics, admin audit trail |

## Roles and approval

| Role | Who | Can do | How it is granted |
|---|---|---|---|
| **Administrator** | Platform owners | Everything, including the approver list, subscribers, form inbox and deleting videos. Can approve any video, including their own. | Entra app role `Admin` |
| **Approver** | Reviewers | Everything a Content Creator can, plus approve or send back videos, edit or unpublish published videos, maintain Lists & tags and email subscribers. Cannot approve a video they submitted. | Entra app role `Approver` (recommended), or added on the admin portal's **Approvers** page |
| **Content Creator** | Solutions Consultants | Add videos, edit unpublished videos, submit them for approval. Published videos are read-only to them. | Entra app role `Creator` (the older `Editor` role also counts) |
| **Consumer** | Anyone | Watch and browse the public site. No sign-in. | Public |

A video moves through **Draft → Awaiting approval → Active / Archived**. Only Active and Archived videos appear on the public site, and a video only becomes public through **Approve**, which records the approver. Submitting a video emails everyone on the approver list. People given the Entra `Approver` role join that list automatically the first time they sign in, and leave it when the role is removed, because the portal can't read Entra role assignments without Microsoft Graph permissions. Approving or requesting changes emails the creator, and a change request includes the approver's comment.

## Architecture

```
                 Visitors                                        Editors (Entra ID)
                    │                                                   │
        ┌───────────▼───────────┐                         ┌─────────────▼────────────┐
        │  Public site (Web App) │                         │  Admin portal (Web App)   │
        │  React + Express       │                         │  Easy Auth + app roles    │
        └──┬──────────────┬─────┘                         └──┬───────────┬────────┬───┘
   read    │              │ subscribe/forms        metadata  │  SAS URL  │ enqueue │
           ▼              ▼                                  ▼           ▼         ▼
     ┌──────────────────────────┐   ┌─────────────────┐   ┌───────────────────────────┐
     │ Cosmos DB (serverless)   │◄──┤ ACS Email       │   │ Storage: uploads │ media  │
     └──────────────▲───────────┘   └─────────────────┘   │          queue: encode-jobs│
                    │ status                                └──▲───────┬──────────▲───┘
                    │                       browser uploads ───┘       │ trigger  │ HLS out
             ┌──────┴───────────────────────────────────────┐          │          │
             │ Container Apps Job: ffmpeg → 1080/720/480 HLS ├──────────┘──────────┘
             └──────────────────────────────────────────────┘
                                                 ▲
     Players ── HLS / images ── Azure Front Door ┘ (media container)
     Vimeo / YouTube videos play from their own players (privacy-enhanced embeds)
```

**Why this streaming design:** Azure Media Services was retired on Jun 30, 2024, so Azure no longer has a managed encoder. Uploads go **straight from the browser to Blob Storage** with a short-lived, single-file, write-only SAS. That handles multi-GB files with parallel 8 MB blocks and never routes the file through the web server. A queue-triggered Container Apps Job converts each upload into an adaptive HLS ladder (no upscaling) plus a poster image. Front Door caches and serves it worldwide. Playback uses native HLS on Safari/iOS and hls.js elsewhere.

More detail: [docs/architecture.md](docs/architecture.md) · [docs/security.md](docs/security.md)

## Repo layout

```
packages/core     Shared types, data store (Cosmos / local JSON), Blob + queue, email, search, validation
apps/web          Public site: Express API + React (Vite) SPA
apps/admin        Admin portal: Express API + React (Vite) SPA
apps/encoder      ffmpeg HLS encoder (Container Apps Job)
tools/importer    iVengi Excel export importer
infra             main.bicep + compiled azuredeploy.json (Deploy to Azure)
scripts           configure-admin-auth.ps1 (Entra app registration + roles)
docker            Dockerfiles for the three images
```

## Local development

Requires Node.js 22 or later (24 LTS recommended). Without Azure settings everything runs against a JSON store and files in `./data`.

```bash
npm install
cp .env.example .env
npm run import -- --file "iVengi Export/Video Data 7 Nov 2026.xlsx" --write --no-files
npm run dev:web      # http://localhost:5173
npm run dev:admin    # http://localhost:5174  (AUTH_MODE=dev signs you in as a local admin)
```

`AUTH_MODE=dev` is refused automatically when the app detects it is running in Azure or with `NODE_ENV=production`.

## Import from iVengi

The importer reads the iVengi Excel export, untangles its multi-value fields, maps `IA` / `PA` to the business lines, and copies thumbnails and attachments from iVengi into Blob Storage. Video ids are derived from the iVengi `contentindex`, so you can run it again safely. **Re-running overwrites admin edits for the rows it imports.**

```bash
# 1. Dry run: writes data/import-report.json, saves nothing
npm run import -- --file "iVengi Export/Video Data 7 Nov 2026.xlsx"

# 2. Into Azure (your az login needs data roles: deploy with operatorPrincipalId = your object ID)
#    PowerShell:
$env:DATA_MODE="cosmos"; $env:COSMOS_ENDPOINT="<output cosmosEndpoint>"; $env:STORAGE_ACCOUNT="<output storageAccount>"; $env:MEDIA_BASE_URL="<output mediaBaseUrl>"
npm run import -- --file "iVengi Export/Video Data 7 Nov 2026.xlsx" --write
```

Rows in the iVengi "Test group" and videos without a playable URL are imported as **drafts**. Check `import-report.json` for anything that needs attention.

> The export contains internal notes and staff names. It is listed in `.gitignore`. Never commit it.

## License

All rights reserved. See [LICENSE](LICENSE). Any open-source license needs approval from Tungsten Automation Legal.
