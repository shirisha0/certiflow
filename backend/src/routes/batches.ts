import { Router } from 'express';
import multer from 'multer';
import { BatchStatus, DecisionType, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { requireAuth, requireRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { recordAudit } from '../services/audit';
import { parseAndValidateSpreadsheet } from '../services/csvParser';
import { enqueueBatchIssuance } from '../services/queue';
import { publishEvent } from '../services/sse';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const createBatchSchema = z.object({
  batchCode: z.string().min(3).max(50),
  courseName: z.string().min(3).max(150),
  district: z.string().min(2).max(80).optional(),
});

const decideSchema = z.object({
  decision: z.nativeEnum(DecisionType),
  reason: z.string().trim().optional(),
});

// List batches scoped to the authenticated user's role
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const where: Prisma.BatchWhereInput = {};

    if (user.role === UserRole.TRAINING_CENTRE) {
      where.createdById = user.id;
    } else if (user.role === UserRole.DISTRICT_OFFICER) {
      where.district = user.district;
    } else if (user.role === UserRole.QUALITY_TEAM) {
      where.requiresQualityTeam = true;
    }

    const batches = await prisma.batch.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { candidates: true, certificates: true },
        },
        decisions: {
          where: { active: true },
          include: {
            officer: { select: { id: true, name: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        escalationAlerts: {
          where: { acknowledged: false },
        },
      },
    });

    // A send-back voids the round's approvals (active=false), so the reason would vanish from
    // `decisions`. Attach the most recent send-back/reject so the centre can see what to fix.
    const returnedIds = batches
      .filter((b) => b.status === BatchStatus.RETURNED_FOR_CORRECTION || b.status === BatchStatus.REJECTED)
      .map((b) => b.id);
    const lastReturnByBatch = new Map<string, { decision: DecisionType; reason: string | null; officerName: string }>();
    if (returnedIds.length > 0) {
      const returns = await prisma.approvalDecision.findMany({
        where: {
          batchId: { in: returnedIds },
          decision: { in: [DecisionType.SEND_BACK, DecisionType.REJECT] },
        },
        orderBy: { createdAt: 'desc' },
        include: { officer: { select: { name: true } } },
      });
      for (const d of returns) {
        if (!lastReturnByBatch.has(d.batchId)) {
          lastReturnByBatch.set(d.batchId, {
            decision: d.decision,
            reason: d.reason,
            officerName: d.officer.name,
          });
        }
      }
    }

    res.json({
      batches: batches.map((b) => ({ ...b, lastReturn: lastReturnByBatch.get(b.id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

// Get SLA escalation alerts (State Office only)
router.get(
  '/escalations/list',
  requireAuth,
  requireRole(UserRole.STATE_OFFICE),
  async (_req, res, next) => {
    try {
      const alerts = await prisma.escalationAlert.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          batch: {
            select: {
              id: true,
              batchCode: true,
              courseName: true,
              district: true,
              status: true,
              stageEnteredAt: true,
            },
          },
          acknowledgedBy: { select: { id: true, name: true } },
        },
      });
      res.json({ alerts });
    } catch (err) {
      next(err);
    }
  }
);

// Trigger SLA check on demand (State Office only)
router.post(
  '/sla-check',
  requireAuth,
  requireRole(UserRole.STATE_OFFICE),
  async (req, res, next) => {
    try {
      const createdAlerts = await runSlaCheck(req.user!.id, req.user!.name, req.user!.role);
      res.json({ checked: true, newAlertsCount: createdAlerts.length, alerts: createdAlerts });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/escalations/:alertId/ack',
  requireAuth,
  requireRole(UserRole.STATE_OFFICE),
  async (req, res, next) => {
    try {
      const alert = await prisma.escalationAlert.update({
        where: { id: req.params.alertId },
        data: {
          acknowledged: true,
          acknowledgedById: req.user!.id,
        },
      });
      await recordAudit({
        batchId: alert.batchId,
        actorId: req.user!.id,
        actorName: req.user!.name,
        actorRole: req.user!.role,
        action: 'ESCALATION_ACKNOWLEDGED',
        entityType: 'ESCALATION_ALERT',
        entityId: alert.id,
      });
      res.json({ alert });
    } catch (err) {
      next(err);
    }
  }
);

// Get single batch details (scoped by role)
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const batch = await prisma.batch.findUnique({
      where: { id: req.params.id },
      include: {
        createdBy: { select: { id: true, name: true, email: true, centreName: true } },
        candidates: {
          orderBy: { fullName: 'asc' },
          include: {
            certificate: {
              select: {
                id: true,
                certificateNumber: true,
                status: true,
                issuedAt: true,
                cancelledAt: true,
                cancellationReason: true,
                whatsappMessages: {
                  select: {
                    status: true,
                    attempts: true,
                    providerMsgId: true,
                    lastError: true,
                    sentAt: true,
                  },
                },
              },
            },
          },
        },
        decisions: {
          include: {
            officer: { select: { id: true, name: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        auditEvents: {
          orderBy: { createdAt: 'desc' },
        },
        escalationAlerts: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!batch) {
      throw new AppError(404, 'Batch not found');
    }

    if (user.role === UserRole.TRAINING_CENTRE && batch.createdById !== user.id) {
      throw new AppError(403, 'Forbidden: cannot view another training centre batch');
    }
    if (user.role === UserRole.DISTRICT_OFFICER && batch.district !== user.district) {
      throw new AppError(403, 'Forbidden: cannot view batch from another district');
    }
    if (user.role === UserRole.QUALITY_TEAM && !batch.requiresQualityTeam) {
      throw new AppError(403, 'Forbidden: this batch is not in the quality review scope');
    }

    res.json({ batch });
  } catch (err) {
    next(err);
  }
});

// Create a new DRAFT batch (Training Centre only)
router.post(
  '/',
  requireAuth,
  requireRole(UserRole.TRAINING_CENTRE),
  async (req, res, next) => {
    try {
      const parsed = createBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'Invalid batch payload', parsed.error.flatten());
      }

      const user = req.user!;
      const district = parsed.data.district || user.district || 'Pune';
      const centreName = user.centreName || 'Registered Training Centre';

      const batch = await prisma.$transaction(async (tx) => {
        const created = await tx.batch.create({
          data: {
            batchCode: parsed.data.batchCode.trim(),
            courseName: parsed.data.courseName.trim(),
            district,
            trainingCentreName: centreName,
            status: BatchStatus.DRAFT,
            createdById: user.id,
          },
        });

        await recordAudit(
          {
            batchId: created.id,
            actorId: user.id,
            actorName: user.name,
            actorRole: user.role,
            action: 'BATCH_CREATED',
            entityType: 'BATCH',
            entityId: created.id,
            details: { batchCode: created.batchCode, courseName: created.courseName },
          },
          tx
        );

        return created;
      });

      await publishEvent('BATCH_CREATED', { batchId: batch.id, batchCode: batch.batchCode });
      res.status(201).json({ batch });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        return next(new AppError(409, 'A batch with this batchCode already exists'));
      }
      next(err);
    }
  }
);

// Atomic CSV/XLSX upload (all-or-nothing)
router.post(
  '/:id/upload',
  requireAuth,
  requireRole(UserRole.TRAINING_CENTRE),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new AppError(400, 'Spreadsheet file (.csv or .xlsx) is required');
      }

      const user = req.user!;
      const batch = await prisma.batch.findUnique({ where: { id: req.params.id } });
      if (!batch) {
        throw new AppError(404, 'Batch not found');
      }
      if (batch.createdById !== user.id) {
        throw new AppError(403, 'Forbidden: you do not own this batch');
      }
      if (
        batch.status !== BatchStatus.DRAFT &&
        batch.status !== BatchStatus.RETURNED_FOR_CORRECTION
      ) {
        throw new AppError(
          400,
          `Cannot upload candidates while batch is in ${batch.status} status`
        );
      }

      const result = parseAndValidateSpreadsheet(req.file.buffer, req.file.originalname);
      if (!result.valid) {
        return res.status(400).json({
          error: 'Spreadsheet validation failed. No rows were saved.',
          rowErrors: result.errors,
        });
      }

      const requiresQualityTeam = result.rows.length >= env.largeBatchThreshold;

      const updatedBatch = await prisma.$transaction(async (tx) => {
        await tx.candidate.deleteMany({ where: { batchId: batch.id } });
        await tx.candidate.createMany({
          data: result.rows.map((r) => ({
            batchId: batch.id,
            fullName: r.fullName,
            phone: r.phone,
            email: r.email,
            nationalIdLast4: r.nationalIdLast4,
            score: r.score,
            passed: r.passed,
          })),
        });

        const updated = await tx.batch.update({
          where: { id: batch.id },
          data: {
            requiresQualityTeam,
            version: { increment: 1 },
          },
          include: { _count: { select: { candidates: true } } },
        });

        await recordAudit(
          {
            batchId: batch.id,
            actorId: user.id,
            actorName: user.name,
            actorRole: user.role,
            action: 'CANDIDATES_UPLOADED',
            entityType: 'BATCH',
            entityId: batch.id,
            details: {
              filename: req.file!.originalname,
              candidateCount: result.rows.length,
              requiresQualityTeam,
            },
          },
          tx
        );

        return updated;
      });

      await publishEvent('BATCH_UPDATED', { batchId: batch.id, status: updatedBatch.status });
      res.json({
        batch: updatedBatch,
        candidateCount: result.rows.length,
        requiresQualityTeam,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Submit or resubmit batch for approval
router.post(
  '/:id/submit',
  requireAuth,
  requireRole(UserRole.TRAINING_CENTRE),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const batch = await prisma.batch.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { candidates: true } } },
      });

      if (!batch) {
        throw new AppError(404, 'Batch not found');
      }
      if (batch.createdById !== user.id) {
        throw new AppError(403, 'Forbidden: you do not own this batch');
      }
      if (
        batch.status !== BatchStatus.DRAFT &&
        batch.status !== BatchStatus.RETURNED_FOR_CORRECTION
      ) {
        throw new AppError(400, `Batch cannot be submitted from ${batch.status}`);
      }
      if (batch._count.candidates === 0) {
        throw new AppError(400, 'Cannot submit an empty batch. Upload candidates first.');
      }

      const isResubmission = batch.status === BatchStatus.RETURNED_FOR_CORRECTION;
      const newRound = isResubmission ? batch.approvalRound + 1 : batch.approvalRound;

      const updated = await prisma.$transaction(async (tx) => {
        if (isResubmission) {
          // Deliberate documented decision: prior-round approvals are archived (active=false)
          // so officers must re-verify the corrected candidate list in the new round.
          await tx.approvalDecision.updateMany({
            where: { batchId: batch.id, active: true },
            data: { active: false },
          });
        }

        const nextBatch = await tx.batch.update({
          where: { id: batch.id },
          data: {
            status: BatchStatus.SUBMITTED_DISTRICT,
            approvalRound: newRound,
            stageEnteredAt: new Date(),
            version: { increment: 1 },
          },
        });

        await recordAudit(
          {
            batchId: batch.id,
            actorId: user.id,
            actorName: user.name,
            actorRole: user.role,
            action: isResubmission ? 'BATCH_RESUBMITTED' : 'BATCH_SUBMITTED',
            entityType: 'BATCH',
            entityId: batch.id,
            details: {
              round: newRound,
              priorApprovalsInvalidated: isResubmission,
            },
          },
          tx
        );

        return nextBatch;
      });

      await publishEvent('BATCH_UPDATED', { batchId: batch.id, status: updated.status });
      res.json({ batch: updated });
    } catch (err) {
      next(err);
    }
  }
);

// Concurrency-safe officer/quality/state decision endpoint
router.post('/:id/decide', requireAuth, async (req, res, next) => {
  try {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid decision payload', parsed.error.flatten());
    }

    const { decision, reason } = parsed.data;
    if (
      (decision === DecisionType.REJECT || decision === DecisionType.SEND_BACK) &&
      (!reason || reason.length < 3)
    ) {
      throw new AppError(400, 'A clear reason (min 3 chars) is required when rejecting or sending back');
    }

    const user = req.user!;
    const batchId = req.params.id;

    const txResult = await prisma.$transaction(async (tx) => {
      // Lock the batch row with SELECT ... FOR UPDATE to guarantee Moment 2
      // (two officers approving at the exact same moment never double-advance)
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: BatchStatus;
          district: string;
          approvalRound: number;
          requiresQualityTeam: boolean;
        }>
      >`SELECT id, status, district, "approvalRound", "requiresQualityTeam" FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;

      if (lockedRows.length === 0) {
        throw new AppError(404, 'Batch not found');
      }

      const batch = lockedRows[0];

      // Strict step & role authorization ("Things that must never happen: Someone acting at a step that is not theirs")
      if (batch.status === BatchStatus.SUBMITTED_DISTRICT) {
        if (user.role !== UserRole.DISTRICT_OFFICER) {
          throw new AppError(403, 'Only District Officers can decide at SUBMITTED_DISTRICT stage');
        }
        if (user.district !== batch.district) {
          throw new AppError(403, `Officer belongs to ${user.district}, cannot act on ${batch.district} batch`);
        }
      } else if (batch.status === BatchStatus.PENDING_QUALITY) {
        if (user.role !== UserRole.QUALITY_TEAM) {
          throw new AppError(403, 'Only Quality Team can decide at PENDING_QUALITY stage');
        }
      } else if (batch.status === BatchStatus.PENDING_STATE) {
        if (user.role !== UserRole.STATE_OFFICE) {
          throw new AppError(403, 'Only State Office can decide at PENDING_STATE stage');
        }
      } else {
        throw new AppError(400, `Batch is in ${batch.status} status and cannot be reviewed`);
      }

      // Prevent same officer from voting twice in the same stage & round
      const existingVote = await tx.approvalDecision.findUnique({
        where: {
          batchId_officerId_stage_round: {
            batchId: batch.id,
            officerId: user.id,
            stage: batch.status,
            round: batch.approvalRound,
          },
        },
      });

      if (existingVote) {
        throw new AppError(409, 'You have already recorded a decision for this batch in the current round');
      }

      await tx.approvalDecision.create({
        data: {
          batchId: batch.id,
          officerId: user.id,
          role: user.role,
          stage: batch.status,
          round: batch.approvalRound,
          decision,
          reason: reason || null,
          active: true,
        },
      });

      let nextStatus: BatchStatus = batch.status;
      let shouldEnqueueIssuance = false;

      if (decision === DecisionType.REJECT) {
        nextStatus = BatchStatus.REJECTED;
      } else if (decision === DecisionType.SEND_BACK) {
        nextStatus = BatchStatus.RETURNED_FOR_CORRECTION;
        await tx.approvalDecision.updateMany({
          where: { batchId: batch.id, active: true },
          data: { active: false },
        });
      } else if (decision === DecisionType.APPROVE) {
        if (batch.status === BatchStatus.SUBMITTED_DISTRICT) {
          const districtApprovals = await tx.approvalDecision.count({
            where: {
              batchId: batch.id,
              stage: BatchStatus.SUBMITTED_DISTRICT,
              round: batch.approvalRound,
              decision: DecisionType.APPROVE,
              active: true,
            },
          });

          if (districtApprovals >= env.districtApprovalsRequired) {
            nextStatus = batch.requiresQualityTeam
              ? BatchStatus.PENDING_QUALITY
              : BatchStatus.PENDING_STATE;
          }
        } else if (batch.status === BatchStatus.PENDING_QUALITY) {
          nextStatus = BatchStatus.PENDING_STATE;
        } else if (batch.status === BatchStatus.PENDING_STATE) {
          nextStatus = BatchStatus.APPROVED;
          shouldEnqueueIssuance = true;
        }
      }

      const updatedBatch = await tx.batch.update({
        where: { id: batch.id },
        data: {
          status: nextStatus,
          stageEnteredAt: nextStatus !== batch.status ? new Date() : undefined,
          version: { increment: 1 },
        },
      });

      await recordAudit(
        {
          batchId: batch.id,
          actorId: user.id,
          actorName: user.name,
          actorRole: user.role,
          action: `DECISION_${decision}`,
          entityType: 'BATCH',
          entityId: batch.id,
          details: {
            stage: batch.status,
            nextStatus,
            round: batch.approvalRound,
            reason: reason || null,
          },
        },
        tx
      );

      return { updatedBatch, shouldEnqueueIssuance };
    });

    if (txResult.shouldEnqueueIssuance) {
      try {
        await enqueueBatchIssuance(txResult.updatedBatch.id);
      } catch (err) {
        // The approval is committed. If Redis is unreachable right now, the reconciler
        // re-queues batches stuck in APPROVED, so do not fail the officer's request.
        console.error('[decide] could not enqueue issuance; reconciler will retry:', (err as Error).message);
      }
    }

    await publishEvent('BATCH_DECISION', {
      batchId: txResult.updatedBatch.id,
      status: txResult.updatedBatch.status,
      actorName: user.name,
      decision,
    });

    res.json({ batch: txResult.updatedBatch });
  } catch (err) {
    next(err);
  }
});

export async function runSlaCheck(actorId?: string, actorName = 'SLA Monitor', actorRole = 'SYSTEM') {
  const cutoff = new Date(Date.now() - env.slaHours * 60 * 60 * 1000);
  const stuckBatches = await prisma.batch.findMany({
    where: {
      status: {
        in: [
          BatchStatus.SUBMITTED_DISTRICT,
          BatchStatus.PENDING_QUALITY,
          BatchStatus.PENDING_STATE,
        ],
      },
      stageEnteredAt: { lt: cutoff },
    },
  });

  const createdAlerts = [];
  for (const batch of stuckBatches) {
    // One alert at a time per batch and stage: skip while an alert is still open, and also for
    // one full SLA window after the last alert (so acknowledging it does not make the next
    // 60-second check immediately raise an identical one). Re-escalates if still stuck later.
    const existingRecent = await prisma.escalationAlert.findFirst({
      where: {
        batchId: batch.id,
        stage: batch.status,
        OR: [{ acknowledged: false }, { createdAt: { gte: cutoff } }],
      },
    });
    if (existingRecent) continue;

    const hoursStuck = Math.round(((Date.now() - batch.stageEnteredAt.getTime()) / 3600000) * 10) / 10;
    const alert = await prisma.escalationAlert.create({
      data: {
        batchId: batch.id,
        stage: batch.status,
        hoursStuck,
        message: `Batch ${batch.batchCode} (${batch.district}) has been waiting in ${batch.status} for ${hoursStuck}h (SLA: ${env.slaHours}h).`,
      },
    });

    await recordAudit({
      batchId: batch.id,
      actorId: actorId ?? null,
      actorName,
      actorRole,
      action: 'SLA_ESCALATION_TRIGGERED',
      entityType: 'ESCALATION_ALERT',
      entityId: alert.id,
      details: { stage: batch.status, hoursStuck },
    });

    await publishEvent('ESCALATION_ALERT', {
      alertId: alert.id,
      batchId: batch.id,
      batchCode: batch.batchCode,
      hoursStuck,
    });

    createdAlerts.push(alert);
  }

  return createdAlerts;
}

export default router;