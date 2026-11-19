import pino from 'pino';
import { env, isProd, isTest } from './env';

/**
 * Paths redacted from every log line. Credentials, tokens and student-identifying
 * personal data must never reach log storage.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'currentPassword',
  '*.currentPassword',
  'newPassword',
  '*.newPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'apiKey',
  '*.apiKey',
  'cnic',
  '*.cnic',
  'bFormNo',
  '*.bFormNo',
  'medicalNotes',
  '*.medicalNotes',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'school-os-backend' },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd || isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }),
});
