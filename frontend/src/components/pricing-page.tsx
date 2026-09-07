import { useState } from 'react';
import { ArrowRight, Check, ScanSearch, Users } from 'lucide-react';
import { Button } from './ui/button';

export const PRICING_PLANS = [
  { name: 'Starter', monthly: 299, yearly: 2990, description: 'Bring your first publisher teams into one review workspace.', publishers: '5 publisher teams', reviews: '250 reviews / month', features: ['One advertiser workspace', 'Your offer guidelines, applied automatically', 'Publisher logins and manual uploads', 'Creative, video, and ad copy review', 'Advertiser decisions and feedback', 'Public links for creatives and collections'] },
  { name: 'Growth', monthly: 799, yearly: 7990, description: 'Keep a growing publisher network moving with one clear process.', publishers: '25 publisher teams', reviews: '1,000 reviews / month', features: ['Everything in Starter', 'More publisher workspaces and review capacity', 'Publisher filters across review insights', 'Batch uploads and progress tracking', 'Downloadable review reports', 'Sales-assisted onboarding'] },
  { name: 'Enterprise', monthly: 1999, yearly: null, description: 'A tailored rollout for larger advertiser and affiliate networks.', publishers: 'Custom publisher capacity', reviews: 'Custom review allowance', features: ['Everything in Growth', 'Multiple advertiser workspaces by agreement', 'Partner API access, scoped to your offers', 'Custom volume and commercial terms', 'Guideline setup with your team', 'A rollout plan built around your workflow'] },
];

export function PricingPage({ embedded = false }: { embedded?: boolean }) {
  const [yearly, setYearly] = useState(false);
  return <div className={embedded ? '' : 'min-h-screen bg-[#fbfcfa] text-zinc-950'}>
    {!embedded ? <header className="border-b bg-white"><nav className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-5"><a href="https://adchecked.com" className="flex items-center gap-2 text-lg font-semibold"><ScanSearch className="size-7" />AdChecked</a><a className="text-sm font-medium" href="https://app.adchecked.com/login">Sign in <span aria-hidden>↗</span></a></nav></header> : null}
    <main className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-3xl text-center"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Plans for advertiser teams</p><h1 className="mt-4 text-4xl leading-tight font-semibold tracking-[-0.045em] sm:text-6xl">One standard.<br />Every publisher.</h1><p className="mx-auto mt-5 max-w-xl text-lg leading-7 text-zinc-600">Give your publishers a place to upload. Give your team a clear review, the evidence, and the final say.</p></div>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3"><div className="inline-flex rounded-full border bg-white p-1" aria-label="Billing period"><Button className="rounded-full" variant={!yearly ? 'default' : 'ghost'} aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</Button><Button className="rounded-full" variant={yearly ? 'default' : 'ghost'} aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly</Button></div><span className="text-sm font-medium text-emerald-700">2 months free with annual billing</span></div>
      <div className="mt-10 grid items-stretch gap-5 lg:grid-cols-3">{PRICING_PLANS.map((plan, index) => <article key={plan.name} className={`relative flex flex-col rounded-3xl border p-7 ${index === 1 ? 'border-emerald-600 bg-emerald-50/50 shadow-lg shadow-emerald-900/5' : 'border-zinc-200 bg-white'}`}>
        {index === 1 ? <span className="absolute -top-3 left-6 rounded-full bg-emerald-700 px-3 py-1 text-xs font-semibold text-white">For growing networks</span> : null}
        <h2 className="text-xl font-semibold">{plan.name}</h2><p className="mt-2 min-h-12 text-sm leading-6 text-zinc-600">{plan.description}</p>
        <div className="mt-7"><p className="h-5 text-xs font-medium text-zinc-500">{plan.yearly === null ? 'Starting at' : yearly ? 'Monthly equivalent, billed yearly' : 'Billed monthly'}</p><p className="mt-1"><span className="text-5xl font-semibold tracking-tight">${(yearly && plan.yearly ? plan.yearly / 12 : plan.monthly).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span><span className="text-sm text-zinc-500"> / month</span></p><p className="mt-2 h-5 text-xs text-zinc-600">{plan.yearly === null ? 'Annual terms tailored to your agreement' : yearly ? `$${plan.yearly.toLocaleString('en-US')} paid annually · save $${(plan.monthly * 12 - plan.yearly).toLocaleString('en-US')}` : 'Annual billing available'}</p></div>
        <div className="my-6 grid gap-2 border-y border-zinc-200 py-5 text-sm font-semibold"><span className="flex items-center gap-2"><Users className="size-4 text-emerald-700" />{plan.publishers}</span><span>{plan.reviews}</span></div>
        <ul className="mb-8 grid gap-3 text-sm text-zinc-700">{plan.features.map(feature => <li key={feature} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-700" />{feature}</li>)}</ul>
        <a className={`mt-auto flex items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-semibold ${index === 1 ? 'bg-emerald-700 text-white hover:bg-emerald-800' : 'bg-zinc-950 text-white hover:bg-zinc-800'}`} href={`mailto:hello@adchecked.com?subject=${encodeURIComponent(`AdChecked ${plan.name} — ${yearly ? 'annual' : 'monthly'} plan`)}`}>{plan.yearly === null ? 'Contact sales' : `Talk to us about ${plan.name}`}<ArrowRight className="size-4" /></a>
      </article>)}</div>
      <p className="mt-6 text-center text-sm text-zinc-600">All prices in USD, before applicable taxes. Plans are activated with our team. No payment is taken on this page.</p>
      <div className="mx-auto mt-16 grid max-w-4xl gap-7 sm:grid-cols-2">{[
        ['What counts as a review?', 'One submitted creative, with its accompanying ad copy, counts as one review against your advertiser’s guidelines. A standalone copy submission or a new revision counts as another review.'],
        ['Do publishers pay separately?', 'No. The advertiser pays for the workspace. Each included publisher team receives its own login and sees only its own submissions and your feedback.'],
        ['What happens at the limit?', 'Your allowance resets on the first day of each calendar month (UTC), including on annual plans. New submissions pause at the limit. Contact us to increase capacity; there are no automatic overage charges.'],
        ['How do public links work?', 'Share one creative or up to 100 selected creatives per link. Anyone with the link can read the selected reviews without signing in. Links expire after 30 days and can be revoked at any time.'],
        ['Can publishers use my guidelines?', 'Yes. Publisher uploads automatically use the guidelines configured for their advertiser. Publishers cannot choose another advertiser or replace those guidelines.'],
        ['Can we connect an existing workflow?', 'Publishers can upload files directly with no integrations to configure. Contact sales about enterprise API access and an agreed rollout.'],
      ].map(([title, text]) => <div key={title}><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-zinc-600">{text}</p></div>)}</div>
    </main>
    {!embedded ? <footer className="border-t px-6 py-8 text-center text-sm text-zinc-500"><a href="mailto:hello@adchecked.com" className="underline underline-offset-4">hello@adchecked.com</a> · AdChecked</footer> : null}
  </div>;
}
