/**
 * Help and support, driver side.
 *
 * The same help centre the rider app uses — the API narrows the topics and
 * categories to a driver audience, so this screen carries no driver-specific
 * copy of its own. Earnings questions and rider reports are where the volume
 * is, and both are one tap from here.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  EmptyState,
  Field,
  NavRow,
  OptionRow,
  Row,
  ScreenHeader,
  Section,
  Text,
  useTheme,
} from '@lift/ui';
import {
  formatRelativeTime,
  ticketStatusLabel,
  unreadForRequester,
  type HelpAction,
  type HelpArticle,
  type HelpTopic,
  type SupportTicket,
  type TicketCategory,
} from '@lift/core';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

type Layer =
  | { kind: 'topics' }
  | { kind: 'article'; topic: HelpTopic; article: HelpArticle }
  | { kind: 'compose'; categoryId: string };

const EMERGENCY_NUMBERS: Record<string, string> = {
  US: '911',
  CA: '911',
  MX: '911',
  GB: '999',
  IE: '112',
  AU: '000',
  NZ: '111',
};

export default function Support(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, config } = useDriver();
  const params = useLocalSearchParams<{ rideId?: string; category?: string }>();

  const [topics, setTopics] = useState<readonly HelpTopic[]>([]);
  const [categories, setCategories] = useState<readonly TicketCategory[]>([]);
  const [tickets, setTickets] = useState<readonly SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [layer, setLayer] = useState<Layer>(
    params.category ? { kind: 'compose', categoryId: params.category } : { kind: 'topics' },
  );

  const load = useCallback(async () => {
    try {
      const [help, mine] = await Promise.all([
        client.help({ audience: 'driver', ...(params.rideId ? { rideId: params.rideId } : {}) }),
        client.tickets().catch(() => ({ tickets: [] })),
      ]);
      setTopics(help.topics);
      setCategories(help.categories);
      setTickets(mine.tickets);
    } catch {
      setTopics([]);
    } finally {
      setLoading(false);
    }
  }, [client, params.rideId]);

  useEffect(() => {
    void load();
  }, [load]);

  const emergencyNumber = useMemo(() => {
    const region = (config?.market.locale ?? 'en-US').split('-')[1] ?? 'US';
    return EMERGENCY_NUMBERS[region] ?? '112';
  }, [config]);

  const runAction = useCallback(
    (action: HelpAction) => {
      switch (action.kind) {
        case 'open_ticket':
          setLayer({ kind: 'compose', categoryId: action.category });
          return;
        case 'route':
          router.push(action.path as never);
          return;
        case 'call': {
          const number = action.number === 'emergency' ? emergencyNumber : action.number;
          void Linking.openURL(`tel:${number}`).catch(() =>
            Alert.alert('Could not open the dialer', `Call ${number} directly.`),
          );
          return;
        }
        case 'link':
          void Linking.openURL(action.url).catch(() => Alert.alert('Could not open that link'));
      }
    },
    [emergencyNumber],
  );

  const back = useCallback(() => {
    if (layer.kind === 'topics') router.back();
    else setLayer({ kind: 'topics' });
  }, [layer]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title={
          layer.kind === 'article'
            ? layer.article.title
            : layer.kind === 'compose'
              ? 'Contact us'
              : 'Help'
        }
        onBack={back}
      />

      {loading ? (
        <Column style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </Column>
      ) : layer.kind === 'article' ? (
        <ScrollView
          contentContainerStyle={{
            padding: theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing.xxl,
            gap: theme.spacing.lg,
          }}
        >
          {layer.article.body.map((paragraph, index) => (
            <Text key={index} variant="body" color="secondary">
              {paragraph}
            </Text>
          ))}
          {layer.article.actions?.length ? (
            <Column gap="sm">
              <Divider />
              {layer.article.actions.map((action, index) => (
                <Button
                  key={index}
                  label={action.label}
                  variant={action.kind === 'call' ? 'danger' : index === 0 ? 'primary' : 'secondary'}
                  onPress={() => runAction(action)}
                />
              ))}
            </Column>
          ) : null}
        </ScrollView>
      ) : layer.kind === 'compose' ? (
        <Compose
          categories={categories}
          initialCategoryId={layer.categoryId}
          {...(params.rideId ? { rideId: params.rideId } : {})}
          onOpened={(ticket) => {
            void load();
            setLayer({ kind: 'topics' });
            router.push(`/ticket/${ticket.id}`);
          }}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing.xxl,
            gap: theme.spacing.xl,
          }}
        >
          {tickets.length > 0 ? (
            <Section title="Your requests">
              {tickets.slice(0, 4).map((ticket) => (
                <NavRow
                  key={ticket.id}
                  label={ticket.subject}
                  description={`${ticketStatusLabel(ticket.status)} · ${formatRelativeTime(
                    ticket.updatedAt,
                    Date.now(),
                  )}`}
                  {...(unreadForRequester(ticket) > 0
                    ? { value: `${unreadForRequester(ticket)} new` }
                    : {})}
                  onPress={() => router.push(`/ticket/${ticket.id}`)}
                />
              ))}
            </Section>
          ) : null}

          {topics.length === 0 ? (
            <EmptyState
              icon="📡"
              title="Help is offline"
              message="We could not reach the help centre. Check your connection and try again."
              action={<Button label="Retry" variant="secondary" onPress={() => void load()} />}
            />
          ) : (
            <Section title="Browse">
              {topics.map((topic) => (
                <NavRow
                  key={topic.id}
                  label={topic.title}
                  description={topic.summary}
                  icon={topic.icon}
                  onPress={() =>
                    topic.articles[0]
                      ? setLayer({ kind: 'article', topic, article: topic.articles[0] })
                      : setLayer({ kind: 'compose', categoryId: 'app_problem' })
                  }
                />
              ))}
            </Section>
          )}

          <Column gap="sm">
            <Button
              label="Contact support"
              variant="secondary"
              size="lg"
              onPress={() =>
                setLayer({ kind: 'compose', categoryId: categories[0]?.id ?? 'app_problem' })
              }
            />
            <Button
              label={`Emergency — call ${emergencyNumber}`}
              variant="danger"
              onPress={() =>
                Alert.alert(
                  `Call ${emergencyNumber}?`,
                  'This places a real call to emergency services.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Call',
                      style: 'destructive',
                      onPress: () => {
                        void Linking.openURL(`tel:${emergencyNumber}`);
                      },
                    },
                  ],
                )
              }
            />
          </Column>
        </ScrollView>
      )}
    </View>
  );
}

const Compose = ({
  categories,
  initialCategoryId,
  rideId,
  onOpened,
}: {
  categories: readonly TicketCategory[];
  initialCategoryId: string;
  rideId?: string;
  onOpened: (ticket: SupportTicket) => void;
}): React.JSX.Element => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();

  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const category = categories.find((c) => c.id === categoryId);
  const missingRide = Boolean(category?.requiresRide && !rideId);
  const canSubmit = body.trim().length > 0 && !missingRide && !submitting;

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const { ticket } = await client.openTicket({
        categoryId,
        body: body.trim(),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ...(rideId ? { rideId } : {}),
      });
      onOpened(ticket);
    } catch (e) {
      Alert.alert('Could not send', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={{
        padding: theme.spacing.lg,
        paddingBottom: insets.bottom + theme.spacing.xxl,
        gap: theme.spacing.xl,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Section title="What is this about?">
        {categories.map((option) => (
          <OptionRow
            key={option.id}
            label={option.label}
            description={option.description}
            selected={option.id === categoryId}
            onSelect={() => setCategoryId(option.id)}
          />
        ))}
      </Section>

      {rideId ? (
        <Card padded="md">
          <Row gap="sm" align="center">
            <Text variant="caption" color="muted">
              Attached to trip
            </Text>
            <Badge label={rideId.slice(-6).toUpperCase()} />
          </Row>
        </Card>
      ) : missingRide ? (
        <Text variant="caption" color="danger">
          {category?.label} requests have to name a trip. Open this from the trip in your earnings.
        </Text>
      ) : null}

      <Column gap="md">
        <Field
          label="Subject"
          value={subject}
          onChangeText={setSubject}
          placeholder={category?.label ?? 'Summary'}
        />
        <Field
          label="What happened?"
          value={body}
          onChangeText={setBody}
          multiline
          placeholder="Tell us in your own words."
        />
      </Column>

      <Button
        label="Send"
        size="lg"
        onPress={() => void submit()}
        disabled={!canSubmit}
        loading={submitting}
      />
    </ScrollView>
  );
};
