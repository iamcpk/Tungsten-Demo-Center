import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackupEngine, BACKUP_CONTAINER, BACKUP_ID, newBackupId, docProblem, type BackupComponentKey } from './backup.js';
import { parseContainerSasUrl, type BackupStorage, type BlobEntry } from './backup-storage.js';
import type { CoreConfig } from './config.js';
import type { Doc, Store, Stores } from './store.js';
import type { Video } from './types.js';

// ---------- in-memory fakes ----------
class MemStore<T extends Doc> implements Store<T> {
  m = new Map<string, T>();
  async list() { return [...this.m.values()].map((d) => structuredClone(d)); }
  async get(id: string) { const d = this.m.get(id); return d ? structuredClone(d) : undefined; }
  async findBy(f: keyof T & string, v: string) { return (await this.list()).filter((d) => (d as Record<string, unknown>)[f] === v); }
  async upsert(d: T) { this.m.set(d.id, structuredClone(d)); return d; }
  async delete(id: string) { this.m.delete(id); }
}

class MemStorage implements BackupStorage {
  blobs = new Map<string, { data: Buffer; contentType?: string }>();
  locked = false;
  private k(c: string, n: string) { return `${c}/${n}`; }
  async ensureContainer() {}
  async *list(c: string, prefix: string): AsyncIterable<BlobEntry> {
    for (const [key, v] of [...this.blobs]) {
      if (!key.startsWith(`${c}/`)) continue;
      const name = key.slice(c.length + 1);
      if (name.startsWith(prefix)) yield { name, size: v.data.length, contentType: v.contentType };
    }
  }
  async listFolders(c: string, prefix: string) {
    const out = new Set<string>();
    for await (const b of this.list(c, prefix)) { const rest = b.name.slice(prefix.length); if (rest.includes('/')) out.add(rest.split('/')[0]); }
    return [...out];
  }
  async exists(c: string, n: string) { return this.blobs.has(this.k(c, n)); }
  async read(c: string, n: string) { const b = this.blobs.get(this.k(c, n)); if (!b) throw Object.assign(new Error('not found'), { statusCode: 404 }); return Buffer.from(b.data); }
  async write(c: string, n: string, data: Buffer, contentType: string) { this.blobs.set(this.k(c, n), { data: Buffer.from(data), contentType }); }
  async copy(from: { container: string; name: string }, to: { container: string; name: string }) {
    const b = this.blobs.get(this.k(from.container, from.name));
    if (!b) throw new Error(`missing ${from.name}`);
    this.blobs.set(this.k(to.container, to.name), { ...b, data: Buffer.from(b.data) });
  }
  async delete(c: string, n: string) { this.blobs.delete(this.k(c, n)); }
  async tryLock() { if (this.locked) return undefined; this.locked = true; return { release: async () => { this.locked = false; } }; }
  put(c: string, n: string, text: string, contentType = 'image/jpeg') { this.blobs.set(this.k(c, n), { data: Buffer.from(text), contentType }); }
  text(c: string, n: string) { return this.blobs.get(this.k(c, n))?.data.toString(); }
}

const config: CoreConfig = { dataMode: 'local', localDataDir: 'x', cosmosDatabase: 'tdc', mediaBaseUrl: 'https://media.example', publicSiteUrl: 'https://site.example' };
const VID = '11111111-2222-3333-4444-555555555555';
const VID2 = '99999999-2222-3333-4444-555555555555';

function video(id: string, title: string): Video {
  return {
    id, slug: title.toLowerCase().replace(/\W+/g, '-'), title, shortDescription: '', description: '', status: 'active', itemType: 'video',
    businessLines: [], products: [], verticals: [], authors: [], languages: [], categories: [], keywords: [],
    featured: false, source: { provider: 'vimeo', externalId: '1' }, attachments: [],
    publishedAt: '2026-01-01T00:00:00Z', createdAt: '', updatedAt: '',
  };
}

function setup() {
  const stores = {
    videos: new MemStore(), meta: new MemStore(), approvers: new MemStore(), branding: new MemStore(), subscribers: new MemStore(), submissions: new MemStore(), analytics: new MemStore(),
  } as unknown as Stores & Record<string, MemStore<Doc>>;
  const storage = new MemStorage();
  const restored: BackupComponentKey[][] = [];
  const engine = new BackupEngine({ stores, storage, config, appVersion: 'test', log: () => undefined, onRestored: (c) => restored.push(c) });
  return { stores, storage, engine, restored };
}

