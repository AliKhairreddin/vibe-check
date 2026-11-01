import type { CreativeText } from '@/lib/api';

export function CreativeTextPanel({ text }: { text?: CreativeText | null }) {
  return <details className="w-full min-w-0 rounded-xl border bg-card p-4">
    <summary className="cursor-pointer text-sm font-semibold">Video script & creative text</summary>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Text extracted from this creative during its review. Transcription and text recognition may contain errors.</p>
    <div className="mt-4 grid gap-4">
      {([
        ['Spoken text / transcript', text?.transcript],
        ['On-screen text', text?.onscreen_text],
        ['Submitted ad copy', text?.ad_copy],
      ] as const).map(([label, value]) => <section key={label} className="min-w-0">
        <h3 className="text-sm font-medium">{label}</h3>
        <p className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-muted-foreground">{value || 'No saved text is available for this section.'}</p>
        {label === 'On-screen text' && text?.onscreen_text_partial ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Only part of the sampled on-screen text could be read.</p> : null}
      </section>)}
    </div>
  </details>;
}
