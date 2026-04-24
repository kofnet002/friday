import * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', className = '', ...rest }, ref) => {
    const base =
      'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none px-4 py-2';
    const styles =
      variant === 'ghost'
        ? 'bg-transparent hover:bg-neutral-200 dark:hover:bg-neutral-800'
        : 'bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
    return <button ref={ref} className={`${base} ${styles} ${className}`} {...rest} />;
  },
);

Button.displayName = 'Button';
