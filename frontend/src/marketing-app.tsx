import { createRoot, type Root } from 'react-dom/client';
import {
  ArrowRight,
  BadgeCheck,
  Braces,
  Check,
  CheckCircle2,
  CircleAlert,
  FileSearch,
  Gauge,
  Menu,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useState } from 'react';

const CLIENT_LOGIN_URL = 'https://app.adchecked.com/login';
const ADMIN_LOGIN_URL = 'https://admin.adchecked.com/login';
const DEMO_EMAIL_URL = 'mailto:hello@adchecked.com?subject=AdChecked%20demo';

function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 font-semibold tracking-[-0.03em]">
      <span
        className={`relative grid size-8 place-items-center rounded-xl ${inverse ? 'bg-white text-zinc-950' : 'bg-zinc-950 text-white'}`}
      >
        <ScanSearch className="size-4" strokeWidth={2.2} />
        <span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-emerald-500 ring-2 ring-white">
          <Check className="size-2.5 text-white" strokeWidth={3.5} />
        </span>
      </span>
      <span className="text-lg">AdChecked</span>
    </span>
  );
}

function MarketingApp() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen overflow-hidden bg-[#fbfcfa] text-zinc-950">
      <header className="relative z-40 border-b border-zinc-950/6 bg-[#fbfcfa]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 sm:px-8">
          <a href="#top" aria-label="AdChecked home">
            <Brand />
          </a>
          <nav className="hidden items-center gap-8 text-sm font-medium text-zinc-600 md:flex" aria-label="Primary navigation">
            <a className="transition hover:text-zinc-950" href="#product">Product</a>
            <a className="transition hover:text-zinc-950" href="#workflow">How it works</a>
            <a className="transition hover:text-zinc-950" href="#security">Security</a>
          </nav>
          <div className="hidden items-center gap-3 md:flex">
            <a className="rounded-full px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-950/5 hover:text-zinc-950" href={CLIENT_LOGIN_URL}>
              Client sign in
            </a>
            <a className="inline-flex items-center gap-2 rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800" href={DEMO_EMAIL_URL}>
              Request a demo <ArrowRight className="size-4" />
            </a>
          </div>
          <button
            type="button"
            className="grid size-10 place-items-center rounded-full border border-zinc-950/10 bg-white md:hidden"
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
        {menuOpen ? (
          <nav className="grid gap-1 border-t border-zinc-950/6 bg-white p-5 text-sm font-medium md:hidden" aria-label="Mobile navigation">
            <a className="rounded-xl px-3 py-3 hover:bg-zinc-100" href="#product" onClick={() => setMenuOpen(false)}>Product</a>
            <a className="rounded-xl px-3 py-3 hover:bg-zinc-100" href="#workflow" onClick={() => setMenuOpen(false)}>How it works</a>
            <a className="rounded-xl px-3 py-3 hover:bg-zinc-100" href="#security" onClick={() => setMenuOpen(false)}>Security</a>
            <a className="rounded-xl px-3 py-3 hover:bg-zinc-100" href={CLIENT_LOGIN_URL}>Client sign in</a>
            <a className="mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-950 px-4 py-3 text-white" href={DEMO_EMAIL_URL}>
              Request a demo <ArrowRight className="size-4" />
            </a>
          </nav>
        ) : null}
      </header>

      <main id="top">
        <section className="relative isolate px-5 pt-20 pb-18 sm:px-8 sm:pt-28 lg:pt-32">
          <div className="pointer-events-none absolute top-0 left-1/2 -z-10 h-[38rem] w-[70rem] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(circle,rgba(52,211,153,0.16)_0%,rgba(59,130,246,0.07)_40%,transparent_70%)] blur-3xl" />
          <div className="mx-auto grid max-w-7xl items-center gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:gap-12">
            <div className="max-w-2xl">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-800/15 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 shadow-sm">
                <Sparkles className="size-3.5" /> AI-assisted creative compliance
              </div>
              <h1 className="max-w-xl text-balance text-5xl leading-[0.98] font-semibold tracking-[-0.055em] sm:text-6xl lg:text-7xl">
                Catch ad risk before your audience does.
              </h1>
              <p className="mt-7 max-w-xl text-pretty text-lg leading-8 text-zinc-600 sm:text-xl">
                AdChecked reviews video, imagery, audio, on-screen text, and copy against the policies that govern each offer—then gives your team evidence it can act on.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <a className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-zinc-950 px-6 text-sm font-semibold text-white shadow-lg shadow-zinc-950/12 transition hover:-translate-y-0.5 hover:bg-zinc-800" href={DEMO_EMAIL_URL}>
                  Request a demo <ArrowRight className="size-4" />
                </a>
                <a className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-zinc-950/12 bg-white px-6 text-sm font-semibold text-zinc-800 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-950/25" href={CLIENT_LOGIN_URL}>
                  Open client portal
                </a>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-zinc-500">
                <span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-600" /> Offer-specific policies</span>
                <span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-600" /> Human override trail</span>
                <span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-600" /> API-ready</span>
              </div>
            </div>

            <ProductPreview />
          </div>
        </section>

        <section className="border-y border-zinc-950/6 bg-white px-5 py-8 sm:px-8">
          <div className="mx-auto grid max-w-7xl gap-6 text-sm text-zinc-500 sm:grid-cols-2 lg:grid-cols-4">
            <Stat value="Video + image" label="Creative analysis" />
            <Stat value="Audio + OCR" label="Message extraction" />
            <Stat value="Policy evidence" label="Actionable findings" />
            <Stat value="API + live scans" label="Workflow coverage" />
          </div>
        </section>

        <section id="product" className="scroll-mt-20 px-5 py-24 sm:px-8 lg:py-32">
          <div className="mx-auto max-w-7xl">
            <SectionIntro eyebrow="One review surface" title="From raw creative to a defensible decision." description="AdChecked keeps the source, policy match, evidence, and client decision connected—so compliance work does not disappear into screenshots and chat threads." />
            <div className="mt-14 grid gap-5 md:grid-cols-3">
              <Feature icon={<FileSearch />} title="See what the ad says" description="Extract spoken claims, on-screen text, imagery, and copy from a single upload or a Drive selection." />
              <Feature icon={<ShieldCheck />} title="Apply the right policy" description="Evaluate every enabled offer against its own official guidance and approved internal exceptions." />
              <Feature icon={<BadgeCheck />} title="Close the review loop" description="Give each client a scoped approval queue while preserving overrides and reusable policy precedent." />
            </div>
          </div>
        </section>

        <section id="workflow" className="scroll-mt-20 bg-zinc-950 px-5 py-24 text-white sm:px-8 lg:py-32">
          <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-[0.85fr_1.15fr]">
            <SectionIntro inverse eyebrow="How it works" title="Review faster without turning judgment into a black box." description="Automation does the extraction and first pass. Your team keeps the policy, evidence, and final say." />
            <ol className="grid gap-4">
              <WorkflowStep number="01" title="Bring the creative" description="Upload a file, select from Google Drive, submit copy, or connect through the partner API." />
              <WorkflowStep number="02" title="Inspect every signal" description="AdChecked analyzes frames, transcripts, OCR, visual context, and policy language together." />
              <WorkflowStep number="03" title="Share a clear verdict" description="Teams and clients see the finding, exact evidence, severity, and a downloadable report." />
            </ol>
          </div>
        </section>

        <section id="security" className="scroll-mt-20 px-5 py-24 sm:px-8 lg:py-32">
          <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-2">
            <div>
              <SectionIntro eyebrow="Built for controlled access" title="The right workspace for every role." description="The public website, client portal, owner console, and partner API are separated by design, with offer-scoped access and auditable decisions." />
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                <MiniFeature icon={<ShieldCheck />} title="Scoped client portals" />
                <MiniFeature icon={<Braces />} title="Partner API keys" />
                <MiniFeature icon={<Gauge />} title="Usage controls" />
                <MiniFeature icon={<BadgeCheck />} title="Decision history" />
              </div>
            </div>
            <div className="rounded-[2rem] border border-zinc-950/8 bg-white p-3 shadow-2xl shadow-zinc-950/8">
              <div className="rounded-[1.4rem] bg-[#f4f6f3] p-6 sm:p-8">
                <div className="flex items-center justify-between border-b border-zinc-950/8 pb-5">
                  <div>
                    <p className="text-sm font-semibold">Review access</p>
                    <p className="mt-1 text-xs text-zinc-500">Separated by role and workspace</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">Protected</span>
                </div>
                <div className="mt-5 grid gap-3">
                  <AccessRow name="Client portal" detail="Assigned offers only" status="Scoped" />
                  <AccessRow name="Admin console" detail="Owner settings, employee submissions" status="Scoped" />
                  <AccessRow name="Partner API" detail="Key scopes and usage limits" status="Token" />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 pb-24 sm:px-8 lg:pb-32">
          <div className="mx-auto max-w-7xl overflow-hidden rounded-[2.2rem] bg-emerald-400 px-6 py-14 text-zinc-950 shadow-xl shadow-emerald-900/10 sm:px-12 sm:py-16 lg:flex lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-950/65">Private pilots are open</p>
              <h2 className="mt-3 max-w-2xl text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Make compliance part of the creative workflow.</h2>
              <p className="mt-4 max-w-xl text-lg text-emerald-950/70">Tell us what you review today and we’ll map an AdChecked rollout around your policies and clients.</p>
            </div>
            <a className="mt-8 inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-zinc-950 px-6 text-sm font-semibold text-white transition hover:bg-zinc-800 lg:mt-0" href={DEMO_EMAIL_URL}>
              Talk to AdChecked <ArrowRight className="size-4" />
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-950/8 bg-white px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <Brand />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <a className="hover:text-zinc-950" href={CLIENT_LOGIN_URL}>Client sign in</a>
            <a className="hover:text-zinc-950" href={ADMIN_LOGIN_URL}>Admin</a>
            <a className="hover:text-zinc-950" href={DEMO_EMAIL_URL}>Contact</a>
          </div>
          <span>© {new Date().getFullYear()} AdChecked</span>
        </div>
      </footer>
    </div>
  );
}

