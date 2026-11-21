import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { BatchDetail } from '../types';

interface Props {
  batchId: string;
  onClose: () => void;
}

export const AuditTimelineModal: React.FC<Props> = ({ batchId, onClose }) => {
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBatch(batchId)
      .then((res) => setBatch(res.batch))
      .catch((err) => setError(err.message));
  }, [batchId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            {batch ? `${batch.batchCode} — ${batch.courseName}` : 'Loading Batch...'}
          </h2>
          <button className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {batch && (
          <>
            <p className="muted">
              Centre: <strong>{batch.trainingCentreName}</strong> ({batch.district}) | Status:{' '}
              <strong>{batch.status}</strong> | Approval Round: <strong>{batch.approvalRound}</strong> |{' '}
              Large Batch Quality Check: <strong>{batch.requiresQualityTeam ? 'Required' : 'Not Required'}</strong>
            </p>

            <h3>Candidates ({batch.candidates.length})</h3>
            <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>ID Last 4</th>
                    <th>Score</th>
                    <th>Certificate</th>
                    <th>WhatsApp</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.candidates.map((c) => (
                    <tr key={c.id}>
                      <td>{c.fullName}</td>
                      <td>{c.phone}</td>
                      <td>****{c.nationalIdLast4}</td>
                      <td>{c.score}%</td>
                      <td>{c.certificate ? c.certificate.certificateNumber : '—'}</td>
                      <td>
                        {c.certificate?.whatsappMessages?.[0]
                          ? `${c.certificate.whatsappMessages[0].status} (${c.certificate.whatsappMessages[0].attempts}x)`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Decision History</h3>
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Stage</th>
                  <th>Officer</th>
                  <th>Decision</th>
                  <th>Reason</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {batch.decisions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No decisions recorded yet.
                    </td>
                  </tr>
                ) : (
                  batch.decisions.map((d) => (
                    <tr key={d.id} style={{ opacity: d.active ? 1 : 0.55 }}>
                      <td>R{d.round}</td>
                      <td>{d.stage}</td>
                      <td>{d.officer.name}</td>
                      <td>{d.decision}</td>
                      <td>{d.reason || '—'}</td>
                      <td>{d.active ? 'Yes' : 'Superseded'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <h3 style={{ marginTop: 18 }}>End-to-End Audit Trail</h3>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.auditEvents.map((ev) => (
                    <tr key={ev.id}>
                      <td>{new Date(ev.createdAt).toLocaleString()}</td>
                      <td>
                        {ev.actorName} <span className="muted">({ev.actorRole})</span>
                      </td>
                      <td>
                        <strong>{ev.action}</strong>
                      </td>
                      <td className="muted">{ev.details ? JSON.stringify(ev.details) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
