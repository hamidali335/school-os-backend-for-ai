import crypto from 'node:crypto';
import { inject } from 'vitest';

// Runs before each test file's imports, so src/config/env.ts sees these values.
const [hosts, query] = inject('mongoUri').split('?');
const base = hosts.replace(/\/?$/, '/');
process.env.NODE_ENV = 'test';
// Keeps options such as ?replicaSet=... (replica-set project).
process.env.MONGODB_URI = `${base}schoolos_test_${crypto.randomBytes(4).toString('hex')}${query ? `?${query}` : ''}`;
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_PLATFORM_SECRET = 'test-platform-secret-0123456789abcdef01234567';
process.env.BCRYPT_ROUNDS = '4';
process.env.SCHEDULER_ENABLED = 'false';
process.env.STORAGE_DIR = `./storage-test/${crypto.randomBytes(4).toString('hex')}`;
process.env.BACKUP_DIR = `./storage-test/backups-${crypto.randomBytes(4).toString('hex')}`;
// Throwaway key for this test run only.
process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.BACKUP_SCHEDULE_ENABLED = 'false';
delete process.env.PLATFORM_ALLOWED_IPS;
process.env.AI_PROVIDER = 'groq';
delete process.env.XAI_API_KEY;
delete process.env.AI_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.WHATSAPP_TOKEN;
