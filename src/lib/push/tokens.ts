/** Expo push tokens look like `ExponentPushToken[xxxxxxxx]` (or `ExpoPushToken[…]`). */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/.test(value)
}
