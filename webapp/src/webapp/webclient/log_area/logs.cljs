(ns webapp.webclient.log-area.logs
  (:require ["@radix-ui/themes" :refer [Box Button Callout Spinner Flex Text]]
            ["lucide-react" :refer [AlertTriangle Clock Play]]
            [clojure.string :as cs]
            [re-frame.core :as rf]
            [webapp.audit.views.session-details :as session-details]
            [webapp.audit.views.time-window-modal :as time-window-modal]
            [webapp.formatters :as formatters]))

(def ^:const max-rendered-chars
  "Upper bound on how much output reaches the DOM.

  This panel renders output into one unvirtualized `whitespace-pre` node, and
  Chrome clamps layout at 2^25 px — which a single unwrapped line hits at ~3.8M
  characters, leaving the viewport blank behind a huge scrollbar (EVL-121).
  Measured at 14px monospace: 512KB lays out in 16ms at 4.4M px, ~8x below the
  clamp, where 4MB is already clamped. Layout is only half the cost though —
  scroll repaint of a very wide node degrades well before the clamp, so the
  bound is set from what stays responsive in a real browser, not from the
  headless numbers. Full output stays reachable through the output menu."
  (* 512 1024))

(defn- humanize-size
  "Formats a character count as a size; terminal output is effectively ASCII."
  [n]
  (cond
    (>= n (* 1024 1024)) (str (.toFixed (/ n 1024 1024) 1) " MB")
    (>= n 1024) (str (.toFixed (/ n 1024) 1) " KB")
    :else (str n " B")))

(defn- truncation-notice
  [total-chars]
  [:> Callout.Root {:color "amber"
                    :size "1"
                    :class "mb-3 whitespace-normal"}
   [:> Callout.Icon
    [:> AlertTriangle {:size 16}]]
   [:> Callout.Text {:size "1"}
    (str "Output truncated for display — showing the first "
         (humanize-size max-rendered-chars) " of " (humanize-size total-chars)
         ". Use the output menu to download or view the complete result.")]])

(defn open-session-details
  "Opens the session-details modal for an exec session. Shared by the
  webclient output surfaces."
  [session-id]
  (rf/dispatch [:modal->open
                {:id "session-details"
                 :maxWidth "95vw"
                 :content [session-details/main {:id session-id :verb "exec"}]}]))

;; One row per banner state: [title description callout-color icon], where
;; icon is :spinner, :alert or :clock.
(defn- review-copy [state review-status]
  (case state
    :waiting-approval ["Waiting for review approval"
                       "This run needs approval. The result will show up here as soon as it is approved and finishes."
                       "blue" :spinner]
    :ready ["Approved — ready to run"
            "The review was approved. Execute it and the result will show up here."
            "blue" :clock]
    :executing ["Approved — executing"
                "The review was approved and the command is running."
                "blue" :spinner]
    :fetching-output ["Loading result"
                      "The run finished — fetching its output."
                      "blue" :spinner]
    :rejected [(if (= review-status "REVOKED") "Review revoked" "Review rejected")
               "This run was not approved, so there is no output."
               "red" :alert]
    :large-output ["Result too large to show here"
                   "The run finished, but its output is over 4MB. Open the session details to view or download it."
                   "amber" :clock]
    :poll-timeout ["Still waiting for this review"
                   "No decision after 2 minutes. Check again, or open the session details to track it."
                   "gray" :clock]
    ["Checking review status"
     "This run needs review. Watching the session so the result shows up here."
     "blue" :spinner]))

