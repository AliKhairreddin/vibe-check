import { v } from 'convex/values';

export const emailStatus = v.union(v.literal('draft'), v.literal('sending'), v.literal('sent'), v.literal('uncertain'));
export const emailLink = v.object({
  batchId: v.string(), label: v.string(), url: v.string(), shareId: v.string(), jobIds: v.array(v.string()),
});
export const emailFields = {
  emailId: v.string(), ownerKey: v.string(), clientId: v.optional(v.string()), publisherId: v.optional(v.string()),
  offerId: v.string(), to: v.array(v.string()), cc: v.array(v.string()), replyTo: v.string(),
  subject: v.string(), message: v.string(), signature: v.string(), links: v.array(emailLink),
  status: emailStatus, createdAt: v.number(), expiresAt: v.number(),
  sentAt: v.optional(v.number()), from: v.optional(v.string()), messageId: v.optional(v.string()),
  sendingAt: v.optional(v.number()),
  claimId: v.optional(v.string()),
};

export function validateEmailContent(value: { to: string[]; cc: string[]; replyTo: string; subject: string; message: string; signature: string }) {
  const address = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/;
  if (!value.to.length || value.to.length + value.cc.length > 50 || [...value.to, ...value.cc, value.replyTo].some(email => email.length > 254 || !address.test(email))) {
    throw new Error('Enter valid email addresses and a reply-to address (up to 50 recipients)');
  }
  if (!value.subject.trim() || value.subject.length > 200 || /[\r\n]/.test(value.subject) || !value.message.trim() || value.message.length > 10000 || value.signature.length > 1000) {
    throw new Error('Enter a subject and message within the allowed lengths');
  }
}
