import React, { useState } from 'react';
import { api } from '../api';
import { BatchSummary } from '../types';

interface Props {
  batches: BatchSummary[];
  onRefresh: () => void;
  onInspect: (batchId: string) => void;
}

export const TrainingCentreView: React.FC<Props> = ({ batches, onRefresh, onInspect }) => {
  const [batchCode, setBatchCode] = useState('');
  const [courseName, setCourseName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Array<{ row: number; field: string; message: string }>>([]);
  const [success, setSuccess] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRowErrors([]);
    setSuccess(null);
    try {
      await api.createBatch({ batchCode, courseName });
      setBatchCode('');
      setCourseName('');
      setSuccess('Batch created in DRAFT status.');
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleUpload = async (batchId: string, file: File | null) => {
    if (!file) return;
    setError(null);
    setRowErrors([]);
    setSuccess(null);
    try {
      const res = await api.uploadCandidates(batchId, file);
      setSuccess(
        `Uploaded ${res.candidateCount} candidates atomically.${
          res.requiresQualityTeam ? ' Large batch (>=50): Quality Team review enabled.' : ''
        }`
      );
      onRefresh();
    } catch (err) {
      const e = err as Error & { rowErrors?: Array<{ row: number; field: string; message: string }> };
      setError(e.message);
      if (e.rowErrors) setRowErrors(e.rowErrors);
    }
  };

  const handleSubmit = async (batchId: string) => {
    setError(null);
    setRowErrors([]);
    setSuccess(null);
    try {
      await api.submitBatch(batchId);
      setSuccess('Batch submitted for District Officer approval.');
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>Create New Batch</h2>
        <form onSubmit={handleCreate} className="row">
          <input
            className="input"
            placeholder="Batch Code (e.g. BATCH-2026-005)"
            value={batchCode}
            onChange={(e) => setBatchCode(e.target.value)}
            required
          />
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Course Name (e.g. Solar PV Technician)"
            value={courseName}
            onChange={(e) => setCourseName(e.target.value)}
            required
          />
          <button className="btn btn-primary" type="submit">
            Create Batch
          </button>
        </form>
      </div>

      {error && (
        <div className="alert alert-error">
          <strong>{error}</strong>
          {rowErrors.length > 0 && (
            <ul style={{ margin: '8px 0 0 18px' }}>
              {rowErrors.map((re, idx) => (
                <li key={idx}>
                  Row {re.row} ({re.field}): {re.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {success && <div className="alert alert-success">{success}</div>}

      <div className="card">
        <h2>Your Training Centre Batches</h2>
        <table>
          <thead>
            <tr>
              <th>Batch Code</th>
              <th>Course</th>
              <th>Candidates</th>
              <th>Status</th>
              <th>Round</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const canEdit = b.status === 'DRAFT' || b.status === 'RETURNED_FOR_CORRECTION';
              return (
                <tr key={b.id}>
                  <td>
                    <strong>{b.batchCode}</strong>
                    {b.requiresQualityTeam && <div className="muted">Large Batch (Quality Check)</div>}
                    {b.lastReturn &&
                      (b.status === 'RETURNED_FOR_CORRECTION' || b.status === 'REJECTED') && (
                        <div className="muted" style={{ color: '#b45309' }}>
                          {b.lastReturn.decision === 'SEND_BACK' ? 'Sent back' : 'Rejected'} by{' '}
                          {b.lastReturn.officerName}: {b.lastReturn.reason}
                        </div>
                      )}
                  </td>
                  <td>{b.courseName}</td>
                  <td>{b._count.candidates}</td>
                  <td>
                    <span className={`badge badge-${b.status.toLowerCase().split('_')[0]}`}>
                      {b.status}
                    </span>
                  </td>
                  <td>R{b.approvalRound}</td>
                  <td>
                    <div className="row">
                      {canEdit && (
                        <label className="btn btn-outline" style={{ cursor: 'pointer' }}>
                          Upload CSV/XLSX
                          <input
                            type="file"
                            accept=".csv,.xlsx,.xls"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              handleUpload(b.id, e.target.files?.[0] || null);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      )}
                      {canEdit && b._count.candidates > 0 && (
                        <button className="btn btn-success" onClick={() => handleSubmit(b.id)}>
                          {b.status === 'RETURNED_FOR_CORRECTION' ? 'Fix & Resubmit' : 'Submit'}
                        </button>
                      )}
                      <button className="btn btn-outline" onClick={() => onInspect(b.id)}>
                        Inspect / Audit
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
