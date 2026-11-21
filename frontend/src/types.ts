export type UserRole =
  | 'TRAINING_CENTRE'
  | 'DISTRICT_OFFICER'
  | 'QUALITY_TEAM'
  | 'STATE_OFFICE';

export type BatchStatus =
  | 'DRAFT'
  | 'SUBMITTED_DISTRICT'
  | 'PENDING_QUALITY'
  | 'PENDING_STATE'
  | 'RETURNED_FOR_CORRECTION'
  | 'REJECTED'
  | 'APPROVED'
  | 'ISSUING'
  | 'ISSUED';

export interface Persona {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  district: string | null;
  centreName: string | null;
}

export interface ApprovalDecision {
  id: string;
  officerId: string;
  role: UserRole;
  stage: BatchStatus;
  round: number;
  decision: 'APPROVE' | 'REJECT' | 'SEND_BACK';
  reason: string | null;
  active: boolean;
  createdAt: string;
  officer: { id: string; name: string; role: UserRole };
}

export interface BatchSummary {
  id: string;
  batchCode: string;
  courseName: string;
  district: string;
  trainingCentreName: string;
  status: BatchStatus;
  approvalRound: number;
  requiresQualityTeam: boolean;
  stageEnteredAt: string;
  createdAt: string;
  updatedAt: string;
  _count: { candidates: number; certificates: number };
  decisions: ApprovalDecision[];
  escalationAlerts: Array<{ id: string; hoursStuck: number; message: string }>;
  /** Most recent send-back / reject (reason shown to the training centre). */
  lastReturn?: { decision: 'REJECT' | 'SEND_BACK'; reason: string | null; officerName: string } | null;
}

export interface AuditEvent {
  id: string;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface CandidateDetail {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  nationalIdLast4: string;
  score: number;
  passed: boolean;
  certificate?: {
    id: string;
    certificateNumber: string;
    status: 'ISSUED' | 'CANCELLED';
    issuedAt: string;
    cancelledAt: string | null;
    cancellationReason: string | null;
    whatsappMessages: Array<{
      status: string;
      attempts: number;
      providerMsgId: string | null;
      lastError: string | null;
      sentAt: string | null;
    }>;
  } | null;
}

export interface BatchDetail extends BatchSummary {
  candidates: CandidateDetail[];
  auditEvents: AuditEvent[];
}

export interface CertificateRecord {
  id: string;
  certificateNumber: string;
  candidateName: string;
  courseName: string;
  trainingCentreName: string;
  district: string;
  status: 'ISSUED' | 'CANCELLED';
  issuedAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  batch: { batchCode: string };
  whatsappMessages: Array<{
    status: string;
    attempts: number;
    sentAt: string | null;
    lastError: string | null;
  }>;
}

export interface EscalationAlert {
  id: string;
  batchId: string;
  stage: BatchStatus;
  hoursStuck: number;
  message: string;
  acknowledged: boolean;
  createdAt: string;
  batch: {
    id: string;
    batchCode: string;
    courseName: string;
    district: string;
    status: BatchStatus;
  };
}

export interface WhatsAppMessageRecord {
  id: string;
  recipientPhone: string;
  recipientName: string;
  messageBody: string;
  mediaUrl: string;
  status: string;
  attempts: number;
  providerMsgId: string | null;
  lastError: string | null;
  sentAt: string | null;
  certificate: {
    id: string;
    certificateNumber: string;
    courseName: string;
    status: 'ISSUED' | 'CANCELLED';
  };
}

export interface PublicVerifyResult {
  valid: boolean;
  status: 'ISSUED' | 'CANCELLED' | 'NOT_FOUND';
  certificateNumber?: string;
  candidateName?: string;
  courseName?: string;
  trainingCentreName?: string;
  district?: string;
  issuedAt?: string;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  cached?: boolean;
  message?: string;
}
