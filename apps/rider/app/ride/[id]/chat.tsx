/**
 * In-ride chat. Opens once a driver is assigned and closes when the trip ends —
 * enforced by the API, not merely hidden in the UI.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Row, Text, useTheme } from '@lift/ui';
import { channels, type ChatMessage } from '@lift/sdk';
import { formatClockTime } from '@lift/core';
import { useApp } from '../../../src/state/AppProvider.js';

export default function Chat(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, realtime } = useApp();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [replies, setReplies] = useState<string[]>([]);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [history, quick] = await Promise.all([
        client.messages(id),
        client.quickReplies().catch(() => ({ replies: [] as string[] })),
      ]);
      setMessages(history.messages);
      setReplies(quick.replies);
    } catch {
      // An empty thread is a perfectly good starting state.
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // New messages arrive over the ride channel rather than by polling.
  useEffect(() => {
    if (!id) return;
    return realtime.subscribe(channels.ride(id), (message) => {
      if (message.type === 'chat.message') void load();
    });
  }, [id, realtime, load]);

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || !id) return;
    setDraft('');
    try {
      const { message } = await client.sendMessage(id, trimmed);
      setMessages((current) => [...current, message]);
    } catch {
      // Put the text back so the rider does not lose what they typed.
      setDraft(trimmed);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}
    >
      <Row gap="md" style={{ padding: theme.spacing.lg }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Text variant="title">←</Text>
        </Pressable>
        <Text variant="heading">Your driver</Text>
      </Row>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const mine = item.from === 'rider';
          return (
            <View
              style={{
                alignSelf: mine ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                backgroundColor: mine ? theme.colors.primary : theme.colors.surfaceSunken,
                borderRadius: theme.radius.lg,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
              }}
            >
              <Text variant="body" color={mine ? 'inverse' : 'default'}>
                {item.text}
              </Text>
              <Text variant="label" color={mine ? 'inverse' : 'muted'} style={{ opacity: 0.7 }}>
                {formatClockTime(item.sentAt)}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text
            variant="caption"
            color="muted"
            align="center"
            style={{ padding: theme.spacing.xl }}
          >
            Say hello — messages stay private to this ride.
          </Text>
        }
      />

      {/* Canned replies, so most exchanges need no typing. */}
      {replies.length > 0 ? (
        <Row gap="sm" wrap style={{ paddingHorizontal: theme.spacing.lg }}>
          {replies.slice(0, 3).map((reply) => (
            <Pressable
              key={reply}
              onPress={() => void send(reply)}
              accessibilityRole="button"
              accessibilityLabel={reply}
              style={{
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.surfaceSunken,
              }}
            >
              <Text variant="caption">{reply}</Text>
            </Pressable>
          ))}
        </Row>
      ) : null}

      <Row
        gap="sm"
        style={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.lg,
        }}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel="Message"
          onSubmitEditing={() => void send(draft)}
          style={{
            flex: 1,
            backgroundColor: theme.colors.surfaceSunken,
            borderRadius: theme.radius.pill,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            color: theme.colors.text,
          }}
        />
        <Pressable
          onPress={() => void send(draft)}
          disabled={draft.trim().length === 0}
          accessibilityRole="button"
          accessibilityLabel="Send"
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.primary,
            opacity: draft.trim().length === 0 ? 0.4 : 1,
          }}
        >
          <Text color="inverse">↑</Text>
        </Pressable>
      </Row>
    </KeyboardAvoidingView>
  );
}
