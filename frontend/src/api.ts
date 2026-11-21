import {
  BatchDetail,
  BatchSummary,
  CertificateRecord,
  EscalationAlert,
  Persona,
  PublicVerifyResult,
  WhatsAppMessageRecord,
} from './types';

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`) as Error & {
      details?: unknown;
      rowErrors?: Array<{ row: number; field: string; message: string }>;
    };
    err.details = data.details;
    err.rowErrors = data.rowErrors;
    throw err;
  }
  return data as T;
}

export const api = {
  getPersonas: () => request<{ personas: Persona[] }>('/api/auth/personas'),
  switchPersona: (userId: string) =>
    request<{ user: Persona; token: string }>('/api/auth/switch', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  getBatches: () => request<{ batches: BatchSummary[] }>('/api/batches'),
  getBatch: (id: string) => request<{ batch: BatchDetail }>(`/api/batches/${id}`),
  createBatch: (payload: { batchCode: string; courseName: string; district?: string }) =>
    request<{ batch: BatchSummary }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  uploadCandidates: (batchId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ batch: BatchSummary; candidateCount: number; requiresQualityTeam: boolean }>(
      `/api/batches/${batchId}/upload`,
      { method: 'POST', body: fd }
    );
  },
  submitBatch: (batchId: string) =>
    request<{ batch: BatchSummary }>(`/api/batches/${batchId}/submit`, { method: 'POST' }),
  decideBatch: (
    batchId: string,
    payload: { decision: 'APPROVE' | 'REJECT' | 'SEND_BACK'; reason?: string }
  ) =>
    request<{ batch: BatchSummary }>(`/api/batches/${batchId}/decide`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getEscalations: () => request<{ alerts: EscalationAlert[] }>('/api/batches/escalations/list'),
  runSlaCheck: () =>
    request<{ checked: boolean; newAlertsCount: number }>('/api/batches/sla-check', {
      method: 'POST',
    }),
  ackEscalation: (alertId: string) =>
    request(`/api/batches/escalations/${alertId}/ack`, { method: 'POST' }),
  getCertificates: () => request<{ certificates: CertificateRecord[] }>('/api/certificates'),
  cancelCertificate: (id: string, reason: string) =>
    request<{ certificate: CertificateRecord }>(`/api/certificates/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  verifyPublic: (certNumber: string) =>
    request<PublicVerifyResult>(`/api/public/verify/${encodeURIComponent(certNumber)}`),
  getWhatsAppMessages: () =>
    request<{ messages: WhatsAppMessageRecord[] }>('/api/whatsapp/messages'),
};
