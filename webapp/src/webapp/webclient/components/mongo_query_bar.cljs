(ns webapp.webclient.components.mongo-query-bar
  "Compass-style find bar for MongoDB connections: pick a collection, type a
  bare filter object ({createdBy: 'user@lyric.tech'}), hit Find. Builds
  db.getSiblingDB(<db>).<collection>.find(<filter>).limit(<n>) and dispatches
  :editor-plugin/submit-task, so metadata, JIRA-template gates, the review
  flow and the Documents viewer all apply exactly like an editor run.
  Collections come from the Database Schema state — the bar appears once a
  database is opened in the schema tree."
  (:require
   ["@radix-ui/themes" :refer [Button Flex Select Text TextField]]
   [clojure.string :as cs]
   [re-frame.core :as rf]
   [reagent.core :as r]
   [webapp.events.database-schema :as db-schema]
   [webapp.subs :as subs]))

(def ^:private default-limit 25)

(defn- parse-limit [s]
  (let [n (js/parseInt s 10)]
    (when (pos? n) n)))

(defn- build-script [db-name collection filter-text limit]
  (str "db.getSiblingDB(\"" db-name "\")." collection
       ".find(" (if (cs/blank? filter-text) "{}" (cs/trim filter-text)) ")"
       ".limit(" limit ")"))

(defn main [_]
  (let [schema (rf/subscribe [::subs/database-schema])
        ;; The text inputs are UNCONTROLLED (defaultValue + on-change into
        ;; these atoms): Radix TextField is a custom React component, so a
        ;; controlled :value prop drops keystrokes under Reagent's async
        ;; rendering (only native [:input] is patched for that).
        filter-text (r/atom "")
        filter-el (atom nil)
        collection (r/atom nil)
        limit (r/atom (str default-limit))]
    (fn [connection-name]
      (when-let [{:keys [database collections]}
                 (db-schema/mongo-find-target
                  (get-in @schema [:data connection-name]))]
        (let [sel (or @collection (first collections))
              find! (fn []
                      (rf/dispatch
                       [:editor-plugin/submit-task
                        {:script (build-script database sel @filter-text
                                               (or (parse-limit @limit)
                                                   default-limit))}]))]
          [:> Flex {:align "center" :gap "2"
                    :class "px-small py-1.5 bg-gray-2 border-t border-gray-3 flex-shrink-0"}
           [:> Text {:size "1" :class "text-gray-10 whitespace-nowrap"} database]
           [:> Select.Root {:size "1"
                            :value sel
                            :onValueChange #(reset! collection %)}
            [:> Select.Trigger {:placeholder "Collection"}]
            [:> Select.Content
             (for [c collections]
               ^{:key c} [:> Select.Item {:value c} c])]]
           [:> TextField.Root
            {:size "1"
             :class "flex-1 min-w-0 font-mono"
             :placeholder "{ createdBy: 'user@lyric.tech' }"
             :aria-label "Find filter"
             :defaultValue @filter-text
             :ref #(reset! filter-el %)
             :on-change #(reset! filter-text (-> % .-target .-value))
             :on-key-down (fn [e]
                            (when (= (.-key e) "Enter")
                              (find!)))}]
           [:> Text {:size "1" :class "text-gray-10"} "Limit"]
           [:> TextField.Root
            {:size "1"
             :class "w-14 font-mono"
             :aria-label "Result limit"
             :defaultValue @limit
             :on-change #(reset! limit (-> % .-target .-value))}]
           [:> Button {:size "1" :variant "soft" :color "gray"
                       :on-click (fn []
                                   (reset! filter-text "")
                                   (when-let [^js el @filter-el]
                                     (set! (.-value el) "")))}
            "Reset"]
           [:> Button {:size "1" :on-click find!}
            "Find"]])))))
