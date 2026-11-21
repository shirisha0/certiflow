import { Response } from 'express';
import { redisPub, redisSub } from '../config/redis';

const CHANNEL = 'certiflow:events';
const clients = new Set<Response>();
let subscribed = false;

export interface RealtimeEvent {
  type:
    | 'BATCH_CREATED'
    | 'BATCH_UPDATED'
    | 'BATCH_DECISION'
    | 'CERTIFICATES_ISSUED'
    | 'CERTIFICATE_CANCELLED'
    | 'WHATSAPP_UPDATED'
    | 'ESCALATION_ALERT';
  payload: Record<string, unknown>;
  timestamp: string;
}

export function initSseSubscriber() {
  if (subscribed) return;
  subscribed = true;

  redisSub.subscribe(CHANNEL, (err) => {
    if (err) {
      console.error('Failed to subscribe to Redis SSE channel:', err);
    }
  });

  redisSub.on('message', (_channel, message) => {
    for (const res of clients) {
      res.write(`data: ${message}\n\n`);
    }
  });
}

export function addSseClient(res: Response) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

export async function publishEvent(
  type: RealtimeEvent['type'],
  payload: Record<string, unknown>
) {
  const event: RealtimeEvent = {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  try {
    await redisPub.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    // Realtime is best-effort: the DB write is the source of truth, and clients refetch.
    console.error('[sse] publish failed (non-fatal):', (err as Error).message);
  }
}
