/**
 * The button.
 *
 * Variants cover every action in both apps. `hold` exists for the destructive
 * ones a driver might hit by accident while driving — cancelling a ride
 * requires a deliberate press-and-hold rather than a tap.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';
import { Text } from './Text.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  readonly label: string;
  readonly onPress?: () => void;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
  readonly icon?: React.ReactNode;
  /** Secondary line under the label, e.g. a fare or an ETA. */
  readonly caption?: string;
  /** Require a press-and-hold of this many ms before firing. */
  readonly holdMs?: number;
  readonly testID?: string;
  readonly style?: ViewStyle;
}

export const Button = ({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = true,
  icon,
  caption,
  holdMs,
  testID,
  style,
}: ButtonProps): React.JSX.Element => {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(holdTimer.current), []);

  const background: Record<ButtonVariant, string> = {
    primary: pressed ? theme.colors.primaryPressed : theme.colors.primary,
    secondary: pressed ? theme.colors.surfaceSunken : theme.colors.surface,
    ghost: 'transparent',
    danger: theme.colors.danger,
    success: theme.colors.success,
  };

  const foreground: Record<ButtonVariant, Parameters<typeof Text>[0]['color']> = {
    primary: 'inverse',
    secondary: 'default',
    ghost: 'primary',
    danger: 'inverse',
    success: 'inverse',
  };

  const heights: Record<ButtonSize, number> = { sm: 38, md: 48, lg: 56 };

  const startHold = useCallback(() => {
    setPressed(true);
    if (!holdMs) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: holdMs,
      useNativeDriver: false,
    }).start();
    holdTimer.current = setTimeout(() => {
      onPress?.();
      progress.setValue(0);
    }, holdMs);
  }, [holdMs, onPress, progress]);

  const endHold = useCallback(() => {
    setPressed(false);
    if (!holdMs) return;
    // Released early: abandon the action rather than firing it.
    clearTimeout(holdTimer.current);
    Animated.timing(progress, { toValue: 0, duration: 120, useNativeDriver: false }).start();
  }, [holdMs, progress]);

  const isDisabled = disabled || loading;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={caption ? `${label}. ${caption}` : label}
      disabled={isDisabled}
      onPressIn={startHold}
      onPressOut={endHold}
      onPress={holdMs ? undefined : onPress}
      style={[
        styles.base,
        {
          height: caption ? heights[size] + 14 : heights[size],
          backgroundColor: background[variant],
          borderRadius: theme.radius.lg,
          opacity: isDisabled ? 0.5 : 1,
          borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth * 2 : 0,
          borderColor: theme.colors.borderStrong,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          paddingHorizontal: fullWidth ? theme.spacing.lg : theme.spacing.xl,
        },
        style,
      ]}
    >
      {/* A hold button fills as it charges, so the wait is visible. */}
      {holdMs ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: 'rgba(255,255,255,0.25)',
              borderRadius: theme.radius.lg,
              width: progress.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      ) : null}

      {loading ? (
        <ActivityIndicator color={variant === 'secondary' || variant === 'ghost' ? theme.colors.primary : theme.colors.onPrimary} />
      ) : (
        <View style={styles.content}>
          {icon ? <View style={{ marginRight: theme.spacing.sm }}>{icon}</View> : null}
          <View>
            <Text
              variant={size === 'sm' ? 'captionStrong' : 'bodyStrong'}
              color={foreground[variant]}
              align="center"
            >
              {label}
            </Text>
            {caption ? (
              <Text
                variant="caption"
                color={variant === 'secondary' || variant === 'ghost' ? 'secondary' : 'inverse'}
                align="center"
                style={{ opacity: 0.85 }}
              >
                {caption}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
