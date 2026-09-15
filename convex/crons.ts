import { cronJobs, makeFunctionReference } from 'convex/server';

const crons = cronJobs();
// The local-time gate handles daylight saving changes; the durable run is once a day.
crons.interval('Telegram daily roundup', { minutes: 5 }, makeFunctionReference<'mutation'>('telegramDigest:tick'));
crons.interval('Telegram email delivery check', { minutes: 5 }, makeFunctionReference<'mutation'>('telegramMilestones:checkDelivery'));
export default crons;