async function waitIdle(engine: BackupEngine) {
  for (let i = 0; i < 200 && engine.isBusy(); i++) await new Promise((r) => setTimeout(r, 5));
  const job = engine.currentJob();
  assert.ok(job?.finishedAt, 'job did not finish');
  return job!;
}

async function backup(engine: BackupEngine, components: BackupComponentKey[], trigger?: 'manual' | 'nightly') {
  const id = await engine.startBackup({ components, by: 'admin@example.com', trigger });
  const job = await waitIdle(engine);
  assert.equal(job.error, undefined, job.error);
  return id;
}

// ---------- tests ----------
test('backup ids are sortable and validated', () => {
  const id = newBackupId('manual', new Date('2026-11-09T02:03:04.567Z'));
  assert.match(id, /^20261109T020304567Z-manual-[a-z0-9]{6}$/);
  assert.ok(BACKUP_ID.test(id));
  for (const bad of ['../etc', '20261109T020304Z-manual-ABC', '20261109T020304Z-evil-abcdef', `${id}/x`]) assert.ok(!BACKUP_ID.test(bad), bad);
});

test('backs up data and files, writes the manifest last, and restores into an empty site', async () => {
  const a = setup();
  await a.stores.videos.upsert(video(VID, 'eCopy demo'));
  await a.stores.meta.upsert({ id: 'taxonomy', products: ['eCopy'], verticals: [], authors: [], languages: [], categories: [] } as never);
  a.storage.put('media', `thumbs/${VID}/1.jpg`, 'thumb-bytes');
  a.storage.put('media', `attachments/${VID}/guide.pdf`, 'pdf-bytes', 'application/pdf');
  const id = await backup(a.engine, ['videos', 'taxonomy', 'thumbnails', 'attachments']);

  const list = await a.engine.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'complete');
  assert.ok(!(await a.storage.exists(BACKUP_CONTAINER, `${id}/status.json`)), 'status file removed once complete');
  const m = await a.engine.readManifest(id);
  assert.equal(m.components.videos?.items, 1);
  assert.equal(m.components.thumbnails?.items, 1);
  assert.equal(m.app.version, 'test');

  // A brand-new site: copy the backup folder across (what AzCopy would do), then restore.
  const b = setup();
  for (const [k, v] of a.storage.blobs) if (k.startsWith(`${BACKUP_CONTAINER}/`)) b.storage.blobs.set(k, v);
  await b.engine.startRestore({ id, components: ['videos', 'taxonomy', 'thumbnails', 'attachments'], mode: 'merge', by: 'admin@example.com' });
  const job = await waitIdle(b.engine);
  assert.equal(job.error, undefined, job.error);
  assert.equal((await b.stores.videos.get(VID))?.title, 'eCopy demo');
  assert.deepEqual(((await b.stores.meta.get('taxonomy')) as unknown as { products: string[] }).products, ['eCopy']);
  assert.equal(b.storage.text('media', `thumbs/${VID}/1.jpg`), 'thumb-bytes');
  assert.equal(b.storage.blobs.get(`media/attachments/${VID}/guide.pdf`)?.contentType, 'application/pdf');
  assert.deepEqual(b.restored, [['videos', 'taxonomy', 'thumbnails', 'attachments']]);
  // A safety backup was taken before the restore.
  assert.ok((await b.engine.list()).some((x) => x.trigger === 'pre-restore' && x.state === 'complete'));
});

