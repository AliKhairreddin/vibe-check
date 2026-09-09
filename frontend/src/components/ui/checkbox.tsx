import { useEffect, useRef, type ComponentProps } from 'react';
import { Check, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

type CheckboxProps = Omit<ComponentProps<'input'>, 'type' | 'ref'> & {
  indeterminate?: boolean;
};

/** A circular multi-select control with native checkbox and form behavior. */
export function Checkbox({ className, indeterminate = false, ...props }: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className={cn('relative inline-flex size-5 shrink-0 align-middle', className)}>
      <input
        {...props}
        ref={inputRef}
        type="checkbox"
        data-slot="checkbox"
        className="peer m-0 size-full appearance-none rounded-full border border-input bg-background transition-colors checked:border-blue-600 checked:bg-blue-600 indeterminate:border-blue-600 indeterminate:bg-blue-600 enabled:hover:border-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:checked:border-blue-500 dark:checked:bg-blue-500 dark:indeterminate:border-blue-500 dark:indeterminate:bg-blue-500"
      />
      <Check aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto hidden size-3 text-white peer-checked:block peer-indeterminate:hidden peer-disabled:opacity-40" />
      <Minus aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto hidden size-3 text-white peer-indeterminate:block peer-disabled:opacity-40" />
    </span>
  );
}
