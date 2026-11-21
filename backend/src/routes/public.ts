import { Router, Request, Response, NextFunction } from 'express';
import { CertificateStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import {
  redis,
  VERIFY_CACHE_TTL_SECONDS,
  verifyCacheKey,
  verifyTombstoneKey,
} from '../config/redis';

const router = Router();

/**
 * Fixed-window rate limit per client IP. Certificate numbers are sequential, so without a limit
 * the public endpoint could be used to enumerate every certificate (and candidate name).
 * Fails OPEN if Redis is down: verification availability matters more than the limit.
 */
async function verifyRateLimit(req: Request, res: Response, next: NextFunction) {
  try {
    const window = Math.floor(Date.now() / 60000);
    const key = `rl:verify:${req.ip}:${window}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 70);
    if (count > env.verifyRateLimitPerMin) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many verification requests. Try again in a minute.' });
    }
  } catch (err) {
    console.warn('[verify] rate limiter unavailable, allowing request:', (err as Error).message);
  }
  next();
}

// Public, unauthenticated verification endpoint for employers and the public.
// NEVER exposes candidate phone, email, nationalIdLast4, score, or downloadToken.
router.get('/verify/:certificateNumber', verifyRateLimit, async (req, res, next) => {
  try {
    const certNumber = req.params.certificateNumber.trim().toUpperCase();
    const cacheKey = verifyCacheKey(certNumber);

    // Cache read is an optimisation only: any Redis problem falls through to Postgres.
    // If a cancellation tombstone exists, the cache is ignored (see certificates.ts).
    try {
      const [cached, tombstone] = await redis.mget(cacheKey, verifyTombstoneKey(certNumber));
      if (cached && !tombstone) {
        return res.json({ ...JSON.parse(cached), cached: true });
      }
    } catch (err) {
      console.warn('[verify] cache read failed, using database:', (err as Error).message);
    }

    const cert = await prisma.certificate.findUnique({
      where: { certificateNumber: certNumber },
      select: {
        certificateNumber: true,
        candidateName: true,
        courseName: true,
        trainingCentreName: true,
        district: true,
        status: true,
        issuedAt: true,
        cancelledAt: true,
        cancellationReason: true,
      },
    });

    if (!cert) {
      return res.status(404).json({
        valid: false,
        status: 'NOT_FOUND',
        message: 'No certificate found with this number.',
      });
    }

    const responsePayload = {
      valid: cert.status === CertificateStatus.ISSUED,
      status: cert.status,
      certificateNumber: cert.certificateNumber,
      candidateName: cert.candidateName,
      courseName: cert.courseName,
      trainingCentreName: cert.trainingCentreName,
      district: cert.district,
      issuedAt: cert.issuedAt,
      cancelledAt: cert.cancelledAt,
      cancellationReason: cert.cancellationReason,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', VERIFY_CACHE_TTL_SECONDS);
    } catch (err) {
      console.warn('[verify] cache write failed (non-fatal):', (err as Error).message);
    }

    return res.json({ ...responsePayload, cached: false });
  } catch (err) {
    next(err);
  }
});

export default router;
