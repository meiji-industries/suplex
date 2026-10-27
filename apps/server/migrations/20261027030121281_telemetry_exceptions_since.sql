-- Unix milliseconds when telemetry last turned on. Exception reports recorded earlier are never sent.
ALTER TABLE suplex_telemetry ADD COLUMN exceptions_since INTEGER;
