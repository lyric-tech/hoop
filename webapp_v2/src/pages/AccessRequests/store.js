import { create } from 'zustand'
import { accessRequestsService } from '@/services/accessRequests'
import { reviewsService } from '@/services/reviews'

// A standing request is a jit review carrying the rule name, so the pending
// ones are found by filtering the (unbounded, unfiltered) reviews list.
function isStandingRequest(review) {
  return review?.type === 'jit' && Boolean(review?.access_request_rule_name)
}

export const useAccessRequestsStore = create((set, get) => ({
  rules: [],
  // 'idle' | 'loading' | 'success' | 'error'
  rulesStatus: 'idle',

  reviews: [],
  reviewsStatus: 'idle',

  submitting: false,

  fetchRules: async () => {
    set({ rulesStatus: 'loading' })
    try {
      const { data } = await accessRequestsService.listRequestable()
      set({ rules: data ?? [], rulesStatus: 'success' })
    } catch {
      set({ rulesStatus: 'error' })
    }
  },

  fetchReviews: async () => {
    set({ reviewsStatus: 'loading' })
    try {
      const data = await reviewsService.list()
      set({ reviews: (data ?? []).filter(isStandingRequest), reviewsStatus: 'success' })
    } catch {
      set({ reviewsStatus: 'error' })
    }
  },

  refresh: async () => {
    await Promise.all([get().fetchRules(), get().fetchReviews()])
  },

  requestAccess: async (payload) => {
    set({ submitting: true })
    try {
      await accessRequestsService.requestAccess(payload)
      await get().refresh()
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    } finally {
      set({ submitting: false })
    }
  },

  reviewRequest: async (id, status, rejectionReason) => {
    set({ submitting: true })
    try {
      await reviewsService.update(id, { status, rejection_reason: rejectionReason })
      await get().refresh()
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    } finally {
      set({ submitting: false })
    }
  },
}))
