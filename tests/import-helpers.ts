import type { Express } from 'express';
import request from 'supertest';
import { auth } from './helpers';

/**
 * After an upload, the rows are saved in the background (status "staging"). Wait until they are
 * ready, as the import screen does, before checking the file.
 */
export async function waitStaged(app: Express, token: string, id: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await request(app).get(`/api/v1/imports/${id}`).set(auth(token));
    if (res.body?.data?.status !== 'staging') return res.body.data;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('rows were not prepared in time');
}

/** Checking runs in the background (status "checking"): wait until it has finished. */
export async function waitChecked(app: Express, token: string, id: string, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await request(app).get(`/api/v1/imports/${id}`).set(auth(token));
    if (res.body?.data?.status !== 'checking') return res.body.data;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('rows were not checked in time');
}

/**
 * Start a check and wait for it, as the import screen does. Returns what the check request
 * returned before checking ran in the background: the job, the summary and the warnings.
 */
export async function checkAndWait(app: Express, token: string, id: string, body: object) {
  const res = await request(app).post(`/api/v1/imports/${id}/check`).set(auth(token)).send(body);
  if (res.status !== 200) throw new Error(`check failed: ${res.status} ${JSON.stringify(res.body)}`);
  const job = await waitChecked(app, token, id);
  return { job, summary: job.summary, warnings: job.warnings };
}
