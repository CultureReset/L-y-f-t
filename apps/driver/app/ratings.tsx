/**
 * Your rating, broken down.
 *
 * A driver's rating is the number their livelihood hangs on, and a single
 * average tells them nothing they can act on. This shows the distribution, the
 * tags riders actually chose, what has changed recently, and which low ratings
 * came with nothing to act on at all.
 */

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Column,
  Divider,
  EmptyState,
  Row,
  ScreenHeader,
  Section,
  StatTile,
  Text,
  useTheme,
} from '@lift/ui';
import type { RatingsResponse } from '@lift/sdk';
import { useDriver } from '../src/state/DriverProvider.js';

export default function Ratings(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();

  const [data, setData] = useState<RatingsResponse>();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await client.driverRatings());
    } catch {
      setData(undefined);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const breakdown = data?.breakdown;
  const trend =
    breakdown && breakdown.recentCount > 0 && breakdown.count > breakdown.recentCount
      ? breakdown.recentAverage - breakdown.average
      : 0;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader title="Your rating" onBack={() => router.back()} />

      {loading ? (
        <Column style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.primary} />
        </Column>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
          contentContainerStyle={{
            padding: theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing.xxl,
            gap: theme.spacing.xl,
          }}
        >
          {!breakdown || breakdown.count === 0 ? (
            <EmptyState
              icon="⭐"
              title="No ratings yet"
              message="Riders rate you after a trip. Your first few will show up here."
            />
          ) : (
            <>
              <Column gap="xs" style={{ alignItems: 'center' }}>
                <Text variant="display">{breakdown.average.toFixed(2)}</Text>
                <Text variant="caption" color="muted">
                  from {breakdown.count} {breakdown.count === 1 ? 'rating' : 'ratings'}
                </Text>
                {trend !== 0 ? (
                  <Badge
                    label={`${trend > 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(2)} recently`}
                    tone={trend > 0 ? 'success' : 'warning'}
                  />
                ) : null}
              </Column>

              {/* The distribution: where the ratings actually sit. */}
              <Card>
                <Column gap="sm">
                  {([5, 4, 3, 2, 1] as const).map((stars) => (
                    <StarBar
                      key={stars}
                      stars={stars}
                      count={breakdown.distribution[stars]}
                      total={breakdown.count}
                    />
                  ))}
                </Column>
              </Card>

              <Row gap="sm" wrap>
                <StatTile
                  label="Last 30 days"
                  value={
                    breakdown.recentCount > 0 ? breakdown.recentAverage.toFixed(2) : '—'
                  }
                  caption={`${breakdown.recentCount} rated`}
                />
                <StatTile
                  label="Five stars"
                  value={`${Math.round((breakdown.distribution[5] / breakdown.count) * 100)}%`}
                />
              </Row>

              {breakdown.tags.length > 0 ? (
                <Section
                  title="What riders mention"
                  footer="Compliments and complaints riders picked from a list."
                >
                  <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
                    {breakdown.tags.map((tag) => (
                      <Row key={tag.tag} justify="space-between">
                        <Text variant="caption">{humanizeTag(tag.tag)}</Text>
                        <Badge label={`${tag.count}×`} />
                      </Row>
                    ))}
                  </Column>
                </Section>
              ) : null}

              {(data?.comments.length ?? 0) > 0 ? (
                <Section title="What riders wrote">
                  <Column gap="md" style={{ paddingVertical: theme.spacing.sm }}>
                    {data!.comments.map((comment) => (
                      <Column key={comment.rideId} gap="xxs">
                        <Row gap="sm" align="center">
                          <Text variant="captionStrong">{'★'.repeat(comment.stars)}</Text>
                          <Text variant="caption" color="muted">
                            {new Date(comment.at).toLocaleDateString()}
                          </Text>
                        </Row>
                        <Text variant="caption" color="secondary">
                          {comment.comment}
                        </Text>
                        <Divider />
                      </Column>
                    ))}
                  </Column>
                </Section>
              ) : null}

              {(data?.disputable.length ?? 0) > 0 ? (
                <Section
                  title="Worth a look"
                  footer="A low rating with no comment and no tags tells you nothing. Support can review these."
                >
                  <Column gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
                    <Text variant="caption" color="secondary">
                      {data!.disputable.length}{' '}
                      {data!.disputable.length === 1 ? 'rating' : 'ratings'} came with nothing to
                      act on.
                    </Text>
                    <Button
                      label="Ask support to review"
                      variant="secondary"
                      onPress={() =>
                        router.push({
                          pathname: '/support',
                          params: { category: 'account' },
                        })
                      }
                    />
                  </Column>
                </Section>
              ) : null}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const StarBar = ({
  stars,
  count,
  total,
}: {
  stars: number;
  count: number;
  total: number;
}): React.JSX.Element => {
  const theme = useTheme();
  const fraction = total > 0 ? count / total : 0;

  return (
    <Row gap="md" align="center">
      <Text variant="caption" color="muted" style={{ width: 28 }}>
        {stars}★
      </Text>
      <View
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.surfaceSunken,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${Math.round(fraction * 100)}%`,
            height: '100%',
            // Low ratings read as warnings rather than as more of the same.
            backgroundColor: stars >= 4 ? theme.colors.success : theme.colors.warning,
          }}
        />
      </View>
      <Text variant="caption" color="muted" style={{ width: 32, textAlign: 'right' }}>
        {count}
      </Text>
    </Row>
  );
};

/** Tags arrive as machine codes; nobody wants to read `safe_driving`. */
const humanizeTag = (tag: string): string =>
  tag.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
