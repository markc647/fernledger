-- Change Log viewer: each entry says what kind of thing changed, so Members can filter by it.
-- Nullable: entries written before this migration get a type from their summary below; anything else stays NULL ("Other").
ALTER TABLE change_log ADD COLUMN type TEXT;

UPDATE change_log SET type = 'settings' WHERE type IS NULL AND summary LIKE 'Changed settings:%';
UPDATE change_log SET type = 'import' WHERE type IS NULL AND summary LIKE 'Imported %';
UPDATE change_log SET type = 'account' WHERE type IS NULL AND summary LIKE 'Renamed Account %';
