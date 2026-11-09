import {
  BlobSASPermissions, BlobServiceClient, ContainerClient, SASProtocol, generateBlobSASQueryParameters,
  type BlobLeaseClient, type UserDelegationKey,
} from '@azure/storage-blob';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CoreConfig } from './config.js';
import { getCredential } from './credential.js';

export interface BlobEntry {
  name: string;
  size: number;
  contentType?: string;
  /** Base64 MD5 when the service recorded one. */
  md5?: string;
}

export interface StorageLock {
  release(): Promise<void>;
}

/** Blob operations the backup engine needs. Implemented for Azure, the local dev folder and tests. */
export interface BackupStorage {
  ensureContainer(container: string): Promise<void>;
  list(container: string, prefix: string): AsyncIterable<BlobEntry>;
  /** Immediate "folder" names under a prefix, without the trailing slash. */
  listFolders(container: string, prefix: string): Promise<string[]>;
  exists(container: string, name: string): Promise<boolean>;
  read(container: string, name: string): Promise<Buffer>;
  write(container: string, name: string, data: Buffer, contentType: string): Promise<void>;
  /** Server-side copy. Content type and cache headers travel with the blob. */
  copy(from: { container: string; name: string }, to: { container: string; name: string }): Promise<void>;
  delete(container: string, name: string): Promise<void>;
  /** Exclusive lock shared by every app instance, or undefined when someone else holds it. */
  tryLock(container: string, name: string): Promise<StorageLock | undefined>;
  /** Copy a backup folder from another storage account, given a container SAS URL. */
  importFrom?(containerSasUrl: string, prefix: string, to: { container: string; prefix: string }, onBlob?: () => void): Promise<number>;
}

const md5Of = (v?: Uint8Array) => (v && v.length ? Buffer.from(v).toString('base64') : undefined);

class AzureBackupStorage implements BackupStorage {
  private readonly svc: BlobServiceClient;
  private udk?: { key: UserDelegationKey; expires: number };

  constructor(private readonly account: string, config: CoreConfig) {
    this.svc = new BlobServiceClient(`https://${account}.blob.core.windows.net`, getCredential(config));
  }

  private c(container: string) { return this.svc.getContainerClient(container); }

  async ensureContainer(container: string) {
    // No public access: backups contain internal notes and, optionally, personal data.
    await this.c(container).createIfNotExists();
  }

  async *list(container: string, prefix: string): AsyncIterable<BlobEntry> {
    for await (const b of this.c(container).listBlobsFlat({ prefix })) {
      yield { name: b.name, size: b.properties.contentLength ?? 0, contentType: b.properties.contentType, md5: md5Of(b.properties.contentMD5) };
    }
  }

  async listFolders(container: string, prefix: string) {
    const out: string[] = [];
    for await (const item of this.c(container).listBlobsByHierarchy('/', { prefix })) {
      if (item.kind === 'prefix') out.push(item.name.slice(prefix.length).replace(/\/$/, ''));
    }
    return out;
  }

  async exists(container: string, name: string) { return this.c(container).getBlobClient(name).exists(); }
  async read(container: string, name: string) { return this.c(container).getBlobClient(name).downloadToBuffer(); }

