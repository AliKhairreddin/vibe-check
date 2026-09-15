import { v } from 'convex/values';

export const releaseSection = v.object({
  offerId: v.string(), name: v.string(), jobIds: v.array(v.string()),
  red: v.number(), yellow: v.number(), green: v.number(), eligible: v.number(), reviewed: v.number(),
});

export const deliveryFields = {
  batchId: v.string(), offerId: v.string(), emailId: v.string(), jobIds: v.array(v.string()),
  status: v.union(v.literal('sending'), v.literal('sent'), v.literal('uncertain')),
  to: v.array(v.string()), cc: v.array(v.string()), updatedAt: v.number(), sentAt: v.optional(v.number()),
  attemptCreatedAt: v.number(),
};

export const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const shortText = (value: string, length = 100) => escapeHtml(value.length > length ? `${value.slice(0, length)}…` : value);
export const adminUrl = () => (process.env.TELEGRAM_ADMIN_URL || 'https://admin.adchecked.com').replace(/\/$/, '');
export const batchLink = (batchId: string, offerId?: string) => `${adminUrl()}/batches/${encodeURIComponent(batchId)}${offerId ? `?offer=${encodeURIComponent(offerId)}` : ''}`;

// Parts always end on a complete HTML line. Leave room for the repeated heading.
export function messageParts(header: string, sections: string[]) {
  const parts: string[] = [];
  let part = header;
  for (const section of sections) {
    for (const line of (`\n${section}`).split('\n')) {
      if (line.length > 3500) throw new Error('Notification line is too long');
      if (part.length + line.length + 1 > 3800) { parts.push(part); part = `${header} (continued)`; }
      part += `\n${line}`;
    }
  }
  if (part !== header) parts.push(part);
  return parts;
}

export function localDate(timestamp: number, timeZone = process.env.TELEGRAM_DIGEST_TIMEZONE || 'America/Toronto') {
  const fields = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
  const get = (type: string) => fields.find(field => field.type === type)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function localDayStart(timestamp: number, timeZone = process.env.TELEGRAM_DIGEST_TIMEZONE || 'America/Toronto') {
  const day = localDate(timestamp, timeZone).day;
  // Find the date boundary rather than subtracting hours: DST days can be 23 or 25 hours.
  let before = timestamp - 36 * 60 * 60_000;
  let start = timestamp;
  while (start - before > 1) {
    const middle = Math.floor((before + start) / 2);
    if (localDate(middle, timeZone).day === day) start = middle;
    else before = middle;
  }
  return start;
}
