/**
 * One support request, as a conversation.
 *
 * Deliberately the same shape as the in-ride chat: a thread you can reply to,
 * not a form you filled in and never hear about again. The status pill is the
 * honest answer to "is anyone looking at this?" — it says whose turn it is.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Field,
  Row,
  ScreenHeader,
  Text,
  useTheme,
} from '@lift/ui';
import {
  formatClockTime,
  isTicketOpen,
  ticketStatusLabel,
  type SupportTicket,
  type TicketMessage,
} from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useApp } from '../../src/state/AppProvider.js';

export default function Ticket(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useApp();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [ticket, setTicket] = useState<SupportTicket>();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scroller = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const { ticket: found } = await client.ticket(id);
      setTicket(found);
      // Opening the thread is what marks it read; doing it on a timer would
      // clear the badge for someone who never looked.
      void client.markTicketRead(id).catch(() => {});
    } catch (e) {
      Alert.alert(
        'Could not open this request',
        e instanceof ApiError ? e.userMessage : 'Try again in a moment.',
      );
      router.back();
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !id) return;
    setSending(true);
    try {
      const { ticket: updated } = await client.replyToTicket(id, text);
      setTicket(updated);
      setDraft('');
      setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      Alert.alert(
        'Could not send',
        e instanceof ApiError ? e.userMessage : 'Try again in a moment.',
      );
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (action: 'close' | 'reopen'): Promise<void> => {
    if (!id) return;
    try {
      const { ticket: updated } = await client.setTicketStatus(id, action);
      setTicket(updated);
    } catch (e) {
      Alert.alert('Could not update', e instanceof ApiError ? e.userMessage : 'Try again.');
    }
  };

  if (loading || !ticket) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const open = isTicketOpen(ticket);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <ScreenHeader
        title={ticket.subject}
        subtitle={ticketStatusLabel(ticket.status)}
        onBack={() => router.back()}
        trailing={
          <Badge
            label={ticketStatusLabel(ticket.status)}
            tone={open ? 'primary' : ticket.status === 'resolved' ? 'success' : 'neutral'}
          />
        }
      />

      <ScrollView
        ref={scroller}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
          paddingBottom: theme.spacing.xl,
        }}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {ticket.rideId ? (
          <Card padded="md">
            <Row justify="space-between" align="center">
              <Text variant="caption" color="muted">
                About trip {ticket.rideId.slice(-6).toUpperCase()}
              </Text>
              <Button
                label="View"
                variant="ghost"
                size="sm"
                onPress={() => router.push(`/ride/${ticket.rideId}`)}
              />
            </Row>
          </Card>
        ) : null}

        {ticket.messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
      </ScrollView>

      <View
        style={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.lg,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          gap: theme.spacing.sm,
        }}
      >
        {ticket.status === 'closed' ? (
          // A closed thread is final, so the honest thing is to say so and
          // offer the only action that actually works.
          <Column gap="sm">
            <Text variant="caption" color="muted" align="center">
              This request is closed.
            </Text>
            <Button
              label="Start a new request"
              variant="secondary"
              onPress={() => router.replace('/support')}
            />
          </Column>
        ) : (
          <>
            <Row gap="sm" align="flex-end">
              <View style={{ flex: 1 }}>
                <Field
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={
                    ticket.status === 'resolved' ? 'Reply to reopen this' : 'Write a reply'
                  }
                  multiline
                />
              </View>
              <Button
                label="Send"
                onPress={() => void send()}
                disabled={draft.trim().length === 0 || sending}
                loading={sending}
              />
            </Row>
            {open ? (
              <Button
                label="Close this request"
                variant="ghost"
                size="sm"
                onPress={() =>
                  Alert.alert('Close this request?', 'You can always open a new one.', [
                    { text: 'Keep open', style: 'cancel' },
                    {
                      text: 'Close',
                      style: 'destructive',
                      onPress: () => void setStatus('close'),
                    },
                  ])
                }
              />
            ) : null}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const Bubble = ({ message }: { message: TicketMessage }): React.JSX.Element => {
  const theme = useTheme();
  const mine = message.from === 'requester';
  // A system note reads as neither side's voice, because it is neither's.
  const system = message.from === 'system';

  return (
    <Column
      gap="xxs"
      style={{ alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', alignSelf: mine ? 'flex-end' : 'flex-start' }}
    >
      <View
        style={{
          backgroundColor: mine
            ? theme.colors.primary
            : system
              ? theme.colors.surfaceSunken
              : theme.colors.surface,
          borderRadius: theme.radius.lg,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          borderWidth: system ? 1 : 0,
          borderColor: theme.colors.border,
        }}
      >
        <Text variant="body" color={mine ? 'inverse' : system ? 'secondary' : 'default'}>
          {message.text}
        </Text>
      </View>
      <Text variant="caption" color="muted">
        {system ? 'Support · automatic' : mine ? 'You' : 'Support'} ·{' '}
        {formatClockTime(message.sentAt)}
      </Text>
    </Column>
  );
};