test('merge keeps newer items; replace removes them; a safety backup can undo the restore', async () => {
  const { stores, storage, engine } = setup();
  await stores.videos.upsert(video(VID, 'Original title'));
  storage.put('media', `thumbs/${VID}/1.jpg`, 'old');
  const id = await backup(engine, ['videos', 'thumbnails']);

  await stores.videos.upsert({ ...video(VID, 'Edited title') });
  await stores.videos.upsert(video(VID2, 'Added later'));
  storage.put('media', `thumbs/${VID2}/1.jpg`, 'new');

  await engine.startRestore({ id, components: ['videos', 'thumbnails'], mode: 'merge', by: 'a' });
  await waitIdle(engine);
  assert.equal((await stores.videos.get(VID))?.title, 'Original title');
  assert.ok(await stores.videos.get(VID2), 'merge keeps items added since');
  assert.ok(storage.text('media', `thumbs/${VID2}/1.jpg`));

  const { safetyBackupId } = await engine.startRestore({ id, components: ['videos', 'thumbnails'], mode: 'replace', by: 'a' });
  await waitIdle(engine);
  assert.equal(await stores.videos.get(VID2), undefined, 'replace removes items added since');
  assert.equal(storage.text('media', `thumbs/${VID2}/1.jpg`), undefined, 'replace removes files added since');

  // The safety backup holds the state just before the replace: restoring it brings VID2 back.
  await engine.startRestore({ id: safetyBackupId, components: ['videos'], mode: 'merge', by: 'a' });
  await waitIdle(engine);
  assert.equal((await stores.videos.get(VID2))?.title, 'Added later');
});

test('a changed or damaged backup is refused before anything is written', async () => {
  const { stores, storage, engine } = setup();
  await stores.videos.upsert(video(VID, 'Original'));
  const id = await backup(engine, ['videos']);
  const path = `${id}/data/videos.json`;
  const docs = JSON.parse(storage.text(BACKUP_CONTAINER, path)!);
  docs[0].title = 'Tampered';
  storage.put(BACKUP_CONTAINER, path, JSON.stringify(docs), 'application/json');
  await stores.videos.upsert(video(VID, 'Current'));
  await assert.rejects(engine.startRestore({ id, components: ['videos'], mode: 'merge', by: 'a' }), /checksum/);
  assert.equal((await stores.videos.get(VID))?.title, 'Current');
  assert.equal(engine.isBusy(), false);
  assert.equal(storage.locked, false, 'lock released after a refused restore');
});

test('invalid documents and unsafe file names are rejected', async () => {
  assert.match(docProblem('videos', { id: 'x', title: 't' })!, /UUID/);
  assert.match(docProblem('videos', { ...video(VID, 'ok'), status: 'deleted' })!, /status/);
  assert.equal(docProblem('videos', video(VID, 'ok')), undefined);
  assert.match(docProblem('subscribers', { id: 'a', email: 'nope', status: 'confirmed' })!, /email/);
  assert.match(docProblem('approvers', { id: 'approvers', people: [{ email: 'x' }] })!, /email/);
  assert.match(docProblem('taxonomy', { id: 'other' })!, /wrong id/);

  const { storage, engine } = setup();
  storage.put('media', 'thumbs/a/1.jpg', 'x');
  const id = await backup(engine, ['thumbnails']);
  const m = JSON.parse(storage.text(BACKUP_CONTAINER, `${id}/manifest.json`)!);
  const index = [{ name: '../../uploads/evil', size: 1 }];
  const body = JSON.stringify(index);
  storage.put(BACKUP_CONTAINER, `${id}/files/thumbnails/index.json`, body, 'application/json');
  m.components.thumbnails.sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  storage.put(BACKUP_CONTAINER, `${id}/manifest.json`, JSON.stringify(m), 'application/json');
  await assert.rejects(engine.startRestore({ id, components: ['thumbnails'], mode: 'merge', by: 'a' }), /invalid entry/);
});

test('restoring subscribers never re-subscribes someone who unsubscribed later', async () => {
  const { stores, engine } = setup();
  const sub = { id: 'h1', email: 'p@example.com', status: 'confirmed', products: [], token: 't', consentText: 'c', createdAt: '' };
  await stores.subscribers.upsert(sub as never);
  const id = await backup(engine, ['subscribers']);
  await stores.subscribers.upsert({ ...sub, status: 'unsubscribed', unsubscribedAt: '2026-11-09' } as never);
  await engine.startRestore({ id, components: ['subscribers'], mode: 'replace', by: 'a' });
  await waitIdle(engine);
  assert.equal(((await stores.subscribers.get('h1')) as unknown as { status: string }).status, 'unsubscribed');
});

test('only one backup or restore runs at a time', async () => {
  const { stores, engine } = setup();
  await stores.videos.upsert(video(VID, 'x'));
  await engine.startBackup({ components: ['videos'], by: 'a' });
  await assert.rejects(engine.startBackup({ components: ['videos'], by: 'b' }), /already running/);
  await waitIdle(engine);
});

