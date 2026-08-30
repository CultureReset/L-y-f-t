/**
 * Theme context. Follows the device colour scheme by default, and can be
 * overridden per app or per screen.
 */

import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, type Theme } from './tokens.js';

const ThemeContext = createContext<Theme>(lightTheme);

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Force a scheme; omit to follow the device. */
  readonly scheme?: 'light' | 'dark';
  /** Replace the themes entirely, for a custom brand. */
  readonly themes?: { light: Theme; dark: Theme };
}

export const ThemeProvider = ({
  children,
  scheme,
  themes,
}: ThemeProviderProps): React.JSX.Element => {
  const deviceScheme = useColorScheme();
  const resolved = scheme ?? (deviceScheme === 'dark' ? 'dark' : 'light');

  const theme = useMemo(() => {
    const pair = themes ?? { light: lightTheme, dark: darkTheme };
    return resolved === 'dark' ? pair.dark : pair.light;
  }, [resolved, themes]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): Theme => useContext(ThemeContext);

/**
 * Build styles from the theme, memoised per theme so a re-render does not
 * rebuild a StyleSheet.
 */
export const useThemedStyles = <T,>(factory: (theme: Theme) => T): T => {
  const theme = useTheme();
  return useMemo(() => factory(theme), [theme, factory]);
};
