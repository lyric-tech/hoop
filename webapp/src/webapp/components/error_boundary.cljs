(ns webapp.components.error-boundary
  "React error boundary for Reagent subtrees.

  Without one, a throw inside any component unmounts the entire React tree
  and the user gets a white screen. Wrap the risky panel instead, and a
  crash degrades to `:fallback` while the rest of the page keeps working.

  Usage:

    [error-boundary/main {:fallback [plain-view text]}
     [risky-view text]]"
  (:require
   [goog.object :as gobj]
   [reagent.core :as r]))

;; State is read/written through string keys: `#js {:failed true}` emits an
;; unquoted property that Closure renames under :advanced, and `.-failed`
;; would then read a different name than the one React stored.
(def ^:private failed-key "failed")

(def main
  (r/create-class
   {:display-name "error-boundary"

    :get-initial-state (fn [_this] (js-obj failed-key false))

    ;; React calls this during the render phase and immediately re-renders,
    ;; so the fallback has to be driven by this state. Driving it from
    ;; component-did-catch instead is too late — that runs in the commit
    ;; phase, so the boundary re-renders the throwing child first, throws
    ;; again, and React tears down the whole tree as unrecoverable.
    :get-derived-state-from-error (fn [_error] (js-obj failed-key true))

    :component-did-catch
    (fn [_this error _info]
      (js/console.error "error-boundary caught:" error))

    :reagent-render
    (fn [{:keys [fallback]} & children]
      (if (gobj/get (.-state ^js (r/current-component)) failed-key)
        (or fallback [:<>])
        (into [:<>] children)))}))
