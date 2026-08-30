# Play Store listing — driver app

## Title (30 characters max)

```
Lyft Clone Driver
```

## Short description (80 characters max)

```
Drive when you want. See what each trip pays before you accept it.
```

## Full description (4000 characters max)

```
Drive on your own terms.

Go online when you want to work, see exactly what a trip pays before you
accept it, and cash out your earnings the same day.

EVERY TRIP, UP FRONT
• The fare, the pickup distance, and the destination before you accept
• A countdown you can let run out — declining costs you nothing
• Turn-by-turn navigation built in, or hand off to the maps app you prefer

CHOOSE YOUR WORK
• Turn off the ride types you don't want
• Set how far you'll go for a pickup
• Heading home? Only get rides going your way
• See where demand is paying above the normal rate

YOUR MONEY, CLEARLY
• Every trip broken down: fare, tips, bonuses, and what the platform took
• Earnings per hour, not just per trip
• Cash out to your bank whenever your balance clears the minimum
• The fee is shown before you confirm, and comes out of the amount

YOUR RATING, EXPLAINED
• The full distribution, not one averaged number
• What riders actually mention, ranked
• Low ratings that came with no explanation flagged for review

Help is attached to every trip, and a person answers.
```

## Category

Maps & Navigation

## Contact

- Website: `https://example.com/drive`
- Email: `drivers@example.com`
- Privacy policy: `https://example.com/privacy`

## Graphics

| Asset | File | Requirement |
| --- | --- | --- |
| Icon | `play-icon-512.png` | 512×512 PNG, 32-bit |
| Feature graphic | `play-feature-graphic.png` | 1024×500, no transparency |

## Screenshots

1. **Online** — today's earnings, the go-offline button, demand and preferences.
2. **An offer** — fare, pickup distance, destination, countdown running.
3. **Navigation** — the manoeuvre banner and the step list.
4. **Earnings** — per-hour alongside the total, with the trip list.
5. **Payouts** — the balance and the cash-out sheet showing the fee.
6. **Your rating** — the distribution and the tags.

## Background location declaration

Play requires a video for `ACCESS_BACKGROUND_LOCATION`. Record:

1. The driver app online, a trip accepted, navigation running.
2. The phone's home button pressed — the app goes to the background, and the
   persistent location notification is visible in the shade.
3. The rider app, side by side, still showing the car moving.
4. The driver going offline, and the notification disappearing.

The written justification: a driver's phone is mounted and its screen sleeps
during a trip. Without background location the rider's map freezes mid-trip,
which is both the core function of the product and a safety feature.
