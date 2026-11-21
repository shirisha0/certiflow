import { PrismaClient, UserRole, BatchStatus, CertificateStatus, DeliveryStatus } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export async function seedDatabase() {
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    console.log('Database already seeded, skipping.');
    return;
  }

  console.log('Seeding CertiFlow demo users and sample data...');

  const anika = await prisma.user.create({
    data: {
      id: 'user-anika',
      name: 'Anika Sharma',
      email: 'anika@pragatitech.in',
      role: UserRole.TRAINING_CENTRE,
      district: 'Pune',
      centreName: 'Pragati Tech Academy',
    },
  });

  const dev = await prisma.user.create({
    data: {
      id: 'user-dev',
      name: 'Dev Kulkarni',
      email: 'dev.pune@pragati.gov.in',
      role: UserRole.DISTRICT_OFFICER,
      district: 'Pune',
    },
  });

  const meera = await prisma.user.create({
    data: {
      id: 'user-meera',
      name: 'Meera Deshmukh',
      email: 'meera.pune@pragati.gov.in',
      role: UserRole.DISTRICT_OFFICER,
      district: 'Pune',
    },
  });

  await prisma.user.create({
    data: {
      id: 'user-kabir',
      name: 'Kabir Joshi',
      email: 'kabir.pune@pragati.gov.in',
      role: UserRole.DISTRICT_OFFICER,
      district: 'Pune',
    },
  });

  await prisma.user.create({
    data: {
      id: 'user-neha',
      name: 'Neha Verma',
      email: 'neha.quality@pragati.gov.in',
      role: UserRole.QUALITY_TEAM,
    },
  });

  const farah = await prisma.user.create({
    data: {
      id: 'user-farah',
      name: 'Farah Siddiqui',
      email: 'farah.state@pragati.gov.in',
      role: UserRole.STATE_OFFICE,
    },
  });

  // 1. A batch awaiting district approval (stuck for 72h to demonstrate SLA escalation)
  const stuckDate = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const batch1 = await prisma.batch.create({
    data: {
      batchCode: 'BATCH-2026-001',
      courseName: 'Solar PV Technician (NSQF Level 4)',
      district: 'Pune',
      trainingCentreName: 'Pragati Tech Academy',
      status: BatchStatus.SUBMITTED_DISTRICT,
      approvalRound: 1,
      requiresQualityTeam: false,
      stageEnteredAt: stuckDate,
      createdById: anika.id,
      candidates: {
        create: [
          { fullName: 'Aarav Patel', phone: '+919876543210', email: 'aarav@example.com', nationalIdLast4: '4321', score: 88, passed: true },
          { fullName: 'Priya Nair', phone: '+919876543211', email: 'priya@example.com', nationalIdLast4: '4322', score: 91, passed: true },
          { fullName: 'Rohan Gupta', phone: '+919876543212', email: 'rohan@example.com', nationalIdLast4: '4323', score: 79, passed: true },
          { fullName: 'Sneha Iyer', phone: '+919876543213', email: 'sneha@example.com', nationalIdLast4: '4324', score: 85, passed: true },
          { fullName: 'Vikram Singh', phone: '+919876543214', email: 'vikram@example.com', nationalIdLast4: '4325', score: 82, passed: true },
        ],
      },
    },
  });

  await prisma.auditEvent.createMany({
    data: [
      {
        batchId: batch1.id,
        actorId: anika.id,
        actorName: anika.name,
        actorRole: anika.role,
        action: 'BATCH_CREATED',
        entityType: 'BATCH',
        entityId: batch1.id,
        details: { batchCode: batch1.batchCode, candidateCount: 5 },
      },
      {
        batchId: batch1.id,
        actorId: anika.id,
        actorName: anika.name,
        actorRole: anika.role,
        action: 'BATCH_SUBMITTED',
        entityType: 'BATCH',
        entityId: batch1.id,
        details: { round: 1 },
      },
    ],
  });

  // 2. A DRAFT batch ready for Anika to upload spreadsheet or submit
  const batch2 = await prisma.batch.create({
    data: {
      batchCode: 'BATCH-2026-002',
      courseName: 'CNC Machine Operator (NSQF Level 3)',
      district: 'Pune',
      trainingCentreName: 'Pragati Tech Academy',
      status: BatchStatus.DRAFT,
      approvalRound: 1,
      requiresQualityTeam: false,
      createdById: anika.id,
    },
  });

  await prisma.auditEvent.create({
    data: {
      batchId: batch2.id,
      actorId: anika.id,
      actorName: anika.name,
      actorRole: anika.role,
      action: 'BATCH_CREATED',
      entityType: 'BATCH',
      entityId: batch2.id,
      details: { batchCode: batch2.batchCode },
    },
  });

  // 3. An ISSUED batch with verifiable certificates (and one ready to test cancellation)
  const batch3 = await prisma.batch.create({
    data: {
      batchCode: 'BATCH-2026-000',
      courseName: 'Electric Vehicle Service Technician',
      district: 'Pune',
      trainingCentreName: 'Pragati Tech Academy',
      status: BatchStatus.ISSUED,
      approvalRound: 1,
      requiresQualityTeam: false,
      createdById: anika.id,
    },
  });

  const c1 = await prisma.candidate.create({
    data: {
      batchId: batch3.id,
      fullName: 'Kiran Jadhav',
      phone: '+919822001100',
      email: 'kiran@example.com',
      nationalIdLast4: '9001',
      score: 94,
      passed: true,
    },
  });

  const c2 = await prisma.candidate.create({
    data: {
      batchId: batch3.id,
      fullName: 'Pooja Sawant',
      phone: '+919822001101',
      email: 'pooja@example.com',
      nationalIdLast4: '9002',
      score: 89,
      passed: true,
    },
  });

  await prisma.approvalDecision.createMany({
    data: [
      {
        batchId: batch3.id,
        officerId: dev.id,
        role: UserRole.DISTRICT_OFFICER,
        stage: BatchStatus.SUBMITTED_DISTRICT,
        round: 1,
        decision: 'APPROVE',
      },
      {
        batchId: batch3.id,
        officerId: meera.id,
        role: UserRole.DISTRICT_OFFICER,
        stage: BatchStatus.SUBMITTED_DISTRICT,
        round: 1,
        decision: 'APPROVE',
      },
      {
        batchId: batch3.id,
        officerId: farah.id,
        role: UserRole.STATE_OFFICE,
        stage: BatchStatus.PENDING_STATE,
        round: 1,
        decision: 'APPROVE',
      },
    ],
  });

  const cert1 = await prisma.certificate.create({
    data: {
      certificateNumber: 'PSM-2026-PUNE-10000',
      batchId: batch3.id,
      candidateId: c1.id,
      candidateName: c1.fullName,
      courseName: batch3.courseName,
      trainingCentreName: batch3.trainingCentreName,
      district: batch3.district,
      status: CertificateStatus.ISSUED,
      downloadToken: crypto.randomBytes(24).toString('hex'),
    },
  });

  const cert2 = await prisma.certificate.create({
    data: {
      certificateNumber: 'PSM-2026-PUNE-10001',
      batchId: batch3.id,
      candidateId: c2.id,
      candidateName: c2.fullName,
      courseName: batch3.courseName,
      trainingCentreName: batch3.trainingCentreName,
      district: batch3.district,
      status: CertificateStatus.ISSUED,
      downloadToken: crypto.randomBytes(24).toString('hex'),
    },
  });

  await prisma.whatsAppMessage.createMany({
    data: [
      {
        certificateId: cert1.id,
        recipientPhone: c1.phone,
        recipientName: c1.fullName,
        messageBody: `Congratulations ${c1.fullName}! Your Pragati Skills Mission certificate (${cert1.certificateNumber}) for ${batch3.courseName} is ready.`,
        mediaUrl: `/api/certificates/${cert1.id}/download?token=${cert1.downloadToken}`,
        idempotencyKey: `wa-${cert1.id}`,
        status: DeliveryStatus.DELIVERED,
        attempts: 1,
        providerMsgId: 'wamid.seed-001',
        sentAt: new Date(),
      },
      {
        certificateId: cert2.id,
        recipientPhone: c2.phone,
        recipientName: c2.fullName,
        messageBody: `Congratulations ${c2.fullName}! Your Pragati Skills Mission certificate (${cert2.certificateNumber}) for ${batch3.courseName} is ready.`,
        mediaUrl: `/api/certificates/${cert2.id}/download?token=${cert2.downloadToken}`,
        idempotencyKey: `wa-${cert2.id}`,
        status: DeliveryStatus.DELIVERED,
        attempts: 1,
        providerMsgId: 'wamid.seed-002',
        sentAt: new Date(),
      },
    ],
  });

  console.log('Seed completed successfully.');
}

if (require.main === module) {
  seedDatabase()
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
