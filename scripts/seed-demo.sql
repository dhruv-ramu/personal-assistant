-- Local demo seed: clearly FICTIONAL simulated-calendar data only (no real appointments or people).
-- Times are relative to "now" so the demo always has something upcoming.
INSERT OR IGNORE INTO sim_calendars (id, summary, is_primary, access_role, timezone)
VALUES ('primary-sim@calendar.invalid', 'Personal (simulated)', 1, 'owner', 'America/Los_Angeles');

INSERT OR REPLACE INTO sim_calendar_events (calendar_id, event_id, recurring_event_id, etag_counter, data_json, updated_at) VALUES
('primary-sim@calendar.invalid', 'demo1', NULL, 1,
 json_object('summary', 'Demo: Dentist appointment (fictional)', 'description', NULL, 'location', 'Example Clinic', 'status', 'confirmed', 'allDay', json('false'),
   'startMs', (CAST(strftime('%s','now','+1 day','start of day','+22 hours') AS INTEGER) * 1000), 'endMs', (CAST(strftime('%s','now','+1 day','start of day','+23 hours') AS INTEGER) * 1000),
   'startDate', NULL, 'endDate', NULL, 'timeZone', 'America/Los_Angeles', 'transparency', 'opaque', 'selfResponse', NULL, 'hasAttendees', json('false'), 'createdByDella', json('false'), 'isRecurringSeries', json('false')),
 CAST(strftime('%s','now') AS INTEGER) * 1000),
('primary-sim@calendar.invalid', 'demo2', NULL, 1,
 json_object('summary', 'Demo: Team sync (fictional)', 'description', NULL, 'location', NULL, 'status', 'confirmed', 'allDay', json('false'),
   'startMs', (CAST(strftime('%s','now','+1 day','start of day','+18 hours') AS INTEGER) * 1000), 'endMs', (CAST(strftime('%s','now','+1 day','start of day','+18 hours','+30 minutes') AS INTEGER) * 1000),
   'startDate', NULL, 'endDate', NULL, 'timeZone', 'America/Los_Angeles', 'transparency', 'opaque', 'selfResponse', NULL, 'hasAttendees', json('true'), 'createdByDella', json('false'), 'isRecurringSeries', json('false')),
 CAST(strftime('%s','now') AS INTEGER) * 1000);