  async write(container: string, name: string, data: Buffer, contentType: string) {
    await this.c(container).getBlockBlobClient(name).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'no-store' } });
  }

  /** User delegation keys are signed by Entra ID, so no storage account key is used. */
  private async delegationKey() {
    const now = Date.now();
    if (this.udk && this.udk.expires - now > 30 * 60_000) return this.udk.key;
    const expires = new Date(now + 6 * 3600_000);
    const key = await this.svc.getUserDelegationKey(new Date(now - 5 * 60_000), expires);
    this.udk = { key, expires: expires.getTime() };
    return key;
  }

  private async readUrl(container: string, name: string) {
    const blob = this.c(container).getBlobClient(name);
    const q = generateBlobSASQueryParameters({
      containerName: container, blobName: name, permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(Date.now() - 2 * 60_000), expiresOn: new Date(Date.now() + 120 * 60_000), protocol: SASProtocol.Https,
    }, await this.delegationKey(), this.account);
    return `${blob.url}?${q.toString()}`;
  }

  async copy(from: { container: string; name: string }, to: { container: string; name: string }) {
    const poller = await this.c(to.container).getBlobClient(to.name).beginCopyFromURL(await this.readUrl(from.container, from.name));
    const r = await poller.pollUntilDone();
    if (r.copyStatus && r.copyStatus !== 'success') throw new Error(`Copy of ${from.name} ended with status ${r.copyStatus}`);
  }

  async delete(container: string, name: string) {
    await this.c(container).getBlobClient(name).deleteIfExists({ deleteSnapshots: 'include' });
  }

  async tryLock(container: string, name: string): Promise<StorageLock | undefined> {
    const blob = this.c(container).getBlockBlobClient(name);
    if (!(await blob.exists())) {
      await blob.uploadData(Buffer.from('lock'), { conditions: { ifNoneMatch: '*' } }).catch((e: { statusCode?: number }) => {
        if (e.statusCode !== 409 && e.statusCode !== 412) throw e;
      });
    }
    const lease: BlobLeaseClient = blob.getBlobLeaseClient();
    try {
      await lease.acquireLease(60);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 409) return undefined;
      throw e;
    }
    // Leases last 60 seconds; renew well before that while the job runs.
    const timer = setInterval(() => { lease.renewLease().catch((e) => console.error('backup lock renew failed', e)); }, 20_000);
    timer.unref?.();
    return { release: async () => { clearInterval(timer); await lease.releaseLease().catch(() => undefined); } };
  }

  async importFrom(containerSasUrl: string, prefix: string, to: { container: string; prefix: string }, onBlob?: () => void) {
    const src = new ContainerClient(containerSasUrl);
    let n = 0;
    for await (const b of src.listBlobsFlat({ prefix })) {
      const target = to.prefix + b.name.slice(prefix.length);
      // The source URL carries the SAS the administrator supplied; it is never logged or stored.
      const poller = await this.c(to.container).getBlobClient(target).beginCopyFromURL(src.getBlobClient(b.name).url);
      const r = await poller.pollUntilDone();
      if (r.copyStatus && r.copyStatus !== 'success') throw new Error(`Copy of ${b.name} ended with status ${r.copyStatus}`);
      n++;
      onBlob?.();
    }
    return n;
  }
}

/** Folder-backed stand-in for local development. */
class LocalBackupStorage implements BackupStorage {
  private locked = new Set<string>();
  constructor(private readonly root: string) {}

  private file(container: string, name = '') {
    const base = path.resolve(this.root, container);
    const p = path.resolve(base, name);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Invalid path');
    return p;
  }

  async ensureContainer(container: string) { await fs.mkdir(this.file(container), { recursive: true }); }

  async *list(container: string, prefix: string): AsyncIterable<BlobEntry> {
    const base = this.file(container);
    const walk = async function* (dir: string): AsyncGenerator<string> {
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(p); else yield p;
      }
    };
    for await (const p of walk(base)) {
      const name = path.relative(base, p).split(path.sep).join('/');
      if (name.startsWith(prefix)) yield { name, size: (await fs.stat(p)).size };
    }
  }

  async listFolders(container: string, prefix: string) {
    try {
      return (await fs.readdir(this.file(container, prefix), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { return []; }
  }

  async exists(container: string, name: string) { return fs.stat(this.file(container, name)).then(() => true, () => false); }
  async read(container: string, name: string) { return fs.readFile(this.file(container, name)); }
  async write(container: string, name: string, data: Buffer) {
    const p = this.file(container, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
  async copy(from: { container: string; name: string }, to: { container: string; name: string }) {
    const dst = this.file(to.container, to.name);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(this.file(from.container, from.name), dst);
  }
  async delete(container: string, name: string) { await fs.rm(this.file(container, name), { force: true }); }
  async tryLock(container: string, name: string) {
    const key = `${container}/${name}`;
    if (this.locked.has(key)) return undefined;
    this.locked.add(key);
    return { release: async () => { this.locked.delete(key); } };
  }
}

export function createBackupStorage(config: CoreConfig): BackupStorage {
  if (config.storageAccount) return new AzureBackupStorage(config.storageAccount, config);
  return new LocalBackupStorage(path.resolve(config.localDataDir));
}

/**
 * Accepts only an HTTPS Azure Blob container URL carrying a SAS token, so the server can't be
 * pointed at arbitrary hosts. Returns the URL normalised, or an error message.
 */
export function parseContainerSasUrl(raw: string): { url: string } | { error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { error: 'That is not a valid URL.' }; }
  if (u.protocol !== 'https:') return { error: 'The URL must start with https://.' };
  if (!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(u.hostname)) return { error: 'The URL must be an Azure Blob Storage address (<account>.blob.core.windows.net).' };
  if (u.port || u.username || u.password) return { error: 'The URL must not include a port or user name.' };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(parts[0])) return { error: 'Use the URL of the backups container itself, not a folder or file.' };
  if (!u.searchParams.get('sig') || !u.searchParams.get('sp')) return { error: 'The URL needs a SAS token with Read and List permissions.' };
  const perms = u.searchParams.get('sp') ?? '';
  if (!perms.includes('r') || !perms.includes('l')) return { error: 'The SAS token needs both Read (r) and List (l) permissions.' };
  return { url: u.toString() };
}
