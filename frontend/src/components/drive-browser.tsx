import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  ChevronRight,
  ExternalLink,
  FileImage,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { browseDriveFolder, type DriveBrowserItem, type DriveFolder } from '@/lib/api';
import { cn } from '@/lib/utils';

export type DriveBrowserProps = {
  selectedFolderIds: Set<string>;
  selectedFileIds: Set<string>;
  onSelectionChange: (folders: Set<string>, files: Set<string>) => void;
};

export function DriveBrowser({
  selectedFolderIds,
  selectedFileIds,
  onSelectionChange,
}: DriveBrowserProps) {
  const [folderPath, setFolderPath] = useState<DriveFolder[]>([]);
  const [search, setSearch] = useState('');
  const searchId = useId();
  const currentFolderId = folderPath[folderPath.length - 1]?.folder_id;

  const folderQuery = useQuery({
    queryKey: ['drive', 'browse', currentFolderId ?? 'root'],
    queryFn: () => browseDriveFolder(currentFolderId),
    staleTime: 60_000,
  });

  const visiblePath = folderPath.length
    ? folderPath
    : folderQuery.data
      ? [folderQuery.data.current_folder]
      : [];
  const selectedAncestor = visiblePath.find((folder) => selectedFolderIds.has(folder.folder_id));
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return [...(folderQuery.data?.items ?? [])]
      .filter((item) => !query || item.name.toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
      });
  }, [folderQuery.data?.items, search]);

  function toggleFolder(folderId: string) {
    const folders = new Set(selectedFolderIds);
    if (folders.has(folderId)) folders.delete(folderId);
    else folders.add(folderId);
    onSelectionChange(folders, new Set(selectedFileIds));
  }

  function toggleFile(fileId: string) {
    const files = new Set(selectedFileIds);
    if (files.has(fileId)) files.delete(fileId);
    else files.add(fileId);
    onSelectionChange(new Set(selectedFolderIds), files);
  }

  function openFolder(item: DriveBrowserItem) {
    const basePath = folderPath.length
      ? folderPath
      : folderQuery.data
        ? [folderQuery.data.current_folder]
        : [];
    setFolderPath([
      ...basePath,
      {
        folder_id: item.file_id,
        name: item.name,
        web_view_link: item.web_view_link,
      },
    ]);
    setSearch('');
  }

  function openBreadcrumb(index: number) {
    setFolderPath(visiblePath.slice(0, index + 1));
    setSearch('');
  }

  function clearSelection() {
    onSelectionChange(new Set(), new Set());
  }

  const selectedCount = selectedFolderIds.size + selectedFileIds.size;
  const selectionLabel = [
    selectedFolderIds.size ? `${selectedFolderIds.size} ${pluralize('folder', selectedFolderIds.size)}` : '',
    selectedFileIds.size ? `${selectedFileIds.size} ${pluralize('file', selectedFileIds.size)}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <section
      className="grid gap-3 rounded-lg border bg-muted/10 p-3"
      aria-label="Google Drive folder browser"
      aria-busy={folderQuery.isLoading || folderQuery.isFetching}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Current Google Drive path">
          {visiblePath.length ? (
            <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Google Drive breadcrumbs">
              {visiblePath.map((folder, index) => {
                const isCurrent = index === visiblePath.length - 1;
                return (
                  <span key={folder.folder_id} className="flex min-w-0 items-center gap-1">
                    {index ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
                    <Button
                      type="button"
                      size="xs"
                      variant={isCurrent ? 'secondary' : 'ghost'}
                      aria-current={isCurrent ? 'page' : undefined}
                      disabled={isCurrent}
                      onClick={() => openBreadcrumb(index)}
                      className="max-w-44"
                    >
                      {index ? <Folder /> : <FolderOpen />}
                      <span className="truncate">{folder.name}</span>
                    </Button>
                  </span>
                );
              })}
            </nav>
          ) : (
            <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <FolderOpen className="size-4" />
              Google Drive
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selectedCount ? <Badge variant="outline">{selectionLabel} selected</Badge> : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!selectedCount}
            onClick={clearSelection}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="relative">
        <Label htmlFor={searchId} className="sr-only">Search this Google Drive folder</Label>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id={searchId}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          className="pl-8"
          placeholder="Search this folder"
          autoComplete="off"
        />
      </div>

      {selectedAncestor ? (
        <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
          Everything in <span className="font-medium text-foreground">{selectedAncestor.name}</span> is included through the selected folder.
        </p>
      ) : null}

      {folderQuery.isLoading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Loading this Drive folder…
        </div>
      ) : folderQuery.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load this Drive folder</AlertTitle>
          <AlertDescription>{errorMessage(folderQuery.error)}</AlertDescription>
          <AlertAction>
            <Button type="button" size="xs" variant="outline" onClick={() => void folderQuery.refetch()}>
              <RefreshCw />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : visibleItems.length ? (
        <div className="grid max-h-80 gap-1 overflow-y-auto pr-1" aria-label="Items in this Google Drive folder">
          {visibleItems.map((item) => item.kind === 'folder' ? (
            <FolderRow
              key={item.file_id}
              item={item}
              selected={selectedFolderIds.has(item.file_id)}
              onToggle={() => toggleFolder(item.file_id)}
              onOpen={() => openFolder(item)}
            />
          ) : (
            <FileRow
              key={item.file_id}
              item={item}
              selected={selectedFileIds.has(item.file_id)}
              includedByFolder={Boolean(selectedAncestor)}
              onToggle={() => toggleFile(item.file_id)}
            />
          ))}
        </div>
      ) : (
        <div className="grid min-h-32 place-items-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          <div className="grid gap-1">
            <FolderOpen className="mx-auto size-5" aria-hidden="true" />
            <p>{search ? 'No folders or creatives match this search.' : 'This folder has no supported creatives or subfolders.'}</p>
          </div>
        </div>
      )}

      <p className="text-xs leading-5 text-muted-foreground">
        Use the checkbox to include an entire folder, or open it to choose individual files.
        {folderQuery.data ? ` Up to ${folderQuery.data.max_selection} creatives can be reviewed per submission.` : ''}
      </p>
    </section>
  );
}

function FolderRow({
  item,
  selected,
  onToggle,
  onOpen,
}: {
  item: DriveBrowserItem;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className={cn(
      'flex items-center gap-1 rounded-lg border bg-background transition-colors',
      selected && 'border-primary/50 bg-primary/5'
    )}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? 'Remove' : 'Select'} entire folder ${item.name}`}
        className="ml-2 grid size-6 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onToggle}
      >
        <SelectionBox selected={selected} />
      </button>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`Open folder ${item.name}`}
        onClick={onOpen}
      >
        <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.name}</span>
          <span className="block text-xs text-muted-foreground">Open to choose individual files</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <ExternalDriveLink item={item} />
    </div>
  );
}

