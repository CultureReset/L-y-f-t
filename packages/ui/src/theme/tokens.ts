/**
 * Design tokens.
 *
 * Every colour, space, radius, and type ramp in both apps resolves to a token
 * here. Rebranding the platform — or supporting a second brand in the same
 * binary — means supplying a different token set, not touching a component.
 */

export interface ColorScale {
  readonly 50: string;
  readonly 100: string;
  readonly 200: string;
  readonly 300: string;
  readonly 400: string;
  readonly 500: string;
  readonly 600: string;
  readonly 700: string;
  readonly 800: string;
  readonly 900: string;
}

export interface ThemeColors {
  /** App background, behind everything. */
  readonly background: string;
  /** Cards, sheets, and raised surfaces. */
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceSunken: string;
  readonly border: string;
  readonly borderStrong: string;

  readonly text: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly textInverse: string;

  readonly primary: string;
  readonly primaryPressed: string;
  readonly primaryMuted: string;
  readonly onPrimary: string;

  readonly accent: string;
  readonly onAccent: string;

  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly onDanger: string;

  /** Map-specific colours. */
  readonly mapBackground: string;
  readonly mapRoad: string;
  readonly mapWater: string;
  readonly mapPark: string;
  readonly routeLine: string;
  readonly routeLineMuted: string;
  readonly pickupPin: string;
  readonly dropoffPin: string;
  readonly carMarker: string;

  readonly overlay: string;
  readonly skeleton: string;
}

/** The brand ramp. Swap this to rebrand. */
export const BRAND: ColorScale = {
  50: '#F5EBFF',
  100: '#E9D5FF',
  200: '#D8B4FE',
  300: '#C084FC',
  400: '#A855F7',
  500: '#8B2FD6',
  600: '#7423B4',
  700: '#5D1C90',
  800: '#46156D',
  900: '#2F0E49',
};

const NEUTRAL: ColorScale = {
  50: '#FAFAFA',
  100: '#F4F4F5',
  200: '#E4E4E7',
  300: '#D4D4D8',
  400: '#A1A1AA',
  500: '#71717A',
  600: '#52525B',
  700: '#3F3F46',
  800: '#27272A',
  900: '#18181B',
};

export const lightColors: ThemeColors = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: NEUTRAL[100],
  border: NEUTRAL[200],
  borderStrong: NEUTRAL[300],

  text: NEUTRAL[900],
  textSecondary: NEUTRAL[600],
  textMuted: NEUTRAL[500],
  textInverse: '#FFFFFF',

  primary: BRAND[500],
  primaryPressed: BRAND[600],
  primaryMuted: BRAND[50],
  onPrimary: '#FFFFFF',

  accent: '#0B7285',
  onAccent: '#FFFFFF',

  success: '#12805C',
  warning: '#B45309',
  danger: '#C2255C',
  onDanger: '#FFFFFF',

  mapBackground: '#EDEDF2',
  mapRoad: '#FFFFFF',
  mapWater: '#C5DCF0',
  mapPark: '#D6E8D0',
  routeLine: BRAND[500],
  routeLineMuted: NEUTRAL[300],
  pickupPin: '#12805C',
  dropoffPin: NEUTRAL[900],
  carMarker: NEUTRAL[900],

  overlay: 'rgba(24,24,27,0.45)',
  skeleton: NEUTRAL[200],
};

export const darkColors: ThemeColors = {
  background: '#0C0C0F',
  surface: '#17171B',
  surfaceRaised: '#1F1F24',
  surfaceSunken: '#101014',
  border: '#2A2A31',
  borderStrong: '#3A3A43',

  text: '#F7F7F8',
  textSecondary: '#A9A9B4',
  textMuted: '#77777F',
  textInverse: '#0C0C0F',

  primary: BRAND[400],
  primaryPressed: BRAND[300],
  primaryMuted: '#241534',
  onPrimary: '#0C0C0F',

  accent: '#22B8CF',
  onAccent: '#0C0C0F',

  success: '#3DD68C',
  warning: '#F5A524',
  danger: '#F06595',
  onDanger: '#0C0C0F',

  mapBackground: '#15151A',
  mapRoad: '#2A2A32',
  mapWater: '#16293D',
  mapPark: '#1B2A1E',
  routeLine: BRAND[300],
  routeLineMuted: '#3A3A43',
  pickupPin: '#3DD68C',
  dropoffPin: '#F7F7F8',
  carMarker: '#F7F7F8',

  overlay: 'rgba(0,0,0,0.6)',
  skeleton: '#26262D',
};

/** A 4pt spacing scale. */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export type SpacingKey = keyof typeof spacing;

export const radius = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/**
 * The type ramp.
 *
 * Typed explicitly rather than with `as const`: a const assertion freezes
 * `fontVariant` into a readonly tuple, which React Native's TextStyle rejects.
 */
export type FontVariantOption =
  | 'tabular-nums'
  | 'lining-nums'
  | 'oldstyle-nums'
  | 'proportional-nums';

export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: '300' | '400' | '500' | '600' | '700' | '800';
  letterSpacing?: number;
  fontVariant?: FontVariantOption[];
}

export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.5 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.3 },
  heading: { fontSize: 19, lineHeight: 25, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 23, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  caption: { fontSize: 14, lineHeight: 19, fontWeight: '400' },
  captionStrong: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.4 },
  /** Tabular figures for money and countdowns, so digits do not jitter. */
  mono: { fontSize: 16, lineHeight: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
} satisfies Record<string, TypeStyle>;

export type TypographyKey = keyof typeof typography;

export const elevation = {
  none: {},
  low: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  medium: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  high: {
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} as const;

export const duration = {
  instant: 90,
  fast: 160,
  normal: 240,
  slow: 400,
} as const;

export interface Theme {
  readonly scheme: 'light' | 'dark';
  readonly colors: ThemeColors;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  readonly elevation: typeof elevation;
  readonly duration: typeof duration;
}

export const lightTheme: Theme = {
  scheme: 'light',
  colors: lightColors,
  spacing,
  radius,
  typography,
  elevation,
  duration,
};

export const darkTheme: Theme = {
  scheme: 'dark',
  colors: darkColors,
  spacing,
  radius,
  typography,
  elevation,
  duration,
};

/** Build a themed pair from a custom colour ramp. */
export const createTheme = (overrides: {
  light?: Partial<ThemeColors>;
  dark?: Partial<ThemeColors>;
}): { light: Theme; dark: Theme } => ({
  light: { ...lightTheme, colors: { ...lightColors, ...overrides.light } },
  dark: { ...darkTheme, colors: { ...darkColors, ...overrides.dark } },
});
