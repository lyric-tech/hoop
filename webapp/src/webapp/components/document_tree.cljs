(ns webapp.components.document-tree
  "Compass-style collapsible tree for document/JSON command output (MongoDB,
  DynamoDB, CloudWatch). Reuses the tested JS parsers in this folder via interop;
  this namespace only renders."
  (:require
   ["./mongo_shell.js" :as mongo]
   ["./dynamo_unwrap.js" :as dynamo]
   ["lucide-react" :refer [ChevronDown ChevronRight]]
   [goog.object :as gobj]
   [reagent.core :as r]))

;; ── Normalization ─────────────────────────────────────────────────────────
;; Turns raw command output into a seq of JS document values, or nil when the
;; output isn't parseable as documents (caller falls back to the raw Logs tab).

(defn parse-documents [connection-type output]
  (let [t (or connection-type "")]
    (cond
      (= t "mongodb")
      (when (mongo/looksLikeMongo output)
        (when-let [res (mongo/parseOutput output)]
          (seq (map (fn [d] (if (.-ok d) (.-value d) (.-raw d)))
                    (array-seq (.-documents res))))))

      (or (= t "dynamodb") (= t "cloudwatch"))
      (try
        (let [json (js/JSON.parse output)
              items (dynamo/unwrapDynamoResponse json)
              events (and json (gobj/get json "events"))]
          (cond
            (some? items) (seq (array-seq items))
            (js/Array.isArray json) (seq (array-seq json))
            (js/Array.isArray events) (seq (array-seq events))
            (some? json) [json]
            :else nil))
        (catch :default _ nil))

      :else nil)))

;; ── Rendering ─────────────────────────────────────────────────────────────

(defn- value-kind [v]
  (cond
    (nil? v) :null
    (js/Array.isArray v) :array
    (and (object? v) (some? (gobj/get v mongo/MONGO_TYPE))) :mongo
    (object? v) :object
    (string? v) :string
    (number? v) :number
    (boolean? v) :boolean
    :else :other))

(defn- mongo-str
  "Compact shell-style text for a mongo-typed node (shared by the tree leaf
  and the Table view cells)."
  [node]
  (let [t (gobj/get node mongo/MONGO_TYPE)]
    (case t
      "ObjectId" (str "ObjectId('" (gobj/get node "value") "')")
      "ISODate" (str (or (gobj/get node "value") "ISODate()"))
      ("NumberLong" "NumberInt" "NumberDecimal") (str (gobj/get node "value"))
      "Timestamp" (str "Timestamp(" (gobj/get node "t") ", " (gobj/get node "i") ")")
      "Regex" (str (gobj/get node "value"))
      "Call" (str (gobj/get node "raw"))
      (str (or (gobj/get node "name") t)))))

;; Type colors ride the Radix scale vars (step 11 = high-contrast text), so
;; they hold up in both light and dark themes without dark: variants.
(defn- mongo-leaf [node]
  (let [t (gobj/get node mongo/MONGO_TYPE)
        cls (case t
              "ObjectId" "text-[var(--purple-11)]"
              "ISODate" "text-[var(--teal-11)]"
              ("NumberLong" "NumberInt" "NumberDecimal" "Timestamp") "text-info-11"
              "Regex" "text-[var(--pink-11)]"
              "text-gray-10")]
    [:span.font-mono.whitespace-nowrap {:class cls} (mongo-str node)]))

(defn- leaf [v]
  (case (value-kind v)
    :mongo (mongo-leaf v)
    :null [:span.font-mono.italic {:class "text-gray-9"} "null"]
    :string [:span.font-mono {:class "text-success-11"} (str "\"" v "\"")]
    :number [:span.font-mono {:class "text-info-11"} (str v)]
    :boolean [:span.font-mono {:class "text-warning-11"} (str v)]
    [:span.font-mono.text-gray-11 (str v)]))

