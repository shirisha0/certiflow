import { BatchStatus, CertificateStatus, DeliveryStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { enqueueBatchIssuance, enqueueWhatsAppDelivery } from './queue';
import { recordAudit } from './audit';

/**
 * Safety net for the two places where "commit to Postgres" and "enqueue to Redis" are
 * separate steps (the classic dual-write problem):
 *
 *  1. A batch was approved (row committed) but the process died before the issuance job was
 *     queued, or the job exhausted its retries -> batch sits in APPROVED/ISSUING forever.
 *  2. A WhatsApp message exhausted its queue retries (provider outage) -> candidate never
 *     receives the certificate.
 *
 * Both are recovered by re-queueing; every downstream step is idempotent, so running this
 * repeatedly (or from several worker instances) is safe.
 */
export async function reconcileStuckWork(): Promise<{ batches: number; messages: number }> {
  const cutoff = new Date(Date.now() - env.reconcileAfterSeconds * 1000);

  const stuckBatches = await prisma.batch.findMany({
    where: {
      status: { in: [BatchStatus.APPROVED, BatchStatus.ISSUING] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, batchCode: true },
    take: 100,
  });

  for (const batch of stuckBatches) {
    await enqueueBatchIssuance(batch.id);
    await recordAudit({
      batchId: batch.id,
      actorName: 'Reconciler',
      actorRole: 'SYSTEM',
      action: 'ISSUANCE_REQUEUED',
      entityType: 'BATCH',
      entityId: batch.id,
      details: { reason: 'Batch stuck in APPROVED/ISSUING; re-queued for issuance' },
    });
  }

  const undelivered = await prisma.certificate.findMany({
    where: {
      status: CertificateStatus.ISSUED,
      OR: [
        // certificate exists but no message was ever created
        { issuedAt: { lt: cutoff }, whatsappMessages: { none: {} } },
        // message exists, is not delivered, has been idle, and has not hit the attempt cap
        {
          whatsappMessages: {
            some: {
              status: { not: DeliveryStatus.DELIVERED },
              attempts: { lt: env.whatsappMaxTotalAttempts },
              updatedAt: { lt: cutoff },
            },
          },
        },
      ],
    },
    select: { id: true },
    take: 500,
  });

  for (const cert of undelivered) {
    await enqueueWhatsAppDelivery(cert.id);
  }

  return { batches: stuckBatches.length, messages: undelivered.length };
}
