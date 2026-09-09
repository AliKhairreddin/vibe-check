import { useEffect, useRef, useState, type AriaAttributes, type ReactNode } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { selectedControlClassName } from '@/lib/control-styles';

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
};

type SelectProps = AriaAttributes & {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  id?: string;
  name?: string;
  form?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  icon?: ReactNode;
  menuLabel?: string;
  active?: boolean;
};

export function Select({ options, value, defaultValue, onValueChange, id, name, form, required, disabled, className, icon, menuLabel, active = false, ...aria }: SelectProps) {
  const initialValue = defaultValue ?? options[0]?.value ?? '';
  const [localValue, setLocalValue] = useState(initialValue);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Keep native FormData and form.reset() behavior for uncontrolled upload forms.
  useEffect(() => {
    const owner = triggerRef.current?.form;
    if (value !== undefined || !owner) return;
    const reset = () => setLocalValue(initialValue);
    owner.addEventListener('reset', reset);
    return () => owner.removeEventListener('reset', reset);
  }, [value, initialValue, form]);

  return (
    <SelectPrimitive.Root<string>
      items={options}
      value={value ?? localValue}
      onValueChange={next => {
        if (next === null) return;
        if (value === undefined) setLocalValue(next);
        onValueChange?.(next);
      }}
      name={name}
      form={form}
      required={required}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        {...aria}
        id={id}
        ref={triggerRef}
        form={form}
        data-slot="select-trigger"
        data-active={active || undefined}
        className={cn(
          'group/select inline-flex h-9 min-w-0 max-w-full items-center justify-between gap-2.5 rounded-lg border border-input bg-background px-3 text-left text-sm text-foreground shadow-xs outline-none transition-[background-color,border-color,box-shadow] hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 data-popup-open:border-ring data-popup-open:ring-3 data-popup-open:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/20',
          className,
          active && selectedControlClassName,
        )}
      >
        {icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
        <SelectPrimitive.Value className="min-w-0 flex-1 truncate" />
        <SelectPrimitive.Icon className="shrink-0 text-muted-foreground transition-transform duration-150 group-data-popup-open/select:rotate-180"><ChevronDown className="size-3.5" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={6} align="start" alignItemWithTrigger={false} className="z-[100] max-w-[calc(100vw-1rem)] outline-none">
          <SelectPrimitive.Popup
            data-slot="select-popup"
            className="min-w-[max(var(--anchor-width),11rem)] max-w-[min(24rem,calc(100vw-1rem))] origin-(--transform-origin) overflow-hidden rounded-xl border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/10 outline-none transition-[opacity,transform] duration-150 data-starting-style:translate-y-1 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none dark:shadow-black/30"
          >
            {menuLabel ? <p className="px-2.5 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{menuLabel}</p> : null}
            <SelectPrimitive.List className="max-h-[min(20rem,calc(var(--available-height)-3rem))] overflow-y-auto overscroll-contain outline-none">
              {options.map(option => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="group/item relative flex min-h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg py-2 pr-9 pl-2.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:bg-muted/70 data-selected:font-medium data-disabled:pointer-events-none data-disabled:opacity-40"
                >
                  {option.icon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{option.icon}</span> : null}
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 break-words">{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex size-4 items-center justify-center"><Check className="size-3.5" strokeWidth={2.5} /></SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