function FileRow({
  item,
  selected,
  includedByFolder,
  onToggle,
}: {
  item: DriveBrowserItem;
  selected: boolean;
  includedByFolder: boolean;
  onToggle: () => void;
}) {
  const disabled = !item.selectable;
  const effectiveSelected = selected || includedByFolder;
  const detail = disabled
    ? item.disabled_reason || 'This file cannot be selected'
    : [formatBytes(item.size), formatDriveDate(item.modified_time)].filter(Boolean).join(' · ');

  return (
    <div className={cn(
      'flex items-center gap-1 rounded-lg border bg-background transition-colors',
      effectiveSelected && !disabled && 'border-primary/50 bg-primary/5',
      disabled && 'bg-muted/30 text-muted-foreground'
    )}>
      <button
        type="button"
        disabled={disabled || includedByFolder}
        aria-pressed={effectiveSelected}
        aria-label={disabled
          ? `${item.name} cannot be selected: ${detail}`
          : includedByFolder
            ? `${item.name} is included through a selected folder`
            : `${selected ? 'Remove' : 'Select'} file ${item.name}`}
        title={disabled ? detail : includedByFolder ? 'Included through a selected folder' : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-70"
        onClick={onToggle}
      >
        <SelectionBox selected={effectiveSelected && !disabled} disabled={disabled} />
        <FileImage className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.name}</span>
          <span className={cn('block text-xs text-muted-foreground', disabled && 'text-destructive')}>
            {detail || 'Size unavailable'}
          </span>
        </span>
      </button>
      <ExternalDriveLink item={item} />
    </div>
  );
}

function SelectionBox({ selected, disabled = false }: { selected: boolean; disabled?: boolean }) {
  return (
    <span className={cn(
      'grid size-5 shrink-0 place-items-center rounded border',
      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
      disabled && 'bg-muted'
    )} aria-hidden="true">
      {selected ? <Check className="size-3.5" /> : disabled ? <AlertCircle className="size-3" /> : null}
    </span>
  );
}

function ExternalDriveLink({ item }: { item: DriveBrowserItem }) {
  return (
    <a
      href={item.web_view_link}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${item.name} in Google Drive`}
      className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'mr-1')}
    >
      <ExternalLink />
    </a>
  );
}

function formatBytes(value?: number | null) {
  if (value === undefined || value === null) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDriveDate(value?: string | null) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
