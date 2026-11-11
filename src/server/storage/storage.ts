import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Disco local: só para desenvolvimento (web e worker na mesma máquina). */
class LocalStorage implements Storage {
  constructor(private readonly root: string) {}
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('chave de storage inválida');
    return p;
  }
  async put(key: string, body: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
  }
  get(key: string) {
    return readFile(this.file(key));
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

/**
 * Object storage compatível com S3 (Railway Buckets, Cloudflare R2, MinIO). Bucket privado:
 * downloads passam sempre pela aplicação, que confere o dono do anexo.
 */
class S3Storage implements Storage {
  private s3: S3Client;
  constructor(
    private readonly bucket: string,
    opts: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean },
  ) {
    this.s3 = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let instance: Storage | undefined;

export function storage(): Storage {
  if (instance) return instance;
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    instance = new S3Storage(S3_BUCKET, {
      endpoint: S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('em produção, web e worker não compartilham disco: configure o bucket S3 (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)');
  } else {
    instance = new LocalStorage(process.env.LOCAL_STORAGE_DIR ?? path.resolve('.data/uploads'));
  }
  return instance;
}
