PRAGMA user_version = 7;
CREATE TABLE schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 7)
) STRICT;
INSERT INTO schema_metadata (singleton, schema_version) VALUES (1, 7);
