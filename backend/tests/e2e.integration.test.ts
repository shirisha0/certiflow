/**
 * End-to-end tests against REAL Postgres + Redis (no database mocks).
 *
 * Only the BullMQ *queue module* is replaced with spies, so that:
 *   - a running worker cannot interfere with the assertions, and
 *   - we can prove the API hands work to the queue ("event-driven").
 * The worker functions themselves (issuance, WhatsApp delivery, reconciler) run for real.
 *
 * Needs: Postgres + Redis running, migrations applied (`npx prisma migrate deploy`).
 * Skip with SKIP_E2E=true.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { UserRole, CertificateStatus, DeliveryStatus, BatchStatus } from '@prisma/client';

vi.mock('../src/services/queue', () => ({
  QUEUE_NAMES: {
    BATCH_ISSUANCE: 'batch-issuance',
    WHATSAPP_DELIVERY: 'whatsapp-delivery',
    SLA_MONITOR: 'sla-monitor',
  },
  enqueueBatchIssuance: vi.fn(async () => undefined),
  enqueueWhatsAppDelivery: vi.fn(async () => undefined),
  scheduleSlaMonitor: vi.fn(async () => undefined),
}));

import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { prisma } from '../src/config/prisma';
import { redis, verifyCacheKey } from '../src/config/redis';
import { seedDatabase } from '../prisma/seed';
import { processBatchIssuance, processWhatsAppDelivery } from '../src/workers/index';
import { reconcileStuckWork } from '../src/services/reconcile';
import { providerStats } from '../src/services/whatsappProvider';
import { enqueueBatchIssuance, enqueueWhatsAppDelivery } from '../src/services/queue';

const describeE2E = process.env.SKIP_E2E === 'true' ? describe.skip : describe;
const RUN = Date.now();

const csvOf = (n: number, tag: string) => {
  const lines = ['fullName,phone,email,nationalIdLast4,score,passed'];
  for (let i = 1; i <= n; i++) {
    // last-4 digits deliberately repeat: they are not unique per person
    lines.push(
      `Cand ${tag} ${i},+9197${String(RUN % 100000).padStart(5, '0')}${String(i).padStart(3, '0')},c${i}@example.com,${1000 + (i % 10)},85,PASS`
    );
  }
  return lines.join('\n');
};

describeE2E('CertiFlow E2E: moments that must work & things that must never happen', () => {
  const app = createApp();
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const originalEnv = { ...env };

  async function switchTo(userId: string) {
    const res = await request(app).post('/api/auth/switch').send({ userId });
    expect(res.status).toBe(200);
    return res.body.token as string;
  }

  async function newSubmittedBatch(n: number, tag: string) {
    const created = await request(app)
      .post('/api/batches')
      .set(as('anika'))
      .send({ batchCode: `E2E-${tag}-${RUN}`, courseName: `Course ${tag}` });
    expect(created.status).toBe(201);
    const batchId = created.body.batch.id as string;
    await request(app)
      .post(`/api/batches/${batchId}/upload`)
      .set(as('anika'))
      .attach('file', Buffer.from(csvOf(n, tag)), 'batch.csv')
      .expect(200);
    await request(app).post(`/api/batches/${batchId}/submit`).set(as('anika')).expect(200);
    return batchId;
  }

  const decide = (who: string, batchId: string, decision: string, reason?: string) =>
    request(app).post(`/api/batches/${batchId}/decide`).set(as(who)).send({ decision, reason });

  const getBatch = async (who: string, batchId: string) =>
    (await request(app).get(`/api/batches/${batchId}`).set(as(who))).body.batch;

  beforeAll(async () => {
    env.demoMode = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
    } catch (err) {
      throw new Error(
        'E2E tests need Postgres and Redis running and migrations applied ' +
          '(see SETUP.md). Underlying error: ' + (err as Error).message
      );
    }
    await seedDatabase();
    for (const who of ['anika', 'dev', 'meera', 'kabir', 'neha', 'farah']) {
      tokens[who] = await switchTo(`user-${who}`);
    }
  });

  afterAll(() => {
    Object.assign(env, originalEnv);
  });

  // ---------------------------------------------------------------- Moment 1
  describe('Moment 1: a spreadsheet with bad rows saves nothing and says exactly what is wrong', () => {
    it('returns row-level errors and leaves the batch untouched', async () => {
      const created = await request(app)
        .post('/api/batches')
        .set(as('anika'))
        .send({ batchCode: `E2E-M1-${RUN}`, courseName: 'Moment One' });
      const batchId = created.body.batch.id as string;

      // A good upload first, so we can prove a later bad upload does not wipe or half-save
      await request(app)
        .post(`/api/batches/${batchId}/upload`)
        .set(as('anika'))
        .attach('file', Buffer.from(csvOf(2, 'm1')), 'good.csv')
        .expect(200);

      const bad = [
        'fullName,phone,email,nationalIdLast4,score,passed',
        'Fine Person,+919811110001,f@example.com,1001,85,PASS',
        'Bad Phone,12345,b@example.com,1002,80,PASS',
        'Bad Score,+919811110003,s@example.com,1003,150,PASS',
        'Failed Person,+919811110004,x@example.com,1004,30,FAIL',
      ].join('\n');
      const res = await request(app)
        .post(`/api/batches/${batchId}/upload`)
        .set(as('anika'))
        .attach('file', Buffer.from(bad), 'bad.csv');

      expect(res.status).toBe(400);
      const fields = (res.body.rowErrors as Array<{ row: number; field: string }>).map(
        (e) => `${e.row}:${e.field}`
      );
      expect(fields).toEqual(expect.arrayContaining(['3:phone', '4:score', '5:passed']));

      const batch = await getBatch('anika', batchId);
      expect(batch.candidates).toHaveLength(2); // still the earlier good upload, nothing half-saved
      expect(batch.candidates.map((c: { fullName: string }) => c.fullName).join()).not.toContain('Fine Person');
    });
  });

  // ---------------------------------------------------------------- Moment 2
  describe('Moment 2: simultaneous approvals move the batch forward exactly once', () => {
    it('three officers approve at the same instant: 2 count, batch advances once, the 3rd is refused', async () => {
      const batchId = await newSubmittedBatch(3, 'M2');

      const results = await Promise.all([
        decide('dev', batchId, 'APPROVE'),
        decide('meera', batchId, 'APPROVE'),
        decide('kabir', batchId, 'APPROVE'),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(2);
      expect(statuses.filter((s) => s !== 200)).toHaveLength(1);

      const batch = await getBatch('farah', batchId);
      expect(batch.status).toBe('PENDING_STATE');

      const audits = await prisma.auditEvent.findMany({
        where: { batchId, action: 'DECISION_APPROVE' },
      });
      const advances = audits.filter(
        (a) => (a.details as { nextStatus?: string } | null)?.nextStatus === 'PENDING_STATE'
      );
      expect(advances).toHaveLength(1); // moved forward once, not twice
    });

    it('the same officer cannot vote twice to reach the quorum alone', async () => {
      const batchId = await newSubmittedBatch(2, 'M2b');
      await decide('dev', batchId, 'APPROVE').expect(200);
      const again = await decide('dev', batchId, 'APPROVE');
      expect(again.status).toBe(409);
      expect((await getBatch('dev', batchId)).status).toBe('SUBMITTED_DISTRICT');
    });
  });

  // ------------------------------------------------- Moment 3 + issuance rules
  describe('Moment 3: 60 candidates, flaky WhatsApp, exactly one certificate each', () => {
    let batchId = '';
    let certs: Array<{ id: string; certificateNumber: string; downloadToken: string; candidateId: string }> = [];

    it('large batch takes the quality route, then issues exactly one certificate per candidate', async () => {
      vi.mocked(enqueueBatchIssuance).mockClear();
      batchId = await newSubmittedBatch(60, 'M3');
      expect((await getBatch('anika', batchId)).requiresQualityTeam).toBe(true);

      await decide('dev', batchId, 'APPROVE').expect(200);
      await decide('meera', batchId, 'APPROVE').expect(200);
      expect((await getBatch('neha', batchId)).status).toBe('PENDING_QUALITY');
      await decide('neha', batchId, 'APPROVE').expect(200);
      await decide('farah', batchId, 'APPROVE').expect(200);

      // the API handed the work to the queue instead of doing it inline
      expect(enqueueBatchIssuance).toHaveBeenCalledWith(batchId);

      // The queue may deliver the same job more than once: run the issuance twice.
      await processBatchIssuance(batchId);
      await processBatchIssuance(batchId);

      expect(await prisma.candidate.count({ where: { batchId } })).toBe(60);
      certs = await prisma.certificate.findMany({ where: { batchId } });
      expect(certs).toHaveLength(60);
      expect(new Set(certs.map((c) => c.certificateNumber)).size).toBe(60);
      expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);
      expect((await getBatch('farah', batchId)).status).toBe('ISSUED');
    });

    it('every candidate receives exactly one WhatsApp message despite failures and lost acks', async () => {
      env.whatsappFailureRate = 0.4; // 40% of sends fail outright
      env.whatsappAmbiguousRate = 0.2; // 20% deliver but the ack times out
      env.whatsappTimeoutMs = 0;
      const before = providerStats.deliveries;
      let failedAttempts = 0;

      for (const cert of certs) {
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            await processWhatsAppDelivery(cert.id); // what the queue worker runs on each retry
            break;
          } catch {
            failedAttempts++;
          }
        }
      }

      const messages = await prisma.whatsAppMessage.findMany({ where: { certificate: { batchId } } });
      expect(failedAttempts).toBeGreaterThan(0); // chaos really happened
      expect(messages).toHaveLength(60);
      expect(messages.every((m) => m.status === DeliveryStatus.DELIVERED)).toBe(true);
      expect(new Set(messages.map((m) => m.certificateId)).size).toBe(60);
      // the provider really delivered exactly 60 times, never twice to the same candidate
      expect(providerStats.deliveries - before).toBe(60);
    });

    it('a candidate cannot get a second certificate (database constraint backs the code)', async () => {
      const first = certs[0];
      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
      await expect(
        prisma.certificate.create({
          data: {
            certificateNumber: `PSM-DUP-${RUN}`,
            batchId,
            candidateId: first.candidateId,
            candidateName: 'Duplicate',
            courseName: batch.courseName,
            trainingCentreName: batch.trainingCentreName,
            district: batch.district,
            downloadToken: `dup-${RUN}`,
          },
        })
      ).rejects.toThrow();
      expect(await prisma.certificate.count({ where: { batchId } })).toBe(60);
    });

    it('reconciler re-queues work that was lost (crash after commit / provider outage)', async () => {
      vi.mocked(enqueueBatchIssuance).mockClear();
      vi.mocked(enqueueWhatsAppDelivery).mockClear();

      // (a) a batch approved long ago whose issuance job never ran
      const stuckId = await newSubmittedBatch(2, 'REC');
      await prisma.$executeRaw`UPDATE "Batch" SET status = 'APPROVED'::"BatchStatus", "updatedAt" = now() - interval '1 hour' WHERE id = ${stuckId}`;

      // (b) a message that failed and has been idle
      const victim = certs[2];
      await prisma.$executeRaw`UPDATE "WhatsAppMessage" SET status = 'FAILED'::"DeliveryStatus", "updatedAt" = now() - interval '1 hour' WHERE "certificateId" = ${victim.id}`;

      await reconcileStuckWork();
      expect(enqueueBatchIssuance).toHaveBeenCalledWith(stuckId);
      // the re-queued job completes the batch
      await processBatchIssuance(stuckId);
      expect((await getBatch('farah', stuckId)).status).toBe('ISSUED');
      expect(enqueueWhatsAppDelivery).toHaveBeenCalledWith(victim.id);

      // and the retry path still ends with exactly one delivery
      env.whatsappFailureRate = 0;
      env.whatsappAmbiguousRate = 0;
      await processWhatsAppDelivery(victim.id);
      const msg = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { certificateId: victim.id } });
      expect(msg.status).toBe(DeliveryStatus.DELIVERED);
    });

    it('a stranger cannot download a certificate; the holder of the link can', async () => {
      const cert = certs[1];
      expect((await request(app).get(`/api/certificates/${cert.id}/download`)).status).toBe(403);
      expect((await request(app).get(`/api/certificates/${cert.id}/download?token=wrong`)).status).toBe(403);
      const ok = await request(app).get(`/api/certificates/${cert.id}/download?token=${cert.downloadToken}`);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toContain('application/pdf');
    });

    it('public verification reveals no personal details', async () => {
      const cert = certs[3];
      const res = await request(app)
        .get(`/api/public/verify/${cert.certificateNumber}`)
        .set('X-Forwarded-For', `10.9.${RUN % 250}.1`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      for (const secret of ['phone', 'email', 'nationalIdLast4', 'score', 'downloadToken']) {
        expect(res.body[secret]).toBeUndefined();
      }
      const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: cert.candidateId } });
      expect(JSON.stringify(res.body)).not.toContain(candidate.phone);
    });

    // ------------------------------------------------------------ Moment 4
    it('Moment 4: after the state office cancels, verification says invalid at once, even against a stale cache', async () => {
      const cert = certs[4];
      const ip = `10.8.${RUN % 250}.1`;
      const verify = () =>
        request(app).get(`/api/public/verify/${cert.certificateNumber}`).set('X-Forwarded-For', ip);

      expect((await verify()).body.valid).toBe(true); // also primes the cache

      await request(app)
        .post(`/api/certificates/${cert.id}/cancel`)
        .set(as('farah'))
        .send({ reason: 'Issued in error' })
        .expect(200);

      const after = await verify();
      expect(after.body.valid).toBe(false);
      expect(after.body.status).toBe('CANCELLED');

      // Simulate the race: a reader that fetched "valid" before the cancel writes it to the cache after
      await redis.set(
        verifyCacheKey(cert.certificateNumber),
        JSON.stringify({ valid: true, status: 'ISSUED', certificateNumber: cert.certificateNumber }),
        'EX',
        120
      );
      const raced = await verify();
      expect(raced.body.valid).toBe(false);

      // a cancelled certificate can no longer be downloaded or re-sent
      const dl = await request(app).get(`/api/certificates/${cert.id}/download?token=${cert.downloadToken}`);
      expect(dl.status).toBe(410);
      const sendsBefore = providerStats.deliveries;
      await processWhatsAppDelivery(cert.id);
      expect(providerStats.deliveries).toBe(sendsBefore);
      expect(
        (await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).status
      ).toBe(CertificateStatus.CANCELLED);
    });

    it('only the state office can cancel a certificate', async () => {
      const cert = certs[5];
      await request(app).post(`/api/certificates/${cert.id}/cancel`).set(as('dev')).send({ reason: 'nope nope' }).expect(403);
      await request(app).post(`/api/certificates/${cert.id}/cancel`).set(as('anika')).send({ reason: 'nope nope' }).expect(403);
      await request(app).post(`/api/certificates/${cert.id}/cancel`).send({ reason: 'nope nope' }).expect(401);
    });
  });

  // ---------------------------------------------------------------- Moment 5
  describe('Moment 5: a batch stuck with an officer is escalated without anyone chasing', () => {
    it('SLA check raises exactly one open alert for a batch idle past the SLA, visible to the state office only', async () => {
      const batchId = await newSubmittedBatch(2, 'M5');
      await prisma.$executeRaw`UPDATE "Batch" SET "stageEnteredAt" = now() - interval '72 hours' WHERE id = ${batchId}`;

      await request(app).post('/api/batches/sla-check').set(as('farah')).expect(200);
      await request(app).post('/api/batches/sla-check').set(as('farah')).expect(200); // idempotent

      const list = await request(app).get('/api/batches/escalations/list').set(as('farah'));
      expect(list.status).toBe(200);
      const open = (
        list.body.alerts as Array<{ acknowledged: boolean; batch: { id: string } }>
      ).filter((a) => a.batch.id === batchId && !a.acknowledged);
      expect(open).toHaveLength(1);

      await request(app).get('/api/batches/escalations/list').set(as('anika')).expect(403);
      await request(app).post('/api/batches/sla-check').set(as('dev')).expect(403);
    });
  });

  // ---------------------------------------------------------------- Moment 6
  describe('Moment 6: sent back, fixed and resent: prior approvals are voided (documented decision)', () => {
    it('archives round-1 approvals, so the new round needs a fresh quorum', async () => {
      const batchId = await newSubmittedBatch(2, 'M6');
      await decide('dev', batchId, 'APPROVE').expect(200);
      await decide('kabir', batchId, 'SEND_BACK', 'Fix candidate spelling').expect(200);
      expect((await getBatch('anika', batchId)).status).toBe('RETURNED_FOR_CORRECTION');

      await request(app)
        .post(`/api/batches/${batchId}/upload`)
        .set(as('anika'))
        .attach('file', Buffer.from(csvOf(2, 'M6fixed')), 'fixed.csv')
        .expect(200);
      await request(app).post(`/api/batches/${batchId}/submit`).set(as('anika')).expect(200);

      const batch = await getBatch('dev', batchId);
      expect(batch.approvalRound).toBe(2);
      expect(batch.status).toBe('SUBMITTED_DISTRICT');
      expect(batch.decisions.filter((d: { active: boolean }) => d.active)).toHaveLength(0);

      // Dev's round-1 approval does not carry over: one new approval is not enough
      await decide('dev', batchId, 'APPROVE').expect(200);
      expect((await getBatch('dev', batchId)).status).toBe('SUBMITTED_DISTRICT');
      await decide('meera', batchId, 'APPROVE').expect(200);
      expect((await getBatch('dev', batchId)).status).toBe('PENDING_STATE');
    });

    it('rejecting or sending back requires a reason', async () => {
      const batchId = await newSubmittedBatch(2, 'M6r');
      await decide('dev', batchId, 'REJECT').expect(400);
      await decide('dev', batchId, 'SEND_BACK', '').expect(400);
    });
  });

  // ----------------------------------------------- Things that must never happen
  describe('Never: acting at a step that is not yours, or as someone else', () => {
    it('refuses wrong roles, wrong districts and wrong steps', async () => {
      const batchId = await newSubmittedBatch(2, 'N1');
      await decide('farah', batchId, 'APPROVE').expect(403); // state office at the district step
      await decide('neha', batchId, 'APPROVE').expect(403); // quality team at the district step
      await decide('anika', batchId, 'APPROVE').expect(403); // the centre approving its own batch

      const nashik = await prisma.user.upsert({
        where: { email: 'dev.nashik@test.pragati.gov.in' },
        update: {},
        create: {
          id: `user-nashik-${RUN}`,
          name: 'Nashik Officer',
          email: 'dev.nashik@test.pragati.gov.in',
          role: UserRole.DISTRICT_OFFICER,
          district: 'Nashik',
        },
      });
      tokens.nashik = await switchTo(nashik.id);
      await decide('nashik', batchId, 'APPROVE').expect(403); // another district
      await request(app).get(`/api/batches/${batchId}`).set(as('nashik')).expect(403);
      const list = await request(app).get('/api/batches').set(as('nashik'));
      expect(list.body.batches.map((b: { id: string }) => b.id)).not.toContain(batchId);

      // once the batch has moved on, district officers have no say at the state step
      await decide('dev', batchId, 'APPROVE').expect(403);
      await decide('kabir', batchId, 'APPROVE').expect(403);
    });

    it('a forged or tampered token cannot impersonate anyone', async () => {
      const forged = jwt.sign({ sub: 'user-farah', role: 'STATE_OFFICE' }, 'not-the-real-secret');
      await request(app).get('/api/batches').set('Authorization', `Bearer ${forged}`).expect(401);

      // Valid signature, but the token CLAIMS to be the state office while the user is a centre.
      const lying = jwt.sign({ sub: 'user-anika', role: 'STATE_OFFICE' }, env.jwtSecret);
      await request(app)
        .post('/api/batches/sla-check')
        .set('Authorization', `Bearer ${lying}`)
        .expect(403); // role comes from the database, never from the token
    });

    it('centres cannot see each other\'s batches', async () => {
      const batchId = await newSubmittedBatch(2, 'N3');
      const other = await prisma.user.upsert({
        where: { email: 'centre.b@test.pragati.in' },
        update: {},
        create: {
          id: `user-centre-b-${RUN}`,
          name: 'Other Centre',
          email: 'centre.b@test.pragati.in',
          role: UserRole.TRAINING_CENTRE,
          district: 'Pune',
          centreName: 'Other Academy',
        },
      });
      tokens.otherCentre = await switchTo(other.id);
      await request(app).get(`/api/batches/${batchId}`).set(as('otherCentre')).expect(403);
      await request(app).post(`/api/batches/${batchId}/submit`).set(as('otherCentre')).expect(403);
      const list = await request(app).get('/api/batches').set(as('otherCentre'));
      expect(list.body.batches.map((b: { id: string }) => b.id)).not.toContain(batchId);
    });

    it('quality team only sees batches that need quality review', async () => {
      const smallBatchId = await newSubmittedBatch(2, 'N4');
      await request(app).get(`/api/batches/${smallBatchId}`).set(as('neha')).expect(403);
    });
  });

  describe('Never: a decision that cannot be traced to who made it and when', () => {
    it('every decision has the officer, role, stage, round and a timestamp, in both tables', async () => {
      const batchId = await newSubmittedBatch(2, 'T1');
      await decide('dev', batchId, 'APPROVE').expect(200);
      await decide('meera', batchId, 'APPROVE').expect(200);

      const decisions = await prisma.approvalDecision.findMany({ where: { batchId } });
      expect(decisions.map((d) => d.officerId).sort()).toEqual(['user-dev', 'user-meera']);
      for (const d of decisions) {
        expect(d.createdAt).toBeInstanceOf(Date);
        expect(d.stage).toBe(BatchStatus.SUBMITTED_DISTRICT);
        expect(d.round).toBe(1);
      }
      const audits = await prisma.auditEvent.findMany({ where: { batchId, action: 'DECISION_APPROVE' } });
      expect(audits).toHaveLength(2);
      for (const a of audits) {
        expect(a.actorId).toBeTruthy();
        expect(a.actorName).toBeTruthy();
        expect(a.actorRole).toBe('DISTRICT_OFFICER');
        expect(a.createdAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('Never: a stranger gets in through the demo or realtime surfaces', () => {
    it('demo endpoints disappear when DEMO_MODE is off, and the event stream needs a login', async () => {
      env.demoMode = false;
      try {
        await request(app).get('/api/auth/personas').expect(404);
        await request(app).post('/api/auth/switch').send({ userId: 'user-farah' }).expect(404);
        await request(app).get('/api/whatsapp/messages').expect(404);
      } finally {
        env.demoMode = true;
      }
      await request(app).get('/api/events').expect(401);
    });
  });

  describe('Public verification is rate limited and keeps working without the cache', () => {
    it('answers 429 after the per-IP limit, but other clients are unaffected', async () => {
      const limit = 3;
      env.verifyRateLimitPerMin = limit;
      const ipA = `10.7.${RUN % 250}.${RUN % 200}`;
      const ipB = `10.6.${RUN % 250}.${RUN % 200}`;
      const get = (ip: string) =>
        request(app).get('/api/public/verify/PSM-2026-PUNE-10000').set('X-Forwarded-For', ip);

      // (a minute rollover resets the counter, so allow up to 2x the limit before expecting a 429)
      let limited = false;
      for (let i = 0; i < limit * 2 + 2 && !limited; i++) {
        limited = (await get(ipA)).status === 429;
      }
      expect(limited).toBe(true);
      expect((await get(ipB)).status).toBeLessThan(429);
      env.verifyRateLimitPerMin = originalEnv.verifyRateLimitPerMin;
    });

    it('unknown numbers return 404 NOT_FOUND, not an error', async () => {
      const res = await request(app)
        .get('/api/public/verify/PSM-0000-NONE-1')
        .set('X-Forwarded-For', `10.5.${RUN % 250}.1`);
      expect(res.status).toBe(404);
      expect(res.body.valid).toBe(false);
    });
  });
});
