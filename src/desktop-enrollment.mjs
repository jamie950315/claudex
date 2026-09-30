/** Enrollment is durable metadata. Stopped conversations retain their complete
 * ledger, native identities and content assets; they are excluded from work and
 * presentation without making their history available for rediscovery.
 */
export function isDesktopTracked(conversation) {
  return conversation?.tracking?.status !== 'stopped';
}

export function activeDesktopState(state) {
  return { ...state,
    conversations: Object.fromEntries(Object.entries(state.conversations)
      .filter(([, conversation]) => isDesktopTracked(conversation))),
    records: state.records.filter(record => isDesktopTracked(state.conversations[record.conversationId])),
  };
}

export function activeDesktopConversationIds(state) {
  return Object.entries(state.conversations).filter(([, conversation]) => isDesktopTracked(conversation)).map(([id]) => id);
}

export function validateDesktopEnrollment(state) {
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.tracking === undefined) continue;
    const tracking = conversation.tracking;
    if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking)
      || tracking.status !== 'stopped' || !Number.isSafeInteger(tracking.stoppedAt) || tracking.stoppedAt < 0
      || Object.keys(tracking).some(key => !['status', 'stoppedAt'].includes(key)))
      throw new Error('Invalid Desktop conversation enrollment; saved histories were preserved.');
  }
}
