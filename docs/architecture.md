# Architecture notes

## Data model (Cosmos DB, database `tdc`, all containers partitioned on `/id`)

| Container | Contents |
|---|---|
| `videos` | One document per video/document item: metadata, source (Vimeo / YouTube / Azure HLS), thumbnail, attachments, status, audit fields, `legacyId` (iVengi contentindex) |
| `meta` | Single `taxonomy` document: managed lists of products, categories, industries, languages, presenters |
| `subscribers` | id = sha256(email); status pending / confirmed / unsubscribed; product interests; consent text |
| `submissions` | Contact / suggest / demo form entries |

The catalogue is a few thousand items at most. The public site loads it into memory (refreshing every 60 seconds) and does search, filtering and facet counts in-process. That keeps responses fast and Cosmos serverless costs near zero, with no separate search service to run. If the library grows past ~20k items, add Azure AI Search.

## iVengi field mapping

| iVengi column | New field |
|---|---|
| contentindex | `legacyId` (and a deterministic `id`) |
| Title / Page title | `title` / `pageTitle` |
| Short description / Page description | `shortDescription` |
| Long text | `description` (sanitised HTML) |
| Video url | `source` (Vimeo id + privacy hash, or YouTube id) |
| Set the status of the video | `status` (Active → active, Archived → archived) |
| Select the type of video (IA / PA) | `businessLines` (Intelligent Automation / Print & Workplace Automation) |
| Select products / verticals / authors / languages / categories | `products` / `verticals` / `authors` / `languages` / `categories` |
| Enter keywords | `keywords` |
| Upload a file (x5) + File name (x5) | `attachments` (copied into Blob Storage) |
| Overwrite default image | `thumbnailPath` (copied), else Vimeo/YouTube oEmbed thumbnail |
| Internal notifications/comments | `internalNotes` (never public) |
| Date | `publishedAt` |
| Group = "Test group" | imported as `draft` |
| Rating | dropped (ratings are not carried forward) |

Old links like `/items/<slug>` redirect (301) to `/videos/<slug>`, and slugs are generated the same way iVengi made them.

## Encoding pipeline
1. Admin creates a draft with source "Upload file" and picks a file.
2. Admin API issues a write-only SAS for `uploads/<videoId>/<timestamp>-<name>`, and the browser uploads in parallel 8 MB blocks.
3. `upload-complete` checks the blob exists, marks the video `queued` and puts a message on `encode-jobs`.
4. KEDA starts a Container Apps Job execution (4 vCPU / 8 GiB). It streams the source through a read SAS, encodes each rendition in turn (H.264/AAC, 6 s segments, aligned GOPs), uploads it and deletes the local copy to keep disk use down.
5. The master playlist goes to `media/hls/<videoId>/<runId>/master.m3u8`. A poster frame is captured if there is no thumbnail. The video is marked `ready`.
6. Failures are retried up to 3 times through the queue dequeue count, then marked `failed` with the ffmpeg error. Editors can retry from the portal.

The versioned `<runId>` path means a re-encode never conflicts with cached Front Door content. The previous version is deleted after the new one is live.

## Custom domains (later)
When DNS is ready: add `www.tungstendemocenter.com` to the public web app and `admin.tungstendemocenter.com` to the admin web app (App Service managed certificates), optionally give Front Door a `media.` domain, then update `PUBLIC_SITE_URL`, the Storage CORS origin and the app registration redirect URI.
