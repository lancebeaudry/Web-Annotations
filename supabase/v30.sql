-- PinPoint 2.8.6 — open feedback on by default for new projects.
-- Existing projects keep their current setting. The dashboard and the
-- overlay pass open_access explicitly; this covers any other insert.
alter table projects alter column open_access set default true;
