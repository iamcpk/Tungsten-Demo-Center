import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BLOB_CONTAINERS, ENCODE_QUEUE, type CoreConfig } from './config.js';
import { getCredential } from './credential.js';
import type { EncodeJobMessage } from './types.js';

export type BlobContainerName = (typeof BLOB_CONTAINERS)[keyof typeof BLOB_CONTAINERS];

export interface MediaService {
  readonly mode: 'azure' | 'local';
  /** Write a file to the public media container. Returns the relative path. */
  putMedia(relPath: string, data: Buffer, contentType: string): Promise<string>;
  deleteMediaPrefix(prefix: string): Promise<void>;
  /** Size in bytes, or undefined when the blob does not exist. */
  blobSize(container: BlobContainerName, name: string): Promise<number | undefined>;
  /** Short-lived, single-blob, create/write-only SAS URL for direct browser upload. */
  createUploadUrl(container: BlobContainerName, name: string, minutes?: number): Promise<string>;
  /** Short-lived read-only SAS URL (used by the encoder to stream the source). */
  createReadUrl(container: BlobContainerName, name: string, minutes?: number): Promise<string>;
  deleteBlob(container: BlobContainerName, name: string): Promise<void>;
  enqueueEncode(msg: EncodeJobMessage): Promise<void>;
  publicUrl(relPath: string): string;
}

/** Only these characters are allowed in blob paths we construct. */
export function safeBlobName(name: string): string {
  const base = name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return base || 'file';
}

class AzureMedia implements MediaService {
  readonly mode = 'azure' as const;
  private readonly svc: BlobServiceClient;
  private readonly queue: QueueClient;
  private udk?: { key: UserDelegationKey; expires: number };

  constructor(private readonly config: CoreConfig) {
    const cred = getCredential(config);
    this.svc = new BlobServiceClient(`https://${config.storageAccount}.blob.core.windows.net`, cred);
    this.queue = new QueueClient(`https://${config.storageAccount}.queue.core.windows.net/${ENCODE_QUEUE}`, cred);
  }

  private block(container: BlobContainerName, name: string) {
    return this.svc.getContainerClient(container).getBlockBlobClient(name);
  }

  async putMedia(relPath: string, data: Buffer, contentType: string) {
    await this.block(BLOB_CONTAINERS.media, relPath).uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: 'public, max-age=31536000, immutable' },
    });
    return relPath;
  }

  async deleteMediaPrefix(prefix: string) {
    const c = this.svc.getContainerClient(BLOB_CONTAINERS.media);
    for await (const b of c.listBlobsFlat({ prefix })) await c.deleteBlob(b.name, { deleteSnapshots: 'include' });
  }

  async blobSize(container: BlobContainerName, name: string) {
    try {
      const p = await this.block(container, name).getProperties();
      return p.contentLength;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return undefined;
      throw e;
    }
  }

  /** User delegation keys are signed by Entra ID, so no storage account key is ever used. */
  private async delegationKey(): Promise<UserDelegationKey> {
    const now = Date.now();
    if (this.udk && this.udk.expires - now > 10 * 60_000) return this.udk.key;
    const starts = new Date(now - 5 * 60_000);
    const expires = new Date(now + 6 * 3600_000);
    const key = await this.svc.getUserDelegationKey(starts, expires);
    this.udk = { key, expires: expires.getTime() };
    return key;
  }

  private async sas(container: BlobContainerName, name: string, perms: string, minutes: number) {
    const key = await this.delegationKey();
    const q = generateBlobSASQueryParameters(
      {
        containerName: container,
        blobName: name,
        permissions: BlobSASPermissions.parse(perms),
        startsOn: new Date(Date.now() - 2 * 60_000),
        expiresOn: new Date(Date.now() + minutes * 60_000),
        protocol: SASProtocol.Https,
      },
      key,
      this.config.storageAccount!,
    );
    return `${this.block(container, name).url}?${q.toString()}`;
  }

  createUploadUrl(container: BlobContainerName, name: string, minutes = 240) {
    return this.sas(container, name, 'cw', minutes);
  }
  createReadUrl(container: BlobContainerName, name: string, minutes = 360) {
    return this.sas(container, name, 'r', minutes);
  }
  async deleteBlob(container: BlobContainerName, name: string) {
    await this.block(container, name).deleteIfExists({ deleteSnapshots: 'include' });
  }
  async enqueueEncode(msg: EncodeJobMessage) {
    await this.queue.sendMessage(Buffer.from(JSON.stringify(msg)).toString('base64'));
  }
  publicUrl(relPath: string) {
    return `${this.config.mediaBaseUrl}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  }
}

/** Local filesystem stand-in used during development. */
class LocalMedia implements MediaService {
  readonly mode = 'local' as const;
  constructor(private readonly config: CoreConfig) {}
  private file(container: string, name: string) {
    const root = path.resolve(this.config.localDataDir, container);
    const p = path.resolve(root, name);
    if (!p.startsWith(root + path.sep)) throw new Error('Invalid path');
    return p;
  }
  async putMedia(relPath: string, data: Buffer) {
    const p = this.file(BLOB_CONTAINERS.media, relPath);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return relPath;
  }
  async deleteMediaPrefix(prefix: string) {
    await fs.rm(this.file(BLOB_CONTAINERS.media, prefix), { recursive: true, force: true });
  }
  async blobSize(container: BlobContainerName, name: string) {
    try { return (await fs.stat(this.file(container, name))).size; } catch { return undefined; }
  }
  async createUploadUrl(container: BlobContainerName, name: string) {
    return `local://${container}/${name}`;
  }
  async createReadUrl(container: BlobContainerName, name: string) {
    return this.file(container, name);
  }
  async deleteBlob(container: BlobContainerName, name: string) {
    await fs.rm(this.file(container, name), { force: true });
  }
  async enqueueEncode(msg: EncodeJobMessage) {
    const p = path.resolve(this.config.localDataDir, 'encode-queue.jsonl');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(msg) + '\n');
  }
  publicUrl(relPath: string) {
    return `${this.config.mediaBaseUrl}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  }
  /** Used by the admin dev server to accept a raw PUT body. */
  async writeLocal(container: BlobContainerName, name: string, data: Buffer) {
    const p = this.file(container, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
}

export function createMedia(config: CoreConfig): MediaService & { writeLocal?: LocalMedia['writeLocal'] } {
  if (config.storageAccount) return new AzureMedia(config);
  return new LocalMedia(config);
}