test('a backup without a manifest is never offered for restore', async () => {
  const { storage, engine } = setup();
  const id = newBackupId('manual');
  storage.put(BACKUP_CONTAINER, `${id}/status.json`, JSON.stringify({ id, state: 'running', trigger: 'manual', createdBy: 'a', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', components: ['videos'] }), 'application/json');
  const [b] = await engine.list();
  assert.equal(b.state, 'interrupted');
  await assert.rejects(engine.startRestore({ id, components: ['videos'], mode: 'merge', by: 'a' }), /did not finish/);
});

test('data export round-trips through an uploaded file', async () => {
  const a = setup();
  await a.stores.videos.upsert(video(VID, 'Portable'));
  a.storage.put('media', 'thumbs/x/1.jpg', 'x');
  const id = await backup(a.engine, ['videos', 'thumbnails']);
  const f = await a.engine.exportData(id);
  assert.match(f.filename, /\.json$/);
  const parsed = JSON.parse(f.body.toString());
  assert.deepEqual(Object.keys(parsed.data), ['videos']);

  const b = setup();
  const newId = await b.engine.importDataFile(f.body, 'admin');
  assert.match(newId, /-uploaded-/);
  await b.engine.startRestore({ id: newId, components: ['videos'], mode: 'merge', by: 'admin' });
  await waitIdle(b.engine);
  assert.equal((await b.stores.videos.get(VID))?.title, 'Portable');
  await assert.rejects(b.engine.importDataFile(Buffer.from('{"hello":1}'), 'admin'), /not a Demo Center backup/);
});

test('nightly schedule runs once per day after the set hour and keeps only the configured number', async () => {
  const { stores, engine } = setup();
  await stores.videos.upsert(video(VID, 'x'));
  await engine.saveSettings({ nightly: true, hourUtc: 2, keep: 2, components: ['videos'] }, 'admin');
  assert.equal(await engine.tick(new Date('2026-11-09T01:00:00Z')), undefined, 'not before the hour');
  const first = await engine.tick(new Date('2026-11-09T02:30:00Z'));
  assert.ok(first);
  await waitIdle(engine);
  assert.equal(await engine.tick(new Date('2026-11-09T05:00:00Z')), undefined, 'once a day');

  // Simulate three more nights by writing complete nightly backups with older ids.
  for (const id of ['20261101T020000000Z-nightly-aaaaaa', '20261102T020000000Z-nightly-bbbbbb', '20261103T020000000Z-nightly-cccccc']) {
    await engine['o'].storage.write(BACKUP_CONTAINER, `${id}/manifest.json`, Buffer.from(JSON.stringify({ format: 'tdc-backup', formatVersion: 1, id, trigger: 'nightly', createdAt: '', completedAt: '', createdBy: 'Nightly schedule', app: {}, source: {}, components: {} })), 'application/json');
  }
  const removed = await engine.applyRetention();
  assert.deepEqual(removed.sort(), ['20261101T020000000Z-nightly-aaaaaa', '20261102T020000000Z-nightly-bbbbbb']);
  assert.equal((await engine.list()).filter((b) => b.trigger === 'nightly').length, 2);
});

test('only Azure Blob container SAS URLs are accepted for import', () => {
  assert.ok('url' in parseContainerSasUrl('https://oldacct123.blob.core.windows.net/backups?sv=2024&sp=rl&sig=abc'));
  for (const [u, why] of [
    ['http://oldacct.blob.core.windows.net/backups?sp=rl&sig=a', /https/],
    ['https://evil.example.com/backups?sp=rl&sig=a', /Azure Blob/],
    ['https://oldacct.blob.core.windows.net.evil.com/backups?sp=rl&sig=a', /Azure Blob/],
    ['https://oldacct.blob.core.windows.net/backups/x?sp=rl&sig=a', /container itself/],
    ['https://oldacct.blob.core.windows.net/backups', /SAS/],
    ['https://oldacct.blob.core.windows.net/backups?sp=r&sig=a', /List/],
    ['https://user@oldacct.blob.core.windows.net/backups?sp=rl&sig=a', /port or user/],
  ] as const) {
    const r = parseContainerSasUrl(u);
    assert.ok('error' in r && why.test(r.error), `${u} -> ${JSON.stringify(r)}`);
  }
});
