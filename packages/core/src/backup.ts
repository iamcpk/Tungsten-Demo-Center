/**
 * Site backup and restore.
 *
 * A backup is a folder in the private "backups" blob container:
 *
 *   <id>/status.json                 progress while running (and the error if it failed)
 *   <id>/data/<component>.json       documents from Cosmos DB, as a JSON array
 *   <id>/files/<component>/index.json  list of files: name, size, content type, MD5
 *   <id>/files/<component>/blobs/... the files themselves (server-side copies)
 *   <id>/manifest.json               written last; a backup without one is incomplete
 *
 * The manifest records a SHA-256 for every data file and file index, so a damaged or edited
 * backup is refused before anything is restored. Everything is stored with relative paths,
 * so a backup restores into the same site or into a new Azure deployment.
 */
import { createHash, randomBytes } from 'node:crypto';
import { BLOB_CONTAINERS, type CoreConfig } from './config.js';
import { brandingSchema } from './branding.js';
import { withDefaults } from './branding-model.js';
import { taxonomySchema } from './schemas.js';
import type { Doc, Store, Stores } from './store.js';
import type { BackupStorage, BlobEntry, StorageLock } from './backup-storage.js';

export const BACKUP_CONTAINER = 'backups';
export const BACKUP_FORMAT = 'tdc-backup';
export const BACKUP_FORMAT_VERSION = 1;
const LOCK_BLOB = '.lock';
const SETTINGS_ID = 'backup-settings';
/** A running backup that hasn't reported progress for this long was interrupted (for example by a restart). */
const STALE_MS = 10 * 60_000;
const COPY_CONCURRENCY = 8;
const KEEP_PRE_RESTORE = 10;

export type BackupTrigger = 'manual' | 'nightly' | 'pre-restore' | 'uploaded' | 'imported';
/** yyyymmddThhmmssmmmZ-trigger-random: sorts by time to the millisecond. */
export const BACKUP_ID = /^\d{8}T\d{9}Z-(manual|nightly|pre-restore|uploaded|imported)-[a-z0-9]{6}$/;

// ---------- components ----------
export type DataComponent = 'videos' | 'taxonomy' | 'approvers' | 'branding' | 'subscribers' | 'submissions' | 'analytics';
export type FileComponent = 'thumbnails' | 'attachments' | 'brandFiles' | 'videoStreams' | 'videoOriginals' | 'importFiles';
export type BackupComponentKey = DataComponent | FileComponent;

export interface BackupComponent {
  key: BackupComponentKey;
  label: string;
  description: string;
  group: 'Content' | 'Site settings' | 'People' | 'Other';
  kind: 'data' | 'files';
  /** Ticked by default for new backups and the nightly backup. */
  defaultOn: boolean;
  personalData?: boolean;
  /** Restoring this without these may leave broken references (shown as a warning). */
  pairsWith?: BackupComponentKey[];
}

export const BACKUP_COMPONENTS: BackupComponent[] = [
  { key: 'videos', label: 'Videos and their details', description: 'Every video and document: titles, descriptions, tags, status, approval history, links to Vimeo/YouTube and internal notes.', group: 'Content', kind: 'data', defaultOn: true, pairsWith: ['thumbnails', 'attachments', 'videoStreams'] },
  { key: 'taxonomy', label: 'Lists & tags', description: 'Products, industries, presenters, languages and categories.', group: 'Content', kind: 'data', defaultOn: true },
  { key: 'thumbnails', label: 'Thumbnails', description: 'Thumbnail images stored on the site (uploaded, imported or refreshed from Vimeo/YouTube).', group: 'Content', kind: 'files', defaultOn: true, pairsWith: ['videos'] },
  { key: 'attachments', label: 'Attachments', description: 'Files attached to videos (PDFs, slides, documents).', group: 'Content', kind: 'files', defaultOn: true, pairsWith: ['videos'] },
  { key: 'videoStreams', label: 'Uploaded videos (playable)', description: 'Encoded streams of videos uploaded directly to the site. Can be large.', group: 'Content', kind: 'files', defaultOn: true, pairsWith: ['videos'] },
  { key: 'videoOriginals', label: 'Uploaded videos (original files)', description: 'The original files uploaded for encoding. Only needed to re-encode. Can be very large.', group: 'Content', kind: 'files', defaultOn: false, pairsWith: ['videos'] },
  { key: 'branding', label: 'Branding settings', description: 'Published branding, the current draft and version history.', group: 'Site settings', kind: 'data', defaultOn: true, pairsWith: ['brandFiles'] },
  { key: 'brandFiles', label: 'Branding files', description: 'Uploaded logos, favicon, home-screen icon, social image and fonts.', group: 'Site settings', kind: 'files', defaultOn: true, pairsWith: ['branding'] },
  { key: 'approvers', label: 'Approvers list', description: 'People added on the Approvers page. Entra ID roles are managed in Entra and are not part of a backup.', group: 'Site settings', kind: 'data', defaultOn: true },
  { key: 'subscribers', label: 'Subscribers', description: 'Email subscribers and their product interests. Personal data: include only when you need it.', group: 'People', kind: 'data', defaultOn: false, personalData: true },
  { key: 'submissions', label: 'Form inbox', description: 'Contact, suggest-a-video and demo requests. Contains names and email addresses.', group: 'People', kind: 'data', defaultOn: true, personalData: true },
  { key: 'analytics', label: 'Video analytics', description: 'Anonymous daily view and watch-time totals for each video. No personal data.', group: 'Other', kind: 'data', defaultOn: true },
  { key: 'importFiles', label: 'Import files', description: 'Files and reports from the original site import. Rarely needed.', group: 'Other', kind: 'files', defaultOn: false },
];
export const COMPONENT_KEYS = BACKUP_COMPONENTS.map((c) => c.key);
export const DEFAULT_COMPONENTS = BACKUP_COMPONENTS.filter((c) => c.defaultOn).map((c) => c.key);
const componentOf = (k: BackupComponentKey) => BACKUP_COMPONENTS.find((c) => c.key === k)!;

