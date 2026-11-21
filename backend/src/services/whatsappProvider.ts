import { DeliveryStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

/** Counts real provider-side deliveries (used by tests to prove exactly-once). */
export const providerStats = { deliveries: 0 };

export interface WhatsAppSendRequest {
  certificateId: string;
  recipientPhone: string;
  recipientName: string;
  messageBody: string;
  mediaUrl: string;
  idempotencyKey: string;
  simulateChaos?: boolean;
}

export interface WhatsAppSendResult {
  providerMsgId: string;
  alreadyDelivered: boolean;
}

/**
 * Stand-in WhatsApp Business API provider.
 * Simulates real-world network timeouts, 503 outages, and 429 rate limits,
 * while strictly enforcing idempotencyKey so retries never double-deliver.
 */
export async function sendViaStandInWhatsApp(
  req: WhatsAppSendRequest
): Promise<WhatsAppSendResult> {
  // 1. Check idempotency: if already DELIVERED, do NOT send again!
  const existing = await prisma.whatsAppMessage.findUnique({
    where: { idempotencyKey: req.idempotencyKey },
  });

  if (existing && existing.status === DeliveryStatus.DELIVERED && existing.providerMsgId) {
    return {
      providerMsgId: existing.providerMsgId,
      alreadyDelivered: true,
    };
  }

  // Ensure record exists and increment attempt counter
  const record = await prisma.whatsAppMessage.upsert({
    where: { idempotencyKey: req.idempotencyKey },
    create: {
      certificateId: req.certificateId,
      recipientPhone: req.recipientPhone,
      recipientName: req.recipientName,
      messageBody: req.messageBody,
      mediaUrl: req.mediaUrl,
      idempotencyKey: req.idempotencyKey,
      status: DeliveryStatus.PENDING,
      attempts: 1,
    },
    update: {
      attempts: { increment: 1 },
    },
  });

  // 2. Simulate realistic provider latency
  if (env.whatsappTimeoutMs > 0) {
    await new Promise((r) => setTimeout(r, Math.min(env.whatsappTimeoutMs, 200)));
  }

  // 3. Simulate transient failures / timeouts (when enabled)
  const shouldFail =
    (req.simulateChaos ?? true) &&
    env.whatsappFailureRate > 0 &&
    Math.random() < env.whatsappFailureRate;

  if (shouldFail) {
    const errMsg = 'WhatsApp Stand-In Provider: 503 Gateway Timeout (simulated transient failure)';
    await prisma.whatsAppMessage.update({
      where: { id: record.id },
      data: {
        status: DeliveryStatus.FAILED,
        lastError: errMsg,
      },
    });
    throw new Error(errMsg);
  }

  // 4. The provider accepts and delivers the message.
  const providerMsgId = `wamid.${Date.now()}.${record.id.slice(0, 8)}`;
  providerStats.deliveries += 1;
  await prisma.whatsAppMessage.update({
    where: { id: record.id },
    data: {
      status: DeliveryStatus.DELIVERED,
      providerMsgId,
      lastError: null,
      sentAt: new Date(),
    },
  });

  // 5. Ambiguous timeout: the message WAS delivered but the acknowledgement never reached us.
  //    Our job fails and is retried; the idempotency check at the top must NOT send again.
  const ackLost =
    (req.simulateChaos ?? true) &&
    env.whatsappAmbiguousRate > 0 &&
    Math.random() < env.whatsappAmbiguousRate;
  if (ackLost) {
    throw new Error('WhatsApp Stand-In Provider: ack timeout after delivery (simulated ambiguous failure)');
  }

  return {
    providerMsgId,
    alreadyDelivered: false,
  };
}
