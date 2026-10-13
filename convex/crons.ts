import { cronJobs, makeFunctionReference } from 'convex/server';

const crons = cronJobs();
crons.interval('Reconcile Stripe billing and expire event receipts', { minutes: 5 }, makeFunctionReference<'mutation'>('billing:recover'));
crons.interval('Clean up expired demo workspaces and limits', { minutes: 5 }, makeFunctionReference<'mutation'>('demo:cleanup'));
// The local-time gate handles daylight saving changes; the durable run is once a day.
crons.interval('Telegram daily roundup', { minutes: 5 }, makeFunctionReference<'mutation'>('telegramDigest:tick'));
crons.interval('Telegram email delivery check', { minutes: 5 }, makeFunctionReference<'mutation'>('telegramMilestones:checkDelivery'));
crons.interval('Recover Lemonmaxx status sync', { minutes: 1 }, makeFunctionReference<'mutation'>('lemonmaxx:recover'));
export default crons;
