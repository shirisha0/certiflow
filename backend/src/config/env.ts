import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://certiflow:certiflow@localhost:5432/certiflow?schema=public',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'certiflow-dev-secret-change-in-prod',
  largeBatchThreshold: parseInt(process.env.LARGE_BATCH_THRESHOLD || '50', 10),
  districtApprovalsRequired: parseInt(process.env.DISTRICT_APPROVALS_REQUIRED || '2', 10),
  slaHours: parseFloat(process.env.SLA_HOURS || '48'),
  certStorageDir: path.resolve(
    process.env.CERT_STORAGE_DIR || path.join(process.cwd(), 'storage', 'certificates')
  ),
  publicVerifyBaseUrl: process.env.PUBLIC_VERIFY_BASE_URL || 'http://localhost:5173/verify',
  whatsappFailureRate: parseFloat(process.env.WHATSAPP_FAILURE_RATE || '0.25'),
  whatsappTimeoutMs: parseInt(process.env.WHATSAPP_TIMEOUT_MS || '150', 10),
  // Probability that the stand-in provider *delivers* a message but the ack times out
  // (the nasty ambiguous case: the client must retry without double-sending).
  whatsappAmbiguousRate: parseFloat(process.env.WHATSAPP_AMBIGUOUS_RATE || '0.1'),
  // Demo-only surface: persona switcher (login without password) and the stand-in
  // WhatsApp inbox. MUST be 'false' in any real deployment.
  demoMode: (process.env.DEMO_MODE ?? 'true') === 'true',
  verifyRateLimitPerMin: parseInt(process.env.VERIFY_RATE_LIMIT_PER_MIN || '60', 10),
  // Reconciler: work stuck longer than this is re-queued; total WhatsApp attempts are capped.
  reconcileAfterSeconds: parseInt(process.env.RECONCILE_AFTER_SECONDS || '120', 10),
  whatsappMaxTotalAttempts: parseInt(process.env.WHATSAPP_MAX_TOTAL_ATTEMPTS || '20', 10),
};
