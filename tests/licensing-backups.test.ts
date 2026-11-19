import crypto from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestSchool, useTestApp, type TestSchool } from './helpers';
import { License } from '../src/modules/licensing/licensing.models';
import { verifyLicenseSignature } from '../src/modules/licensing/licensing.crypto';
import { SchoolBackup } from '../src/modules/cloud-backups/cloud-backups.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { School } from '../src/modules/schools/school.model';

const t = useTestApp();

describe('Phase 6 Backend Licensing & Cloud Backups Suite', () => {
  let schoolA: TestSchool;
  let schoolB: TestSchool;
  let tokenA: string;
  let tokenB: string;
  let customPlanId: any;

  beforeAll(async () => {
    schoolA = await createTestSchool(t.app, 'LSA' + Date.now().toString(36).toUpperCase());
    schoolB = await createTestSchool(t.app, 'LSB' + Date.now().toString(36).toUpperCase());

    tokenA = schoolA.ownerToken;
    tokenB = schoolB.ownerToken;

    // Create a custom plan with maxDevices: 2
    const plan = await Plan.create({
      code: 'desk_plan_2dev_' + Date.now().toString(36),
      name: 'Desktop Plan 2 Devices',
      priceMonthlyPkr: 5000,
      features: ['core.school_admin', 'core.students', 'core.fees', 'core.attendance', 'core.cloud_backup'],
      limits: {
        maxStudents: 500,
        maxDevices: 2,
        offlineGraceDays: 7,
      },
      published: true,
    });
    customPlanId = plan._id;

    // Assign plan to schoolA
    await School.findByIdAndUpdate(schoolA.schoolId, {
      'subscription.planId': customPlanId,
      'subscription.status': 'active',
    });
  });

  describe('Device Activation & Asymmetric Licensing', () => {
    let licenseA: any;
    const deviceId1 = 'dev_win_ws_01';
    const fp1 = crypto.createHash('sha256').update('machine_guid_01_cpu_8').digest('hex');

    it('1. Activates a workstation and returns signed Ed25519 license', async () => {
      const res = await request(t.app)
        .post('/api/v1/licensing/activate')
        .set(auth(tokenA))
        .send({
          deviceId: deviceId1,
          hardwareFingerprint: fp1,
          deviceName: 'Admin-Desktop-1',
          platform: 'windows_desktop',
        })
        .expect(200);

      expect(res.body.data.licenseId).toMatch(/^lic_/);
      expect(res.body.data.deviceId).toBe(deviceId1);
      expect(res.body.data.hardwareFingerprint).toBe(fp1);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.signature).toBeDefined();
      expect(res.body.data.publicKey).toBeDefined();
      expect(res.body.data.signedPayload).toBeDefined();
      expect(res.body.data.limits.maxDevices).toBe(2);

      // Verify asymmetric Ed25519 digital signature
      const validSig = verifyLicenseSignature(
        res.body.data.signedPayload,
        res.body.data.signature,
        res.body.data.publicKey,
      );
      expect(validSig).toBe(true);

      licenseA = res.body.data;
    });

    it('2. Tampered license payload fails signature verification', () => {
      const tamperedPayload = licenseA.signedPayload.replace('"status":"active"', '"status":"revoked"');
      expect(tamperedPayload).not.toBe(licenseA.signedPayload);
      const isValid = verifyLicenseSignature(tamperedPayload, licenseA.signature, licenseA.publicKey);
      expect(isValid).toBe(false);
    });

    it('3. Re-activating the same device updates license without consuming extra seat', async () => {
      const res = await request(t.app)
        .post('/api/v1/licensing/activate')
        .set(auth(tokenA))
        .send({
          deviceId: deviceId1,
          hardwareFingerprint: fp1,
          deviceName: 'Admin-Desktop-1-Renamed',
          platform: 'windows_desktop',
        })
        .expect(200);

      expect(res.body.data.licenseId).toBe(licenseA.licenseId);

      const activeLicenses = await License.countDocuments({ schoolId: schoolA.schoolId, status: 'active' });
      expect(activeLicenses).toBe(1);
    });

    it('4. Activates second device within allowed limit (maxDevices = 2)', async () => {
      const deviceId2 = 'dev_win_ws_02';
      const fp2 = crypto.createHash('sha256').update('machine_guid_02_cpu_16').digest('hex');

      const res = await request(t.app)
        .post('/api/v1/licensing/activate')
        .set(auth(tokenA))
        .send({
          deviceId: deviceId2,
          hardwareFingerprint: fp2,
          deviceName: 'Accounts-Desktop-2',
          platform: 'windows_desktop',
        })
        .expect(200);

      expect(res.body.data.deviceId).toBe(deviceId2);

      const activeLicenses = await License.countDocuments({ schoolId: schoolA.schoolId, status: 'active' });
      expect(activeLicenses).toBe(2);
    });

    it('5. Enforces device limit: third device activation is rejected with 403 DEVICE_LIMIT_EXCEEDED', async () => {
      const deviceId3 = 'dev_win_ws_03';
      const fp3 = crypto.createHash('sha256').update('machine_guid_03_cpu_4').digest('hex');

      const res = await request(t.app)
        .post('/api/v1/licensing/activate')
        .set(auth(tokenA))
        .send({
          deviceId: deviceId3,
          hardwareFingerprint: fp3,
          deviceName: 'Library-Desktop-3',
          platform: 'windows_desktop',
        })
        .expect(403);

      expect(res.body.error.code).toBe('DEVICE_LIMIT_EXCEEDED');
    });

    it('6. Revalidates device license and updates lastVerifiedAt', async () => {
      const res = await request(t.app)
        .post('/api/v1/licensing/verify')
        .set(auth(tokenA))
        .send({
          licenseId: licenseA.licenseId,
          deviceId: deviceId1,
          hardwareFingerprint: fp1,
        })
        .expect(200);

      expect(res.body.data.serverTime).toBeDefined();
      expect(new Date(res.body.data.serverTime).getTime()).toBeGreaterThan(0);
    });

    it('7. Rejects license verify if hardware fingerprint does not match', async () => {
      const res = await request(t.app)
        .post('/api/v1/licensing/verify')
        .set(auth(tokenA))
        .send({
          licenseId: licenseA.licenseId,
          deviceId: deviceId1,
          hardwareFingerprint: 'tampered_or_copied_fingerprint_hash',
        })
        .expect(403);

      expect(res.body.error.code).toBe('DEVICE_FINGERPRINT_MISMATCH');
    });

    it('8. Device replacement revokes old workstation and activates new workstation', async () => {
      const newDeviceId = 'dev_win_ws_replacement';
      const newFp = crypto.createHash('sha256').update('new_motherboard_guid').digest('hex');

      const res = await request(t.app)
        .post('/api/v1/licensing/replace')
        .set(auth(tokenA))
        .send({
          oldDeviceId: deviceId1,
          newDeviceId,
          hardwareFingerprint: newFp,
          deviceName: 'Principal-New-Laptop',
          reason: 'Hard drive failure and motherboard replacement',
        })
        .expect(200);

      expect(res.body.data.deviceId).toBe(newDeviceId);

      // Verify old device is revoked
      const oldLic = await License.findOne({ schoolId: schoolA.schoolId, deviceId: deviceId1 });
      expect(oldLic?.status).toBe('revoked');
      expect(oldLic?.revocationReason).toContain('Replaced by device dev_win_ws_replacement');

      // Active count should still be 2
      const activeCount = await License.countDocuments({ schoolId: schoolA.schoolId, status: 'active' });
      expect(activeCount).toBe(2);
    });

    it('9. Public key endpoint provides public Ed25519 key anonymously', async () => {
      const res = await request(t.app)
        .get('/api/v1/licensing/public-key')
        .expect(200);

      expect(res.body.data.algorithm).toBe('Ed25519');
      expect(res.body.data.publicKey).toContain('PUBLIC KEY');
    });
  });

  describe('School Cloud Backups & Isolation', () => {
    const backupId1 = 'sbak_test_001';
    const fakeCiphertext = Buffer.from('SMSBAK01_AUTHENTICATED_CIPHERTEXT_AES_GCM_SIMULATION_PAYLOAD');
    const checksum1 = crypto.createHash('sha256').update(fakeCiphertext).digest('hex');

    it('10. Uploads an encrypted school backup and verifies checksum', async () => {
      const res = await request(t.app)
        .post('/api/v1/backups/school/upload')
        .set(auth(tokenA))
        .send({
          backupId: backupId1,
          deviceId: 'dev_win_ws_02',
          fileName: 'sms-backup-2026-11-14.enc.bak',
          checksumSha256: checksum1,
          schemaVersion: 8,
          triggerType: 'manual',
          isEncrypted: true,
          encryptionAlgorithm: 'aes-256-gcm',
          dataBase64: fakeCiphertext.toString('base64'),
        })
        .expect(200);

      expect(res.body.data.backupId).toBe(backupId1);
      expect(res.body.data.checksumSha256).toBe(checksum1);
      expect(res.body.data.fileSizeBytes).toBe(fakeCiphertext.length);

      const dbDoc = await SchoolBackup.findOne({ schoolId: schoolA.schoolId, backupId: backupId1 });
      expect(dbDoc).not.toBeNull();
      expect(dbDoc?.status).toBe('completed');
    });

    it('11. Rejects backup upload with mismatched checksum (transit corruption)', async () => {
      const corruptedChecksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const res = await request(t.app)
        .post('/api/v1/backups/school/upload')
        .set(auth(tokenA))
        .send({
          backupId: 'sbak_corrupt_test',
          deviceId: 'dev_win_ws_02',
          fileName: 'corrupt.enc.bak',
          checksumSha256: corruptedChecksum,
          dataBase64: fakeCiphertext.toString('base64'),
        })
        .expect(400);

      expect(res.body.error.message).toContain('Checksum mismatch');
    });

    it('12. Duplicate backup upload is recognized idempotently', async () => {
      const res = await request(t.app)
        .post('/api/v1/backups/school/upload')
        .set(auth(tokenA))
        .send({
          backupId: backupId1,
          deviceId: 'dev_win_ws_02',
          fileName: 'sms-backup-2026-11-14.enc.bak',
          checksumSha256: checksum1,
          dataBase64: fakeCiphertext.toString('base64'),
        })
        .expect(200);

      expect(res.body.data.backupId).toBe(backupId1);
      expect(res.body.data.message).toContain('already exists');
    });

    it('13. Lists uploaded cloud backups scoped to authenticated school tenant', async () => {
      const res = await request(t.app)
        .get('/api/v1/backups/school')
        .set(auth(tokenA))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].backupId).toBe(backupId1);
    });

    it('14. Multi-tenant isolation: Tenant B cannot see or download Tenant A backup', async () => {
      // Tenant B lists backups -> should be empty
      const listB = await request(t.app)
        .get('/api/v1/backups/school')
        .set(auth(tokenB))
        .expect(200);

      expect(listB.body.data.length).toBe(0);

      // Tenant B tries to download Tenant A backup -> 404
      await request(t.app)
        .get(`/api/v1/backups/school/${backupId1}/download`)
        .set(auth(tokenB))
        .expect(404);
    });

    it('15. Authenticated school downloads encrypted backup binary data', async () => {
      const res = await request(t.app)
        .get(`/api/v1/backups/school/${backupId1}/download`)
        .set(auth(tokenA))
        .expect(200);

      expect(res.body.data.backupId).toBe(backupId1);
      expect(res.body.data.dataBase64).toBe(fakeCiphertext.toString('base64'));

      // Validate downloaded bytes match original
      const downloadedBuffer = Buffer.from(res.body.data.dataBase64, 'base64');
      expect(downloadedBuffer.equals(fakeCiphertext)).toBe(true);
    });

    it('16. Deletes cloud backup and removes from storage', async () => {
      const res = await request(t.app)
        .delete(`/api/v1/backups/school/${backupId1}`)
        .set(auth(tokenA))
        .expect(200);

      expect(res.body.data.success).toBe(true);

      const dbDoc = await SchoolBackup.findOne({ schoolId: schoolA.schoolId, backupId: backupId1 });
      expect(dbDoc?.status).toBe('deleted');

      // Subsequent download returns 404
      await request(t.app)
        .get(`/api/v1/backups/school/${backupId1}/download`)
        .set(auth(tokenA))
        .expect(404);
    });
  });
});
