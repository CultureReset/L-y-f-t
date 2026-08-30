/**
 * Layout primitives: Card, Sheet, Row, Divider, Spacer.
 *
 * `Sheet` is the bottom sheet both apps are built around — the rider's ride
 * flow and the driver's offer card all live in one.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';
import type { SpacingKey } from '../theme/tokens.js';

export interface CardProps extends ViewProps {
  readonly padded?: boolean | SpacingKey;
  readonly elevated?: 'none' | 'low' | 'medium' | 'high';
  readonly bordered?: boolean;
  readonly children?: ReactNode;
}

export const Card = ({
  padded = true,
  elevated = 'none',
  bordered = true,
  style,
  children,
  ...rest
}: CardProps): React.JSX.Element => {
  const theme = useTheme();
  const padding =
    padded === true ? theme.spacing.lg : padded === false ? 0 : theme.spacing[padded];

  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          padding,
          borderWidth: bordered ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.colors.border,
        },
        theme.elevation[elevated],
        style,
      ]}
    >
      {children}
    </View>
  );
};

export interface SheetProps extends ViewProps {
  readonly children?: ReactNode;
  /** Show the drag handle. */
  readonly handle?: boolean;
}

/**
 * A bottom sheet surface. Anchored to the bottom of the screen with the map
 * behind it — the layout both apps use for essentially every screen.
 */
export const Sheet = ({
  children,
  handle = true,
  style,
  ...rest
}: SheetProps): React.JSX.Element => {
  const theme = useTheme();
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingHorizontal: theme.spacing.lg,
          paddingTop: handle ? theme.spacing.sm : theme.spacing.lg,
          paddingBottom: theme.spacing.xl,
        },
        theme.elevation.high,
        style,
      ]}
    >
      {handle ? (
        <View
          style={{
            alignSelf: 'center',
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.borderStrong,
            marginBottom: theme.spacing.md,
          }}
        />
      ) : null}
      {children}
    </View>
  );
};

export interface RowProps extends ViewProps {
  readonly gap?: SpacingKey;
  readonly align?: ViewStyle['alignItems'];
  readonly justify?: ViewStyle['justifyContent'];
  readonly wrap?: boolean;
  readonly children?: ReactNode;
}

export const Row = ({
  gap = 'sm',
  align = 'center',
  justify = 'flex-start',
  wrap = false,
  style,
  children,
  ...rest
}: RowProps): React.JSX.Element => {
  const theme = useTheme();
  return (
    <View
      {...rest}
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: justify,
          gap: theme.spacing[gap],
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
};

export const Column = ({
  gap = 'sm',
  style,
  children,
  ...rest
}: RowProps): React.JSX.Element => {
  const theme = useTheme();
  return (
    <View {...rest} style={[{ gap: theme.spacing[gap] }, style]}>
      {children}
    </View>
  );
};

export const Divider = ({ style }: { style?: ViewStyle }): React.JSX.Element => {
  const theme = useTheme();
  return (
    <View
      style={[
        { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border },
        style,
      ]}
    />
  );
};

export const Spacer = ({ size = 'md' }: { size?: SpacingKey }): React.JSX.Element => {
  const theme = useTheme();
  return <View style={{ height: theme.spacing[size] }} />;
};
