(ns webapp.components.rich-output
  "Single decision point for turning command output into a rich view
  (Documents tree or kubectl Table). Owns the SQL exclusion and the size cap
  so the Terminal panel and the session modal cannot drift, and caches the
  parse per holder so re-renders get identical data back — which also lets
  Reagent skip re-rendering unchanged subtrees."
  (:require
   [webapp.components.document-tree :as doc-tree]
   [webapp.components.kubectl-table :as kubectl-table]))

;; SQL output has its own Tabular pipeline everywhere; never rich-parse it.
(def sql-subtypes
  #{"mysql" "mysql-csv" "postgres" "postgres-csv" "sql-server" "sql-server-csv"
    "mssql" "oracledb" "database"})

;; Rich parses walk the whole payload and build a full component tree; above
;; this the raw Logs / streamed viewers are the right tool.
(def ^:private max-parse-chars (* 2 1024 1024))

(defn new-cache
  "One cache per rendering component (same pattern as results-matrix)."
  []
  (atom nil))

(defn- classify* [connection-type response]
  (when-not (or (nil? response)
                (contains? sql-subtypes connection-type)
                (> (count response) max-parse-chars))
    ;; parse-documents dispatches on the connection type itself and returns
    ;; nil for non-document types, so no subtype list is needed here; the
    ;; kubectl parser's own guards reject non-k8s output.
    (if-let [docs (doc-tree/parse-documents connection-type response)]
      {:kind :documents :data docs}
      (when-let [table (kubectl-table/parse-output response)]
        {:kind :k8s-table :data table}))))

(defn classify
  "Returns {:kind :documents|:k8s-table :data ...} or nil, cached on the
  [connection-type response] pair (response by identity — it is a large
  string)."
  [cache connection-type response]
  (let [{:keys [ctype resp result]} @cache]
    (if (and (= ctype connection-type) (identical? resp response))
      result
      (let [result (classify* connection-type response)]
        (reset! cache {:ctype connection-type :resp response :result result})
        result))))
