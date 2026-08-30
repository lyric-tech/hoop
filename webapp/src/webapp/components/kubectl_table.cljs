(ns webapp.components.kubectl-table
  "Renders `kubectl get ...` output as a table with status pills. Prefers the
  well-structured JSON from `-o json` (robust — no fragile text parsing, per
  Venkat / lyric-cluster-dashboard), and falls back to parsing the space-aligned
  plain-text table for a default `kubectl get`. Only activates when the output
  actually looks like Kubernetes resources, so it won't hijack arbitrary output."
  (:require
   [clojure.string :as cs]
   [goog.object :as gobj]
   [reagent.core :as r]
   [webapp.formatters :as formatters]))

;; ── JSON path (preferred: `kubectl get ... -o json`) ───────────────────────

(defn- gv [obj & path]
  (apply gobj/getValueByKeys obj (clj->js path)))

(defn- rel-age [iso]
  (when-let [t (formatters/iso->ms iso)]
    (let [m (js/Math.floor (/ (- (.now js/Date) t) 60000))]
      (cond
        (< m 1) "0m"
        (< m 60) (str m "m")
        (< m 1440) (str (js/Math.floor (/ m 60)) "h")
        :else (str (js/Math.floor (/ m 1440)) "d")))))

(defn- ready-status [item]
  (let [conds (gv item "status" "conditions")]
    (when (js/Array.isArray conds)
      (some (fn [c] (when (= (gobj/get c "type") "Ready")
                      (if (= (gobj/get c "status") "True") "Ready" "NotReady")))
            (array-seq conds)))))

(defn- item->row [item]
  [(or (gv item "metadata" "namespace") "")
   (or (gv item "metadata" "name") "")
   (or (gv item "status" "phase") (ready-status item) "")
   (or (rel-age (gv item "metadata" "creationTimestamp")) "")])

(defn parse-k8s-json [output]
  (try
    (let [json (js/JSON.parse output)
          items (cond
                  (js/Array.isArray (gobj/get json "items")) (array-seq (gobj/get json "items"))
                  (and (object? json) (gobj/get json "kind") (gobj/get json "metadata")) [json]
                  :else nil)]
      (when (seq items)
        {:headers ["NAMESPACE" "NAME" "STATUS" "AGE"]
         :rows (mapv item->row items)}))
    (catch :default _ nil)))

;; ── Text path (fallback: default `kubectl get`) ────────────────────────────

