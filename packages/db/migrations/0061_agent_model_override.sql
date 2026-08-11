-- Which OpenRouter model a work stream's runs are pinned to, when someone has
-- pinned them.
--
-- Model selection otherwise belongs entirely to the `agent-model-workstream`
-- Flagship flag (`docs/FEATURE_FLAGS.md`): one route plan per agent, rolled out
-- per workspace, identical for every work stream in it. That is the right
-- default and the wrong tool for the question the composer's developer-mode
-- selector answers — "what does *this* piece of work look like on that other
-- model" — which is per work stream, decided at creation, and not something to
-- stage a rollout for.
--
-- So the override lives beside the work stream rather than in the flag. NULL is
-- the overwhelming majority and means the flag decides; a value is the model id
-- exactly as OpenRouter publishes it, chosen from the closed list in
-- `AGENT_MODEL_OVERRIDES`.
--
-- Deliberately no CHECK constraint enumerating those ids. The list is a product
-- decision that moves — a model is retired, a new one is added — and pinning it
-- into the schema would make every such change a migration, and would make a
-- retired id unwritable while leaving the rows already carrying it untouched
-- anyway. The API validates on write against the contract and again on read, so
-- a value that leaves the list stops being honoured without a schema change.
ALTER TABLE workstreams ADD COLUMN model_override TEXT;

-- The same override for an automation, held on the subscription because the
-- work streams it applies to do not exist yet: each run copies it onto the work
-- stream it creates. Copying rather than joining is what makes the run's model
-- readable from one row, and what keeps a run that already happened describing
-- the model it was pinned to even after the automation is repointed.
ALTER TABLE automation_subscriptions ADD COLUMN model_override TEXT;
