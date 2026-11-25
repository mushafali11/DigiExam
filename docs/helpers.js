// Helpers for describing the API in OpenAPI format (used by pathsA.js, pathsB.js and openapi.js).

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const num = (extra = {}) => ({ type: 'number', ...extra });
const bool = (extra = {}) => ({ type: 'boolean', ...extra });
const date = (extra = {}) => ({ type: 'string', format: 'date-time', ...extra });
const arr = (items) => ({ type: 'array', items });
const obj = (properties, required = []) => ({
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
});
const json = (schema) => ({ 'application/json': { schema } });

const ROLE = str({ enum: ['teacher', 'student', 'admin'] });
const LEVEL = str({ enum: ['easy', 'medium', 'hard'] });
const REASON = str({ enum: ['manual', 'time_up', 'switch_limit'], nullable: true });
const message = obj({ message: str() });

const idParam = (name = 'id', description = 'Id') => ({
    name, in: 'path', required: true, schema: int({ minimum: 1 }), description,
});
const queryParam = (name, schema, description) => ({
    name, in: 'query', required: false, schema, description,
});
const PAGING = [
    queryParam('page', int({ minimum: 1 }), 'Page number. Using page or limit turns pagination on'),
    queryParam('limit', int({ minimum: 1, maximum: 100 }), 'Rows per page (default 20 when pagination is on)'),
];
const SEARCH = (where) =>
    queryParam('search', str({ maxLength: 100 }), `Case-insensitive text search in ${where}`);

const ERRORS = {
    400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'NotFound', 409: 'Conflict', 429: 'TooManyRequests',
};

const paths = {};

// Adds one operation. Options:
//   tag, summary, who, description, params, body, ok (schema), code (success status), csv,
//   more (extra success responses), errors (list of status codes), public (no login needed)
function add(method, path, o) {
    const responses = {};
    responses[o.code || 200] = {
        description: o.okDescription || 'Success',
        ...(o.csv
            ? { content: { 'text/csv': { schema: str() } } }
            : o.ok
                ? { content: json(o.ok) }
                : {}),
    };
    if (o.more) Object.assign(responses, o.more);

    const errors = new Set(o.errors || []);
    if (!o.public) errors.add(401);
    for (const code of errors) responses[code] = { $ref: `#/components/responses/${ERRORS[code]}` };

    const operation = {
        tags: [o.tag],
        summary: o.summary,
        description: (o.who ? `**Who:** ${o.who}.\n\n` : '') + (o.description || ''),
        parameters: o.params,
        requestBody: o.body ? { required: true, content: json(o.body) } : undefined,
        responses,
        security: o.public ? [] : [{ bearerAuth: [] }],
    };
    if (!paths[path]) paths[path] = {};
    paths[path][method] = operation;
}

module.exports = {
    ref, str, int, num, bool, date, arr, obj, json, ROLE, LEVEL, REASON, message,
    idParam, queryParam, PAGING, SEARCH, add, paths,
};