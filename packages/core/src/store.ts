import { CosmosClient, type Container } from '@azure/cosmos';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONTAINERS, type CoreConfig } from './config.js';
import { getCredential } from './credential.js';
import type { ApproverList, Subscriber, Submission, Taxonomy, Video } from './types.js';
import type { BrandingDoc } from './branding.js';
import type { AnalyticsDoc, AnalyticsWriter } from './analytics.js';

export interface Doc {
  id: string;
}

/** Minimal document store. Every container is partitioned on /id. */
export interface Store<T extends Doc> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  /** Find documents where a top-level string field equals a value (parameterised). */
  findBy(field: keyof T & string, value: string): Promise<T[]>;
  upsert(doc: T): Promise<T>;
  delete(id: string): Promise<void>;
}

const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]*$/;

class CosmosStore<T extends Doc> implements Store<T> {
  constructor(private readonly c: Container) {}

  async list(): Promise<T[]> {
    const { resources } = await this.c.items.readAll().fetchAll();
    return (resources as unknown as T[]).map(strip);
  }

  async get(id: string): Promise<T | undefined> {
    try {
      const { resource } = await this.c.item(id, id).read();
      return resource ? strip(resource as unknown as T) : undefined;
    } catch (e) {
      if ((e as { code?: number }).code === 404) return undefined;
      throw e;
    }
  }

  async findBy(field: keyof T & string, value: string): Promise<T[]> {
    if (!SAFE_FIELD.test(field)) throw new Error('Invalid field name');
    const { resources } = await this.c.items
      .query({ query: `SELECT * FROM c WHERE c.${field} = @v`, parameters: [{ name: '@v', value }] })
      .fetchAll();
    return (resources as unknown as T[]).map(strip);
  }

  async upsert(doc: T): Promise<T> {
    const { resource } = await this.c.items.upsert(doc as unknown as Record<string, unknown>);
    return strip((resource ?? doc) as unknown as T);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.c.item(id, id).delete();
    } catch (e) {
      if ((e as { code?: number }).code !== 404) throw e;
    }
  }
}

/** Removes Cosmos system properties (_rid, _etag, ...). */
function strip<T>(doc: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (!k.startsWith('_')) out[k] = v;
  return out as T;
}

/** JSON-file store for local development only. */
class LocalStore<T extends Doc> implements Store<T> {
  private cache?: Map<string, T>;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async load(): Promise<Map<string, T>> {
    if (this.cache) return this.cache;
    try {
      const arr = JSON.parse(await fs.readFile(this.file, 'utf8')) as T[];
      this.cache = new Map(arr.map((d) => [d.id, d]));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.cache = new Map();
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const data = JSON.stringify([...(await this.load()).values()], null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, data, 'utf8');
    });
    return this.writing;
  }

  async list() { return [...(await this.load()).values()].map((d) => structuredClone(d)); }
  async get(id: string) { const d = (await this.load()).get(id); return d ? structuredClone(d) : undefined; }
  async findBy(field: keyof T & string, value: string) {
    return (await this.list()).filter((d) => (d as Record<string, unknown>)[field] === value);
  }
  async upsert(doc: T) { (await this.load()).set(doc.id, structuredClone(doc)); await this.persist(); return doc; }
  async delete(id: string) { (await this.load()).delete(id); await this.persist(); }
}

export interface Stores {
  videos: Store<Video>;
  meta: Store<Taxonomy>;
  /** Approver list: a single document in the meta container (separate JSON file locally). */
  approvers: Store<ApproverList>;
  /** Site branding: a single document in the meta container (separate JSON file locally). */
  branding: Store<BrandingDoc>;
  subscribers: Store<Subscriber>;
  submissions: Store<Submission>;
  /** Anonymous daily view and watch-time totals. Write through createAnalyticsWriter. */
  analytics: Store<AnalyticsDoc>;
}

export function createStores(config: CoreConfig): Stores {
  if (config.dataMode === 'local') {
    const f = (n: string) => path.resolve(config.localDataDir, `${n}.json`);
    return {
      videos: new LocalStore<Video>(f(CONTAINERS.videos)),
      meta: new LocalStore<Taxonomy>(f(CONTAINERS.meta)),
      approvers: new LocalStore<ApproverList>(f('approvers')),
      branding: new LocalStore<BrandingDoc>(f('branding')),
      subscribers: new LocalStore<Subscriber>(f(CONTAINERS.subscribers)),
      submissions: new LocalStore<Submission>(f(CONTAINERS.submissions)),
      analytics: new LocalStore<AnalyticsDoc>(f(CONTAINERS.analytics)),
    };
  }
  // Entra ID (managed identity) only; Cosmos local key auth is disabled in the template.
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint!, aadCredentials: getCredential(config) });
  const db = client.database(config.cosmosDatabase);
  return {
    videos: new CosmosStore<Video>(db.container(CONTAINERS.videos)),
    meta: new CosmosStore<Taxonomy>(db.container(CONTAINERS.meta)),
    approvers: new CosmosStore<ApproverList>(db.container(CONTAINERS.meta)),
    branding: new CosmosStore<BrandingDoc>(db.container(CONTAINERS.meta)),
    subscribers: new CosmosStore<Subscriber>(db.container(CONTAINERS.subscribers)),
    submissions: new CosmosStore<Submission>(db.container(CONTAINERS.submissions)),
    analytics: new CosmosStore<AnalyticsDoc>(db.container(CONTAINERS.analytics)),
  };
}

/** ETag-checked writes for analytics totals, which several app instances update at once. */
export function createAnalyticsWriter(config: CoreConfig, stores: Stores): AnalyticsWriter {
  if (config.dataMode === 'local') {
    // One process in local development: a version number stands in for the ETag.
    const versions = new Map<string, number>();
    return {
      async read(id) {
        const doc = await stores.analytics.get(id);
        return doc ? { doc, etag: String(versions.get(id) ?? 0) } : undefined;
      },
      async write(doc, etag) {
        const exists = !!(await stores.analytics.get(doc.id));
        if (etag === undefined ? exists : !exists || String(versions.get(doc.id) ?? 0) !== etag) return false;
        versions.set(doc.id, (versions.get(doc.id) ?? 0) + 1);
        await stores.analytics.upsert(doc);
        return true;
      },
    };
  }
  const client = new CosmosClient({ endpoint: config.cosmosEndpoint!, aadCredentials: getCredential(config) });
  const c = client.database(config.cosmosDatabase).container(CONTAINERS.analytics);
  return {
    async read(id) {
      try {
        const { resource, etag } = await c.item(id, id).read();
        return resource ? { doc: strip(resource as unknown as AnalyticsDoc), etag } : undefined;
      } catch (e) {
        if ((e as { code?: number }).code === 404) return undefined;
        throw e;
      }
    },
    async write(doc, etag) {
      try {
        if (etag === undefined) await c.items.create(doc as unknown as Record<string, unknown>);
        else await c.item(doc.id, doc.id).replace(doc as unknown as Record<string, unknown>, { accessCondition: { type: 'IfMatch', condition: etag } });
        return true;
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 409 || code === 412) return false;
        throw e;
      }
    },
  };
}

export const EMPTY_TAXONOMY: Taxonomy = { id: 'taxonomy', products: [], verticals: [], authors: [], languages: [], categories: [] };
