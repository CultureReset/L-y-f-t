/**
 * Avatar, rating, and badge — the small pieces of identity that appear on every
 * driver and rider card.
 */

import React from 'react';
import { Image, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';
import { Text } from './Text.js';
import { Row } from './Surface.js';

export interface AvatarProps {
  readonly name: string;
  readonly url?: string;
  readonly size?: number;
  readonly style?: ViewStyle;
}

export const Avatar = ({ name, url, size = 48, style }: AvatarProps): React.JSX.Element => {
  const theme = useTheme();
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase();

  return (
    <View
      accessibilityLabel={name}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.primaryMuted,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: size, height: size }} />
      ) : (
        <Text
          variant="bodyStrong"
          color="primary"
          style={{ fontSize: size * 0.38, lineHeight: size * 0.46 }}
        >
          {initials}
        </Text>
      )}
    </View>
  );
};

export interface RatingProps {
  readonly value: number;
  readonly count?: number;
  readonly size?: 'sm' | 'md';
}

export const Rating = ({ value, count, size = 'sm' }: RatingProps): React.JSX.Element => (
  <Row gap="xxs">
    <Text variant={size === 'sm' ? 'caption' : 'bodyStrong'}>★</Text>
    <Text variant={size === 'sm' ? 'caption' : 'bodyStrong'}>{value.toFixed(2)}</Text>
    {count !== undefined ? (
      <Text variant="caption" color="muted">
        ({count})
      </Text>
    ) : null}
  </Row>
);

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  readonly label: string;
  readonly tone?: BadgeTone;
  readonly style?: ViewStyle;
}

export const Badge = ({ label, tone = 'neutral', style }: BadgeProps): React.JSX.Element => {
  const theme = useTheme();
  const backgrounds: Record<BadgeTone, string> = {
    neutral: theme.colors.surfaceSunken,
    primary: theme.colors.primaryMuted,
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
  };
  const isSolid = tone === 'success' || tone === 'warning' || tone === 'danger';

  return (
    <View
      style={[
        {
          backgroundColor: backgrounds[tone],
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: 3,
          borderRadius: theme.radius.pill,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text
        variant="label"
        color={isSolid ? 'inverse' : tone === 'primary' ? 'primary' : 'secondary'}
      >
        {label.toUpperCase()}
      </Text>
    </View>
  );
};