function ProductPreview() {
  return (
    <div className="relative mx-auto w-full max-w-2xl lg:mx-0">
      <div className="absolute -inset-5 -z-10 rounded-[2.2rem] bg-gradient-to-br from-emerald-300/35 via-white to-blue-300/25 blur-2xl" />
      <div className="overflow-hidden rounded-[1.7rem] border border-zinc-950/10 bg-white shadow-2xl shadow-zinc-950/12">
        <div className="flex items-center justify-between border-b border-zinc-950/8 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-lg bg-zinc-950 text-white"><ScanSearch className="size-4" /></span>
            <div>
              <p className="text-sm font-semibold">Creative review</p>
              <p className="text-[11px] text-zinc-500">Summer campaign · Video + copy</p>
            </div>
          </div>
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">Needs attention</span>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-[0.82fr_1.18fr] sm:p-5">
          <div className="relative min-h-56 overflow-hidden rounded-xl bg-zinc-950 p-4 text-white">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_25%,rgba(52,211,153,0.38),transparent_32%),linear-gradient(155deg,#18181b_0%,#09090b_70%)]" />
            <div className="relative flex h-full flex-col justify-between">
              <span className="w-fit rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-medium backdrop-blur">00:14 evidence frame</span>
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-400">Detected claim</p>
                <p className="mt-2 max-w-44 text-xl leading-tight font-semibold">“Save up to 40% today.”</p>
              </div>
            </div>
          </div>
          <div className="grid content-start gap-3">
            <div className="rounded-xl border border-zinc-950/8 p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700"><CircleAlert className="size-4" /></span>
                <div>
                  <p className="text-sm font-semibold">Savings claim needs support</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">The percentage claim appears in both voiceover and on-screen text without nearby qualification.</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <PreviewMetric value="2" label="Evidence points" />
              <PreviewMetric value="1" label="Policy match" />
            </div>
            <div className="rounded-xl bg-emerald-50 p-4 text-xs leading-5 text-emerald-900">
              <span className="font-semibold">Suggested next step:</span> add the required qualifier or attach substantiation before launch.
            </div>
          </div>
        </div>
      </div>
      <div className="absolute -right-3 -bottom-7 hidden w-48 rounded-2xl border border-zinc-950/10 bg-white p-4 shadow-xl sm:block">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">Client decision</p>
        <div className="mt-3 flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="size-5 text-emerald-600" /> Approved after fix</div>
      </div>
    </div>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-zinc-950/8 p-3"><p className="text-lg font-semibold">{value}</p><p className="mt-0.5 text-[10px] text-zinc-500">{label}</p></div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="text-center lg:text-left"><p className="font-semibold text-zinc-950">{value}</p><p className="mt-1 text-xs">{label}</p></div>;
}

function SectionIntro({ description, eyebrow, inverse = false, title }: { description: string; eyebrow: string; inverse?: boolean; title: string }) {
  return (
    <div className="max-w-2xl">
      <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${inverse ? 'text-emerald-300' : 'text-emerald-700'}`}>{eyebrow}</p>
      <h2 className={`mt-4 text-balance text-4xl leading-tight font-semibold tracking-[-0.045em] sm:text-5xl ${inverse ? 'text-white' : 'text-zinc-950'}`}>{title}</h2>
      <p className={`mt-5 text-pretty text-lg leading-8 ${inverse ? 'text-zinc-400' : 'text-zinc-600'}`}>{description}</p>
    </div>
  );
}

function Feature({ description, icon, title }: { description: string; icon: React.ReactNode; title: string }) {
  return (
    <article className="rounded-[1.6rem] border border-zinc-950/8 bg-white p-7 shadow-sm transition hover:-translate-y-1 hover:shadow-xl hover:shadow-zinc-950/6">
      <span className="grid size-11 place-items-center rounded-xl bg-zinc-950 text-white [&>svg]:size-5">{icon}</span>
      <h3 className="mt-7 text-xl font-semibold tracking-[-0.025em]">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-zinc-600">{description}</p>
    </article>
  );
}

function WorkflowStep({ description, number, title }: { description: string; number: string; title: string }) {
  return (
    <li className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-6 sm:grid-cols-[3rem_1fr] sm:items-start">
      <span className="font-mono text-sm text-emerald-300">{number}</span>
      <div><h3 className="text-xl font-semibold tracking-[-0.02em]">{title}</h3><p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p></div>
    </li>
  );
}

function MiniFeature({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <div className="flex items-center gap-3 rounded-xl border border-zinc-950/8 bg-white p-4 text-sm font-semibold shadow-sm"><span className="text-emerald-700 [&>svg]:size-4">{icon}</span>{title}</div>;
}

function AccessRow({ detail, name, status }: { detail: string; name: string; status: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-white p-4 shadow-sm">
      <div><p className="text-sm font-semibold">{name}</p><p className="mt-1 text-xs text-zinc-500">{detail}</p></div>
      <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[10px] font-semibold text-zinc-600">{status}</span>
    </div>
  );
}

let marketingRoot: Root | undefined;

export function mountMarketingApp(element: HTMLElement) {
  document.title = 'AdChecked · AI-assisted ad compliance review';
  marketingRoot ??= createRoot(element);
  marketingRoot.render(<MarketingApp />);
}
