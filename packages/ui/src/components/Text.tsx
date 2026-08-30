/**
 * Typography primitive. Every string in both apps renders through this, so a
 * type-ramp change lands everywhere at once.
 */

import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';
import type { TypographyKey } from '../theme/tokens.js';

export interface TextProps extends RNTextProps {
  readonly variant?: TypographyKey;
  readonly color?: 'default' | 'secondary' | 'muted' | 'inverse' | 'primary' | 'danger' | 'success';
  readonly align?: TextStyle['textAlign'];
  readonly weight?: TextStyle['fontWeight'];
}

export const Text = ({
  variant = 'body',
  color = 'default',
  align,
  weight,
  style,
  ...rest
}: TextProps): React.JSX.Element => {
  const theme = useTheme();

  const palette: Record<NonNullable<TextProps['color']>, string> = {
    default: theme.colors.text,
    secondary: theme.colors.textSecondary,
    muted: theme.colors.textMuted,
    inverse: theme.colors.textInverse,
    primary: theme.colors.primary,
    danger: theme.colors.danger,
    success: theme.colors.success,
  };

  return (
    <RNText
      {...rest}
      style={[
        theme.typography[variant],
        { color: palette[color] },
        align ? { textAlign: align } : null,
        weight ? { fontWeight: weight } : null,
        style,
      ]}
    />
  );
};
