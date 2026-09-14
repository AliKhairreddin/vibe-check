type Email = {
  emailId: string; subject: string; message: string; signature: string; to: string[]; cc: string[]; replyTo: string;
  status: 'draft' | 'sending' | 'sent' | 'uncertain'; links: { label: string; url: string }[];
};

export function emailRoute(path: string): 'options' | 'send' | null {
  if (/^\/api\/(?:client\/[^/]+\/)?release-emails\/options$/.test(path)) return 'options';
  if (/^\/api\/(?:client\/[^/]+\/)?release-emails\/[a-f0-9]{32}\/send$/.test(path)) return 'send';
  return null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function renderReleaseEmail(email: Pick<Email, 'message' | 'signature' | 'links'>) {
  const footer = 'These review links are valid for 30 days. Anyone with a link can view the selected advertiser’s results.';
  return {
    text: [email.message, email.links.map(link => `${link.label} Link: ${link.url}`).join('\n\n'), email.signature, footer].filter(Boolean).join('\n\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:640px"><p style="white-space:pre-wrap">${escapeHtml(email.message)}</p>${email.links.map(link => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)} Link</a></p>`).join('')}<p style="white-space:pre-wrap">${escapeHtml(email.signature)}</p><p style="font-size:12px;color:#586174">${footer}</p></div>`,
  };
}

async function mutation<T>(env: Env, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${env.CONVEX_URL}/api/mutation`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `releaseEmails:${name}`, args: { ...args, secret: env.CONVEX_HTTP_SECRET }, format: 'json' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Email storage unavailable');
  const data = await response.json() as { status: string; value?: T; errorMessage?: string };
  if (data.status !== 'success') {
    for (const message of ['Email unavailable', 'Preview expired. Create a fresh email preview', 'A selected link is no longer available. Create a fresh email preview', 'A selected creative is no longer released']) {
      if (data.errorMessage?.includes(message)) throw new Error(message);
    }
    throw new Error('Email storage unavailable');
  }
  return data.value as T;
}

export async function deliverReleaseEmail(env: Env, authorization: { email_id: string; owner_key: string }): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  if (!env.RELEASE_EMAIL_FROM || !env.RELEASE_EMAIL) return Response.json({ detail: 'Email sending is not configured yet.' }, { status: 503, headers });
  const claimId = crypto.randomUUID();
  let claim: { claimed: boolean; email: Email };
  try {
    claim = await mutation(env, 'claim', { emailId: authorization.email_id, ownerKey: authorization.owner_key, claimId, from: env.RELEASE_EMAIL_FROM });
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : 'Could not prepare delivery.' }, { status: 409, headers });
  }
  if (!claim.claimed) return Response.json({ email_id: authorization.email_id, status: claim.email.status }, { headers });
  let messageId: string;
  try {
    const result = await env.RELEASE_EMAIL.send({
      from: { email: env.RELEASE_EMAIL_FROM, name: 'Adchecked' }, to: claim.email.to,
      ...(claim.email.cc.length ? { cc: claim.email.cc } : {}), replyTo: claim.email.replyTo,
      subject: claim.email.subject, ...renderReleaseEmail(claim.email),
    });
    messageId = result.messageId;
  } catch {
    // The provider may already have accepted the message. Never retry a send
    // automatically or release the claim after a timeout/ambiguous failure.
    try { await mutation(env, 'finish', { emailId: authorization.email_id, claimId, status: 'uncertain' }); } catch { /* The durable sending claim still prevents duplicates. */ }
    console.error(JSON.stringify({ event: 'release_email_delivery_uncertain', emailId: authorization.email_id }));
    return Response.json({ email_id: authorization.email_id, status: 'uncertain' }, { headers });
  }
  try {
    // Retrying the status write is safe; never repeat the provider call.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await mutation(env, 'finish', { emailId: authorization.email_id, claimId, status: 'sent', messageId }); break; }
      catch (error) { if (attempt === 2) throw error; }
    }
  } catch {
    console.error(JSON.stringify({ event: 'release_email_audit_pending', emailId: authorization.email_id, messageId }));
    return Response.json({ email_id: authorization.email_id, status: 'sent', audit_pending: true }, { headers });
  }
  return Response.json({ email_id: authorization.email_id, status: 'sent' }, { headers });
}
