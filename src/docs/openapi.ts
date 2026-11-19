import { OpenApiGeneratorV31, type OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { env } from '../config/env';

const DESCRIPTION = `
Multi-tenant REST API for the AI School & Academy Operating System.

## Conventions
- **Base URL:** \`/api/v1\`. Health checks live at \`/health\` and \`/health/ready\`.
- **Success envelope:** \`{ "data": ... }\`. Paginated lists: \`{ "data": [...], "meta": { "page", "limit", "total", "totalPages" } }\`.
- **Error envelope:** \`{ "error": { "code", "message", "details"?, "requestId" } }\`. Branch on \`code\`, not on \`message\`.
- **Ids:** MongoDB ObjectIds returned as \`_id\` (24 hex chars).
- **Money:** whole Pakistani rupees as integers (e.g. \`4500\` = Rs 4,500).
- **Dates:** calendar dates as \`YYYY-MM-DD\`; timestamps ISO-8601 UTC; billing periods \`YYYY-MM\`.
- **Pagination:** \`?page=1&limit=20\` (max 100).
- **Correlation:** every response carries \`X-Request-Id\`; send your own \`X-Request-Id\` to correlate logs.

## Authentication
Two independent identities:
- **School users** (\`schoolBearer\`): \`POST /api/v1/auth/login\`. Roles: school_owner, principal, school_admin, accountant, teacher, parent, student.
- **Platform administrators** (\`platformBearer\`): \`POST /api/v1/platform/auth/login\`. Roles: platform_owner, platform_admin.

Access tokens expire after ${env.ACCESS_TOKEN_TTL_MINUTES} minutes (\`TOKEN_EXPIRED\`). Refresh with the single-use refresh token; each refresh returns a new pair.

## Tenancy
The school (tenant) is derived from the access token only. No endpoint accepts a schoolId from the client for school users.
Ids belonging to another school always return \`404 NOT_FOUND\`.

## Common error codes
\`VALIDATION_ERROR\`, \`UNAUTHORIZED\`, \`TOKEN_EXPIRED\`, \`INVALID_CREDENTIALS\`, \`ACCOUNT_LOCKED\`, \`ACCOUNT_DISABLED\`, \`FORBIDDEN\`,
\`SCHOOL_SUSPENDED\`, \`SUBSCRIPTION_INACTIVE\`, \`PLAN_LIMIT_REACHED\`, \`NOT_FOUND\`, \`DUPLICATE\`, \`CONFLICT\`, \`INVALID_REFERENCE\`,
\`TIMETABLE_CONFLICT\`, \`APPROVAL_REQUIRED\`, \`RATE_LIMITED\`, \`AI_UNAVAILABLE\`, \`AI_LIMIT_REACHED\`, \`AI_PROVIDER_ERROR\`, \`CHANNEL_PAUSED\`, \`INTERNAL_ERROR\`.
`.trim();

export function buildOpenApiDocument(registry: OpenAPIRegistry) {
  registry.registerComponent('securitySchemes', 'schoolBearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Access token from POST /api/v1/auth/login',
  });
  registry.registerComponent('securitySchemes', 'platformBearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Access token from POST /api/v1/platform/auth/login',
  });
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: `${env.APP_NAME} API`, version: '1.0.0', description: DESCRIPTION },
    servers: [{ url: `http://localhost:${env.PORT}`, description: 'Local development' }],
  });
}
