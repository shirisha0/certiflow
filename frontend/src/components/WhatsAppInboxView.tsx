import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { WhatsAppMessageRecord } from '../types';

export const WhatsAppInboxView: React.FC<{ refreshTrigger: number }> = ({ refreshTrigger }) => {
  const [messages, setMessages] = useState<WhatsAppMessageRecord[]>([]);

  useEffect(() => {
    api.getWhatsAppMessages().then((res) => setMessages(res.messages)).catch(console.error);
  }, [refreshTrigger]);

  return (
    <div className="card">
      <h2>Candidate Phone — Stand-In WhatsApp Inbox</h2>
      <p className="muted">
        Simulates candidates receiving their certificate PDF on WhatsApp. Retries with exponential
        backoff and idempotency keys ensure every candidate receives exactly one certificate even
        when the provider fails or times out.
      </p>

      <table>
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Phone</th>
            <th>Certificate</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Download PDF</th>
          </tr>
        </thead>
        <tbody>
          {messages.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No WhatsApp messages dispatched yet.
              </td>
            </tr>
          ) : (
            messages.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.recipientName}</strong>
                  <div className="muted">{m.certificate.courseName}</div>
                </td>
                <td>{m.recipientPhone}</td>
                <td>{m.certificate.certificateNumber}</td>
                <td>
                  <span
                    className={`badge ${
                      m.status === 'DELIVERED'
                        ? 'badge-delivered'
                        : m.status === 'FAILED'
                        ? 'badge-failed'
                        : 'badge-draft'
                    }`}
                  >
                    {m.status}
                  </span>
                </td>
                <td>{m.attempts}</td>
                <td>
                  {m.certificate.status === 'CANCELLED' ? (
                    <span className="muted">Revoked</span>
                  ) : (
                    <a
                      href={m.mediaUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-outline"
                      style={{ textDecoration: 'none', display: 'inline-block' }}
                    >
                      Download PDF
                    </a>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};
