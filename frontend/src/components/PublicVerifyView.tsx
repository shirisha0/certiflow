import React, { useState } from 'react';
import { api } from '../api';
import { PublicVerifyResult } from '../types';

export const PublicVerifyView: React.FC = () => {
  const [certNumber, setCertNumber] = useState('PSM-2026-PUNE-10000');
  const [result, setResult] = useState<PublicVerifyResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!certNumber.trim()) return;
    setLoading(true);
    try {
      const res = await api.verifyPublic(certNumber.trim());
      setResult(res);
    } catch {
      setResult({
        valid: false,
        status: 'NOT_FOUND',
        message: 'No certificate found with this number.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 680, margin: '0 auto' }}>
      <h2>Public Certificate Verification</h2>
      <p className="muted">
        Employers and the public can verify any Pragati Skills Mission certificate without logging
        in. Personal contact details are never exposed.
      </p>

      <form onSubmit={handleVerify} className="row" style={{ marginBottom: 16 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Enter Certificate Number (e.g. PSM-2026-PUNE-10000)"
          value={certNumber}
          onChange={(e) => setCertNumber(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? 'Checking...' : 'Verify Certificate'}
        </button>
      </form>

      {result && (
        <div
          className={`alert ${result.valid ? 'alert-success' : 'alert-error'}`}
          style={{ padding: 18 }}
        >
          <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 8 }}>
            {result.valid
              ? 'GENUINE & VALID CERTIFICATE'
              : result.status === 'CANCELLED'
              ? 'INVALID — THIS CERTIFICATE HAS BEEN CANCELLED'
              : 'NOT FOUND — NO SUCH CERTIFICATE EXISTS'}
          </div>
          {result.certificateNumber && (
            <div>
              <div>
                <strong>Certificate No:</strong> {result.certificateNumber}
              </div>
              <div>
                <strong>Candidate Name:</strong> {result.candidateName}
              </div>
              <div>
                <strong>Course:</strong> {result.courseName}
              </div>
              <div>
                <strong>Training Centre:</strong> {result.trainingCentreName} ({result.district})
              </div>
              <div>
                <strong>Issued On:</strong>{' '}
                {result.issuedAt ? new Date(result.issuedAt).toLocaleDateString() : '—'}
              </div>
              {result.status === 'CANCELLED' && (
                <div style={{ marginTop: 8 }}>
                  <strong>Cancellation Reason:</strong> {result.cancellationReason}
                </div>
              )}
            </div>
          )}
          {result.message && !result.certificateNumber && <div>{result.message}</div>}
        </div>
      )}
    </div>
  );
};
