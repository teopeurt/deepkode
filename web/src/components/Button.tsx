// Responsibility: Button —— five variants: fill (primary) / plain / quiet / icon / mini (the prototype's .btn system).
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'plain' | 'quiet' | 'icon' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  mini?: boolean;
  children?: ReactNode;
}

export function Button({ variant, mini, className = '', children, ...rest }: ButtonProps) {
  const cls = ['btn', variant === 'primary' ? 'primary' : variant === 'plain' ? 'plain' : variant === 'quiet' ? 'quiet' : variant === 'icon' ? 'icon' : variant === 'ghost' ? 'ghost' : '', mini ? 'mini' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
