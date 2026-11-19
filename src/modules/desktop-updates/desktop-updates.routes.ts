import { Router, Request, Response } from 'express';
import type { Api } from '../../utils/api';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const desktopUpdatesRouter = Router();

export function registerDesktopUpdateRoutes(api: Api) {
  api.router.use('/updates/desktop', desktopUpdatesRouter);
}

// In-memory / fixture store for desktop updates
interface UpdateRelease {
  version: string;
  releaseDate: string;
  minSupportedVersion: string;
  mandatory: boolean;
  channel: 'stable' | 'beta';
  windows: {
    url: string;
    sha512: string;
    sizeBytes: number;
    installerType: 'nsis';
    minWindowsBuild?: number;
  };
  releaseNotes: string;
  databaseMigrationRequired: boolean;
  targetSchemaVersion: number;
}

// Default seeded release fixture for development and automated integration testing
const releases: UpdateRelease[] = [
  {
    version: '1.1.0',
    releaseDate: '2026-11-14T00:00:00.000Z',
    minSupportedVersion: '1.0.0',
    mandatory: false,
    channel: 'stable',
    windows: {
      url: 'http://localhost:5000/api/v1/updates/desktop/download/1.1.0',
      sha512: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // will be dynamically set or verified
      sizeBytes: 1024,
      installerType: 'nsis',
      minWindowsBuild: 19041,
    },
    releaseNotes: '- Performance optimizations for large student rosters (Migration 009).\n- Added automatic multi-destination backup rotation.\n- Enhanced offline licensing resilience with clock rollback guards.\n- Smooth NSIS Windows background updates.',
    databaseMigrationRequired: true,
    targetSchemaVersion: 9,
  },
  {
    version: '1.2.0-beta.1',
    releaseDate: '2026-11-15T00:00:00.000Z',
    minSupportedVersion: '1.0.0',
    mandatory: false,
    channel: 'beta',
    windows: {
      url: 'http://localhost:5000/api/v1/updates/desktop/download/1.2.0-beta.1',
      sha512: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 1024,
      installerType: 'nsis',
      minWindowsBuild: 19041,
    },
    releaseNotes: '- Beta Channel Preview: Advanced visual student report card design.\n- Biometric USB terminal bridge preview.',
    databaseMigrationRequired: false,
    targetSchemaVersion: 9,
  }
];

// Stored binary payloads in memory / disk for testing
const binaryStore = new Map<string, Buffer>();

// Seed a dummy 1.1.0 installer payload buffer for testing downloads
const dummyPayload = Buffer.from('MZ_SIMULATED_WINDOWS_PE_INSTALLER_BINARY_DATA_SMS_SETUP_V1.1.0');
const dummyHash = crypto.createHash('sha512').update(dummyPayload).digest('hex');
releases[0].windows.sha512 = dummyHash;
releases[0].windows.sizeBytes = dummyPayload.length;
binaryStore.set('1.1.0', dummyPayload);

/**
 * GET /api/v1/updates/desktop/latest
 * Query: channel (stable|beta), currentVersion, os, arch
 */
desktopUpdatesRouter.get('/latest', (req: Request, res: Response) => {
  const channel = (req.query.channel as string) || 'stable';
  const currentVersion = (req.query.currentVersion as string) || '1.0.0';

  const eligible = releases.filter((r) => {
    if (channel === 'stable') {
      return r.channel === 'stable';
    }
    return true; // beta receives both beta and stable
  });

  if (eligible.length === 0) {
    return res.status(404).json({ error: { message: 'No releases found for channel' } });
  }

  // Pick latest release
  const latest = eligible[0];
  res.json(latest);
});

/**
 * GET /api/v1/updates/desktop/download/:version
 */
desktopUpdatesRouter.get('/download/:version', (req: Request, res: Response) => {
  const version = String(req.params.version);
  const payload = binaryStore.get(version);

  if (!payload) {
    return res.status(404).json({ error: { message: `Binary payload for version ${version} not found` } });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="SchoolManagementSoftware-Setup-${version}.exe"`);
  res.setHeader('Content-Length', payload.length);
  res.send(payload);
});

/**
 * POST /api/v1/updates/desktop/publish
 */
desktopUpdatesRouter.post('/publish', (req: Request, res: Response) => {
  const body = req.body;
  if (!body.version || !body.windows?.sha512) {
    return res.status(400).json({ error: { message: 'Missing required release metadata' } });
  }

  const existingIndex = releases.findIndex((r) => r.version === body.version);
  if (existingIndex >= 0) {
    releases[existingIndex] = body;
  } else {
    releases.unshift(body);
  }

  res.status(201).json({ success: true, release: body });
});
