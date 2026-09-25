-- Global data is a JSON object. Rows written before that rule may hold another JSON value (for
-- example a list saved in the raw JSON editor, stored as JSON text inside a JSON string), or text
-- that is not JSON. The runtime would read those as {} and the next save would replace them, so each
-- is kept under a "value" key instead: `[1,2]` becomes `{"value":[1,2]}`. Rows that already read as
-- an object, including JSON text nested up to three levels deep, are left as they are.
--
-- To review the candidates before migrating (site code that reads one of them as a list or text then
-- reads `data.value`):
--   SELECT slug, data FROM galaxy_globals WHERE CASE WHEN json_valid(data) THEN json_type(data) <> 'object' ELSE 1 END;
-- A listed row that holds a JSON object as encoded text is left as it is, since it reads as that object.
UPDATE `galaxy_globals`
SET `data` = json_object('value', `data`)
WHERE NOT json_valid(`data`);
--> statement-breakpoint
UPDATE `galaxy_globals`
SET `data` = json_object('value', json(`data`))
WHERE CASE WHEN json_valid(`data`) THEN json_type(`data`) NOT IN ('object', 'text') ELSE 0 END;
--> statement-breakpoint
-- A JSON string holds the value as JSON text, encoded up to three times, or as plain text. The value
-- kept is the innermost one, as the runtime decodes it. CASE checks json_valid before each
-- json_type or json_extract, which fail on text that is not JSON.
UPDATE `galaxy_globals`
SET `data` = CASE
	WHEN NOT json_valid(json_extract(`data`, '$')) THEN json_object('value', json_extract(`data`, '$'))
	WHEN json_type(json_extract(`data`, '$')) <> 'text' THEN json_object('value', json(json_extract(`data`, '$')))
	WHEN NOT json_valid(json_extract(json_extract(`data`, '$'), '$')) THEN json_object('value', json_extract(json_extract(`data`, '$'), '$'))
	WHEN json_type(json_extract(json_extract(`data`, '$'), '$')) <> 'text' THEN json_object('value', json(json_extract(json_extract(`data`, '$'), '$')))
	WHEN NOT json_valid(json_extract(json_extract(json_extract(`data`, '$'), '$'), '$')) THEN json_object('value', json_extract(json_extract(json_extract(`data`, '$'), '$'), '$'))
	ELSE json_object('value', json(json_extract(json_extract(json_extract(`data`, '$'), '$'), '$')))
END
WHERE CASE
	WHEN json_valid(`data`) THEN
		CASE
			WHEN json_type(`data`) <> 'text' THEN 0
			WHEN NOT json_valid(json_extract(`data`, '$')) THEN 1
			WHEN json_type(json_extract(`data`, '$')) = 'object' THEN 0
			WHEN json_type(json_extract(`data`, '$')) <> 'text' THEN 1
			WHEN NOT json_valid(json_extract(json_extract(`data`, '$'), '$')) THEN 1
			WHEN json_type(json_extract(json_extract(`data`, '$'), '$')) = 'object' THEN 0
			WHEN json_type(json_extract(json_extract(`data`, '$'), '$')) <> 'text' THEN 1
			WHEN NOT json_valid(json_extract(json_extract(json_extract(`data`, '$'), '$'), '$')) THEN 1
			ELSE json_type(json_extract(json_extract(json_extract(`data`, '$'), '$'), '$')) <> 'object'
		END
	ELSE 0
END;
