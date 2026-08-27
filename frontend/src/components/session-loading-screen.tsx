import { LoaderCircle, ScanSearch } from 'lucide-react';

export function SessionLoadingScreen() {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className="grid min-h-screen place-items-center bg-muted/30 p-4 text-foreground"
    >
      <div className="grid justify-items-center gap-4 text-center" role="status">
        <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <ScanSearch className="size-5" strokeWidth={2.2} />
        </span>
        <div className="grid justify-items-center gap-2">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Checking your session…</p>
        </div>
      </div>
    </main>
  );
}
