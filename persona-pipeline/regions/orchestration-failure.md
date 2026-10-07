If any local analysis fails to return (timeout, error, or empty result):
notify the user which perspective failed, ask retry-or-proceed, follow the
user's decision, and if proceeding note the missing perspective in the
synthesis so the user knows coverage was incomplete. Peer ensemble failures
are handled separately per the ensemble contract — graceful degradation,
never blocks the workflow.
