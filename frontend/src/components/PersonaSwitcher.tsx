import React from 'react';
import { Persona } from '../types';

interface Props {
  personas: Persona[];
  currentUser: Persona | null;
  onSwitch: (userId: string) => void;
}

const ROLE_LABELS: Record<string, string> = {
  TRAINING_CENTRE: 'Training Centre',
  DISTRICT_OFFICER: 'District Officer',
  QUALITY_TEAM: 'Quality Team',
  STATE_OFFICE: 'State Office',
};

export const PersonaSwitcher: React.FC<Props> = ({ personas, currentUser, onSwitch }) => {
  return (
    <div className="row">
      <label htmlFor="persona-select" style={{ fontSize: '0.85rem', opacity: 0.9 }}>
        Active Demo Persona:
      </label>
      <select
        id="persona-select"
        value={currentUser?.id || ''}
        onChange={(e) => onSwitch(e.target.value)}
        style={{ background: '#fff', color: '#0f172a', fontWeight: 600 }}
      >
        {personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({ROLE_LABELS[p.role] || p.role}
            {p.district ? ` - ${p.district}` : ''})
          </option>
        ))}
      </select>
    </div>
  );
};