(defn- looks-like-header? [line]
  (let [tokens (cs/split (cs/trim line) #"\s{2,}")]
    (and (>= (count tokens) 2)
         (every? #(re-matches #"[A-Z][A-Z0-9()%._/ -]*" %) tokens))))

;; Column name + its start index in the header line. Splitting on 2+ spaces
;; keeps two-word headers ("NOMINATED NODE") together, then indexOf recovers the
;; position so rows can be sliced at the same offsets.
(defn- header-columns [line]
  (loop [names (cs/split (cs/trim line) #"\s{2,}")
         from 0
         out []]
    (if-let [nm (first names)]
      (let [idx (.indexOf line nm from)]
        (recur (rest names) (+ idx (count nm)) (conj out [nm idx])))
      out)))

(defn parse-kubectl-table [output]
  (let [lines (->> (cs/split-lines (or output ""))
                   (remove cs/blank?))]
    (when (and (>= (count lines) 2) (looks-like-header? (first lines)))
      (let [cols (header-columns (first lines))
            starts (mapv second cols)
            headers (mapv first cols)
            n (count starts)
            slice-row (fn [line]
                        (let [len (count line)]
                          (mapv (fn [i]
                                  (let [s (min (nth starts i) len)
                                        e (if (< (inc i) n)
                                            (min (nth starts (inc i)) len)
                                            len)]
                                    (cs/trim (subs line s e))))
                                (range n))))
            rows (mapv slice-row (rest lines))]
        {:headers headers :rows rows}))))

;; Prefer structured JSON (`-o json`); fall back to the plain-text table.
;; Returns {:headers :rows} or nil.
(defn parse-output [output]
  (or (parse-k8s-json output)
      (parse-kubectl-table output)))

;; ── Status classification ─────────────────────────────────────────────────
;; Single source of truth: the summary chips, row dots and status pills all
;; derive from the bucket so they always agree.

(defn- status-bucket [s]
  (let [s (or s "")]
    (cond
      (contains? #{"Completed" "Succeeded"} s) :completed
      (contains? #{"Running" "Ready" "Active" "Bound" "Available" "Healthy"} s) :running
      ;; Cordoned nodes ("Ready,SchedulingDisabled") are a warning, not a failure.
      (cs/includes? s "SchedulingDisabled") :pending
      (or (contains? #{"Pending" "ContainerCreating" "PodInitializing" "Terminating"} s)
          (cs/starts-with? s "Init")) :pending
      :else :failed)))

;; Radix token classes so everything reads correctly in both themes.
(def ^:private bucket-style
  {:running    {:pill "bg-success-3 text-success-11" :dot "bg-success-9" :count "text-success-11"}
   :pending    {:pill "bg-warning-3 text-warning-11" :dot "bg-warning-9" :count "text-warning-11"}
   :failed     {:pill "bg-error-3 text-error-11"     :dot "bg-error-9"   :count "text-error-11"}
   :completed  {:pill "bg-gray-3 text-gray-11"       :dot "bg-gray-8"    :count "text-gray-11"}
   :restarting {:dot "bg-warning-9" :count "text-warning-11"}})

(defn- status-class [s] (get-in bucket-style [(status-bucket s) :pill]))
(defn- bucket-dot [b] (get-in bucket-style [b :dot]))
(defn- bucket-count-class [b] (get-in bucket-style [b :count]))

(defn- ready-class [s]
  (let [[a b] (cs/split (or s "") #"/")]
    (if (and a b (not= a b)) "text-warning-11 font-medium" "text-gray-12")))

(defn- col-index [headers name]
  (first (keep-indexed (fn [i h] (when (= h name) i)) headers)))

;; Leading integer of a RESTARTS cell — handles "1 (9h ago)".
(defn- restart-count [cell]
  (js/parseInt (or (re-find #"\d+" (or cell "")) "0") 10))

;; "5d4h" / "22h" / "30m" / "45s" → minutes, for AGE sorting. Unparseable
;; values sort last.
(defn- age->minutes [s]
  (let [pairs (re-seq #"(\d+)([dhms])" (or s ""))]
    (if (empty? pairs)
      ##Inf
      (reduce (fn [acc [_ n u]]
                (+ acc (* (js/parseInt n 10)
                          (case u "d" 1440 "h" 60 "m" 1 (/ 1 60)))))
              0
              pairs))))

;; ── Summary bar (pods and nodes) ──────────────────────────────────────────
;; Per-kind config: chip buckets + labels (:running always renders, the rest
;; only when their count is positive) and the footer noun.

(def ^:private kind-specs
  {:pods {:chips [[:running "Running"] [:pending "Pending"]
                  [:failed "Failed"] [:completed "Completed"]]
          :noun ["pod" "pods"]}
   :nodes {:chips [[:running "Ready"] [:pending "Cordoned"] [:failed "NotReady"]]
           :noun ["node" "nodes"]}})

(defn- summarize [kind rows {:keys [status-idx restarts-idx ns-idx version-idx]}]
  (let [base {:buckets (frequencies (map #(status-bucket (nth % status-idx "")) rows))
              :total (count rows)}]
    (case kind
      :pods (assoc base
                   :restarting (count (filter #(pos? (restart-count (nth % restarts-idx "")))
                                              rows))
                   :namespaces (when ns-idx
                                 (count (distinct (map #(nth % ns-idx "") rows)))))
      :nodes (assoc base
                    :versions (when version-idx
                                (vec (distinct (map #(nth % version-idx "") rows)))))
      nil)))

(defn- summary-footer [kind {:keys [total namespaces versions]}]
  (let [[sing plur] (get-in kind-specs [kind :noun])]
    (str total " " (if (= 1 total) sing plur)
         (case kind
           :pods (when namespaces
                   (str " · " namespaces
                        (if (= 1 namespaces) " namespace" " namespaces")))
           :nodes (when (seq versions)
                    ;; single version → show it; drift → count versions
                    (if (= 1 (count versions))
                      (str " · " (first versions))
                      (str " · " (count versions) " versions")))
           nil))))

(defn- sort-rows [rows {:keys [col dir]} headers]
  (if (or (nil? col) (>= col (count headers)))
    rows
    (let [keyfn (case (nth headers col)
                  "RESTARTS" #(restart-count (nth % col ""))
                  "AGE" #(age->minutes (nth % col ""))
                  nil)
          sorted (if keyfn
                   ;; decorate–sort–undecorate: the regex key runs n times
                   ;; instead of 2·n·log n
                   (->> rows
                        (mapv (juxt keyfn identity))
                        (sort-by first)
                        (mapv second))
                   (vec (sort-by #(nth % col "") rows)))]
      (if (= dir :desc) (vec (rseq sorted)) sorted))))

(defn- summary-chip [{:keys [bucket label n active? on-click]}]
  [:button
   {:class (str "flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs "
                (if active?
                  "bg-gray-3 border-gray-8"
                  "bg-gray-1 border-gray-4 hover:bg-gray-3"))
    :on-click on-click}
   [:span {:class (str "h-1.5 w-1.5 rounded-full " (bucket-dot bucket))}]
   [:span {:class "text-gray-10"} label]
   [:span {:class (str "font-semibold tabular-nums " (bucket-count-class bucket))} n]])

(defn main [_]
  (let [active-filter (r/atom nil)
        sort-state (r/atom nil)
        seen-headers (atom nil)
        summary-cache (atom nil)]
    (fn [{:keys [headers rows]}]
      ;; A new table shape means stale filter/sort would be nonsense.
      (when (not= headers @seen-headers)
        (reset! seen-headers headers)
        (reset! active-filter nil)
        (reset! sort-state nil))
      (let [status-idx (col-index headers "STATUS")
            ready-idx (col-index headers "READY")
            restarts-idx (col-index headers "RESTARTS")
            ns-idx (col-index headers "NAMESPACE")
            roles-idx (col-index headers "ROLES")
            version-idx (col-index headers "VERSION")
            ;; RESTARTS only appears on pods output; ROLES only on nodes.
            kind (cond
                   (and (some? restarts-idx) (some? status-idx)) :pods
                   (and (some? roles-idx) (some? status-idx)) :nodes
                   :else :generic)
            dots? (not= kind :generic)
            summary (when dots?
                      (let [cached @summary-cache]
                        (if (identical? (:rows cached) rows)
                          (:value cached)
                          (let [v (summarize kind rows {:status-idx status-idx
                                                        :restarts-idx restarts-idx
                                                        :ns-idx ns-idx
                                                        :version-idx version-idx})]
                            (reset! summary-cache {:rows rows :value v})
                            v))))
            flt (when dots? @active-filter)
            filtered (cond
                       (nil? flt) rows
                       (= flt :restarting)
                       (filterv #(pos? (restart-count (nth % restarts-idx ""))) rows)
                       :else
                       (filterv #(= flt (status-bucket (nth % status-idx ""))) rows))
            sorted (sort-rows filtered (or @sort-state {}) headers)
            toggle-filter (fn [b] (swap! active-filter #(if (= % b) nil b)))
            toggle-sort (fn [ci]
                          (swap! sort-state
                                 (fn [s]
                                   (cond
                                     (not= (:col s) ci) {:col ci :dir :asc}
                                     (= (:dir s) :asc) {:col ci :dir :desc}
                                     :else nil))))]
        [:div.h-full.flex.flex-col
         (when summary
           [:div {:class "px-2 pt-1.5 pb-1 flex flex-wrap items-center gap-1.5 flex-shrink-0"}
            (doall
             (for [[bucket label] (get-in kind-specs [kind :chips])
                   :let [n (get (:buckets summary) bucket 0)]
                   :when (or (= bucket :running) (pos? n))]
               ^{:key bucket}
               [summary-chip {:bucket bucket :label label :n n
                              :active? (= flt bucket)
                              :on-click #(toggle-filter bucket)}]))
            (when (pos? (or (:restarting summary) 0))
              [summary-chip {:bucket :restarting :label "Restarts"
                             :n (:restarting summary)
                             :active? (= flt :restarting)
                             :on-click #(toggle-filter :restarting)}])
            [:span {:class "ml-auto text-xs text-gray-10 whitespace-nowrap"}
             (summary-footer kind summary)]])
         [:div.flex-1.min-h-0.overflow-auto {:class "px-2 py-1.5"}
          [:table.font-mono.w-full.border-collapse {:class "text-[13px]"}
           [:thead
            [:tr
             (when dots?
               [:th {:class "border-b border-gray-5 w-4"}])
             (doall
              (map-indexed
               (fn [ci h]
                 ^{:key h}
                 [:th.text-left.px-3.py-1.font-semibold.border-b.whitespace-nowrap.cursor-pointer.select-none
                  {:class "text-gray-10 border-gray-5 hover:text-gray-12"
                   :on-click #(toggle-sort ci)}
                  h
                  (when (= (:col @sort-state) ci)
                    [:span {:class "ml-1 text-gray-9"}
                     (if (= (:dir @sort-state) :asc) "▲" "▼")])])
               headers))]]
           [:tbody
            (if (empty? sorted)
              [:tr
               [:td.px-3.py-2 {:class "text-gray-9"
                               :col-span (+ (count headers) (if dots? 1 0))}
                "No rows match this filter"]]
              (doall
               (map-indexed
                (fn [ri row]
                  ^{:key ri}
                  [:tr.border-b {:class "border-gray-3 hover:bg-gray-3"}
                   (when dots?
                     [:td.pl-2.py-1
                      [:span {:class (str "inline-block h-2 w-2 rounded-full "
                                          (bucket-dot (status-bucket (nth row status-idx ""))))}]])
                   (doall
                    (map-indexed
                     (fn [ci cell]
                       ^{:key ci}
                       [:td.px-3.py-1.whitespace-nowrap {:class "text-gray-12"}
                        (cond
                          (= ci status-idx)
                          [:span {:class (str "px-2 py-0.5 rounded text-xs " (status-class cell))} cell]

                          (= ci ready-idx)
                          [:span {:class (ready-class cell)} cell]

                          (and dots? (= ci restarts-idx))
                          [:span {:class (if (pos? (restart-count cell))
                                           "text-warning-11 font-medium"
                                           "text-gray-9")} cell]

                          :else cell)])
                     row))])
                sorted)))]]]]))))
