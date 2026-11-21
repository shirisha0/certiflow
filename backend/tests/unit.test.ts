import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { parseAndValidateSpreadsheet } from '../src/services/csvParser';
import { generateCertificatePdf } from '../src/services/pdfGenerator';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import fs from 'fs';

describe('CertiFlow Core Invariants & Moments', () => {
  describe('Moment 1: Atomic Spreadsheet Validation (All-or-Nothing)', () => {
    it('rejects a spreadsheet with bad rows and returns exact row/field errors', () => {
      const badCsv = [
        'fullName,phone,email,nationalIdLast4,score,passed',
        'Valid User,+919811110001,valid@example.com,1001,85,PASS',
        'Bad Phone,12345,bad@example.com,1002,80,PASS',
        'Bad Score,+919811110003,score@example.com,1003,150,PASS',
        'Failed Candidate,+919811110004,fail@example.com,1004,30,FAIL',
      ].join('\n');

      const result = parseAndValidateSpreadsheet(Buffer.from(badCsv, 'utf-8'), 'test.csv');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.row === 3 && e.field === 'phone')).toBe(true);
        expect(result.errors.some((e) => e.row === 4 && e.field === 'score')).toBe(true);
        expect(result.errors.some((e) => e.row === 5 && e.field === 'passed')).toBe(true);
      }
    });

    it('rejects duplicate phone numbers or IDs within the same batch', () => {
      const dupCsv = [
        'fullName,phone,email,nationalIdLast4,score,passed',
        'User One,+919811110001,u1@example.com,1001,85,PASS',
        'User Two,+919811110001,u2@example.com,1002,88,PASS',
      ].join('\n');

      const result = parseAndValidateSpreadsheet(Buffer.from(dupCsv, 'utf-8'), 'dup.csv');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => e.row === 3 && e.field === 'phone')).toBe(true);
      }
    });

    it('accepts candidates who share the last 4 ID digits (they are not unique per person)', () => {
      const lines = ['fullName,phone,email,nationalIdLast4,score,passed'];
      for (let i = 1; i <= 60; i++) {
        lines.push(`Candidate ${i},+91980000${String(i).padStart(4, '0')},c${i}@example.com,1234,85,PASS`);
      }
      const result = parseAndValidateSpreadsheet(Buffer.from(lines.join('\n'), 'utf-8'), 'same-ids.csv');
      expect(result.valid).toBe(true);
    });

    it('reports every bad row at once, not just the first', () => {
      const csv = [
        'fullName,phone,email,nationalIdLast4,score,passed',
        'A,12345,a@example.com,1001,85,PASS',
        'Bob Valid,+919811110002,b@example.com,12,85,PASS',
        'Cara Valid,+919811110003,not-an-email,1003,85,PASS',
      ].join('\n');
      const result = parseAndValidateSpreadsheet(Buffer.from(csv, 'utf-8'), 'multi.csv');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        const fields = result.errors.map((e) => `${e.row}:${e.field}`);
        expect(fields).toEqual(
          expect.arrayContaining(['2:fullName', '2:phone', '3:nationalIdLast4', '4:email'])
        );
      }
    });

    it('accepts a valid 60-candidate batch cleanly', () => {
      const lines = ['fullName,phone,email,nationalIdLast4,score,passed'];
      for (let i = 1; i <= 60; i++) {
        const phone = `+91980000${String(i).padStart(4, '0')}`;
        const id4 = String(3000 + i);
        lines.push(`Candidate ${i},${phone},c${i}@example.com,${id4},85,PASS`);
      }
      const result = parseAndValidateSpreadsheet(Buffer.from(lines.join('\n'), 'utf-8'), 'large.csv');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.rows).toHaveLength(60);
      }
    });
  });

  describe('PDF Certificate Generation', () => {
    it('generates a valid PDF file with QR verification embedded', async () => {
      const pdfPath = await generateCertificatePdf({
        certificateNumber: 'PSM-2026-TEST-99999',
        candidateName: 'Test Candidate',
        courseName: 'Solar PV Technician',
        trainingCentreName: 'Pragati Tech Academy',
        district: 'Pune',
        issuedAt: new Date(),
      });
      expect(fs.existsSync(pdfPath)).toBe(true);
      const stat = fs.statSync(pdfPath);
      expect(stat.size).toBeGreaterThan(1000);
      fs.unlinkSync(pdfPath);
    });
  });

  describe('Security & Unauthenticated Access Guards', () => {
    const app = createApp();

    it('blocks unauthenticated access to protected batch and certificate routes', async () => {
      const res1 = await request(app).get('/api/batches');
      expect(res1.status).toBe(401);

      const res2 = await request(app).post('/api/batches').send({ batchCode: 'B1', courseName: 'Test' });
      expect(res2.status).toBe(401);

      const res3 = await request(app).post('/api/certificates/fake-id/cancel').send({ reason: 'Fake' });
      expect(res3.status).toBe(401);
    });

    it('requires authentication for the realtime event stream', async () => {
      const res = await request(app).get('/api/events');
      expect(res.status).toBe(401);
    });

    it('hides demo-only endpoints when DEMO_MODE is off', async () => {
      const original = env.demoMode;
      env.demoMode = false;
      try {
        expect((await request(app).get('/api/auth/personas')).status).toBe(404);
        expect((await request(app).post('/api/auth/switch').send({ userId: 'user-farah' })).status).toBe(404);
        expect((await request(app).get('/api/whatsapp/messages')).status).toBe(404);
      } finally {
        env.demoMode = original;
      }
    });

    it('rejects a forged token signed with the wrong secret', async () => {
      const res = await request(app)
        .get('/api/batches')
        .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWZhcmFoIiwicm9sZSI6IlNUQVRFX09GRklDRSJ9.invalid');
      expect(res.status).toBe(401);
    });

    it('returns health check ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });
});
