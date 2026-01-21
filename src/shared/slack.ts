export function isUserActionEvent(payload: any): boolean {
  const event = payload?.event ?? payload;
  if (!event || typeof event !== 'object') {
    return false;
  }

  if (!event.type) {
    return false;
  }

  if (event.bot_id || event.app_id) {
    return false;
  }

  const userId =
    typeof event.user === 'string'
      ? event.user
      : typeof event.user?.id === 'string'
        ? event.user.id
        : '';
  return userId.length > 0;
}
