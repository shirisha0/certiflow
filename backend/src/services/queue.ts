import { Queue } from 'bullmq';
import { redis } from '../config/redis';

export const QUEUE_NAMES = {
  BATCH_ISSUANCE: 'batch-issuance',
  WHATSAPP_DELIVERY: 'whatsapp-delivery',
  SLA_MONITOR: 'sla-monitor',
} as const;

export const batchIssuanceQueue = new Queue(QUEUE_NAMES.BATCH_ISSUANCE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  },
});

export const whatsappDeliveryQueue = new Queue(QUEUE_NAMES.WHATSAPP_DELIVERY, {
  connection: redis,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export const slaMonitorQueue = new Queue(QUEUE_NAMES.SLA_MONITOR, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

/**
 * Add a job with a deterministic id (so duplicates collapse), but make it safe to re-add
 * after a previous run finished or exhausted its retries. BullMQ silently ignores add()
 * when a job with the same id still exists in the completed/failed sets, which would
 * otherwise make the reconciler's re-queue a no-op.
 */
async function addUniqueJob(queue: Queue, name: string, data: object, jobId: string) {
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      await existing.remove();
    } else {
      return existing; // already waiting / active / delayed: nothing to do
    }
  }
  return queue.add(name, data, { jobId });
}

export async function enqueueBatchIssuance(batchId: string) {
  return addUniqueJob(batchIssuanceQueue, 'issue-batch', { batchId }, `issue-batch-${batchId}`);
}

export async function enqueueWhatsAppDelivery(certificateId: string) {
  return addUniqueJob(
    whatsappDeliveryQueue,
    'deliver-whatsapp',
    { certificateId },
    `deliver-wa-${certificateId}`
  );
}

export async function scheduleSlaMonitor() {
  // Check every 60 seconds for stuck batches
  await slaMonitorQueue.add(
    'check-sla',
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'sla-monitor-repeatable',
    }
  );
}
