export type ReviewVertical = "auto-insurance" | "home-insurance";

const HOME_TOKEN = /(^|[^a-z0-9])home([^a-z0-9]|$)/i;
const AUTO_TOKEN = /(^|[^a-z0-9])auto([^a-z0-9]|$)/i;

export function classifyReviewVertical(fileName: string): ReviewVertical {
  if (HOME_TOKEN.test(fileName)) return "home-insurance";
  if (AUTO_TOKEN.test(fileName)) return "auto-insurance";
  return "auto-insurance";
}
