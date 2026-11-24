-- The in-app AI assistant is removed; Grafito's content is reached from outside through the MCP
-- server (/api/mcp) with a personal token. Nothing the person wrote or uploaded is touched: these
-- tables only held the assistant's conversations, personas, provider policy and provider keys.
-- The daily dumps in ./backups keep them if an older version is restored.

delete from app_role_permission where permission_key in ('ai.use', 'ai.manage');
delete from app_permission where key in ('ai.use', 'ai.manage');

-- Personal tokens now serve the REST API and MCP.
update app_permission
set label = 'API y MCP',
    description = 'Crear tokens personales para la API REST y el servidor MCP',
    area = 'API'
where key = 'api.use';

drop table if exists ai_conversation;
drop table if exists ai_profile;
drop table if exists ai_credential;
drop table if exists ai_provider;
