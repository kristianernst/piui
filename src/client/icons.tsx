import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

function Icon({ size = 16, strokeWidth = 1.6, children, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      {children}
    </svg>
  );
}

export const IconCheck = (props: IconProps) => <Icon {...props}><path d="M3.5 8.5 6.5 11.5 12.5 5" /></Icon>;
export const IconChevron = (props: IconProps) => <Icon {...props}><path d="M3.5 6 8 10.5 12.5 6" /></Icon>;
export const IconSearch = (props: IconProps) => <Icon {...props}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 13.5 13.5" /></Icon>;
export const IconChart = (props: IconProps) => <Icon size={18} {...props}><path d="M2 11c1.5 0 2-6 3.5-6S7.5 11 9 11s2-6 3.5-6S14 9 15 9" strokeWidth="1.7" /></Icon>;
export const IconCode = (props: IconProps) => <Icon {...props}><path d="M5.5 5 2.5 8l3 3" /><path d="M10.5 5l3 3-3 3" /></Icon>;
export const IconDatabase = (props: IconProps) => <Icon {...props}><ellipse cx="8" cy="3.5" rx="5" ry="1.8" /><path d="M3 3.5V8c0 1 2.2 1.8 5 1.8S13 9 13 8V3.5" /><path d="M3 8v4.5c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V8" /></Icon>;
export const IconFile = (props: IconProps) => <Icon {...props}><path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" /></Icon>;
export const IconPlus = (props: IconProps) => <Icon {...props}><path d="M8 3v10M3 8h10" /></Icon>;
export const IconArrowUp = (props: IconProps) => <Icon {...props}><path d="M8 12.5v-9M4 7.5l4-4 4 4" /></Icon>;
export const IconStop = (props: IconProps) => <svg width={props.size ?? 12} height={props.size ?? 12} viewBox="0 0 16 16" fill="currentColor" {...props}><rect x="3" y="3" width="10" height="10" rx="2" /></svg>;
export const IconSidebarLeft = (props: IconProps) => <Icon {...props}><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M6 3v10" /></Icon>;
export const IconSidebarRight = (props: IconProps) => <Icon {...props}><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></Icon>;
export const IconFolder = (props: IconProps) => <Icon {...props}><path d="M2 5v7c0 .6.4 1 1 1h10c.6 0 1-.4 1-1V6c0-.6-.4-1-1-1H8L6.5 3.5H3c-.6 0-1 .5-1 1z" /></Icon>;
export const IconSpark = (props: IconProps) => <Icon {...props}><path d="M8 2l1 4.5L13.5 8 9 9.5 8 14 7 9.5 2.5 8 7 6.5z" /></Icon>;
export const IconTerminal = (props: IconProps) => <Icon {...props}><path d="M3 5l3 3-3 3" /><path d="M8 11h5" /></Icon>;
export const IconBolt = (props: IconProps) => <Icon {...props}><path d="M9 2 4 9h4l-1 5 5-7H8z" /></Icon>;
export const IconSettings = (props: IconProps) => <Icon {...props}><circle cx="8" cy="8" r="2" /><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6 3.4 3.4" /></Icon>;
