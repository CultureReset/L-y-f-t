/**
 * Rate the rider.
 *
 * Shown once a trip completes, before the driver goes back to waiting. The
 * rating is two-sided for a reason: a rider who is consistently rude is a
 * problem only drivers can see, and a five-star tap with no thought behind it
 * is worth nothing — so anything below four asks what happened.
 */

import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Column,
  Divider,
  Field,
  Row,
  ScreenHeader,
  Text,
  useTheme,
} from '@lift/ui';
import { ApiError } from '@lift/sdk';
import { useDriver } from '../../src/state/DriverProvider.js';

/**
 * Tags depend on the rating: praise for a good trip, and something specific
 * for a bad one. A single list would offer "was rude" to someone giving five
 * stars, which is how tag data becomes meaningless.
 */
const POSITIVE_TAGS = ['On time', 'Polite', 'Easy pickup', 'Great conversation', 'Clean'];
const NEGATIVE_TAGS = ['Kept me waiting', 'Rude', 'Hard to find', 'Too many riders', 'Left a mess'];

export default function RateRider(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useDriver();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const available = useMemo(() => (stars >= 4 ? POSITIVE_TAGS : NEGATIVE_TAGS), [stars]);
  // A low rating without a reason helps nobody, so it is required below four.
  const needsReason = stars > 0 && stars < 4 && tags.length === 0 && comment.trim().length === 0;

  const submit = async (): Promise<void> => {
    if (!id || stars === 0) return;
    setSubmitting(true);
    try {
      await client.rateRider(id, {
        stars,
        tags: [...tags],
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      router.replace('/drive');
    } catch (e) {
      Alert.alert('Could not submit', e instanceof ApiError ? e.userMessage : 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
      <ScreenHeader
        title="How was your rider?"
        {...(name ? { subtitle: name } : {})}
        // Skipping is allowed: a forced rating is a random rating.
        onBack={() => router.replace('/drive')}
      />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <Column gap="lg" style={{ alignItems: 'center' }}>
            <Row gap="md">
              {[1, 2, 3, 4, 5].map((value) => (
                <Pressable
                  key={value}
                  onPress={() => {
                    setStars(value);
                    // The tag list changes with the rating, so old picks go.
                    setTags([]);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${value} ${value === 1 ? 'star' : 'stars'}`}
                  hitSlop={8}
                >
                  <Text style={{ fontSize: 40 }}>{value <= stars ? '★' : '☆'}</Text>
                </Pressable>
              ))}
            </Row>
            {stars > 0 ? (
              <Text variant="caption" color="muted">
                {stars === 5
                  ? 'A pleasure to drive'
                  : stars === 4
                    ? 'Good trip'
                    : stars === 3
                      ? 'Nothing special'
                      : stars === 2
                        ? 'Not great'
                        : 'Would rather not again'}
              </Text>
            ) : null}
          </Column>
        </Card>

        {stars > 0 ? (
          <>
            <Column gap="sm">
              <Text variant="label" color="muted">
                {stars >= 4 ? 'WHAT WENT WELL?' : 'WHAT WENT WRONG?'}
              </Text>
              <Row gap="sm" wrap>
                {available.map((tag) => (
                  <Button
                    key={tag}
                    label={tag}
                    size="sm"
                    variant={tags.includes(tag) ? 'primary' : 'secondary'}
                    onPress={() =>
                      setTags((current) =>
                        current.includes(tag)
                          ? current.filter((t) => t !== tag)
                          : [...current, tag],
                      )
                    }
                  />
                ))}
              </Row>
            </Column>

            <Field
              label="Anything else?"
              value={comment}
              onChangeText={setComment}
              multiline
              maxLength={500}
              placeholder={
                stars >= 4 ? 'Optional' : 'This goes to a person, not an algorithm.'
              }
              {...(needsReason
                ? { error: 'Pick a reason or write one so we can act on this.' }
                : {})}
            />

            <Divider />
          </>
        ) : null}

        <Column gap="sm">
          <Button
            label="Submit"
            size="lg"
            onPress={() => void submit()}
            disabled={stars === 0 || needsReason || submitting}
            loading={submitting}
          />
          <Button label="Skip" variant="ghost" onPress={() => router.replace('/drive')} />
        </Column>
      </ScrollView>
    </View>
  );
}
