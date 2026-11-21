import { Worker } from 'bullmq';
import crypto from 'crypto';
import { BatchStatus, CertificateStatus, DeliveryStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { redis } from '../config/redis';
import { QUEUE_NAMES, enqueueWhatsAppDelivery, scheduleSlaMonitor } from '../services/queue';
import { generateCertificatePdf } from '../services/pdfGenerator';
import { sendViaStandInWhatsApp } from '../services/whatsappProvider';
import { recordAudit } from '../services/audit';
import { publishEvent } from '../services/sse';
import { runSlaCheck } from '../routes/batches';
import { reconcileStuckWork } from '../services/reconcile';

type IssuanceBatch = { id: string; courseName: string; trainingCentreName: string; district: string };
type IssuanceCandidate = { id: string; fullName: string };

/**
 * Create the certificate for a candidate exactly once. The sequence gives a unique number;
 * the unique constraints on (candidateId) and (certificateNumber) are the backstop if two
 * workers race on the same candidate (e.g. a stalled job that is retried).
 */
async function createCertificateOnce(
  batch: IssuanceBatch,
  candidate: IssuanceCandidate,
  districtCode: string,
  year: number
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const seqResult = await prisma.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('certificate_seq')
    `;
    const certificateNumber = `PSM-${year}-${districtCode}-${seqResult[0].nextval.toString()}`;
    try {
      return await prisma.certificate.create({
        data: {
          certificateNumber,
          batchId: batch.id,
          candidateId: candidate.id,
          candidateName: candidate.fullName,
          courseName: batch.courseName,
          trainingCentreName: batch.trainingCentreName,
          district: batch.district,
          status: CertificateStatus.ISSUED,
          downloadToken: crypto.randomBytes(24).toString('hex'),
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      // Someone else already issued this candidate's certificate: reuse it.
      const existing = await prisma.certificate.findUnique({
        where: { batchId_candidateId: { batchId: batch.id, candidateId: candidate.id } },
      });
      if (existing) return existing;
      // Otherwise the number collided: loop and take the next sequence value.
    }
  }
  throw new Error(`Could not allocate a unique certificate number for candidate ${candidate.id}`);
}

export async function processBatchIssuance(batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { candidates: true },
  });

  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  const issuable: BatchStatus[] = [BatchStatus.APPROVED, BatchStatus.ISSUING, BatchStatus.ISSUED];
  if (!issuable.includes(batch.status)) {
    // Never issue certificates for a batch that was not approved.
    console.warn(`[batch-issuance] Skipping batch ${batch.id}: status ${batch.status}`);
    return;
  }

  if (batch.status === BatchStatus.APPROVED) {
    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: BatchStatus.ISSUING },
    });
  }

  const districtCode = batch.district.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'STAT';
  const year = new Date().getFullYear();

  for (const candidate of batch.candidates) {
    // Idempotent check: if certificate already exists for this candidate, reuse it
    let cert = await prisma.certificate.findUnique({
      where: {
        batchId_candidateId: {
          batchId: batch.id,
          candidateId: candidate.id,
        },
      },
    });

    if (!cert) {
      cert = await createCertificateOnce(batch, candidate, districtCode, year);
    }

    if (!cert.pdfPath) {
      const pdfPath = await generateCertificatePdf({
        certificateNumber: cert.certificateNumber,
        candidateName: cert.candidateName,
        courseName: cert.courseName,
        trainingCentreName: cert.trainingCentreName,
        district: cert.district,
        issuedAt: cert.issuedAt,
      });

      cert = await prisma.certificate.update({
        where: { id: cert.id },
        data: { pdfPath },
      });
    }

    const alreadyDelivered = await prisma.whatsAppMessage.findFirst({
      where: { certificateId: cert.id, status: DeliveryStatus.DELIVERED },
      select: { id: true },
    });
    if (!alreadyDelivered && cert.status === CertificateStatus.ISSUED) {
      await enqueueWhatsAppDelivery(cert.id);
    }
  }

  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: BatchStatus.ISSUED },
  });

  await recordAudit({
    batchId: batch.id,
    actorName: 'Issuance Worker',
    actorRole: 'SYSTEM',
    action: 'CERTIFICATES_ISSUED',
    entityType: 'BATCH',
    entityId: batch.id,
    details: { count: batch.candidates.length },
  });

  await publishEvent('CERTIFICATES_ISSUED', {
    batchId: batch.id,
    batchCode: batch.batchCode,
    count: batch.candidates.length,
  });
}

export async function processWhatsAppDelivery(certificateId: string) {
  const cert = await prisma.certificate.findUnique({
    where: { id: certificateId },
    include: { candidate: true },
  });

  if (!cert) {
    throw new Error(`Certificate ${certificateId} not found`);
  }

  if (cert.status === CertificateStatus.CANCELLED) {
    // Cancelled between issuance and delivery: never send a certificate that is no longer valid.
    return { providerMsgId: 'skipped-cancelled', alreadyDelivered: false };
  }

  const result = await sendViaStandInWhatsApp({
    certificateId: cert.id,
    recipientPhone: cert.candidate.phone,
    recipientName: cert.candidateName,
    messageBody: `Congratulations ${cert.candidateName}! Your Pragati Skills Mission certificate (${cert.certificateNumber}) for ${cert.courseName} is ready.`,
    mediaUrl: `/api/certificates/${cert.id}/download?token=${cert.downloadToken}`,
    idempotencyKey: `wa-${cert.id}`,
  });

  await publishEvent('WHATSAPP_UPDATED', {
    certificateId: cert.id,
    certificateNumber: cert.certificateNumber,
    batchId: cert.batchId,
    providerMsgId: result.providerMsgId,
  });

  return result;
}

function startWorkers() {
  console.log('Starting CertiFlow BullMQ workers...');

  const issuanceWorker = new Worker(
    QUEUE_NAMES.BATCH_ISSUANCE,
    async (job) => {
      await processBatchIssuance(job.data.batchId);
    },
    { connection: redis, concurrency: 5 }
  );

  const whatsappWorker = new Worker(
    QUEUE_NAMES.WHATSAPP_DELIVERY,
    async (job) => {
      await processWhatsAppDelivery(job.data.certificateId);
    },
    { connection: redis, concurrency: 10 }
  );

  const slaWorker = new Worker(
    QUEUE_NAMES.SLA_MONITOR,
    async () => {
      await runSlaCheck();
      const recovered = await reconcileStuckWork();
      if (recovered.batches || recovered.messages) {
        console.warn('[reconciler] re-queued stuck work', recovered);
      }
    },
    { connection: redis, concurrency: 1 }
  );

  issuanceWorker.on('failed', (job, err) => {
    console.error(`[batch-issuance] Job ${job?.id} failed:`, err.message);
  });

  whatsappWorker.on('failed', (job, err) => {
    console.warn(`[whatsapp-delivery] Job ${job?.id} attempt failed (will retry):`, err.message);
  });

  slaWorker.on('failed', (job, err) => {
    console.error(`[sla-monitor] Job ${job?.id} failed:`, err.message);
  });

  scheduleSlaMonitor().catch((err) => {
    console.error('Failed to schedule SLA monitor:', err);
  });
}

if (require.main === module) {
  startWorkers();
}
