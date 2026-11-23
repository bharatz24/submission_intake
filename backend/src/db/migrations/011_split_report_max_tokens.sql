-- The one report output limit (Settings → Claude API, app_settings 'anthropic_report_max_tokens') became three limits
-- in Settings → Limits (services/limitsSettings.ts): synthesisMaxTokens, analysisMaxTokens and comparisonMaxTokens.
-- A saved value carries over to all three; limits an admin already saved there are kept. limitsSettings drops any
-- value outside the new bounds, so it is copied as stored.
INSERT INTO app_settings (key, value, updated_by, updated_at)
SELECT 'limits_settings',
       jsonb_build_object('synthesisMaxTokens', legacy.value, 'analysisMaxTokens', legacy.value, 'comparisonMaxTokens', legacy.value),
       legacy.updated_by, legacy.updated_at
FROM app_settings legacy
WHERE legacy.key = 'anthropic_report_max_tokens' AND jsonb_typeof(legacy.value) = 'number'
ON CONFLICT (key) DO UPDATE SET value = CASE WHEN jsonb_typeof(app_settings.value) = 'object'
    THEN EXCLUDED.value || app_settings.value ELSE EXCLUDED.value END;

DELETE FROM app_settings WHERE key = 'anthropic_report_max_tokens';
