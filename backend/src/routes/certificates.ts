import { Router } from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { CertificateStatus, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { redis, TOMBSTONE_TTL_SECONDS, verifyCacheKey, verifyTombstoneKey } from '../config/redis';
import { requireAuth, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { recordAudit } from '../services/audit';
import { generateCertificatePdf } from '../services/pdfGenerator';
import { publishEvent } from '../services/sse';

const router = Router();

const cancelSchema = z.object({
  reason: z.string().trim().min(3, 'Cancellation reason is required (min 3 chars)'),
});

// List certificates (State Office only)
router.get(
  '/',
  requireAuth,
  requireRole(UserRole.STATE_OFFICE),
  async (_req, res, next) => {
    try {
      const certificates = await prisma.certificate.findMany({
        orderBy: { issuedAt: 'desc' },
        take: 200,
        include: {
          batch: { select: { batchCode: true } },
          whatsappMessages: {
            select: { status: true, attempts: true, sentAt: true, lastError: true },
          },
        },
      });
      res.json({ certificates });
    } catch (err) {
      next(err);
    }
  }
);

// Cancel / revoke a certificate (State Office only)
router.post(
  '/:id/cancel',
  requireAuth,
  requireRole(UserRole.STATE_OFFICE),
  async (req, res, next) => {
    try {
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid cancellation payload', parsed.error.flatten());
      }

      const cert = await prisma.certificate.findUnique({ where: { id: req.params.id } });
      if (!cert) {
        throw new AppError(404, 'Certificate not found');
      }
      if (cert.status === CertificateStatus.CANCELLED) {
        throw new AppError(400, 'Certificate is already cancelled');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const c = await tx.certificate.update({
          where: { id: cert.id },
          data: {
            status: CertificateStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledById: req.user!.id,
            cancellationReason: parsed.data.reason,
          },
        });

        await recordAudit(
          {
            batchId: cert.batchId,
            actorId: req.user!.id,
            actorName: req.user!.name,
            actorRole: req.user!.role,
            action: 'CERTIFICATE_CANCELLED',
            entityType: 'CERTIFICATE',
            entityId: cert.id,
            details: {
              certificateNumber: cert.certificateNumber,
              reason: parsed.data.reason,
            },
          },
          tx
        );

        return c;
      });

      // Invalidate the verification cache and leave a tombstone so a racing reader cannot
      // re-cache the old "valid" answer. The cancel is already committed (Postgres is the
      // source of truth), so a Redis failure here must not turn into a 500.
      try {
        await redis
          .multi()
          .set(verifyTombstoneKey(cert.certificateNumber), '1', 'EX', TOMBSTONE_TTL_SECONDS)
          .del(verifyCacheKey(cert.certificateNumber))
          .exec();
      } catch (err) {
        console.error(
          '[cancel] cache invalidation failed; a stale "valid" verify result is possible for up to 120s:',
          (err as Error).message
        );
      }

      await publishEvent('CERTIFICATE_CANCELLED', {
        certificateId: cert.id,
        certificateNumber: cert.certificateNumber,
        batchId: cert.batchId,
      });

      res.json({ certificate: updated });
    } catch (err) {
      next(err);
    }
  }
);

// Download certificate PDF (requires candidate downloadToken OR authorized staff JWT)
router.get('/:id/download', async (req, res, next) => {
  try {
    const cert = await prisma.certificate.findUnique({
      where: { id: req.params.id },
      include: { batch: true },
    });

    if (!cert) {
      throw new AppError(404, 'Certificate not found');
    }

    const candidateToken = req.query.token as string | undefined;
    const authHeader = req.headers.authorization;
    let authorized = false;

    if (candidateToken && candidateToken === cert.downloadToken) {
      authorized = true;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), env.jwtSecret) as {
          sub: string;
          role: UserRole;
        };
        const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
        if (user) {
          if (user.role === UserRole.STATE_OFFICE || user.role === UserRole.QUALITY_TEAM) {
            authorized = true;
          } else if (user.role === UserRole.DISTRICT_OFFICER && user.district === cert.district) {
            authorized = true;
          } else if (user.role === UserRole.TRAINING_CENTRE && cert.batch.createdById === user.id) {
            authorized = true;
          }
        }
      } catch {
        authorized = false;
      }
    }

    if (!authorized) {
      return res.status(403).json({
        error: 'Forbidden: valid candidate download token or authorized staff session required',
      });
    }

    if (cert.status === CertificateStatus.CANCELLED) {
      return res.status(410).json({
        error: 'This certificate has been cancelled and can no longer be downloaded',
      });
    }

    let pdfPath = cert.pdfPath;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      pdfPath = await generateCertificatePdf({
        certificateNumber: cert.certificateNumber,
        candidateName: cert.candidateName,
        courseName: cert.courseName,
        trainingCentreName: cert.trainingCentreName,
        district: cert.district,
        issuedAt: cert.issuedAt,
      });
      await prisma.certificate.update({
        where: { id: cert.id },
        data: { pdfPath },
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${cert.certificateNumber}.pdf"`
    );
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
