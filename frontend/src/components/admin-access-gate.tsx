import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, KeyRound, LoaderCircle, LockKeyhole, ScanSearch } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  clearAdminSession,
  getAdminSession,
  verifyAdminPassword,
  type AdminSession,
} from '@/lib/api';

type AdminAccessValue = {
  canManageSettings: boolean;
  error: string;
  isChecking: boolean;
  isSigningOut: boolean;
  isUnlocked: boolean;
  lock: () => Promise<void>;
  password: string;
  role: AdminSession['role'] | null;
  setPassword: (value: string) => void;
  unlock: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  username: string;
};

const AdminAccessContext = createContext<AdminAccessValue | null>(null);

export function AdminAccessProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [password, setPasswordState] = useState('');
  const [isChecking, setIsChecking] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [role, setRole] = useState<AdminSession['role'] | null>(null);
  const [username, setUsername] = useState('');

  function applySession(session: AdminSession) {
    setIsUnlocked(true);
    setRole(session.role);
    setUsername(session.username);
  }

  useEffect(() => {
    let active = true;
    void getAdminSession()
      .then((session) => {
        if (active) applySession(session);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIsChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function setPassword(value: string) {
    setPasswordState(value);
    if (error) setError('');
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = password.trim();
    if (!candidate) {
      setError('Enter the admin password.');
      return;
    }
    setIsChecking(true);
    setError('');
    try {
      const session = await verifyAdminPassword(candidate);
      setPasswordState('');
      applySession(session);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['offer-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['automations'] }),
        queryClient.invalidateQueries({ queryKey: ['api-partners'] }),
      ]);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsChecking(false);
    }
  }

  async function lock() {
    setIsSigningOut(true);
    setError('');
    try {
      await clearAdminSession();
    } catch (reason) {
      setError(`Could not sign out. ${errorMessage(reason)}`);
      setIsSigningOut(false);
      return;
    }
    setPasswordState('');
    setIsUnlocked(false);
    setRole(null);
    setUsername('');
    queryClient.clear();
    setIsSigningOut(false);
  }

  return (
    <AdminAccessContext.Provider value={{
      canManageSettings: role === 'owner',
      error,
      isChecking,
      isSigningOut,
      isUnlocked,
      lock,
      password,
      role,
      setPassword,
      unlock,
      username,
    }}>
      {children}
    </AdminAccessContext.Provider>
  );
}

export function AdminPortalGate({ children }: { children: ReactNode }) {
  const access = useAdminAccess();
  if (access.isUnlocked) return children;

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#f7f8f6] p-4 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(52,211,153,0.13),transparent_36%)]" />
      <div className="relative grid w-full max-w-md gap-5">
        <a className="mx-auto inline-flex items-center gap-2.5 text-lg font-semibold tracking-[-0.03em]" href="https://adchecked.com">
          <span className="grid size-9 place-items-center rounded-xl bg-zinc-950 text-white">
            <ScanSearch className="size-4" strokeWidth={2.2} />
          </span>
          AdChecked
        </a>
        <AdminLoginCard />
        <p className="text-center text-xs text-muted-foreground">
          Owner and employee console · <a className="underline underline-offset-4" href="https://app.adchecked.com/login">Client sign in</a>
        </p>
      </div>
    </main>
  );
}

export function AdminAccessGate({ children }: { children: ReactNode }) {
  const { isUnlocked } = useAdminAccess();
  if (isUnlocked) return children;
  return <AdminLoginCard compact />;
}

export function useAdminAccess() {
  const value = useContext(AdminAccessContext);
  if (!value) throw new Error('Admin access must be used inside AdminAccessProvider.');
  return value;
}

function AdminLoginCard({ compact = false }: { compact?: boolean }) {
  const {
    error,
    isChecking,
    password,
    setPassword,
    unlock,
  } = useAdminAccess();

  return (
    <Card className={compact ? undefined : 'w-full border-zinc-950/8 shadow-2xl shadow-zinc-950/8'} size={compact ? 'sm' : 'default'}>
      <CardHeader>
        <span className="mb-2 grid size-10 place-items-center rounded-xl bg-zinc-950 text-white">
          <LockKeyhole className="size-4" />
        </span>
        <CardTitle as={compact ? 'h2' : 'h1'} className={compact ? undefined : 'text-2xl'}>
          Admin sign in
        </CardTitle>
        <CardDescription>
          The existing owner password keeps full access. The separate employee password opens review tools without settings access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={unlock}>
          <div className="grid gap-2">
            <Label htmlFor={compact ? 'inline-admin-password' : 'admin-password'}>Password</Label>
            <Input
              id={compact ? 'inline-admin-password' : 'admin-password'}
              type="password"
              value={password}
              autoComplete="current-password"
              autoFocus={!compact}
              disabled={isChecking}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" size={compact ? 'default' : 'lg'} disabled={isChecking || !password.trim()}>
            {isChecking ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
            {isChecking ? 'Checking access' : 'Open admin console'}
          </Button>
        </form>
        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle />
            <AlertTitle>Sign in failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
