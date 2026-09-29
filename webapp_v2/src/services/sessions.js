import api from './api'

export const sessionsService = {
  list: (params) => api.get('/sessions', { params }),

  // Blocking exec: the gateway holds the request open up to 50s and returns the
  // output inline. A 202 means the exec is still running server-side — poll
  // getById until status is "done", then re-fetch with the event stream.
  execute: (payload) => api.post('/sessions', payload),

  getById: (id, { expandEventStream = false } = {}) =>
    api.get(`/sessions/${id}`, {
      params: expandEventStream
        ? { expand: 'event_stream', event_stream: 'base64' }
        : undefined,
    }),
}
