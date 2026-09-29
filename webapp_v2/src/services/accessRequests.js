import api from './api'

export const accessRequestsService = {
  // Omitting `page_size` returns every rule: the handler defaults it to 0 and
  // reads 0 as "no pagination" (gateway/api/accessrequests/rules.go:214). The
  // response is the paginated envelope { pages, data } either way.
  list: () => api.get('/access-requests/rules'),
  // Rule names are user-defined and travel in the path, so every segment is
  // encoded.
  get: (name) => api.get(`/access-requests/rules/${encodeURIComponent(name)}`),
  create: (payload) => api.post('/access-requests/rules', payload),
  update: (name, payload) =>
    api.put(`/access-requests/rules/${encodeURIComponent(name)}`, payload),
  remove: (name) => api.delete(`/access-requests/rules/${encodeURIComponent(name)}`),

  // The rules the signed-in user may ask for a time window against, each
  // already expanded into the resources one approval covers. Returns a bare
  // array, not the paginated envelope the rules endpoints use.
  listRequestable: () => api.get('/access-requests/requestable'),

  // Raises a standing request: { rule_name, duration_sec, justification }.
  // Answers 409 when the user already holds an unexpired grant on the rule.
  requestAccess: (payload) => api.post('/access-requests', payload),
}
