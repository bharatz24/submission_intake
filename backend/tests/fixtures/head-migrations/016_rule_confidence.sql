-- Rules-only verdicts were stored with a fixed confidence (0.90 submission, 0.85 ignore). Recompute it from the rule
-- score, the sum of the "+3: ..." / "-6: ..." reasons, with the formula in ruleConfidence (classificationRules.ts).
-- Rows with a Claude reason ("LLM: ..."), a person's override (confidence 1) or any other value are left alone.
WITH scored AS (
  SELECT s.id, s.classification, sum((substring(r FROM '^([+-][0-9]+):'))::int) AS score
  FROM submissions s, jsonb_array_elements_text(s.classification_reasons) AS r
  WHERE (s.classification = 'NOT_SUBMISSION' AND s.classification_confidence BETWEEN 0.849 AND 0.851
      OR s.classification = 'SUBMISSION' AND s.classification_confidence BETWEEN 0.899 AND 0.901)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.classification_reasons) AS l WHERE l LIKE 'LLM%')
  GROUP BY s.id, s.classification
)
UPDATE submissions s
SET classification_confidence = round(LEAST(0.99, GREATEST(0, CASE
      WHEN sc.classification = 'SUBMISSION' THEN 0.9 + 0.01 * (sc.score - 9)
      ELSE 0.85 + 0.02 * (-4 - sc.score) END))::numeric, 2)
FROM scored sc
WHERE s.id = sc.id
  AND sc.score IS NOT NULL
  AND (sc.classification = 'SUBMISSION' AND sc.score >= 9 OR sc.classification = 'NOT_SUBMISSION' AND sc.score <= -4);
