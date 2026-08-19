import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      {children}
    </svg>
  );
}

const stroke = {
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  strokeWidth: 1.8,
};

export const Icons = {
  arrow: (props: IconProps) => (
    <Icon {...props}><path d="m9 18 6-6-6-6" {...stroke} /></Icon>
  ),
  audit: (props: IconProps) => (
    <Icon {...props}><path d="M12 3 4.5 6v5.1c0 4.7 3.2 8.2 7.5 9.9 4.3-1.7 7.5-5.2 7.5-9.9V6L12 3Z" {...stroke} /><path d="m9.2 12.1 1.8 1.8 3.8-4" {...stroke} /></Icon>
  ),
  bell: (props: IconProps) => (
    <Icon {...props}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" {...stroke} /></Icon>
  ),
  check: (props: IconProps) => (
    <Icon {...props}><path d="m5 12 4 4L19 6" {...stroke} /></Icon>
  ),
  chevronDown: (props: IconProps) => (
    <Icon {...props}><path d="m6 9 6 6 6-6" {...stroke} /></Icon>
  ),
  database: (props: IconProps) => (
    <Icon {...props}><ellipse cx="12" cy="5" rx="8" ry="3" {...stroke} /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" {...stroke} /></Icon>
  ),
  filter: (props: IconProps) => (
    <Icon {...props}><path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h7M15 18h5" {...stroke} /><circle cx="16" cy="6" r="2" {...stroke} /><circle cx="9" cy="12" r="2" {...stroke} /><circle cx="13" cy="18" r="2" {...stroke} /></Icon>
  ),
  home: (props: IconProps) => (
    <Icon {...props}><path d="m3 10 9-7 9 7v10H3V10Z" {...stroke} /><path d="M9 20v-6h6v6" {...stroke} /></Icon>
  ),
  info: (props: IconProps) => (
    <Icon {...props}><circle cx="12" cy="12" r="9" {...stroke} /><path d="M12 11v6M12 7h.01" {...stroke} /></Icon>
  ),
  more: (props: IconProps) => (
    <Icon {...props}><circle cx="12" cy="5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="19" r="1" fill="currentColor" /></Icon>
  ),
  refresh: (props: IconProps) => (
    <Icon {...props}><path d="M20 7v5h-5M4 17v-5h5" {...stroke} /><path d="M6.1 8.2A7 7 0 0 1 18.5 7L20 12M4 12l1.5 5a7 7 0 0 0 12.4-1.2" {...stroke} /></Icon>
  ),
  search: (props: IconProps) => (
    <Icon {...props}><circle cx="11" cy="11" r="7" {...stroke} /><path d="m20 20-4-4" {...stroke} /></Icon>
  ),
  settings: (props: IconProps) => (
    <Icon {...props}><circle cx="12" cy="12" r="3" {...stroke} /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" {...stroke} /></Icon>
  ),
  tasks: (props: IconProps) => (
    <Icon {...props}><circle cx="12" cy="12" r="9" {...stroke} /><path d="m8.5 12 2.2 2.2 4.8-5" {...stroke} /></Icon>
  ),
  users: (props: IconProps) => (
    <Icon {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" {...stroke} /></Icon>
  ),
};
