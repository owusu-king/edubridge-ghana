-- Staff push (PSH-01): the same browser signing in as staff (or back as a parent) moves its subscription.
GRANT UPDATE (staff_session_id, user_id) ON push_subscriptions TO edubridge_app;
