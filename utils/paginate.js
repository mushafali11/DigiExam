// Optional pagination and search for list endpoints.
// If the request has no page and no limit, nothing changes: the full list is returned as before.

// Reads ?page= and ?limit=. Returns { enabled: false }, { error }, or { enabled: true, page, limit, offset }.
function readPaging(query) {
  if (query.page === undefined && query.limit === undefined) return { enabled: false };

  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);

  if (!Number.isInteger(page) || page < 1) {
    return { error: 'page must be a whole number, 1 or more' };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { error: 'limit must be a whole number from 1 to 100' };
  }
  return { enabled: true, page, limit, offset: (page - 1) * limit };
}

function pagingMeta(paging, total) {
  return {
    page: paging.page,
    limit: paging.limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / paging.limit)),
  };
}

// Reads ?search= (trimmed, at most 100 characters)
function readSearch(query) {
  return typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
}

// Turns search text into an ILIKE pattern. The characters \ % _ are escaped,
// so a search for "50%" finds a literal percent sign instead of matching everything.
// Use it together with:  ILIKE $n ESCAPE '\'
function likePattern(text) {
  return '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
}

module.exports = { readPaging, pagingMeta, readSearch, likePattern };