-- The automatic quote after an Underwriting Analysis (services/rating/autoQuote.ts) is its own LLM task.
ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_task_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_task_check
    CHECK (task = ANY (ARRAY['classification', 'extraction', 'synthesis', 'analysis', 'chat', 'comparison', 'quote']));
