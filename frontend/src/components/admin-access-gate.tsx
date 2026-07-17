import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getAdminPassword, setAdminPassword, verifyAdminPassword } from '@/lib/api';

export function AdminAccessGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState(getAdminPassword);
  const [isChecking, setIsChecking] = useState(Boolean(getAdminPassword()));
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const stored = getAdminPassword();
    if (!stored) {
      setIsChecking(false);
      return;
    }
    let active = true;
    void verifyAdminPassword(stored)
      .then(() => {
        if (active) setIsUnlocked(true);
      })
      .catch((reason) => {
        if (!active) return;
        setAdminPassword('');
        setPassword('');
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setIsChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

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
      await verifyAdminPassword(candidate);
      setAdminPassword(candidate);
      setIsUnlocked(true);
      await queryClient.invalidateQueries({ queryKey: ['offer-profiles'] });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsChecking(false);
    }
  }

  function lock() {
    setAdminPassword('');
    setPassword('');
    setIsUnlocked(false);
    setError('');
    queryClient.removeQueries({ queryKey: ['offer-profiles'] });
  }

  return (
    <div className="grid gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-4 text-muted-foreground" />
            Admin access
          </CardTitle>
          <CardDescription>
            Required to view or change official guidelines, manage overrides, and remove review history.
          </CardDescription>
          {isUnlocked ? (
            <CardAction className="flex items-center gap-2">
              <Badge variant="secondary"><ShieldCheck /> Unlocked</Badge>
              <Button type="button" size="xs" variant="ghost" onClick={lock}>Lock</Button>
            </CardAction>
          ) : null}
        </CardHeader>
        {!isUnlocked ? (
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-[minmax(0,22rem)_auto] sm:items-end" onSubmit={unlock}>
              <div className="grid gap-2">
                <Label htmlFor="admin-password">Admin password</Label>
                <Input
                  id="admin-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  disabled={isChecking}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </div>
              <Button type="submit" disabled={isChecking || !password.trim()}>
                {isChecking ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                {isChecking ? 'Checking' : 'Unlock settings'}
              </Button>
            </form>
            {error ? (
              <Alert variant="destructive" className="mt-3">
                <AlertCircle />
                <AlertTitle>Admin access unavailable</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
      {isUnlocked ? children : null}
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
