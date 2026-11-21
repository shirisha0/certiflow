import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { BatchSummary, CertificateRecord, EscalationAlert } from '../types';

interface Props {
  batches: BatchSummary[];
  onRefresh: () => void;
  onInspect: (batchId: string) => void;
  refreshTrigger: number;
}

export const StateOfficeView: React.FC<Props> = ({
  batches,
  onRefresh,
  onInspect,
  refreshTrigger,
}) => {
  const [alerts, setAlerts] = useState<EscalationAlert[]>([]);
  const [certs, setCerts] = useState<CertificateRecord[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [cancelReasons, setCancelReasons] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStateData = () => {
    api.getEscalations().then((r) => setAlerts(r.alerts)).catch(console.error);
    api.getCertificates().then((r) => setCerts(r.certificates)).catch(console.error);
  };

  useEffect(() => {
    loadStateData();
  }, [refreshTrigger]);

  const handleDecision = async (
    batchId: string,
    decision: 'APPROVE' | 'REJECT' | 'SEND_BACK'
  ) => {
    setError(null);
    setMsg(null);
    try {
      await api.decideBatch(batchId, { decision, reason: reasons[batchId] });
      setMsg(`State decision (${decision}) recorded. Issuance queued if approved.`);
      onRefresh();
      loadStateData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSlaCheck = async () => {
    setError(null);
    const res = await api.runSlaCheck();
    setMsg(`SLA check completed: ${res.newAlertsCount} new escalation alert(s) raised.`);
    loadStateData();
  };

  const handleCancelCert = async (certId: string) => {
    setError(null);
    setMsg(null);
    try {
      const reason = cancelReasons[certId] || '';
      await api.cancelCertificate(certId, reason);
      setMsg('Certificate cancelled and public verification cache invalidated immediately.');
      loadStateData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {msg && <div className="alert alert-success">{msg}</div>}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Stuck Batches & SLA Escalations</h2>
          <button className="btn btn-warn" onClick={handleSlaCheck}>
            Run SLA Escalation Check Now
          </button>
        </div>
        {alerts.length === 0 ? (
          <p className="muted">No SLA escalation alerts yet. Click "Run SLA Escalation Check Now" to scan for stuck batches.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Stage</th>
                <th>Hours Stuck</th>
                <th>Alert</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.batch.batchCode}</strong> ({a.batch.district})
                  </td>
                  <td>{a.stage}</td>
                  <td>{a.hoursStuck}h</td>
                  <td>{a.message}</td>
                  <td>
                    {a.acknowledged ? (
                      <span className="badge badge-issued">Acknowledged</span>
                    ) : (
                      <button
                        className="btn btn-outline"
                        onClick={async () => {
                          await api.ackEscalation(a.id);
                          loadStateData();
                        }}
                      >
                        Acknowledge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>State Office Final Approval Queue</h2>
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Centre & District</th>
              <th>Candidates</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>
                  <strong>{b.batchCode}</strong>
                  <div className="muted">{b.courseName}</div>
                </td>
                <td>
                  {b.trainingCentreName} ({b.district})
                </td>
                <td>{b._count.candidates}</td>
                <td>
                  <span className="badge badge-state">{b.status}</span>
                </td>
                <td>
                  <div className="row">
                    {b.status === 'PENDING_STATE' && (
                      <>
                        <input
                          className="input"
                          style={{ width: 160 }}
                          placeholder="Reason (if returning)"
                          value={reasons[b.id] || ''}
                          onChange={(e) =>
                            setReasons((prev) => ({ ...prev, [b.id]: e.target.value }))
                          }
                        />
                        <button
                          className="btn btn-success"
                          onClick={() => handleDecision(b.id, 'APPROVE')}
                        >
                          Final Approve & Issue
                        </button>
                        <button
                          className="btn btn-warn"
                          onClick={() => handleDecision(b.id, 'SEND_BACK')}
                        >
                          Send Back
                        </button>
                      </>
                    )}
                    <button className="btn btn-outline" onClick={() => onInspect(b.id)}>
                      Inspect
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Issued Certificates Registry (Revoke / Cancel)</h2>
        <table>
          <thead>
            <tr>
              <th>Certificate No</th>
              <th>Candidate</th>
              <th>Course</th>
              <th>Status</th>
              <th>WhatsApp</th>
              <th>Cancel Certificate</th>
            </tr>
          </thead>
          <tbody>
            {certs.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.certificateNumber}</strong>
                </td>
                <td>{c.candidateName}</td>
                <td>{c.courseName}</td>
                <td>
                  <span
                    className={`badge ${
                      c.status === 'ISSUED' ? 'badge-issued' : 'badge-cancelled'
                    }`}
                  >
                    {c.status}
                  </span>
                </td>
                <td>{c.whatsappMessages?.[0]?.status || 'PENDING'}</td>
                <td>
                  {c.status === 'ISSUED' ? (
                    <div className="row">
                      <input
                        className="input"
                        style={{ width: 170 }}
                        placeholder="Cancellation reason"
                        value={cancelReasons[c.id] || ''}
                        onChange={(e) =>
                          setCancelReasons((prev) => ({ ...prev, [c.id]: e.target.value }))
                        }
                      />
                      <button
                        className="btn btn-danger"
                        onClick={() => handleCancelCert(c.id)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span className="muted">Cancelled: {c.cancellationReason}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