/** Whole containers, or single documents (all in the Cosmos "meta" container; separate files in local dev). */
type DataSource = { store: 'videos' | 'subscribers' | 'submissions' | 'analytics' } | { single: 'meta' | 'approvers' | 'branding'; meta: string };
const DATA_SOURCES: Record<DataComponent, DataSource> = {
  videos: { store: 'videos' },
  taxonomy: { single: 'meta', meta: 'taxonomy' },
  approvers: { single: 'approvers', meta: 'approvers' },
  branding: { single: 'branding', meta: 'branding' },
  subscribers: { store: 'subscribers' },
  submissions: { store: 'submissions' },
  analytics: { store: 'analytics' },
};

const UUID_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;
const FILE_SOURCES: Record<FileComponent, { container: string; prefix: string; match?: RegExp }> = {
  thumbnails: { container: BLOB_CONTAINERS.media, prefix: 'thumbs/' },
  attachments: { container: BLOB_CONTAINERS.media, prefix: 'attachments/' },
  brandFiles: { container: BLOB_CONTAINERS.media, prefix: 'branding/' },
  videoStreams: { container: BLOB_CONTAINERS.media, prefix: 'hls/' },
  // Original uploads sit in uploads/<video id>/...; the rest of that container is import material.
  videoOriginals: { container: BLOB_CONTAINERS.uploads, prefix: '', match: UUID_FOLDER },
  importFiles: { container: BLOB_CONTAINERS.uploads, prefix: 'imports/' },
};
const isData = (k: BackupComponentKey): k is DataComponent => k in DATA_SOURCES;

// ---------- manifest and status ----------
export interface ComponentSummary { kind: 'data' | 'files'; items: number; bytes: number; sha256: string }

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  id: string;
  trigger: BackupTrigger;
  createdAt: string;
  completedAt: string;
  createdBy: string;
  note?: string;
  app: { version?: string };
  /** Where the backup came from. Informational: restores never depend on these values. */
  source: { publicSiteUrl: string; mediaBaseUrl: string; storageAccount?: string; cosmosDatabase: string };
  components: Partial<Record<BackupComponentKey, ComponentSummary>>;
}

interface StatusFile {
  id: string;
  state: 'running' | 'failed';
  trigger: BackupTrigger;
  createdBy: string;
  startedAt: string;
  updatedAt: string;
  components: BackupComponentKey[];
  error?: string;
}

export interface BackupSummary {
  id: string;
  state: 'complete' | 'running' | 'failed' | 'interrupted';
  trigger: BackupTrigger;
  createdAt: string;
  createdBy: string;
  note?: string;
  bytes: number;
  components: Partial<Record<BackupComponentKey, ComponentSummary>> | BackupComponentKey[];
  error?: string;
  source?: BackupManifest['source'];
}

export interface FileIndexEntry { name: string; size: number; contentType?: string; md5?: string }

export interface BackupSettings {
  id: typeof SETTINGS_ID;
  nightly: boolean;
  /** Hour of day (UTC) after which the nightly backup runs. */
  hourUtc: number;
  /** Nightly backups to keep. */
  keep: number;
  components: BackupComponentKey[];
  updatedAt?: string;
  updatedBy?: string;
}
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { id: SETTINGS_ID, nightly: true, hourUtc: 2, keep: 14, components: DEFAULT_COMPONENTS };

export type JobKind = 'backup' | 'restore' | 'import';
export interface JobState {
  kind: JobKind;
  backupId: string;
  by: string;
  startedAt: string;
  phase: string;
  done: number;
  total: number;
  finishedAt?: string;
  error?: string;
  result?: string;
}

export type RestoreMode = 'merge' | 'replace';

export class BackupError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

// ---------- helpers ----------
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8');
const SAFE_DOC_ID = /^[A-Za-z0-9._:@-]{1,200}$/;

export function newBackupId(trigger: BackupTrigger, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const rand = randomBytes(6).toString('base64').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(6, '0').slice(0, 6);
  return `${stamp}-${trigger}-${rand}`;
}

/** Relative file names inside a backup: no absolute paths, no "..", no control characters. */
function safeRelName(n: unknown): n is string {
  return typeof n === 'string' && n.length > 0 && n.length <= 1024 && !n.startsWith('/') && !n.includes('\\')
    && !n.split('/').some((p) => p === '..' || p === '.' || p === '') && !/[\u0000-\u001f]/.test(n);
}

