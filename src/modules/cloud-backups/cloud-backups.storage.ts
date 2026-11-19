import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { badRequest } from '../../utils/errors';

export interface ICloudBackupStorage {
  saveBackup(
    schoolId: string,
    backupId: string,
    buffer: Buffer,
  ): Promise<{ storageKey: string; fileSizeBytes: number; checksumSha256: string }>;
  readBackup(storageKey: string): Promise<Buffer>;
  deleteBackup(storageKey: string): Promise<void>;
}

export class LocalFileSystemBackupStorage implements ICloudBackupStorage {
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || path.resolve(env.STORAGE_DIR, 'school-backups');
  }

  public async saveBackup(
    schoolId: string,
    backupId: string,
    buffer: Buffer,
  ): Promise<{ storageKey: string; fileSizeBytes: number; checksumSha256: string }> {
    const relativeKey = path.posix.join(schoolId, `${backupId}.enc.bak`);
    const targetFile = path.resolve(this.baseDir, relativeKey);

    // Guard against path traversal
    if (!targetFile.startsWith(this.baseDir + path.sep)) {
      throw badRequest('Invalid backup storage path traversal');
    }

    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, buffer);

    const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      storageKey: relativeKey,
      fileSizeBytes: buffer.length,
      checksumSha256,
    };
  }

  public async readBackup(storageKey: string): Promise<Buffer> {
    const targetFile = path.resolve(this.baseDir, storageKey);
    if (!targetFile.startsWith(this.baseDir + path.sep)) {
      throw badRequest('Invalid backup storage path');
    }
    return fs.readFile(targetFile);
  }

  public async deleteBackup(storageKey: string): Promise<void> {
    const targetFile = path.resolve(this.baseDir, storageKey);
    if (!targetFile.startsWith(this.baseDir + path.sep)) {
      return;
    }
    try {
      await fs.rm(targetFile, { force: true });
    } catch {}
  }
}

let activeStorageAdapter: ICloudBackupStorage = new LocalFileSystemBackupStorage();

export function getCloudBackupStorage(): ICloudBackupStorage {
  return activeStorageAdapter;
}

export function setCloudBackupStorage(adapter: ICloudBackupStorage) {
  activeStorageAdapter = adapter;
}
