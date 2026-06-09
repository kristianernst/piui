import type { ComponentProps } from "react";
import {
  AddCircle,
  AltArrowDown,
  Bolt,
  ChatRoundDots,
  CheckCircle,
  Chart,
  Code,
  CodeSquare,
  Database,
  Document,
  Folder,
  Magnifer,
  MaximizeSquareMinimalistic,
  Moon,
  Pen2,
  RoundArrowUp,
  Settings,
  SidebarMinimalistic,
  Stars,
  Stop,
  StopCircle,
  Sun,
} from "@solar-icons/react";

// All icons are sourced from `@solar-icons/react` with `weight="Bold"` (filled)
// to keep a consistent visual register. Call sites import these stable aliases
// so swapping the underlying icon is a one-line change in this file.

type AnyIcon = typeof AddCircle;
type SolarProps = ComponentProps<AnyIcon>;
export type IconProps = Omit<SolarProps, "weight">;

const bold =
  (Component: AnyIcon) =>
  (props: IconProps) => <Component weight="Bold" {...props} />;

export const IconCheck = bold(CheckCircle);
export const IconArrowUp = bold(RoundArrowUp);
export const IconStop = bold(Stop);
export const IconStopCircle = bold(StopCircle);
export const IconChev = bold(AltArrowDown);
export const IconSearch = bold(Magnifer);
export const IconFolder = bold(Folder);
export const IconChat = bold(ChatRoundDots);
export const IconSettings = bold(Settings);
export const IconSidebarLeft = (props: IconProps) => <SidebarMinimalistic weight="Bold" {...props} />;
export const IconSidebarRight = (props: IconProps) => <SidebarMinimalistic weight="Bold" mirrored {...props} />;
export const IconCode = bold(Code);
export const IconTerminal = bold(CodeSquare);
export const IconFile = bold(Document);
export const IconDb = bold(Database);
export const IconChart = bold(Chart);
export const IconSpark = bold(Stars);
export const IconBolt = bold(Bolt);
export const IconDiff = bold(Pen2);
export const IconSun = bold(Sun);
export const IconMoon = bold(Moon);
export const IconExpand = bold(MaximizeSquareMinimalistic);

// Plain, hairline glyphs (no circle background, no Bold weight). These are
// the canonical add / close / send / etc. — call sites just use IconPlus and
// IconClose; the *Slim aliases exist for places that want to be explicit.
type SlimProps = { size?: number | string; className?: string; title?: string };

const slimSvgProps = (size: number | string, className?: string, title?: string) => ({
  xmlns: "http://www.w3.org/2000/svg",
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": title ? undefined : true,
  role: title ? "img" : undefined,
});

export const IconPlus = ({ size = 14, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconClose = ({ size = 14, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconArrowUpSlim = ({ size = 16, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const IconArrowLeftSlim = ({ size = 16, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

// Git branch — two nodes on the left rail and a single branch arc forking off
// to a third node on the right. The hairline weight matches IconPlus/IconClose
// so this lives next to monospaced text without overpowering it.
export const IconBranch = ({ size = 14, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="9" r="2" />
    <path d="M6 7v10" />
    <path d="M18 11c0 4-4 4-6 4s-6 0-6 2" />
  </svg>
);

export const IconCopy = ({ size = 14, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

export const IconEdit = ({ size = 14, className, title }: SlimProps) => (
  <svg {...slimSvgProps(size, className, title)}>
    {title ? <title>{title}</title> : null}
    <path d="M14.5 4.5l5 5M4 20l4-1 11-11-4-4L4 15v5z" />
  </svg>
);

// Aliases — preferred for places that want to be explicit about the slim look.
export const IconPlusSlim = IconPlus;
export const IconCloseSlim = IconClose;