function stripSystem<T>(doc: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (!k.startsWith('_')) out[k] = v;
  return out as T;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
const strArr = (v: unknown) => Array.isArray(v) && v.every(str);

/** Checks one document before it is written. Returns a problem, or undefined when it is fine. */
export function docProblem(key: DataComponent, d: unknown): string | undefined {
  if (!isObj(d) || !str(d.id) || !SAFE_DOC_ID.test(d.id as string)) return 'missing or invalid id';
  switch (key) {
    case 'videos':
      if (!/^[0-9a-f-]{36}$/i.test(d.id as string)) return 'video id is not a UUID';
      if (!str(d.title) || !str(d.slug)) return 'missing title or slug';
      if (!['draft', 'pending', 'active', 'archived'].includes(d.status as string)) return 'invalid status';
      if (!isObj(d.source) || !['vimeo', 'youtube', 'azure'].includes(d.source.provider as string)) return 'invalid video source';
      for (const f of ['products', 'verticals', 'authors', 'languages', 'categories', 'keywords', 'businessLines']) if (!strArr(d[f])) return `${f} is not a list`;
      if (!Array.isArray(d.attachments)) return 'attachments is not a list';
      return undefined;
    case 'taxonomy':
      if (d.id !== 'taxonomy') return 'wrong id';
      return taxonomySchema.safeParse(d).success ? undefined : 'lists are not valid';
    case 'approvers':
      if (d.id !== 'approvers' || !Array.isArray(d.people)) return 'not an approver list';
      return (d.people as unknown[]).every((p) => isObj(p) && str(p.email) && (p.email as string).includes('@')) ? undefined : 'approver without a valid email';
    case 'branding': {
      if (d.id !== 'branding' || !Array.isArray(d.history)) return 'not a branding document';
      const ok = (s: unknown) => brandingSchema.safeParse(withDefaults(s as never)).success;
      if (isObj(d.published) && !ok(d.published.settings)) return 'published branding is not valid';
      if (isObj(d.draft) && !ok(d.draft.settings)) return 'draft branding is not valid';
      return undefined;
    }
    case 'subscribers':
      if (!str(d.email) || !(d.email as string).includes('@')) return 'invalid email';
      return ['pending', 'confirmed', 'unsubscribed'].includes(d.status as string) ? undefined : 'invalid status';
    case 'submissions':
      return ['contact', 'suggest', 'demo'].includes(d.type as string) ? undefined : 'invalid form type';
    case 'analytics': {
      if (!isObj(d.videos) || !Object.values(d.videos).every((c) => isObj(c) && Object.values(c).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))) return 'counts are not valid';
      if (d.kind === 'totals') return d.id === 'totals' ? undefined : 'wrong id';
      return d.kind === 'day' && str(d.day) && d.id === `day-${d.day as string}` ? undefined : 'not an analytics day';
    }
  }
}

/** Runs tasks with a fixed number in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ---------- engine ----------
export interface BackupEngineOptions {
  stores: Stores;
  storage: BackupStorage;
  config: CoreConfig;
  appVersion?: string;
  log?: (event: Record<string, unknown>) => void;
  /** Called after a restore so caches (branding, approvers...) can be dropped. */
  onRestored?: (components: BackupComponentKey[]) => void;
}

export class BackupEngine {
  private job?: JobState;
  private ready?: Promise<void>;
  private nightlyAttempts = new Map<string, number>();

  constructor(private readonly o: BackupEngineOptions) {}

  private get s() { return this.o.storage; }
  private log(e: Record<string, unknown>) { (this.o.log ?? ((x) => console.info(JSON.stringify(x))))({ audit: true, ...e, at: new Date().toISOString() }); }
  private init() { return (this.ready ??= this.s.ensureContainer(BACKUP_CONTAINER).catch((e) => { this.ready = undefined; throw e; })); }

  /** The running job, or the last one to finish (kept so the page can show the outcome). */
  currentJob(): JobState | undefined { return this.job ? { ...this.job } : undefined; }
  isBusy() { return !!this.job && !this.job.finishedAt; }

  private dataStore(key: DataComponent): Store<Doc> {
    const src = DATA_SOURCES[key];
    return ('store' in src ? this.o.stores[src.store] : this.o.stores[src.single]) as unknown as Store<Doc>;
  }

  private async readData(key: DataComponent): Promise<Doc[]> {
    const src = DATA_SOURCES[key];
    if ('store' in src) return (await this.dataStore(key).list()).map(stripSystem);
    const d = await this.dataStore(key).get(src.meta);
    return d ? [stripSystem(d)] : [];
  }

  private async *sourceFiles(key: FileComponent): AsyncIterable<BlobEntry> {
    const src = FILE_SOURCES[key];
    for await (const b of this.s.list(src.container, src.prefix)) {
      if (src.match && !src.match.test(b.name)) continue;
      if (b.name.endsWith('/')) continue;
      yield b;
    }
  }

  /** Item counts and sizes for each component, shown next to the tick boxes. */
  async estimate(): Promise<Record<BackupComponentKey, { items: number; bytes: number }>> {
    const out = {} as Record<BackupComponentKey, { items: number; bytes: number }>;
    await Promise.all(COMPONENT_KEYS.map(async (k) => {
      if (isData(k)) {
        const docs = await this.readData(k);
        out[k] = { items: docs.length, bytes: json(docs).length };
      } else {
        let items = 0; let bytes = 0;
        for await (const b of this.sourceFiles(k)) { items++; bytes += b.size; }
        out[k] = { items, bytes };
      }
    }));
    return out;
  }

