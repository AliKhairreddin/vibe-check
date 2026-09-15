import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import type { Finding, ReviewEvidenceFrame } from '@/lib/api';

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function SharedFindings({ findings, frames }: { findings: Finding[]; frames: ReviewEvidenceFrame[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  function updateEdges() {
    const element = track.current;
    if (element) setEdges({ start: element.scrollLeft < 2, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 });
  }
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    updateEdges();
    return () => observer.disconnect();
  }, [findings.length]);
  function move(direction: number) {
    const element = track.current;
    const card = element?.firstElementChild as HTMLElement | null;
    if (element && card) element.scrollBy({ left: direction * (card.offsetWidth + 16), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  return <div className="grid min-w-0 gap-5">
    {findings.length ? <section aria-label="Findings" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Findings <span className="font-normal text-muted-foreground">({findings.length})</span></h3>
        <div className="flex gap-2">
          <Button variant="outline" size="icon-sm" aria-label="Previous finding" disabled={edges.start} onClick={() => move(-1)}><ArrowLeft /></Button>
          <Button variant="outline" size="icon-sm" aria-label="Next finding" disabled={edges.end} onClick={() => move(1)}><ArrowRight /></Button>
        </div>
      </div>
      <div ref={track} tabIndex={0} aria-label="Scroll through findings" onScroll={updateEdges} className="flex snap-x snap-mandatory items-start gap-4 overflow-x-auto overscroll-x-contain rounded-xl pb-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {findings.map((finding, index) => <article key={index} className="w-full min-w-0 shrink-0 snap-start rounded-xl border bg-card p-4 sm:w-[26rem]">
          <div className="mb-3 flex flex-wrap items-center gap-2"><span className="mr-auto text-xs font-medium text-muted-foreground">Finding {index + 1} of {findings.length}</span><Badge variant="outline">{finding.severity}</Badge><Badge variant="secondary">{finding.source.replace(/_/g, ' ')}</Badge>{seconds(finding.timestamp_start) !== null ? <Badge variant="outline">{finding.timestamp_start}s</Badge> : null}</div>
          <p className="wrap-anywhere text-sm font-medium leading-6">{finding.evidence}</p>
          <div className="mt-4 grid gap-3 text-sm leading-6">
            <div><p className="font-medium">Why it was flagged</p><p className="wrap-anywhere text-muted-foreground">{finding.policy_reason}</p></div>
            <div className="rounded-lg bg-muted/50 p-3"><p className="font-medium">Suggested fix</p><p className="wrap-anywhere text-muted-foreground">{finding.suggested_fix}</p></div>
          </div>
        </article>)}
      </div>
    </section> : <p className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="size-5" />No policy issues identified.</p>}
    {frames.length ? <section className="min-w-0" aria-label="Evidence frames">
      <h3 className="mb-3 text-sm font-semibold">Evidence frames</h3>
      <div className="flex gap-3 overflow-x-auto pb-2">{frames.map(frame => <figure key={frame.filename} className="w-28 shrink-0"><a href={frame.url} target="_blank" rel="noreferrer"><img alt={`Evidence${seconds(frame.timestamp) !== null ? ` at ${frame.timestamp} seconds` : ' frame'}`} src={frame.url} loading="lazy" className="h-32 w-full rounded-lg border bg-background object-contain" /></a>{seconds(frame.timestamp) !== null ? <figcaption className="mt-1 text-xs text-muted-foreground">{frame.timestamp}s</figcaption> : null}</figure>)}</div>
    </section> : null}
  </div>;
}
