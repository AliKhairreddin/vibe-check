import { cronJobs, makeFunctionReference } from 'convex/server';

const crons = cronJobs();
// The local-time gate handles daylight saving changes; the durable run is once a day.
crons.interval('Telegram daily roundup', { minutes: 5 }, makeFunctionReference<'mutation'>('telegramDigest:tick'));
crons.interval('Telegram email delivery check', { minutes: 5 }, makeFunctionReference<'mutation'>('telegramMilestones:checkDelivery'));
crons.interval('Recover Lemonmaxx status sync', { minutes: 1 }, makeFunctionReference<'mutation'>('lemonmaxx:recover'));
export default crons;
