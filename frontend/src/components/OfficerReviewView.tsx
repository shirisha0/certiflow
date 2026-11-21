import React, { useState } from 'react';
import { api } from '../api';
import { BatchSummary, Persona } from '../types';

interface Props {
  user: Persona;
  batches: BatchSummary[];
  onRefresh: () => void;
  onInspect: (batchId: string) => void;
}

export const OfficerReviewView: React.FC<Props> = ({ user, batches, onRefresh, onInspect }) => {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const targetStage =
    user.role === 'DISTRICT_OFFICER' ? 'SUBMITTED_DISTRICT' : 'PENDING_QUALITY';

  const handleDecision = async (
    batchId: string,
    decision: 'APPROVE' | 'REJECT' | 'SEND_BACK'
  ) => {
    setError(null);
    setSuccess(null);
    try {
      await api.decideBatch(batchId, {
        decision,
        reason: reasons[batchId] || undefined,
      });
      setSuccess(`Recorded ${decision} decision.`);
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card">
      <h2>
        {user.role === 'DISTRICT_OFFICER'
          ? `District Officer Queue (${user.district})`
          : 'Quality Team Queue (Large Batches >= 50)'}
      </h2>
      <p className="muted">
        {user.role === 'DISTRICT_OFFICER'
          ? 'At least 2 district officers must approve a batch before it advances. Concurrent approvals are serialized atomically.'
          : 'Large batches require an extra Quality Team verification before reaching the State Office.'}
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <table>
        <thead>
          <tr>
            <th>Batch</th>
            <th>Centre</th>
            <th>Candidates</th>
            <th>Status</th>
            <th>Current Round Approvals</th>
            <th>Review Actions</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => {
            const isActionable = b.status === targetStage;
            const alreadyVoted = b.decisions.some(
              (d) => d.officerId === user.id && d.stage === b.status && d.round === b.approvalRound
            );
            const approveCount = b.decisions.filter(
              (d) => d.stage === 'SUBMITTED_DISTRICT' && d.decision === 'APPROVE'
            ).length;

            return (
              <tr key={b.id}>
                <td>
                  <strong>{b.batchCode}</strong>
                  <div className="muted">{b.courseName}</div>
                </td>
                <td>{b.trainingCentreName}</td>
                <td>{b._count.candidates}</td>
                <td>
                  <span className="badge badge-submitted">{b.status}</span>
                </td>
                <td>
                  {b.status === 'SUBMITTED_DISTRICT' ? `${approveCount} / 2` : `R${b.approvalRound}`}
                  <div className="muted">
                    {b.decisions.map((d) => `${d.officer.name} (${d.decision})`).join(', ')}
                  </div>
                </td>
                <td>
                  <div className="row">
                    {isActionable && !alreadyVoted && (
                      <>
                        <input
                          className="input"
                          style={{ width: 170 }}
                          placeholder="Reason (if rejecting/returning)"
                          value={reasons[b.id] || ''}
                          onChange={(e) =>
                            setReasons((prev) => ({ ...prev, [b.id]: e.target.value }))
                          }
                        />
                        <button
                          className="btn btn-success"
                          onClick={() => handleDecision(b.id, 'APPROVE')}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-warn"
                          onClick={() => handleDecision(b.id, 'SEND_BACK')}
                        >
                          Send Back
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => handleDecision(b.id, 'REJECT')}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {isActionable && alreadyVoted && (
                      <span className="muted">You already voted in R{b.approvalRound}</span>
                    )}
                    <button className="btn btn-outline" onClick={() => onInspect(b.id)}>
                      Inspect
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
