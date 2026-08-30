(ns webapp.audit.views.time-window-modal
  "Approve-with-time-window picker: one-click duration presets starting now,
  or a custom start/end range. Times are local; the backend wraps a window
  whose end is earlier than its start to the next day."
  (:require
   ["@radix-ui/themes" :refer [Box Button Flex Grid Heading Text]]
   [reagent.core :as r]
   [webapp.components.forms :as forms]
   [webapp.formatters :as formatters]))

(def ^:private duration-options
  [{:label "30 min" :value 30}
   {:label "1 hour" :value 60}
   {:label "2 hours" :value 120}
   {:label "4 hours" :value 240}
   {:label "8 hours" :value 480}
   {:label "Custom" :value :custom}])

(defn- now-plus [minutes]
  (let [d (js/Date.)]
    (.setMinutes d (+ (.getMinutes d) minutes))
    d))

(defn main [{:keys [on-confirm on-cancel]}]
  (let [selected (r/atom 60) ;; minutes, or :custom
        start-time (r/atom "")
        end-time (r/atom "")]
    (fn [_]
      [:form {:class "w-full space-y-radix-6"
              :on-submit (fn [e]
                           (.preventDefault e)
                           (if (= @selected :custom)
                             (on-confirm {:start-time @start-time
                                          :end-time @end-time})
                             ;; Presets resolve at submit time so the window
                             ;; really starts now, not when the modal opened.
                             (on-confirm {:start-time (formatters/date->hhmm (js/Date.))
                                          :end-time (formatters/date->hhmm (now-plus @selected))})))}
       [:> Box
        [:> Heading {:as "h1" :size "6" :weight "bold" :class "text-gray-12"}
         "Approve with time window"]
        [:> Text {:as "p" :size "2" :class "text-gray-11"}
         "The command can only be executed inside this window."]]

       [:> Flex {:gap "2" :wrap "wrap"}
        (for [{:keys [label value]} duration-options]
          ^{:key label}
          [:> Button {:type "button"
                      :size "2"
                      :variant (if (= @selected value) "solid" "soft")
                      :color (if (= @selected value) "indigo" "gray")
                      :on-click #(reset! selected value)}
           label])]

       (if (= @selected :custom)
         [:> Box
          [:> Grid {:columns "2" :gap "3"}
           [forms/input {:label "Start time"
                         :type "time"
                         :required true
                         :value @start-time
                         :on-change #(reset! start-time (-> % .-target .-value))}]
           [forms/input {:label "End time"
                         :type "time"
                         :required true
                         :value @end-time
                         :on-change #(reset! end-time (-> % .-target .-value))}]]
          [:> Text {:as "p" :size "1" :class "text-gray-10"}
           "Local time. An end time earlier than the start time rolls over to the next day."]]
         [:> Text {:as "p" :size "2" :class "text-gray-11"}
          (str "Starts now (" (formatters/date->hhmm (js/Date.)) ") and ends at "
               (formatters/date->hhmm (now-plus @selected)) ".")])

       [:> Flex {:justify "end" :align "center" :gap "3"}
        [:> Button {:type "button"
                    :size "3"
                    :variant "ghost"
                    :color "gray"
                    :on-click on-cancel}
         "Cancel"]
        [:> Button {:size "3" :type "submit"}
         "Approve for this window"]]])))
