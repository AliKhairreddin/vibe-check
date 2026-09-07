import { createContext, Fragment, useContext, useState, type ReactNode } from 'react';
import type { ClientSession } from '@/lib/api';

type Workspace = { clientId: string; publisherId: string; setClientId: (value: string) => void; setPublisherId: (value: string) => void };
const Context = createContext<Workspace | null>(null);
export function WorkspaceProvider({ session, children }: { session: ClientSession; children: ReactNode }) {
  const [clientId, updateClient] = useState(() => {
    const stored = sessionStorage.getItem('vibe-check-selected-client');
    return session.portals.find(p => p.client_id === stored)?.client_id ?? session.portals[0]?.client_id ?? '';
  });
  const [publisherId, updatePublisher] = useState('all');
  function setClientId(value: string) { updateClient(value); updatePublisher('all'); sessionStorage.setItem('vibe-check-selected-client', value); }
  return <Context.Provider value={{ clientId, publisherId, setClientId, setPublisherId: updatePublisher }}><Fragment key={clientId}>{children}</Fragment></Context.Provider>;
}
export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error('Workspace is unavailable');
  return context;
}
