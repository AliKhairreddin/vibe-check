import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ClientPortalFrame, ClientReviewsPage } from './client-dashboard';
import { useWorkspace } from './workspace-context';
import { getSharedReviewContext } from '@/lib/workspace-api';
import { buttonVariants } from './ui/button';

export function SharedReviewQueue() {
  const { token } = useParams({ from: '/client/shared/$token' });
  const { clientId, setClientId, publisherId, setPublisherId } = useWorkspace();
  const query = useQuery({ queryKey: ['shared-review-context', token], queryFn: () => getSharedReviewContext(token), retry: false });
  const clientIds = query.data?.client_ids;
  useEffect(() => {
    if (clientIds?.length && !clientIds.includes(clientId)) setClientId(clientIds[0]);
  }, [clientIds, clientId, setClientId]);
  useEffect(() => {
    if (publisherId !== 'all') setPublisherId('all');
  }, [publisherId, setPublisherId]);
  if (query.data && clientIds?.includes(clientId)) return <ClientReviewsPage key={token} shared={{ token, title: query.data.title, clientIds }} />;
  return <ClientPortalFrame><div className="mx-auto grid max-w-lg gap-3 rounded-xl border bg-card p-6">
    {query.isLoading || (clientIds?.length && !query.error) ? <p>Opening shared creatives…</p> : <>
      <h1 className="text-xl font-semibold">Shared review unavailable</h1>
      <p role="alert" className="text-sm leading-6 text-muted-foreground">{query.error?.message ?? 'Your account does not have access to this advertiser’s workspace. Sign in with the account that received these creatives.'}</p>
      <a href={`/share/${encodeURIComponent(token)}`} className={buttonVariants({ variant: 'outline' })}>Back to shared preview</a>
      <Link to="/client/reviews" className={buttonVariants({ variant: 'ghost' })}>Open your review queue</Link>
    </>}
  </div></ClientPortalFrame>;
}
