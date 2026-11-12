# Security design

## Identity and access
- **No stored secrets.** All three workloads (public site, admin portal, encoder) use their own user-assigned managed identity. Cosmos DB has local (key) auth disabled. The storage account has shared-key auth disabled.
- **Least privilege (data plane):**

  | Identity | Cosmos DB | Storage | Email |
  |---|---|---|---|
  | Public site | Read all; write `subscribers`, `submissions`, `analytics` only | none | send |
  | Admin portal | Read/write database | Blob Data Contributor, Queue Message Sender | send |
  | Encoder | Read/write `videos` only | Blob Data Contributor, Queue Message Processor + Reader | none |

- **Admin portal sign-in:** App Service Authentication with Entra ID. The enterprise app requires role assignment, so only users given `Admin`, `Approver` or `Creator` (or the older `Editor`) can sign in. The API checks roles on every call. Approval rights come from the Entra `Approver` role or from the in-app approver list that only `Admin` can change. Entra role holders are copied to the approver email list when they sign in; that copy is for email only and never grants rights, so removing the Entra role removes approval rights at the next sign-in. The app needs no Microsoft Graph permissions. Content Creators cannot publish: a video becomes public only through the approve action, approvers cannot approve their own submissions (administrators can), and creators cannot change a published video or its files. Only `Admin` can see subscribers and form submissions, delete videos, or change the approver list. Every submit, approve, request-changes and approver change is written to the audit log. The portal deploys **locked** (401 for everyone) until `configure-admin-auth.ps1` connects an app registration.
- **Optional IP allow-list** for the admin portal (`adminAllowedIpRanges` parameter).
- Basic-auth publishing (FTP/SCM) is disabled on both web apps. HTTPS only, TLS 1.2 minimum.

## Branding
- Only `Admin` can read or change branding, upload brand files, create preview links or publish. Every action is audit-logged.
- Settings are validated with zod: colours must be `#rrggbb`, fonts come from a fixed list or a `[A-Za-z0-9 -]` name, links must be a built-in page, `https://` or `mailto:`, and all text is stripped to plain text. The CSS and HTML the server writes into the page are built only from these validated values, and the JSON data block escapes `<`.
- Brand files are checked by their content (magic bytes), size and, for icons, shape. SVGs containing scripts, event handlers, `foreignObject`, DTDs, script URLs or references to other files are refused. When served, SVGs also get a `sandbox` Content-Security-Policy.
- Preview links carry a random 192-bit token. Only its SHA-256 is stored; it expires after 24 hours and is cancelled by a new link, a publish or a discard. Preview pages are `noindex` and `no-store`.
- Google Fonts send each visitor's IP address to Google. Self-hosted font upload is available; **confirm the font approach with Legal / Privacy before go-live.**

## Backup and restore
- Only `Admin` can see, create, download, restore or delete backups or change the nightly schedule. Every action is audit-logged with the user.
- Backups are stored in the private `backups` container (no public access; Front Door serves only `media`). They contain internal notes and, if ticked, personal data.
- Each backup's manifest records a SHA-256 of every data file and file list. A restore stops before changing anything if a checksum, document shape or file name is wrong (no absolute paths, no `..`, fixed prefixes only).
- Every restore first takes a safety backup of the parts being restored. Restores never re-subscribe someone who unsubscribed after the backup, and Replace never deletes unsubscribe records.
- One backup or restore runs at a time, enforced by a blob lease across app instances.
- Importing from another storage account accepts only `https://<account>.blob.core.windows.net/<container>` URLs with a SAS that has Read and List. The SAS is used once and is never stored or logged.
- Uploaded backup files are limited to 200 MB, must be a Demo Center data export, and are validated like any other backup.
- Subscribers are excluded by default. **Agree how long backups containing personal data may be kept with Legal / Privacy**; nightly retention is configurable.

