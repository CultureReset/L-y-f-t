/**
 * Form primitives.
 *
 * Both apps need the same handful of input shapes — text fields, toggles,
 * selectable rows, section headers, empty states. Building them once means a
 * settings screen in the rider app and one in the driver app look like the same
 * product, and an accessibility fix lands in both.
 */

import React, { type ReactNode } from 'react';
import {
  Pressable,
  Switch,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';
import { Text } from './Text.js';
import { Column, Divider, Row } from './Surface.js';

export interface FieldProps {
  readonly label?: string;
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  readonly placeholder?: string;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly editable?: boolean;
  readonly error?: string;
  readonly hint?: string;
  readonly onSubmitEditing?: () => void;
  readonly autoFocus?: boolean;
  readonly style?: ViewStyle;
  readonly testID?: string;
}

export const Field = ({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = 'sentences',
  multiline = false,
  maxLength,
  editable = true,
  error,
  hint,
  onSubmitEditing,
  autoFocus,
  style,
  testID,
}: FieldProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Column gap="xs" style={style}>
      {label ? (
        <Text variant="label" color="muted">
          {label.toUpperCase()}
        </Text>
      ) : null}
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textMuted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        maxLength={maxLength}
        editable={editable}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        accessibilityLabel={label ?? placeholder}
        style={{
          backgroundColor: theme.colors.surfaceSunken,
          borderRadius: theme.radius.md,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          minHeight: multiline ? 88 : 48,
          textAlignVertical: multiline ? 'top' : 'center',
          fontSize: 16,
          color: editable ? theme.colors.text : theme.colors.textMuted,
          borderWidth: error ? 2 : 0,
          borderColor: theme.colors.danger,
        }}
      />
      {error ? (
        <Text variant="caption" color="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" color="muted">
          {hint}
        </Text>
      ) : null}
    </Column>
  );
};

export interface ToggleRowProps {
  readonly label: string;
  readonly description?: string;
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
  readonly disabled?: boolean;
}

export const ToggleRow = ({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: ToggleRowProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Row
      justify="space-between"
      align="center"
      gap="lg"
      style={{ paddingVertical: theme.spacing.sm, opacity: disabled ? 0.5 : 1 }}
    >
      <Column gap="xxs" style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        {description ? (
          <Text variant="caption" color="muted">
            {description}
          </Text>
        ) : null}
      </Column>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
        thumbColor={theme.colors.surface}
      />
    </Row>
  );
};

export interface OptionRowProps {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly icon?: string;
  readonly trailing?: ReactNode;
  readonly disabled?: boolean;
}

/** A radio-style row: the shape most pickers in both apps take. */
export const OptionRow = ({
  label,
  description,
  selected,
  onSelect,
  icon,
  trailing,
  disabled = false,
}: OptionRowProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Pressable
      onPress={disabled ? undefined : onSelect}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={description ? `${label}. ${description}` : label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 2,
        borderColor: selected ? theme.colors.primary : 'transparent',
        backgroundColor: selected ? theme.colors.primaryMuted : 'transparent',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon ? <Text style={{ fontSize: 20 }}>{icon}</Text> : null}
      <Column gap="xxs" style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        {description ? (
          <Text variant="caption" color="muted">
            {description}
          </Text>
        ) : null}
      </Column>
      {trailing ?? (
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 2,
            borderColor: selected ? theme.colors.primary : theme.colors.borderStrong,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? (
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: theme.colors.primary,
              }}
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
};

/** A tappable row that leads somewhere — the backbone of every settings list. */
export const NavRow = ({
  label,
  value,
  description,
  icon,
  onPress,
  destructive = false,
}: {
  label: string;
  value?: string;
  description?: string;
  icon?: string;
  onPress: () => void;
  destructive?: boolean;
}): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      {icon ? <Text style={{ fontSize: 20 }}>{icon}</Text> : null}
      <Column gap="xxs" style={{ flex: 1 }}>
        <Text variant="body" color={destructive ? 'danger' : 'default'}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" color="muted">
            {description}
          </Text>
        ) : null}
      </Column>
      {value ? (
        <Text variant="caption" color="muted">
          {value}
        </Text>
      ) : null}
      <Text variant="body" color="muted">
        ›
      </Text>
    </Pressable>
  );
};

/** A titled group of rows. */
export const Section = ({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Column gap="sm">
      {title ? (
        <Text variant="label" color="muted">
          {title.toUpperCase()}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.xs,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        {children}
      </View>
      {footer ? (
        <Text variant="caption" color="muted">
          {footer}
        </Text>
      ) : null}
    </Column>
  );
};

/** What a list shows when it has nothing to show. */
export const EmptyState = ({
  icon,
  title,
  message,
  action,
}: {
  icon?: string;
  title: string;
  message?: string;
  action?: ReactNode;
}): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Column
      gap="md"
      style={{ alignItems: 'center', paddingVertical: theme.spacing.xxxl, paddingHorizontal: theme.spacing.xl }}
    >
      {icon ? <Text style={{ fontSize: 44 }}>{icon}</Text> : null}
      <Text variant="heading" align="center">
        {title}
      </Text>
      {message ? (
        <Text variant="caption" color="secondary" align="center">
          {message}
        </Text>
      ) : null}
      {action}
    </Column>
  );
};

/** A screen header with a back affordance — every pushed screen has one. */
export const ScreenHeader = ({
  title,
  subtitle,
  onBack,
  trailing,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  trailing?: ReactNode;
}): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Row gap="md" align="center" style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md }}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={14}
        >
          <Text variant="title">←</Text>
        </Pressable>
      ) : null}
      <Column gap="xxs" style={{ flex: 1 }}>
        <Text variant="title">{title}</Text>
        {subtitle ? (
          <Text variant="caption" color="secondary">
            {subtitle}
          </Text>
        ) : null}
      </Column>
      {trailing}
    </Row>
  );
};

export { Divider };