(defn- review-banner
  "Live status for a reviewed run. The panel polls the session in the
  background (see :editor-plugin->poll-review-session) and swaps this banner
  for the real output once the run finishes."
  [{:keys [review-info session-id execution-time]}]
  (let [{:keys [state review-status review-id can-review?]} review-info
        [title description color icon] (review-copy state review-status)
        restart-poll! #(rf/dispatch [:editor-plugin->poll-review-session session-id 0])
        decide! (fn [decision & opts]
                  (rf/dispatch (into [:audit->add-review {:review-id review-id} decision] opts))
                  (restart-poll!))
        approve-window! (fn []
                          (rf/dispatch
                           [:modal->open
                            {:id "time-window-modal"
                             :maxWidth "500px"
                             :content [time-window-modal/main
                                       {:on-confirm
                                        (fn [{:keys [start-time end-time]}]
                                          (decide! "approved"
                                                   :start-time start-time
                                                   :end-time end-time)
                                          (rf/dispatch [:modal->close]))
                                        :on-cancel #(rf/dispatch [:modal->close])}]}]))
        execute! (fn []
                   (rf/dispatch [:audit->execute-session {:id session-id}])
                   (rf/dispatch [:editor-plugin->review-set-state session-id :executing])
                   (restart-poll!))]
    [:> Box {:class "py-regular pl-regular pr-large whitespace-normal"}
     [:> Callout.Root {:color color :size "1"}
      [:> Callout.Icon
       (case icon
         :spinner [:> Spinner {:loading true}]
         :alert [:> AlertTriangle {:size 16}]
         [:> Clock {:size 16}])]
      [:> Flex {:direction "column" :gap "2" :align "start"}
       [:> Text {:size "2" :weight "medium"} title]
       [:> Text {:size "1"} description]
       (when session-id
         [:> Flex {:gap "2" :align "center" :wrap "wrap"}
          (case state
            :ready
            [:> Button {:size "1" :on-click execute!}
             [:> Play {:size 12}] "Execute"]

            :waiting-approval
            (when can-review?
              [:<>
               [:> Button {:size "1" :color "green" :on-click #(decide! "approved")}
                "Approve"]
               [:> Button {:size "1" :variant "soft" :on-click approve-window!}
                "Approve with time window"]
               [:> Button {:size "1" :variant "soft" :color "red" :on-click #(decide! "rejected")}
                "Reject"]])

            :poll-timeout
            [:> Button {:size "1" :variant "soft" :on-click restart-poll!}
             "Check again"]

            nil)
          [:> Button {:size "1" :variant "soft" :color "gray"
                      :on-click #(open-session-details session-id)}
           "View session details"]])]]
     [:div {:class "text-gray-11 text-sm mt-2"}
      (str (formatters/current-time) " [cost " (formatters/time-elapsed execution-time) "]")]]))

(defn- logs-area-list
  [status {:keys [logs logs-status logs-truncated? logs-total-chars
                  execution-time has-review? review-info session-id]}]
  (case status
    :success (if has-review?
               [review-banner {:review-info review-info
                               :session-id session-id
                               :execution-time execution-time}]

               [:div {:class " group relative py-regular pl-regular pr-large whitespace-pre"}
                (when logs-truncated?
                  [truncation-notice logs-total-chars])
                [:div {:class "text-sm mb-1"}
                 logs]
                [:div {:class (str (if (= logs-status "success")
                                     "text-gray-11 text-sm"
                                     "text-gray-11 text-sm"))}
                 (str (formatters/current-time) " [cost " (formatters/time-elapsed execution-time) "]")]])
    :loading [:div {:class "flex gap-regular py-regular pl-regular pr-large"}
              [:> Spinner {:loading true}]
              [:span "loading"]]
    :running [:> Box {:class "group relative py-regular pl-regular pr-large"}
              [:> Flex {:align "start" :gap "3"}
               [:> Box {:class "flex-shrink-0 text-info-11 mt-0.5"}
                [:> Clock {:size 18}]]
               [:> Flex {:direction "column" :gap "2"}
                [:> Text {:size "2" :weight "medium" :class "text-gray-12"}
                 "Session is still running"]
                [:> Text {:size "2" :class "text-gray-11"}
                 (str "The gateway timed out after 50s waiting for the result. "
                      "Your session keeps executing in the background.")]
                (when session-id
                  [:<>
                   [:> Button {:size "1"
                               :variant "soft"
                               :on-click #(open-session-details session-id)}
                    "View session details"]
                   [:> Text {:size "1" :class "text-gray-10 font-mono"}
                    (str "Session: " session-id)]])]]]
    :failure [:div {:class " group relative py-regular pl-regular pr-large whitespace-pre"}
              [:div {:class "text-sm mb-1"}
               "There was an error to get the logs for this task"]
              [:div {:class "text-gray-11 text-sm"}
               (str (formatters/current-time) " [cost " (formatters/time-elapsed execution-time) "]")]]
    [:div {:class "flex gap-regular py-regular pl-regular pr-large"}
     [:span  "No logs to show"]]))

(defn main
  "config is a map with the following fields:
      :status -> possible values are :success :running :loading :failure. Anything different will be default to an generic error message
      :id -> id to differentiate more than one log on the same page.
      :logs -> the actual string with the logs

   Output above `max-rendered-chars` is cut before it reaches the DOM; the full
   string stays in the app db for the output menu."
  [type config]
  (let [full-response (:response config)
        total-chars (count full-response)
        truncated? (> total-chars max-rendered-chars)
        ;; Derived from the bounded string, so no render walks the full payload.
        display-response (if truncated?
                           (subs full-response 0 max-rendered-chars)
                           full-response)
        line-count (when display-response
                     (count (cs/split-lines display-response)))
        aria-label-text (str "Execution output. "
                             (case (:status config)
                               :success (str "Status: success. "
                                             line-count " lines"
                                             (when truncated?
                                               (str ", truncated for display out of "
                                                    (humanize-size total-chars)
                                                    " total")))
                               :running "Status: still running after gateway timeout"
                               :loading "Status: executing..."
                               :failure "Status: failed"
                               "No output"))]
    [:div {:class "relative h-full"}
     [:section
      {:class (str "bg-gray-2 font-mono h-full"
                   " whitespace-pre text-gray-11 text-sm overflow-auto"
                   " h-full")
       :role "log"
       :tabIndex "0"
       :aria-label aria-label-text
       :aria-live (if (= (:status config) :loading) "assertive" "polite")
       :style {:overflow-anchor "none"}}
      (case type
        :logs
        [logs-area-list (:status config)
         {:logs display-response
          :logs-truncated? truncated?
          :logs-total-chars total-chars
          :logs-status (:response-status config)
          :script (:script config)
          :execution-time (:execution-time config)
          :has-review? (:has-review config)
          :review-info (:review-info config)
          :session-id (:response-id config)}])]]))