## Video analytics
- Approvers and administrators see the Analytics page. Content Creators don't.
- Collection is anonymous by design. The public site reports only "video X was opened, played, reached 25/50/75%, finished, or played for N seconds". No cookies, local storage, visitor IDs or session IDs are used. The IP address is used in memory by the rate limiter and the user agent to drop bots; neither is stored or logged. Nothing is written to the visitor's device, so no consent banner is needed for it. **Confirm this with Legal / Privacy before go-live.**
- The database holds only totals per video per day, written about once a minute from memory, plus lifetime totals per video. Updates use ETag checks so several app instances never overwrite each other.
- Abuse limits: 60 tracking requests per minute per client, at most 40 events per request, each one-off event counted once per video per request, watch time capped at 120 seconds per request, unknown video IDs ignored, and requests from other sites refused (`Sec-Fetch-Site`).
- Retention: daily totals are kept for 25 months (so any month can be compared with the same month a year earlier) and then deleted automatically by Cosmos DB TTL. Lifetime totals are kept. The page only offers dates inside the stored range and starts at the day tracking began.
- The YouTube embed now uses `enablejsapi=1` with the site's `origin` so the page can read playback progress through `postMessage`; it still uses the privacy-enhanced youtube-nocookie.com domain.

## Uploads
- Browsers upload directly to Blob Storage with a **user-delegation SAS** (signed by Entra ID, never an account key). Each SAS covers one blob, allows create/write only, uses HTTPS only, and expires after 6 hours (videos) or 2 hours (attachments).
- Allowed file extensions and maximum sizes are enforced server-side. Thumbnails go through the server, which checks their magic bytes.
- Caption files (.vtt or .srt, up to 2 MB) go through the server, which parses them and stores a rewritten WebVTT file: only cue timings, simple positioning settings and text with `<b>`, `<i>` and `<u>` are kept, and everything else (styles, regions, other markup, control characters) is removed. The public site relays caption files from its own origin so the player can load them without opening up storage CORS.
- Raw uploads stay in the private `uploads` container. Only encoder output, thumbnails and attachments live in the public `media` container. Blob listing is disabled there.
- Storage CORS allows only the admin portal origin.

## Web application
- Strict Content-Security-Policy (no inline scripts; frames limited to Vimeo / YouTube-nocookie), HSTS, `frame-ancestors 'none'`, nosniff, referrer policy.
- All input is validated with zod. Rich descriptions are sanitised with an allow-list on write and again on read.
- Admin API CSRF protection: a custom header is required on state-changing requests, plus an Origin check.
- Public forms: rate limiting per IP, honeypot field, minimum fill time. Subscriptions use **double opt-in**, and the endpoint responds the same way whether or not an address exists. Confirming and unsubscribing both take a POST from a page with a button, so mail scanners (for example Microsoft Defender Safe Links), which open every link in incoming mail, can't confirm or unsubscribe anyone, and can't use up the link before the person clicks it. Confirming is safe to repeat, and an old confirmation link never re-subscribes an address that has unsubscribed. Pages opened from emails are `noindex` and `no-store`.
- CSV export escapes formula characters (CSV injection).
- No tracking cookies. Vimeo embeds use `dnt=1` and YouTube uses the privacy-enhanced domain, so no cookie banner is needed for the site itself. **Confirm this with Legal / Privacy before go-live.**

## Personal data (GDPR)
Subscriber emails and form submissions are personal data. They are stored in the deployment region (West Europe recommended), and email data residency is set to Europe. Admins can delete individual subscribers (erasure requests). Before go-live, agree retention periods, the privacy notice wording and the lawful basis with Legal / Privacy and Compliance.

## Supply chain
Dependabot (npm, Actions, Docker), `npm audit` in CI, and images built in GitHub Actions with SBOM and provenance attestations.

## Known trade-offs / hardening options
- Backups live in the same storage account as the site. Soft delete (14 days) covers accidental deletion; for protection against losing the whole account, copy backups to a second account or add an immutability policy.
- `media` container is publicly readable (required for Front Door Standard). Front Door Premium with Private Link would let it go private (higher cost).
- Email-send permission uses Contributor scoped to the single ACS resource. A custom role could narrow this.
- Cosmos DB and Storage use public endpoints protected by Entra RBAC. Private endpoints + VNet integration are an option for stricter environments.
- Front Door WAF managed rules need the Premium tier.
