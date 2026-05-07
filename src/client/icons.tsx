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
  CloseCircle,
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

export const IconPlus = bold(AddCircle);
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
export const IconClose = bold(CloseCircle);
export const IconExpand = bold(MaximizeSquareMinimalistic);
