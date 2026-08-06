import type { HTMLAttributes, ReactNode } from 'react';

type CardProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

export function Card({ children, className = '', ...props }: CardProps) {
  return (
    <section
      className={`rounded-xl border border-border bg-card p-6 shadow-sm ${className}`}
      {...props}
    >
      {children}
    </section>
  );
}
