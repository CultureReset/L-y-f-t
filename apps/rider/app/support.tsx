/**
 * Help and support.
 *
 * Three layers on one route so a person never loses their place: the topic
 * list, an article, and the request they open when the article did not answer
 * it. Nothing here is hardcoded copy — the topics, the articles, and the
 * categories all come from the API, so an operator rewrites them without a new
 * build.
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
import { useApp } from '../src/state/AppProvider.js';
import { goBack } from '../src/navigation.js';

/** Which of the three layers is on screen. */
type View_ =
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
  const { client, config } = useApp();
  const params = useLocalSearchParams<{ rideId?: string; category?: string }>();

  const [topics, setTopics] = useState<readonly HelpTopic[]>([]);
  const [categories, setCategories] = useState<readonly TicketCategory[]>([]);
  const [tickets, setTickets] = useState<readonly SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View_>(
    params.category ? { kind: 'compose', categoryId: params.category } : { kind: 'topics' },
  );

  const load = useCallback(async () => {
    try {
      const [help, mine] = await Promise.all([
        client.help(params.rideId ? { rideId: params.rideId } : {}),
        client.tickets().catch(() => ({ tickets: [] })),
      ]);
      setTopics(help.topics);
      setCategories(help.categories);
      setTickets(mine.tickets);
    } catch {
      // An unreachable help centre should not be a blank screen with no way out.
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

  /** The four verbs an article's button can be. */
  const runAction = useCallback(
    (action: HelpAction) => {
      switch (action.kind) {
        case 'open_ticket':
          setView({ kind: 'compose', categoryId: action.category });
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
          void Linking.openURL(action.url).catch(() =>
            Alert.alert('Could not open that link'),
          );
      }
    },
    [emergencyNumber],
  );

  const back = useCallback(() => {
    if (view.kind === 'topics') goBack('/account');
    else setView({ kind: 'topics' });
  }, [view]);

  const header =
    view.kind === 'article'
      ? { title: view.article.title, subtitle: view.topic.title }
      : view.kind === 'compose'
        ? { title: 'Contact us', subtitle: 'We reply in the app.' }
        : { title: 'Help', subtitle: undefined };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title={header.title}
        {...(header.subtitle ? { subtitle: header.subtitle } : {})}
        onBack={back}
      />

      {loading ? (
        <Column gap="md" style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </Column>
      ) : view.kind === 'article' ? (
        <ArticleView article={view.article} onAction={runAction} />
      ) : view.kind === 'compose' ? (
        <Compose
          categories={categories}
          initialCategoryId={view.categoryId}
          {...(params.rideId ? { rideId: params.rideId } : {})}
          onOpened={(ticket) => {
            void load();
            setView({ kind: 'topics' });
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
                      ? setView({ kind: 'article', topic, article: topic.articles[0] })
                      : setView({ kind: 'compose', categoryId: 'app_problem' })
                  }
                />
              ))}
            </Section>
          )}

          {/* The escape hatch: nothing above matched, talk to a person. */}
          <Column gap="sm">
            <Button
              label="Contact support"
              variant="secondary"
              size="lg"
              onPress={() =>
                setView({
                  kind: 'compose',
                  categoryId: categories[0]?.id ?? 'app_problem',
                })
              }
            />
            <Text variant="caption" color="muted" align="center">
              For anything urgent on a trip, use the safety tools instead.
            </Text>
          </Column>
        </ScrollView>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ article

const ArticleView = ({
  article,
  onAction,
}: {
  article: HelpArticle;
  onAction: (action: HelpAction) => void;
}): React.JSX.Element => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentContainerStyle={{
        padding: theme.spacing.lg,
        paddingBottom: insets.bottom + theme.spacing.xxl,
        gap: theme.spacing.lg,
      }}
    >
      {article.body.map((paragraph, index) => (
        <Text key={index} variant="body" color="secondary">
          {paragraph}
        </Text>
      ))}

      {article.actions?.length ? (
        <Column gap="sm" style={{ marginTop: theme.spacing.md }}>
          <Divider />
          {article.actions.map((action, index) => (
            <Button
              key={index}
              label={action.label}
              variant={action.kind === 'call' ? 'danger' : index === 0 ? 'primary' : 'secondary'}
              onPress={() => onAction(action)}
            />
          ))}
        </Column>
      ) : null}
    </ScrollView>
  );
};

// ------------------------------------------------------------------ compose

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
  const { client } = useApp();

  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const category = categories.find((c) => c.id === categoryId);
  // The button is disabled rather than the request failing at the server: a
  // category that needs a trip cannot be sent without one.
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
      Alert.alert(
        'Could not send',
        e instanceof ApiError ? e.userMessage : 'Try again in a moment.',
      );
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
          {category?.label} requests have to name a trip. Open this from the trip in your history.
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
          placeholder="Tell us in your own words. Details help us fix it faster."
          multiline
        />
      </Column>

      <Button label="Send" size="lg" onPress={() => void submit()} disabled={!canSubmit} loading={submitting} />
    </ScrollView>
  );
};
