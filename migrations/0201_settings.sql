-- Settings: the app title and the "About your data" fields (README: Privacy and the law).
-- One row per setting. Keys so far: app_title, about_contact, about_retention.
-- The Admin is not a Setting: it is the ADMIN_EMAIL secret (ADR 0002).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
