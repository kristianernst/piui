// Hand-drawn lucide-style icons. Stroke 1.5, 16px viewbox.
const Icon = ({ d, size = 16, fill = 'none', stroke = 'currentColor', strokeWidth = 1.5, children, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth={strokeWidth}
       strokeLinecap="round" strokeLinejoin="round" {...props}>
    {d ? <path d={d} /> : children}
  </svg>
);

const IconCheck = (p) => <Icon d="M3.5 8.5 L6.5 11.5 L12.5 5" {...p} />;
const IconChev = (p) => <Icon d="M3.5 6 L8 10.5 L12.5 6" {...p} />;
const IconChevR = (p) => <Icon d="M6 3.5 L10.5 8 L6 12.5" {...p} />;
const IconSearch = (p) => <Icon size={13} {...p}>
  <circle cx="7" cy="7" r="4.5" />
  <path d="M10.5 10.5 L13.5 13.5" />
</Icon>;
const IconChart = (p) => <Icon size={18} {...p}>
  <path d="M2 11 C 3.5 11, 4 5, 5.5 5 S 7.5 11, 9 11 S 11 5, 12.5 5 S 14 9, 15 9" strokeWidth="1.7" />
</Icon>;
const IconDoc = (p) => <Icon {...p}>
  <path d="M4 2 H10 L13 5 V14 H4 Z" />
  <path d="M10 2 V5 H13" />
</Icon>;
const IconCode = (p) => <Icon {...p}>
  <path d="M5.5 5 L2.5 8 L5.5 11" />
  <path d="M10.5 5 L13.5 8 L10.5 11" />
</Icon>;
const IconDb = (p) => <Icon {...p}>
  <ellipse cx="8" cy="3.5" rx="5" ry="1.8" />
  <path d="M3 3.5 V8 C3 9, 5.2 9.8, 8 9.8 S13 9, 13 8 V3.5" />
  <path d="M3 8 V12.5 C3 13.5, 5.2 14.3, 8 14.3 S13 13.5, 13 12.5 V8" />
</Icon>;
const IconWeb = (p) => <Icon {...p}>
  <circle cx="8" cy="8" r="5.5" />
  <path d="M2.5 8 H13.5" />
  <path d="M8 2.5 C 10 4.5, 10 11.5, 8 13.5 C 6 11.5, 6 4.5, 8 2.5" />
</Icon>;
const IconPlus = (p) => <Icon d="M8 3 V13 M3 8 H13" {...p} />;
const IconAttach = (p) => <Icon {...p}>
  <path d="M11 5 L5.5 10.5 C4.5 11.5, 4.5 13, 5.5 14 C 6.5 15, 8 15, 9 14 L13 10 C 14.5 8.5, 14.5 6, 13 4.5 C 11.5 3, 9 3, 7.5 4.5 L 3 9" />
</Icon>;
const IconMic = (p) => <Icon {...p}>
  <rect x="6" y="2" width="4" height="8" rx="2" />
  <path d="M3.5 8 C3.5 11, 5.5 12.5, 8 12.5 S 12.5 11, 12.5 8" />
  <path d="M8 12.5 V14.5" />
</Icon>;
const IconArrowUp = (p) => <Icon d="M8 12.5 V3.5 M4 7.5 L8 3.5 L12 7.5" {...p} />;
const IconSparkle = (p) => <Icon {...p}>
  <path d="M8 2 L9 6.5 L13.5 8 L9 9.5 L8 14 L7 9.5 L2.5 8 L7 6.5 Z" />
</Icon>;
const IconStop = (p) => <Icon size={12} stroke="none" fill="currentColor" {...p}>
  <rect x="3" y="3" width="10" height="10" rx="2" />
</Icon>;
const IconSidebarL = (p) => <Icon {...p}>
  <rect x="2" y="3" width="12" height="10" rx="2" />
  <path d="M6 3 V13" />
</Icon>;
const IconSidebarR = (p) => <Icon {...p}>
  <rect x="2" y="3" width="12" height="10" rx="2" />
  <path d="M10 3 V13" />
</Icon>;
const IconFolder = (p) => <Icon {...p}>
  <path d="M2 5 V12 C2 12.6, 2.4 13, 3 13 H13 C13.6 13, 14 12.6, 14 12 V6 C14 5.4, 13.6 5, 13 5 H8 L6.5 3.5 H3 C2.4 3.5, 2 4, 2 4.5 Z" />
</Icon>;
const IconChat = (p) => <Icon {...p}>
  <path d="M3 4 H13 C13.6 4, 14 4.4, 14 5 V10 C14 10.6, 13.6 11, 13 11 H7 L4 13.5 V11 H3 C2.4 11, 2 10.6, 2 10 V5 C 2 4.4, 2.4 4, 3 4 Z" />
</Icon>;
const IconSettings = (p) => <Icon {...p}>
  <circle cx="8" cy="8" r="2" />
  <path d="M8 1.5 V3 M8 13 V14.5 M14.5 8 H13 M3 8 H1.5 M12.6 3.4 L11.5 4.5 M4.5 11.5 L3.4 12.6 M12.6 12.6 L11.5 11.5 M4.5 4.5 L3.4 3.4" />
</Icon>;
const IconUser = (p) => <Icon {...p}>
  <circle cx="8" cy="6" r="2.5" />
  <path d="M3 13.5 C 3.5 11, 5.5 9.5, 8 9.5 S 12.5 11, 13 13.5" />
</Icon>;
const IconFile = (p) => <Icon {...p}>
  <path d="M4 2 H10 L13 5 V14 H4 Z" />
  <path d="M10 2 V5 H13" />
</Icon>;
const IconImage = (p) => <Icon {...p}>
  <rect x="2" y="3" width="12" height="10" rx="1.5" />
  <circle cx="6" cy="7" r="1.2" />
  <path d="M3 12 L6.5 8.5 L9 11 L11 9 L13 11" />
</Icon>;
const IconBolt = (p) => <Icon {...p}>
  <path d="M9 2 L4 9 H8 L7 14 L12 7 H8 Z" />
</Icon>;
const IconChartArt = (p) => <Icon {...p}>
  <rect x="2" y="3" width="12" height="10" rx="1.5" />
  <path d="M4 10 C 5 10, 5.5 6, 7 6 S 8.5 10, 10 10 S 11.5 7, 12 7" />
</Icon>;
const IconDots = (p) => <Icon {...p}>
  <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
  <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
  <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
</Icon>;
// Mode icons
const IconYolo = (p) => <Icon {...p}>
  <path d="M9 1.5 L3.5 9 H7.5 L6.5 14.5 L12.5 7 H8.5 Z" />
</Icon>;
const IconAuto = (p) => <Icon {...p}>
  <circle cx="8" cy="8" r="5.5" />
  <path d="M5 8 L7 10 L11 6" />
</Icon>;
const IconAsk = (p) => <Icon {...p}>
  <path d="M5.5 6 C5.5 4, 7 3, 8 3 C9.5 3, 10.8 4, 10.8 5.5 C10.8 7, 9.5 7.5, 8 8.5 V10" />
  <circle cx="8" cy="12.5" r="0.6" fill="currentColor" stroke="none" />
</Icon>;
const IconMaximize = (p) => <Icon {...p}>
  <path d="M3 6 V3 H6 M10 3 H13 V6 M13 10 V13 H10 M6 13 H3 V10" />
</Icon>;

Object.assign(window, {
  Icon, IconCheck, IconChev, IconChevR, IconSearch, IconChart,
  IconDoc, IconCode, IconDb, IconWeb, IconPlus, IconAttach,
  IconMic, IconArrowUp, IconSparkle, IconStop,
  IconSidebarL, IconSidebarR, IconFolder, IconChat, IconSettings,
  IconUser, IconFile, IconImage, IconBolt, IconChartArt, IconDots,
  IconYolo, IconAuto, IconAsk, IconMaximize
});
