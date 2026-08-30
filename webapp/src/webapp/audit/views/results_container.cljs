(ns webapp.audit.views.results-container
  (:require
   ["@radix-ui/themes" :refer [Box Flex]]
   [clojure.string :as string]
   [reagent.core :as r]
   [webapp.components.ag-grid-table :as ag-grid-table]
   [webapp.components.document-view :as doc-view]
   [webapp.components.kubectl-table :as kubectl-table]
   [webapp.components.logs-container :as logs]
   [webapp.components.results-download-menu :as download-menu]
   [webapp.components.results-matrix :as results-matrix]
   [webapp.components.rich-output :as rich-output]
   [webapp.components.tabs :as tabs]))

(defn- parse-results
  [cache results connection-type]
  (when (some? results)
    (results-matrix/parse-results
     cache
     (if (= connection-type "oracledb")
       (string/join "\n" (drop 1 (string/split results #"\n")))
       results))))

(defn- tabbed-results
  "Tab bar + panel over an ordered vector of [name hiccup]; the first entry
  is the default tab."
  [_]
  (let [view (r/atom nil)]
    (fn [{:keys [tab-views download-props]}]
      (let [current (or @view (first (first tab-views)))]
        [:> Flex {:direction "column" :class "h-96 min-h-96"}
         [:> Flex {:justify "between" :align "center" :gap "4" :class "flex-shrink-0"}
          [:> Box {:class "flex-1 min-w-0"}
           [tabs/tabs {:on-change #(reset! view %)
                       :tabs (mapv first tab-views)}]]
          (when download-props
            [:> Box {:class "mb-large flex-shrink-0"}
             [download-menu/main download-props]])]
         [:> Box {:class "flex-1 min-h-0 overflow-hidden"}
          (some (fn [[nm v]] (when (= nm current) v)) tab-views)]]))))

(defmulti results-view identity)

(defmethod results-view :sql
  [_ {:keys [results-heads results-body results status download-props]}]
  [tabbed-results
   {:tab-views [["Plain text" [logs/virtualized-container {:status status :logs results}]]
                ["Table" [ag-grid-table/main results-heads results-body false true
                          {:height "100%"
                           :theme "alpine"
                           :pagination? (boolean (and results-body
                                                      (> (.-length results-body) 100)))
                           :auto-size-columns? true}]]]
    :download-props download-props}])

;; Document/JSON output (Mongo, DynamoDB, CloudWatch) → the same viewer the
;; Terminal panel uses (List/JSON/Table + expand controls).
(defmethod results-view :documents
  [_ {:keys [documents results status download-props]}]
  [tabbed-results
   {:tab-views [["Documents" [doc-view/main documents]]
                ["Plain text" [logs/virtualized-container {:status status :logs results}]]]
    :download-props download-props}])

;; kubectl `get` output → resource table with status pills.
(defmethod results-view :k8s-table
  [_ {:keys [table-data results status download-props]}]
  [tabbed-results
   {:tab-views [["Table" [kubectl-table/main table-data]]
                ["Plain text" [logs/virtualized-container {:status status :logs results}]]]
    :download-props download-props}])

(defmethod results-view :not-sql
  [_ {:keys [results status classes download-props fixed-height?]}]
  [:> Flex {:direction "column"
            :class (if fixed-height? "h-96 min-h-96" "h-full")}
   (when download-props
     [:> Flex {:justify "end" :class "mb-small flex-shrink-0"}
      [download-menu/main download-props]])
   [:> Box {:class "flex-1 min-h-0 overflow-hidden"}
    [logs/virtualized-container {:status status :logs results :classes classes}]]])

(defn main []
  (let [matrix-cache (results-matrix/new-cache)
        rich-cache (rich-output/new-cache)]
    (fn [connection-subtype {:keys [results results-status fixed-height? classes
                                    session-id connection-name has-large-payload?]}]
      (let [parsed (parse-results matrix-cache results connection-subtype)
            results-heads (:heads parsed)
            results-body (:body parsed)
            is-sql? (contains? rich-output/sql-subtypes connection-subtype)
            ;; Streamed large payloads stay plain text; classify also enforces
            ;; its own size cap and caches the parse.
            rich (when (and (= results-status :success)
                            (not has-large-payload?))
                   (rich-output/classify rich-cache connection-subtype results))
            tabular? (boolean (and is-sql?
                                   results-heads results-body
                                   (pos? (.-length results-heads))
                                   (pos? (.-length results-body))))
            download-props (when (= results-status :success)
                             {:results results
                              :matrix (:matrix parsed)
                              :tabular? tabular?
                              :session-id session-id
                              :connection-name connection-name
                              :has-large-payload? has-large-payload?})
            props-log-view {:results-heads results-heads
                            :results-body results-body
                            :fixed-height? fixed-height?
                            :status results-status
                            :results results
                            :classes classes
                            :download-props download-props}]

        (cond
          (= (:kind rich) :documents)
          [results-view :documents (assoc props-log-view :documents (:data rich))]

          (= (:kind rich) :k8s-table)
          [results-view :k8s-table (assoc props-log-view :table-data (:data rich))]

          (and (= results-status :success) is-sql?)
          [results-view :sql props-log-view]

          :else
          [results-view :not-sql props-log-view])))))
