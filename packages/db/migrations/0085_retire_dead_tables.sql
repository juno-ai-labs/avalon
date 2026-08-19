-- Two tables no code references any longer, on this branch or on the deployed
-- Worker, so — unlike `artifacts`, whose live reader forces a deferred drop —
-- they can be removed while the previous release is still serving.
--
-- `web_usage_log` was the per-run web search/fetch usage meter from
-- 0009_provider_connectors_and_web_usage.sql. Its writer was removed long ago
-- and nothing ever queried it back.
--
-- `workspace_opportunity_versions` was the per-workspace suggested-work
-- version counter from 0049_work_opportunities.sql. The complete
-- work-opportunity lifecycle is WorkspaceDO authority after the cutover, and
-- the counter had already lost its last reader before that; only the
-- maintenance scrub still named it.
DROP TABLE web_usage_log;
DROP TABLE workspace_opportunity_versions;
