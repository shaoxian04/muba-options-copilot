-- Adds the actual AI input/output text to forecast_usage_log, alongside the token
-- counts 0001 already captured. `input` is the `user` prompt only, not `system` --
-- system is a static string per call_site, constant across every row, and cheap to
-- look up in code if ever needed, so storing it per row would just be repeated noise.
alter table forecast_usage_log
  add column if not exists input text,
  add column if not exists output text;
