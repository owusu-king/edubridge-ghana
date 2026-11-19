-- A browser that turns notifications on again under a new parent sign-in keeps its endpoint: the row moves
-- to the new sign-in (and number) instead of staying with the old one.
GRANT UPDATE (parent_session_id, phone, p256dh, auth, created_at) ON push_subscriptions TO edubridge_app;