  private async lock(): Promise<StorageLock> {
    await this.init();
    if (this.isBusy()) throw new BackupError(409, 'A backup or restore is already running. Wait for it to finish.');
    const l = await this.s.tryLock(BACKUP_CONTAINER, LOCK_BLOB);
    if (!l) throw new BackupError(409, 'A backup or restore is already running. Wait for it to finish.');
    return l;
  }

  private startJob(kind: JobKind, backupId: string, by: string, total: number) {
    this.job = { kind, backupId, by, startedAt: new Date().toISOString(), phase: 'Starting', done: 0, total };
  }
  private step(phase: string, add = 1) { if (this.job) { this.job.phase = phase; this.job.done += add; } }
  private finishJob(error?: string, result?: string) {
    if (this.job) { this.job.finishedAt = new Date().toISOString(); this.job.error = error; this.job.result = result; }
  }

  /**
   * Start a backup in the background. Returns its id at once; progress is on currentJob().
   * Throws BackupError(409) when another backup or restore is running.
   */
  async startBackup(opts: { components: BackupComponentKey[]; by: string; note?: string; trigger?: BackupTrigger; now?: Date }): Promise<string> {
    const components = this.cleanComponents(opts.components);
    if (!components.length) throw new BackupError(400, 'Choose at least one part of the site to back up.');
    const lock = await this.lock();
    const id = newBackupId(opts.trigger ?? 'manual', opts.now);
    this.startJob('backup', id, opts.by, components.length);
    void (async () => {
      let error: string | undefined;
      try { await this.runBackup(id, components, opts.by, opts.trigger ?? 'manual', opts.note); } catch (e) { error = (e as Error).message; }
      // Release before reporting the job finished, so the next job can start as soon as this one shows as done.
      await lock.release();
      if (!error) await this.applyRetention().catch((e) => console.error('backup retention failed', e));
      this.finishJob(error, error ? undefined : `Backup ${id} completed`);
    })();
    return id;
  }

  private cleanComponents(list: unknown): BackupComponentKey[] {
    if (!Array.isArray(list)) return [];
    return COMPONENT_KEYS.filter((k) => list.includes(k));
  }

