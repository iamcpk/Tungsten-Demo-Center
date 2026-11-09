# Tungsten Demo Center

Video hosting and metadata platform for the Tungsten Automation Solutions Consulting demo library. It replaces the iVengi-hosted site at tungstendemocenter.com.

- **Public site**: browse, search and filter by product, business line (Intelligent Automation / Print & Workplace Automation), industry, language and presenter. Search matches partial words, ignores case, accents, spaces and punctuation ("modern auth" finds "Modern-Auth"), allows small typos, supports "quoted phrases", and includes archived videos unless the visitor turns that off. Current videos always come first, then a "From the archive" section, each in best-match order. The same search powers the admin Videos list. Includes the archive, attachments, email subscriptions, and contact / suggest-a-video / request-a-demo forms.
- **Admin portal** (separate URL, Entra ID sign-in): manage metadata, upload videos, attach files, manage lists, notify subscribers and read form submissions, with **two-stage publishing** (see [Roles and approval](#roles-and-approval)).
- **Branding** (Administrators only): colours, fonts, logos, favicon, home-screen and link-preview images, header menu, home page, footer and page text. See [Branding](#branding).
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

## Branding

Administrators change the public site's look and wording on the admin portal's **Branding** page, without a redeploy.

- **Draft, preview, publish.** Edits are saved as a draft that visitors don't see. **Preview on site** creates a private link (valid 24 hours, one at a time) that shows the draft on the real public site with a preview banner. **Publish** makes it live within about 30 seconds.
- **History.** The last 20 published versions are kept with who published them and an optional note. Any version can be restored into the draft, and **Reset to Tungsten default branding** returns every setting to the original Tungsten look and wording in one step (then publish).
- **Colours** with a WCAG 2.1 AA contrast check for every text and background pair the site uses.
- **Fonts** for headings and body text: a curated Google Fonts list, device fonts, or an uploaded WOFF2 file served from the site's own domain (self-hosted, so no visitor data goes to Google).
- **Images:** header and footer logos, favicon (also used by the admin portal), phone home-screen icon and link-preview image. Files are checked by content, size and shape; SVGs with scripts, event handlers or external references are refused. Uploaded files are stored under `branding/` in the media container with content-hash names and served from the sites' own `/brand/` path.
- **Text:** site name, header menu (labels, order, visibility, button style, links to built-in pages, https or mailto addresses), home page sections, footer, privacy policy link and the headings and introductions on the other pages. All text is stored as plain text.

The subscription consent wording is deliberately not editable, because it is stored with each subscriber as a record of consent. Workflow and subscriber emails keep their fixed wording.

## Backup and restore

Administrators back up and restore the site on the admin portal's **Backup & restore** page.

- **Choose what to include** with tick boxes: videos and their details, lists & tags, thumbnails, attachments, uploaded videos (playable streams and, optionally, the original files), branding settings, branding files, the approvers list, subscribers, the form inbox and import files. Subscribers are unticked by default because they are personal data.
- **Where backups live:** a private `backups` container in the site's storage account. Data from Cosmos DB is saved as JSON, and files are copied inside Azure Storage, so large backups never pass through a browser. Each backup is a folder: `manifest.json` (written last, with a SHA-256 for every part), `data/`, and `files/`.
- **Nightly backup** after a chosen hour (UTC, default 02:00) with the components you choose, keeping the last 14 by default. A blob lease ensures only one app instance runs it. Manual and imported backups are kept until deleted; the last 10 safety copies are kept.
- **Restore** any ticked parts of a backup, by **Merge** (add and overwrite, keep anything newer) or **Replace** (make those parts match the backup exactly). A safety backup of the same parts is always taken first, so every restore can be undone. Backups are checked for damage or tampering before anything is written, and subscribers who unsubscribed after a backup stay unsubscribed.
- **Moving to a new Azure instance:** deploy the template to the new subscription or resource group and set up Entra ID sign-in and roles (these are not in a backup). Make an **Everything** backup on the old site, then either import it on the new site with a short-lived container SAS URL (Read + List) for the old `backups` container, copy the folder with AzCopy (`azcopy copy "https://<old>.blob.core.windows.net/backups/<backup>?<sas>" "https://<new>.blob.core.windows.net/backups/" --recursive`), or, for data only, use **Download data** and upload the file. Then **Restore** it. All paths are relative, so content works on the new address.
- Cosmos DB also keeps Azure's own continuous point-in-time backup (7 days). That restores into the same account and is the better tool after a regional outage; this page covers everything else, including moving the site.

## Video analytics

Approvers and administrators see the **Analytics** page in the admin portal.

- **What is counted:** page views, plays, watch time (only time actually played, not skipped), how many plays reached 25%, 50% and 75%, and how many reached the end (95% or more). It works for Vimeo, YouTube and uploaded videos.
- **Anonymous:** no cookies, no local storage, no visitor or session IDs, and no IP address, user agent or location is stored. The database only holds totals per video per day. Known bots and automated browsers are ignored, and branding previews are not counted.
- **The page:** defaults to the last 30 days, sorted by plays (most watched first). Choose last 7, 30 or 90 days, this month, last month, the last 12 months, all available data, or a custom range. Filter by text, status, product, business line and source, sort by any column, see a daily trend for all videos or one video, compare totals with the previous period of the same length, and export the table as CSV.
- **History:** daily totals are kept for 25 months and then deleted automatically, so every month can be compared with the same month a year earlier. Lifetime totals per video are kept. Data starts on the day tracking was switched on; there is no history from before that (the old iVengi site's statistics are not imported). Days are in UTC, and counts appear within about a minute.
- Analytics are included in backups ("Video analytics", ticked by default).

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
