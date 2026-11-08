# Security design

## Identity and access
- **No stored secrets.** All three workloads (public site, admin portal, encoder) use their own user-assigned managed identity. Cosmos DB has local (key) auth disabled. The storage account has shared-key auth disabled.
- **Least privilege (data plane):**

  | Identity | Cosmos DB | Storage | Email |
  |---|---|---|---|
  | Public site | Read all; write `subscribers`, `submissions` only | none | send |
  | Admin portal | Read/write database | Blob Data Contributor, Queue Message Sender | send |
  | Encoder | Read/write `videos` only | Blob Data Contributor, Queue Message Processor + Reader | none |

- **Admin portal sign-in:** App Service Authentication with Entra ID. The enterprise app requires role assignment, so only users given `Admin` or `Creator` (or the older `Editor`) can sign in. The API checks roles on every call. Approval rights come from the in-app approver list that only `Admin` can change, so the app needs no Microsoft Graph permissions. Content Creators cannot publish: a video becomes public only through the approve action, approvers cannot approve their own submissions (administrators can), and creators cannot change a published video or its files. Only `Admin` can see subscribers and form submissions, delete videos, or change the approver list. Every submit, approve, request-changes and approver change is written to the audit log. The portal deploys **locked** (401 for everyone) until `configure-admin-auth.ps1` connects an app registration.
- **Optional IP allow-list** for the admin portal (`adminAllowedIpRanges` parameter).
- Basic-auth publishing (FTP/SCM) is disabled on both web apps. HTTPS only, TLS 1.2 minimum.

## Uploads
- Browsers upload directly to Blob Storage with a **user-delegation SAS** (signed by Entra ID, never an account key). Each SAS covers one blob, allows create/write only, uses HTTPS only, and expires after 6 hours (videos) or 2 hours (attachments).
- Allowed file extensions and maximum sizes are enforced server-side. Thumbnails go through the server, which checks their magic bytes.
- Raw uploads stay in the private `uploads` container. Only encoder output, thumbnails and attachments live in the public `media` container. Blob listing is disabled there.
- Storage CORS allows only the admin portal origin.

## Web application
- Strict Content-Security-Policy (no inline scripts; frames limited to Vimeo / YouTube-nocookie), HSTS, `frame-ancestors 'none'`, nosniff, referrer policy.
- All input is validated with zod. Rich descriptions are sanitised with an allow-list on write and again on read.
- Admin API CSRF protection: a custom header is required on state-changing requests, plus an Origin check.
- Public forms: rate limiting per IP, honeypot field, minimum fill time. Subscriptions use **double opt-in**, and the endpoint responds the same way whether or not an address exists. Unsubscribing takes a POST, so mail scanners can't unsubscribe people by prefetching the link.
- CSV export escapes formula characters (CSV injection).
- No tracking cookies. Vimeo embeds use `dnt=1` and YouTube uses the privacy-enhanced domain, so no cookie banner is needed for the site itself. **Confirm this with Legal / Privacy before go-live.**

## Personal data (GDPR)
Subscriber emails and form submissions are personal data. They are stored in the deployment region (West Europe recommended), and email data residency is set to Europe. Admins can delete individual subscribers (erasure requests). Before go-live, agree retention periods, the privacy notice wording and the lawful basis with Legal / Privacy and Compliance.

## Supply chain
Dependabot (npm, Actions, Docker), `npm audit` in CI, and images built in GitHub Actions with SBOM and provenance attestations.

## Known trade-offs / hardening options
- `media` container is publicly readable (required for Front Door Standard). Front Door Premium with Private Link would let it go private (higher cost).
- Email-send permission uses Contributor scoped to the single ACS resource. A custom role could narrow this.
- Cosmos DB and Storage use public endpoints protected by Entra RBAC. Private endpoints + VNet integration are an option for stricter environments.
- Front Door WAF managed rules need the Premium tier.
