import React, { useCallback, useEffect, useState } from 'react';
import { api, getAuthToken, setAuthToken } from './api';
import { BatchSummary, Persona } from './types';
import { PersonaSwitcher } from './components/PersonaSwitcher';
import { TrainingCentreView } from './components/TrainingCentreView';
import { OfficerReviewView } from './components/OfficerReviewView';
import { StateOfficeView } from './components/StateOfficeView';
import { PublicVerifyView } from './components/PublicVerifyView';
import { WhatsAppInboxView } from './components/WhatsAppInboxView';
import { AuditTimelineModal } from './components/AuditTimelineModal';

type ActiveTab = 'workspace' | 'verify' | 'whatsapp';

export default function App() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [currentUser, setCurrentUser] = useState<Persona | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');
  const [inspectBatchId, setInspectBatchId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastLiveEvent, setLastLiveEvent] = useState<string | null>(null);

  const loadBatches = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await api.getBatches();
      setBatches(res.batches);
    } catch (err) {
      console.error('Failed to fetch batches:', err);
    }
  }, [currentUser]);

  const handleSwitchPersona = useCallback(async (userId: string) => {
    const res = await api.switchPersona(userId);
    setAuthToken(res.token);
    setCurrentUser(res.user);
    setActiveTab('workspace');
  }, []);

  useEffect(() => {
    api
      .getPersonas()
      .then((res) => {
        setPersonas(res.personas);
        if (res.personas.length > 0) {
          handleSwitchPersona(res.personas[0].id);
        }
      })
      .catch(console.error);
  }, [handleSwitchPersona]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches, refreshTick]);

  // Real-time Server-Sent Events (SSE): updates the UI without a page refresh.
  // The stream is authenticated; EventSource cannot set headers, so the token goes in the URL
  // (accepted by the API for this one endpoint only). Reconnects when the persona changes.
  useEffect(() => {
    const token = getAuthToken();
    if (!currentUser || !token) return;
    const eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    eventSource.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type && data.type !== 'CONNECTED') {
          setLastLiveEvent(`${data.type} at ${new Date(data.timestamp).toLocaleTimeString()}`);
          setRefreshTick((t) => t + 1);
        }
      } catch {
        // ignore heartbeat
      }
    };
    return () => eventSource.close();
  }, [currentUser]);

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <h1>CertiFlow</h1>
          <span>Pragati Skills Mission</span>
          <div className="live-dot">
            {lastLiveEvent ? `Live: ${lastLiveEvent}` : 'Live SSE Connected'}
          </div>
        </div>
        <PersonaSwitcher
          personas={personas}
          currentUser={currentUser}
          onSwitch={handleSwitchPersona}
        />
      </header>

      <nav className="nav-tabs">
        <button
          className={`tab-btn ${activeTab === 'workspace' ? 'active' : ''}`}
          onClick={() => setActiveTab('workspace')}
        >
          Role Workspace
        </button>
        <button
          className={`tab-btn ${activeTab === 'verify' ? 'active' : ''}`}
          onClick={() => setActiveTab('verify')}
        >
          Public Verification (No Login)
        </button>
        <button
          className={`tab-btn ${activeTab === 'whatsapp' ? 'active' : ''}`}
          onClick={() => setActiveTab('whatsapp')}
        >
          Candidate WhatsApp Inbox
        </button>
      </nav>

      <main className="container">
        {activeTab === 'verify' && <PublicVerifyView />}
        {activeTab === 'whatsapp' && <WhatsAppInboxView refreshTrigger={refreshTick} />}
        {activeTab === 'workspace' && currentUser && (
          <>
            {currentUser.role === 'TRAINING_CENTRE' && (
              <TrainingCentreView
                batches={batches}
                onRefresh={() => setRefreshTick((t) => t + 1)}
                onInspect={setInspectBatchId}
              />
            )}
            {(currentUser.role === 'DISTRICT_OFFICER' || currentUser.role === 'QUALITY_TEAM') && (
              <OfficerReviewView
                user={currentUser}
                batches={batches}
                onRefresh={() => setRefreshTick((t) => t + 1)}
                onInspect={setInspectBatchId}
              />
            )}
            {currentUser.role === 'STATE_OFFICE' && (
              <StateOfficeView
                batches={batches}
                onRefresh={() => setRefreshTick((t) => t + 1)}
                onInspect={setInspectBatchId}
                refreshTrigger={refreshTick}
              />
            )}
          </>
        )}
      </main>

      {inspectBatchId && (
        <AuditTimelineModal batchId={inspectBatchId} onClose={() => setInspectBatchId(null)} />
      )}
    </div>
  );
}