(defn- branch? [v]
  (contains? #{:array :object} (value-kind v)))

(defn- entries-of [v]
  (if (js/Array.isArray v)
    (map-indexed (fn [i x] [(str i) x]) (array-seq v))
    (map (fn [k] [k (gobj/get v k)]) (array-seq (js-keys v)))))

(defn- summary [v]
  (if (js/Array.isArray v)
    (let [n (alength v)]
      (str "[ " n " " (if (= n 1) "element" "elements") " ]"))
    (let [n (alength (js-keys v))]
      (str "{ " n " " (if (= n 1) "field" "fields") " }"))))

(defn- caret [open?]
  [:span {:class "mr-0.5 flex-shrink-0 flex items-center text-gray-9 select-none"}
   (if open?
     [:> ChevronDown {:size 12 :strokeWidth 2.5}]
     [:> ChevronRight {:size 12 :strokeWidth 2.5}])])

;; Aligns leaf rows with branch rows, whose text sits after a 12px caret.
(def ^:private caret-spacer
  [:span {:class "w-[14px] flex-shrink-0"}])

(defn- key-label [label]
  (when label
    [:<>
     [:span.font-mono {:class "text-gray-12"} label]
     [:span {:class "text-gray-9 mr-1.5"} ":"]]))

;; default-depth controls how deep nodes start open (Expand all → huge,
;; Collapse all → 0). Callers bump an epoch in the React key to remount the
;; tree, which is what re-arms every node's local open? state.
(defn- node
  [label value depth default-depth]
  (r/with-let [open? (r/atom (< depth default-depth))]
    (let [pad {:padding-left (str (* depth 14) "px")}]
      (if-not (branch? value)
        [:div.flex.items-center.leading-5 {:style pad}
         caret-spacer
         [key-label label]
         [leaf value]]
        [:div
         [:div.flex.items-center.leading-5.cursor-pointer.rounded
          {:class "hover:bg-gray-3"
           :style pad
           :on-click #(swap! open? not)}
          [caret @open?]
          [key-label label]
          [:span.font-mono {:class "text-gray-10"} (summary value)]]
         (when @open?
           (doall
            (for [[k v] (entries-of value)]
              ^{:key k} [node k v (inc depth) default-depth])))]))))

(defn- docs-cards
  "Per-document card list shared by the List and JSON views. render-doc is
  (fn [doc] hiccup); epoch participates in the React key so bumping it
  remounts every card (how Expand/Collapse-all re-arms the open? atoms)."
  [docs epoch render-doc]
  [:div.overflow-x-auto {:class "px-2 py-1.5 text-[13px]"}
   (doall
    (map-indexed
     (fn [i doc]
       ^{:key (str epoch "-" i)}
       [:div {:class (str "mb-1.5 rounded-md border border-gray-4 bg-gray-1 "
                          "px-2 py-1 hover:border-gray-6 transition-colors")}
        (render-doc doc)])
     docs))])

(defn main [docs {:keys [epoch default-depth] :or {epoch 0 default-depth 1}}]
  (docs-cards docs epoch (fn [doc] [node nil doc 0 default-depth])))

;; ── JSON view ─────────────────────────────────────────────────────────────
;; Same collapse recursion as `node`, rendered as shell-syntax JSON: quoted
;; keys, braces/brackets, commas, collapsed branches as {…}/[…].

(defn- json-key [label]
  (when label
    [:<>
     [:span.font-mono {:class "text-error-11"} (str "\"" label "\"")]
     [:span {:class "text-gray-9 mr-1.5"} ":"]]))

(defn- json-node
  [label value depth last? default-depth]
  (r/with-let [open? (r/atom (< depth default-depth))]
     (let [pad {:padding-left (str (* depth 14) "px")}
           comma (when-not last?
                   [:span.font-mono {:class "text-gray-9"} ","])]
       (if-not (branch? value)
         [:div.flex.items-center.leading-5 {:style pad}
          caret-spacer
          [json-key label]
          [leaf value]
          comma]
         (let [arr? (js/Array.isArray value)
               [open-ch close-ch] (if arr? ["[" "]"] ["{" "}"])]
           (if-not @open?
             [:div.flex.items-center.leading-5.cursor-pointer.rounded
              {:class "hover:bg-gray-3"
               :style pad
               :on-click #(swap! open? not)}
              [caret false]
              [json-key label]
              [:span.font-mono {:class "text-gray-10"} (str open-ch "…" close-ch)]
              comma]
             [:div
              [:div.flex.items-center.leading-5.cursor-pointer.rounded
               {:class "hover:bg-gray-3"
                :style pad
                :on-click #(swap! open? not)}
               [caret true]
               [json-key label]
               [:span.font-mono {:class "text-gray-11"} open-ch]]
              (let [es (vec (entries-of value))
                    n (count es)]
                (doall
                 (map-indexed
                  (fn [i [k v]]
                    ^{:key k}
                    [json-node (when-not arr? k) v (inc depth) (= i (dec n)) default-depth])
                  es)))
              [:div.flex.items-center.leading-5 {:style pad}
               caret-spacer
               [:span.font-mono {:class "text-gray-11"} close-ch]
               comma]]))))))

(defn json-main [docs {:keys [epoch default-depth] :or {epoch 0 default-depth 1}}]
  (docs-cards docs epoch (fn [doc] [json-node nil doc 0 true default-depth])))

;; ── Table view ────────────────────────────────────────────────────────────
;; Native Compass-style table (ag-grid is deliberately not used here — it
;; stays on the SQL Tabular path only): columns = union of top-level fields in
;; first-appearance order, cells = compact display strings, "No field" when a
;; document lacks the column (Compass wording).

(defn- plain-object? [d]
  (and (object? d) (not (js/Array.isArray d)) (not (gobj/get d mongo/MONGO_TYPE))))

(defn- type-name [v]
  (case (value-kind v)
    :mongo (let [t (gobj/get v mongo/MONGO_TYPE)]
             (if (contains? #{"NumberLong" "NumberInt" "NumberDecimal"} t) "Number" t))
    :null "Null"
    :array "Array"
    :object "Object"
    :string "String"
    :number "Number"
    :boolean "Boolean"
    ""))

(defn- table-model
  "One pass over the docs: column order (first appearance) and the dominant
  value type per column for the Compass-style `field Type` headers."
  [docs]
  (loop [ds docs order [] seen #{} types {}]
    (if-let [d (first ds)]
      (if (plain-object? d)
        (let [ks (array-seq (js-keys d))]
          (recur (rest ds)
                 (into order (remove seen ks))
                 (into seen ks)
                 (reduce (fn [t k]
                           (update-in t [k (type-name (gobj/get d k))] (fnil inc 0)))
                         types
                         ks)))
        (recur (rest ds) order seen types))
      {:cols order
       :dominant (into {}
                       (map (fn [k]
                              [k (some->> (get types k) (sort-by val >) ffirst)]))
                       order)})))

(defn- cell-str [v]
  (case (value-kind v)
    :mongo (mongo-str v)
    :null "null"
    :string (str "\"" v "\"")
    (:array :object) (summary v)
    (str v)))

(defn table-main
  "Compass-style table: row numbers, `field Type` headers, type-colored
  truncated cells, \"No field\" for missing keys. Hover a cell for the full
  value."
  [docs]
  (let [{:keys [cols dominant]} (table-model docs)]
    (if (empty? cols)
      [:div {:class "px-3 py-4 text-gray-10 text-sm"}
       "No tabular fields to show"]
      [:div.h-full.overflow-auto {:class "px-2 py-1.5 text-[13px]"}
       [:table.font-mono.border-collapse {:class "min-w-full"}
        [:thead
         [:tr
          [:th {:class "sticky top-0 z-10 bg-gray-2 border-b border-gray-5 px-2 py-1"}]
          (for [k cols]
            ^{:key k}
            [:th.text-left.px-3.py-1.whitespace-nowrap
             {:class "sticky top-0 z-10 bg-gray-2 border-b border-gray-5"}
             [:span {:class "font-semibold text-gray-12"} k]
             (when-let [t (get dominant k)]
               [:span {:class "ml-1.5 font-normal text-gray-10"} t])])]]
        [:tbody
         (doall
          (map-indexed
           (fn [ri d]
             ^{:key ri}
             [:tr {:class "border-b border-gray-3 hover:bg-gray-2"}
              [:td.px-2.py-1.text-right.select-none {:class "text-gray-9"} (inc ri)]
              (let [obj? (plain-object? d)]
                (doall
                 (for [k cols]
                   ^{:key k}
                   (let [present? (and obj? (gobj/containsKey d k))
                         v (when present? (gobj/get d k))]
                     [:td.px-3.py-1
                      {:class "border-r border-gray-3 max-w-[280px] truncate"
                       :title (when present? (cell-str v))}
                      (cond
                        (not present?) [:span {:class "text-gray-9"} "No field"]
                        (branch? v) [:span {:class "text-gray-10"} (summary v)]
                        :else [leaf v])]))))])
           docs))]]])))
