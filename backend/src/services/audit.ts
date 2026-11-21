import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

export interface AuditInput {
  batchId?: string | null;
  actorId?: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

export async function recordAudit(
  input: AuditInput,
  tx?: Prisma.TransactionClient
) {
  const client = tx || prisma;
  return client.auditEvent.create({
    data: {
      batchId: input.batchId ?? null,
      actorId: input.actorId ?? null,
      actorName: input.actorName,
      actorRole: input.actorRole,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: (input.details as Prisma.InputJsonValue) ?? undefined,
    },
  });
}