  /** The backup itself. Caller holds the lock. */
  private async runBackup(id: string, components: BackupComponentKey[], by: string, trigger: BackupTrigger, note?: string): Promise<BackupManifest> {
    const startedAt = new Date().toISOString();
    const status: StatusFile = { id, state: 'running', trigger, createdBy: by, startedAt, updatedAt: startedAt, components };
    const writeStatus = () => this.s.write(BACKUP_CONTAINER, `${id}/status.json`, json({ ...status, updatedAt: new Date().toISOString() }), 'application/json');
    await writeStatus();
    let lastStatus = Date.now();
    const heartbeat = async () => { if (Date.now() - lastStatus > 30_000) { lastStatus = Date.now(); await writeStatus(); } };
    this.log({ action: 'backup.start', target: id, user: by, components });
    try {
      const summary: BackupManifest['components'] = {};
      for (const key of components) {
        const label = componentOf(key).label;
        if (isData(key)) {
          this.step(`Backing up ${label}`, 0);
          const docs = await this.readData(key);
          const buf = json(docs);
          await this.s.write(BACKUP_CONTAINER, `${id}/data/${key}.json`, buf, 'application/json');
          summary[key] = { kind: 'data', items: docs.length, bytes: buf.length, sha256: sha256(buf) };
        } else {
          const src = FILE_SOURCES[key];
          const files: BlobEntry[] = [];
          for await (const b of this.sourceFiles(key)) files.push(b);
          if (this.job) this.job.total += files.length;
          await pool(files, COPY_CONCURRENCY, async (b) => {
            const rel = b.name.slice(src.prefix.length);
            await this.s.copy({ container: src.container, name: b.name }, { container: BACKUP_CONTAINER, name: `${id}/files/${key}/blobs/${rel}` });
            this.step(`Copying ${label}`);
            await heartbeat();
          });
          const index: FileIndexEntry[] = files.map((b) => ({ name: b.name.slice(src.prefix.length), size: b.size, contentType: b.contentType, md5: b.md5 }));
          const buf = json(index);
          await this.s.write(BACKUP_CONTAINER, `${id}/files/${key}/index.json`, buf, 'application/json');
          summary[key] = { kind: 'files', items: files.length, bytes: files.reduce((n, b) => n + b.size, 0), sha256: sha256(buf) };
        }
        this.step(`Backed up ${label}`);
        await heartbeat();
      }
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, id, trigger, createdAt: startedAt, completedAt: new Date().toISOString(),
        createdBy: by, note: note?.slice(0, 300) || undefined, app: { version: this.o.appVersion },
        source: { publicSiteUrl: this.o.config.publicSiteUrl, mediaBaseUrl: this.o.config.mediaBaseUrl, storageAccount: this.o.config.storageAccount, cosmosDatabase: this.o.config.cosmosDatabase },
        components: summary,
      };
      // The manifest is the commit marker: written last, so a half-finished backup is never offered for restore.
      await this.s.write(BACKUP_CONTAINER, `${id}/manifest.json`, json(manifest), 'application/json');
      await this.s.delete(BACKUP_CONTAINER, `${id}/status.json`);
      this.log({ action: 'backup.complete', target: id, user: by, items: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v!.items])) });
      return manifest;
    } catch (e) {
      status.state = 'failed';
      status.error = (e as Error).message.slice(0, 500);
      await writeStatus().catch(() => undefined);
      this.log({ action: 'backup.failed', target: id, user: by, error: status.error });
      throw e;
    }
  }

  async readManifest(id: string): Promise<BackupManifest> {
    if (!BACKUP_ID.test(id)) throw new BackupError(400, 'Invalid backup id');
    await this.init();
    if (!(await this.s.exists(BACKUP_CONTAINER, `${id}/manifest.json`))) throw new BackupError(404, 'Backup not found, or it did not finish.');
    let m: BackupManifest;
    try { m = JSON.parse((await this.s.read(BACKUP_CONTAINER, `${id}/manifest.json`)).toString('utf8')); } catch { throw new BackupError(422, 'The backup manifest is damaged.'); }
    if (m.format !== BACKUP_FORMAT || typeof m.formatVersion !== 'number') throw new BackupError(422, 'This is not a Demo Center backup.');
    if (m.formatVersion > BACKUP_FORMAT_VERSION) throw new BackupError(422, 'This backup was made by a newer version of the Demo Center. Update the site before restoring it.');
    if (m.id !== id) throw new BackupError(422, 'The backup manifest does not match its folder.');
    return m;
  }

  async list(): Promise<BackupSummary[]> {
    await this.init();
    const ids = (await this.s.listFolders(BACKUP_CONTAINER, '')).filter((f) => BACKUP_ID.test(f));
    const out: BackupSummary[] = [];
    await pool(ids, 8, async (id) => {
      try {
        if (await this.s.exists(BACKUP_CONTAINER, `${id}/manifest.json`)) {
          const m = await this.readManifest(id);
          out.push({ id, state: 'complete', trigger: m.trigger, createdAt: m.createdAt, createdBy: m.createdBy, note: m.note, components: m.components, source: m.source,
            bytes: Object.values(m.components).reduce((n, c) => n + (c?.bytes ?? 0), 0) });
          return;
        }
        const st = JSON.parse((await this.s.read(BACKUP_CONTAINER, `${id}/status.json`)).toString('utf8')) as StatusFile;
        const live = this.job && !this.job.finishedAt && this.job.backupId === id;
        const stale = Date.now() - Date.parse(st.updatedAt) > STALE_MS;
        out.push({ id, state: st.state === 'failed' ? 'failed' : live || !stale ? 'running' : 'interrupted', trigger: st.trigger, createdAt: st.startedAt, createdBy: st.createdBy,
          bytes: 0, components: st.components, error: st.error });
      } catch {
        out.push({ id, state: 'interrupted', trigger: (BACKUP_ID.exec(id)?.[1] as BackupTrigger) ?? 'manual', createdAt: '', createdBy: '', bytes: 0, components: [] });
      }
    });
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async delete(id: string, by: string): Promise<number> {
    if (!BACKUP_ID.test(id)) throw new BackupError(400, 'Invalid backup id');
    if (this.isBusy() && this.job?.backupId === id) throw new BackupError(409, 'That backup is being used right now.');
    await this.init();
    let n = 0;
    const names: string[] = [];
    for await (const b of this.s.list(BACKUP_CONTAINER, `${id}/`)) names.push(b.name);
    // Manifest first, so a partly deleted backup can never be offered for restore.
    names.sort((a, b) => (a.endsWith('/manifest.json') ? -1 : b.endsWith('/manifest.json') ? 1 : 0));
    for (const name of names) { await this.s.delete(BACKUP_CONTAINER, name); n++; }
    this.log({ action: 'backup.delete', target: id, user: by, files: n });
    return n;
  }

  /** Delete nightly backups beyond the retention count, old pre-restore safety copies, and old failures. */
  async applyRetention(): Promise<string[]> {
    const settings = await this.getSettings();
    const all = await this.list();
    const removed: string[] = [];
    const drop = async (b: BackupSummary) => { await this.delete(b.id, 'retention'); removed.push(b.id); };
    const complete = (t: BackupTrigger) => all.filter((b) => b.trigger === t && b.state === 'complete');
    for (const b of complete('nightly').slice(settings.keep)) await drop(b);
    for (const b of complete('pre-restore').slice(KEEP_PRE_RESTORE)) await drop(b);
    const twoDays = Date.now() - 2 * 86_400_000;
    for (const b of all) if ((b.state === 'failed' || b.state === 'interrupted') && b.createdAt && Date.parse(b.createdAt) < twoDays) await drop(b);
    return removed;
  }

  // ---------- restore ----------
  /** Loads and verifies everything needed for a restore before anything is changed. */
  private async loadForRestore(m: BackupManifest, components: BackupComponentKey[]) {
    const data = new Map<DataComponent, Doc[]>();
    const files = new Map<FileComponent, FileIndexEntry[]>();
    for (const key of components) {
      const c = m.components[key];
      if (!c) throw new BackupError(400, `This backup does not include ${componentOf(key).label}.`);
      const path = isData(key) ? `${m.id}/data/${key}.json` : `${m.id}/files/${key}/index.json`;
      const buf = await this.s.read(BACKUP_CONTAINER, path).catch(() => { throw new BackupError(422, `${componentOf(key).label}: part of the backup is missing.`); });
      if (sha256(buf) !== c.sha256) throw new BackupError(422, `${componentOf(key).label}: the backup has been changed or damaged (checksum mismatch). Nothing was restored.`);
      let parsed: unknown;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch { throw new BackupError(422, `${componentOf(key).label}: the backup is damaged.`); }
      if (!Array.isArray(parsed)) throw new BackupError(422, `${componentOf(key).label}: the backup is damaged.`);
      if (isData(key)) {
        const seen = new Set<string>();
        parsed.forEach((d, i) => {
          const p = docProblem(key, d);
          if (p) throw new BackupError(422, `${componentOf(key).label}: item ${i + 1} is not valid (${p}). Nothing was restored.`);
          const id = (d as Doc).id;
          if (seen.has(id)) throw new BackupError(422, `${componentOf(key).label}: item ${id} appears twice. Nothing was restored.`);
          seen.add(id);
        });
        data.set(key, (parsed as Doc[]).map(stripSystem));
      } else {
        for (const f of parsed as FileIndexEntry[]) {
          if (!isObj(f) || !safeRelName(f.name) || typeof f.size !== 'number') throw new BackupError(422, `${componentOf(key).label}: the file list contains an invalid entry. Nothing was restored.`);
          const src = FILE_SOURCES[key];
          if (src.match && !src.match.test(src.prefix + f.name)) throw new BackupError(422, `${componentOf(key).label}: unexpected file ${f.name}. Nothing was restored.`);
        }
        files.set(key, parsed as FileIndexEntry[]);
      }
    }
    return { data, files };
  }

  /**
   * Restore selected parts of a backup in the background.
   * merge: add and overwrite items from the backup, keep everything else.
   * replace: make the selected parts match the backup exactly (items added since are removed).
   * A safety backup of the same parts is taken first, so a restore can itself be undone.
   */
  async startRestore(opts: { id: string; components: BackupComponentKey[]; mode: RestoreMode; by: string }): Promise<{ safetyBackupId: string }> {
    if (opts.mode !== 'merge' && opts.mode !== 'replace') throw new BackupError(400, 'Choose Merge or Replace.');
    const components = this.cleanComponents(opts.components);
    if (!components.length) throw new BackupError(400, 'Choose at least one part of the backup to restore.');
    const m = await this.readManifest(opts.id);
    const lock = await this.lock();
    try {
      const loaded = await this.loadForRestore(m, components);
      const safetyId = newBackupId('pre-restore');
      const totalFiles = [...loaded.files.values()].reduce((n, f) => n + f.length, 0);
      this.startJob('restore', opts.id, opts.by, components.length * 2 + totalFiles);
      void (async () => {
        let error: string | undefined;
        let result: string | undefined;
        let safetyDone = false;
        try {
          this.step('Taking a safety backup first', 0);
          await this.runBackup(safetyId, components, opts.by, 'pre-restore', `Automatic copy taken before restoring ${opts.id}`);
          safetyDone = true;
          this.step('Safety backup done', components.length);
          const counts = await this.applyRestore(m, loaded, opts.mode);
          this.log({ action: 'backup.restore', target: opts.id, user: opts.by, mode: opts.mode, components, safetyBackupId: safetyId, counts });
          this.o.onRestored?.(components);
          result = `Restored ${components.map((k) => componentOf(k).label).join(', ')} from ${opts.id} (${opts.mode}). Safety backup: ${safetyId}.`;
        } catch (e) {
          this.log({ action: 'backup.restore-failed', target: opts.id, user: opts.by, error: (e as Error).message, safetyBackupId: safetyId });
          error = safetyDone
            ? `${(e as Error).message} Restore the safety backup ${safetyId} to undo any partial changes.`
            : `${(e as Error).message} The safety backup could not be taken, so nothing was restored.`;
        }
        await lock.release();
        if (!error) await this.applyRetention().catch(() => undefined);
        this.finishJob(error, result);
      })();
      return { safetyBackupId: safetyId };
    } catch (e) {
      await lock.release();
      throw e;
    }
  }

  private async applyRestore(m: BackupManifest, loaded: Awaited<ReturnType<BackupEngine['loadForRestore']>>, mode: RestoreMode) {
    const counts: Record<string, { written: number; removed: number; skipped?: number }> = {};
    for (const [key, docs] of loaded.data) {
      const label = componentOf(key).label;
      this.step(`Restoring ${label}`, 0);
      const store = this.dataStore(key);
      const src = DATA_SOURCES[key];
      const current = await this.readData(key);
      const currentById = new Map(current.map((d) => [d.id, d]));
      let written = 0; let removed = 0; let skipped = 0;
      for (const doc of docs) {
        // Never re-subscribe someone who unsubscribed after the backup was taken.
        if (key === 'subscribers') {
          const now = currentById.get(doc.id) as { status?: string } | undefined;
          if (now?.status === 'unsubscribed' && (doc as { status?: string }).status !== 'unsubscribed') { skipped++; continue; }
        }
        await store.upsert(doc);
        written++;
      }
      if (mode === 'replace') {
        const keep = new Set(docs.map((d) => d.id));
        for (const d of current) {
          if (keep.has(d.id)) continue;
          // Keep unsubscribe records: deleting them would lose the person's opt-out.
          if (key === 'subscribers' && (d as { status?: string }).status === 'unsubscribed') continue;
          if ('meta' in src && d.id !== src.meta) continue;
          await store.delete(d.id);
          removed++;
        }
      }
      counts[key] = { written, removed, ...(skipped ? { skipped } : {}) };
      this.step(`Restored ${label}`);
    }
    for (const [key, index] of loaded.files) {
      const label = componentOf(key).label;
      const src = FILE_SOURCES[key];
      const existing = new Map<string, BlobEntry>();
      for await (const b of this.sourceFiles(key)) existing.set(b.name, b);
      let written = 0; let removed = 0; let skipped = 0;
      await pool(index, COPY_CONCURRENCY, async (f) => {
        const target = src.prefix + f.name;
        const now = existing.get(target);
        if (now && now.size === f.size && (!f.md5 || !now.md5 || f.md5 === now.md5)) { skipped++; this.step(`Restoring ${label}`); return; }
        await this.s.copy({ container: BACKUP_CONTAINER, name: `${m.id}/files/${key}/blobs/${f.name}` }, { container: src.container, name: target });
        written++;
        this.step(`Restoring ${label}`);
      });
      if (mode === 'replace') {
        const keep = new Set(index.map((f) => src.prefix + f.name));
        for (const name of existing.keys()) if (!keep.has(name)) { await this.s.delete(src.container, name); removed++; }
      }
      counts[key] = { written, removed, skipped };
    }
    return counts;
  }

  // ---------- portable data file ----------
  /** Data parts of a backup as one JSON file, for download. Files stay in storage (copy those with AzCopy). */
  async exportData(id: string): Promise<{ filename: string; body: Buffer }> {
    const m = await this.readManifest(id);
    const data: Record<string, unknown> = {};
    const components: BackupManifest['components'] = {};
    for (const [key, c] of Object.entries(m.components) as [BackupComponentKey, ComponentSummary][]) {
      if (c.kind !== 'data') continue;
      const buf = await this.s.read(BACKUP_CONTAINER, `${id}/data/${key}.json`);
      if (sha256(buf) !== c.sha256) throw new BackupError(422, `${componentOf(key).label}: the backup is damaged (checksum mismatch).`);
      data[key] = JSON.parse(buf.toString('utf8'));
      components[key] = c;
    }
    if (!Object.keys(components).length) throw new BackupError(400, 'This backup only contains files. Copy it with AzCopy or Storage Explorer instead.');
    const body = json({ format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, kind: 'data-export', manifest: { ...m, components }, data });
    return { filename: `demo-center-backup-${id}.json`, body };
  }

  /** Turn an uploaded data file into a backup in this site's storage, ready to restore. */
  async importDataFile(buf: Buffer, by: string): Promise<string> {
    let f: { format?: string; formatVersion?: number; kind?: string; manifest?: BackupManifest; data?: Record<string, unknown> };
    try { f = JSON.parse(buf.toString('utf8')); } catch { throw new BackupError(400, 'That file is not a Demo Center backup (not valid JSON).'); }
    if (f.format !== BACKUP_FORMAT || f.kind !== 'data-export' || !isObj(f.manifest) || !isObj(f.data)) throw new BackupError(400, 'That file is not a Demo Center backup download.');
    if ((f.formatVersion ?? 0) > BACKUP_FORMAT_VERSION) throw new BackupError(422, 'This backup was made by a newer version of the Demo Center.');
    const lock = await this.lock();
    try {
      const id = newBackupId('uploaded');
      const components: BackupManifest['components'] = {};
      for (const key of COMPONENT_KEYS) {
        if (!isData(key) || !(key in f.data)) continue;
        const docs = f.data[key];
        if (!Array.isArray(docs)) throw new BackupError(422, `${componentOf(key).label}: not a list.`);
        docs.forEach((d, i) => { const p = docProblem(key, d); if (p) throw new BackupError(422, `${componentOf(key).label}: item ${i + 1} is not valid (${p}).`); });
        const out = json(docs);
        await this.s.write(BACKUP_CONTAINER, `${id}/data/${key}.json`, out, 'application/json');
        components[key] = { kind: 'data', items: docs.length, bytes: out.length, sha256: sha256(out) };
      }
      if (!Object.keys(components).length) throw new BackupError(422, 'The file contains no site data.');
      const src = f.manifest;
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, id, trigger: 'uploaded', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        createdBy: by, note: `Uploaded copy of ${typeof src.id === 'string' ? src.id.slice(0, 60) : 'a backup'}`, app: { version: this.o.appVersion },
        source: isObj(src.source) ? { publicSiteUrl: String(src.source.publicSiteUrl ?? '').slice(0, 200), mediaBaseUrl: String(src.source.mediaBaseUrl ?? '').slice(0, 200), cosmosDatabase: String(src.source.cosmosDatabase ?? '').slice(0, 60) }
          : { publicSiteUrl: '', mediaBaseUrl: '', cosmosDatabase: '' },
        components,
      };
      await this.s.write(BACKUP_CONTAINER, `${id}/manifest.json`, json(manifest), 'application/json');
      this.log({ action: 'backup.upload', target: id, user: by });
      return id;
    } finally {
      await lock.release();
    }
  }

  /** Copy a complete backup from another Azure storage account (for moving the site). Runs in the background. */
  async startRemoteImport(opts: { containerSasUrl: string; backupId: string; by: string }): Promise<string> {
    if (!this.s.importFrom) throw new BackupError(400, 'Importing from another storage account needs Azure storage.');
    if (!BACKUP_ID.test(opts.backupId)) throw new BackupError(400, 'That backup name is not valid. It looks like 20261109T020000000Z-nightly-abc123.');
    const lock = await this.lock();
    const id = newBackupId('imported');
    this.startJob('import', id, opts.by, 1);
    void (async () => {
      try {
        this.step('Copying the backup from the other storage account', 0);
        await this.s.importFrom!(opts.containerSasUrl, `${opts.backupId}/`, { container: BACKUP_CONTAINER, prefix: `${id}/` }, () => { if (this.job) { this.job.total++; this.job.done++; } });
        // Re-stamp the manifest with the new id; checksums of the data stay as they were and are verified on restore.
        const buf = await this.s.read(BACKUP_CONTAINER, `${id}/manifest.json`).catch(() => { throw new Error('The copied folder has no manifest.json, so it is not a complete backup.'); });
        const m = JSON.parse(buf.toString('utf8')) as BackupManifest;
        if (m.format !== BACKUP_FORMAT || m.id !== opts.backupId) throw new Error('The copied folder is not a matching Demo Center backup.');
        if (m.formatVersion > BACKUP_FORMAT_VERSION) throw new Error('That backup was made by a newer version of the Demo Center.');
        const note = `Imported from ${m.source?.publicSiteUrl || 'another site'} (${opts.backupId})`.slice(0, 300);
        await this.s.write(BACKUP_CONTAINER, `${id}/manifest.json`, json({ ...m, id, trigger: 'imported', note }), 'application/json');
        this.log({ action: 'backup.import', target: id, user: opts.by, from: opts.backupId });
        await lock.release();
        this.finishJob(undefined, `Imported ${opts.backupId} as ${id}. You can now restore it.`);
      } catch (e) {
        // Remove the partial copy so it isn't mistaken for a backup.
        for await (const b of this.s.list(BACKUP_CONTAINER, `${id}/`)) await this.s.delete(BACKUP_CONTAINER, b.name).catch(() => undefined);
        await lock.release();
        this.finishJob((e as Error).message.replace(/sig=[^&\s]+/g, 'sig=REDACTED'));
      }
    })();
    return id;
  }

  // ---------- settings and schedule ----------
  async getSettings(): Promise<BackupSettings> {
    const d = (await this.o.stores.meta.get(SETTINGS_ID as never)) as unknown as BackupSettings | undefined;
    return { ...DEFAULT_BACKUP_SETTINGS, ...(d ?? {}), id: SETTINGS_ID };
  }

  async saveSettings(input: Partial<BackupSettings>, by: string): Promise<BackupSettings> {
    const cur = await this.getSettings();
    const next: BackupSettings = {
      id: SETTINGS_ID,
      nightly: typeof input.nightly === 'boolean' ? input.nightly : cur.nightly,
      hourUtc: Number.isInteger(input.hourUtc) && input.hourUtc! >= 0 && input.hourUtc! <= 23 ? input.hourUtc! : cur.hourUtc,
      keep: Number.isInteger(input.keep) && input.keep! >= 1 && input.keep! <= 90 ? input.keep! : cur.keep,
      components: input.components ? this.cleanComponents(input.components) : cur.components,
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    };
    if (!next.components.length) throw new BackupError(400, 'The nightly backup needs at least one part of the site.');
    await this.o.stores.meta.upsert(next as never);
    this.log({ action: 'backup.settings', target: SETTINGS_ID, user: by, nightly: next.nightly, hourUtc: next.hourUtc, keep: next.keep, components: next.components });
    return next;
  }

  /** Called every few minutes. Starts the nightly backup once a day after the configured hour (UTC). */
  async tick(now = new Date()): Promise<string | undefined> {
    const settings = await this.getSettings();
    if (!settings.nightly || now.getUTCHours() < settings.hourUtc || this.isBusy()) return undefined;
    const day = now.toISOString().slice(0, 10);
    const tries = this.nightlyAttempts.get(day) ?? 0;
    if (tries >= 3) return undefined;
    const stamp = day.replace(/-/g, '');
    const done = (await this.list()).some((b) => b.trigger === 'nightly' && b.id.startsWith(stamp) && (b.state === 'complete' || b.state === 'running'));
    if (done) return undefined;
    this.nightlyAttempts.set(day, tries + 1);
    for (const k of this.nightlyAttempts.keys()) if (k < day) this.nightlyAttempts.delete(k);
    try {
      return await this.startBackup({ components: settings.components, by: 'Nightly schedule', trigger: 'nightly', now });
    } catch (e) {
      if (e instanceof BackupError && e.status === 409) return undefined; // another instance is on it
      throw e;
    }
  }
}
