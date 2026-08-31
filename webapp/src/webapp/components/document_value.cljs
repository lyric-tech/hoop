(ns webapp.components.document-value
  "One place that turns a single document value into hiccup: its kind, its
  colour, its compact shell-style text, and the humanized date beside it.

  Shared by the document tree, the table cells, and later the schema and
  explain views, so a colour or a format only ever changes here.

  TWO NODE SHAPES, ON PURPOSE
  ---------------------------
  * Tagged nodes (`__ht`/`__hv`) come from the tagging walker the Compass
    surfaces inject into every generated script. These carry exact values --
    an int64 past 2^53 keeps every digit.
  * Legacy MONGO_TYPE nodes come from mongo_shell.js scanning the shell's
    default pseudo-JSON output. These are what a Shell-tab run and every
    session recorded before the tagger produce.

  This namespace is also the ONLY place that still understands the legacy
  shape. When the Shell tab and session retention have both moved past it,
  deleting `legacy-kind` and its branch here is the whole retirement -- see
  the precedence test in document_tree_test."
  (:require
   ["lucide-react" :refer [TriangleAlert]]
   [goog.object :as gobj]
   [webapp.components.mongo-types :as mt]
   ["./mongo_shell.js" :as mongo]
   [webapp.formatters :as formatters]))

;; ── Kind ──────────────────────────────────────────────────────────────────

(def ^:private legacy->kind
  "mongo_shell.js tags -> the same kinds the tagger emits, so everything
  downstream switches on one vocabulary. `Call` is an unrecognized wrapper the
  scanner captured verbatim, which is exactly what :raw means."
  {"ObjectId" :objectId
   "ISODate" :date
   "Date" :date
   "NumberLong" :int64
   "NumberInt" :int32
   "NumberDecimal" :decimal128
   "Timestamp" :timestamp
   "Regex" :regex
   "Call" :raw})

(defn- legacy-node? [v]
  (and (object? v)
       (not (js/Array.isArray v))
       (some? (gobj/get v mongo/MONGO_TYPE))))

(defn kind
  "The kind of one value, as a keyword, for either node shape.

  O(1) -- called at render time on the node the renderer is already visiting,
  so a collapsed subtree costs nothing."
  [v]
  (cond
    (legacy-node? v) (get legacy->kind (gobj/get v mongo/MONGO_TYPE) :raw)
    :else (mt/classify v)))

(defn branch?
  "True when the value has children to expand rather than a value to print."
  [v]
  (contains? #{:array :object} (kind v)))

;; ── Text ──────────────────────────────────────────────────────────────────

(defn- legacy-text [node k]
  (case k
    :objectId (str "ObjectId('" (gobj/get node "value") "')")
    :timestamp (str "Timestamp(" (gobj/get node "t") ", " (gobj/get node "i") ")")
    :raw (str (or (gobj/get node "raw")
                  (gobj/get node "name")
                  (gobj/get node mongo/MONGO_TYPE)))
    (str (gobj/get node "value"))))

(defn- tagged-text [v k]
  (let [{:keys [kind text subtype]} (mt/value v)]
    (case kind
      :objectId (str "ObjectId('" text "')")
      :date (if-let [ms (mt/date-millis v)]
              (.toISOString (js/Date. ms))
              text)
      :binary (if-let [uuid (mt/uuid-from-binary v)]
                (str "UUID('" uuid "')")
                (str "Binary(" (or subtype 0) ", '" text "')"))
      :minKey "MinKey()"
      :maxKey "MaxKey()"
      :undefined "undefined"
      ;; :raw included: the shell's own string form is the honest thing to show
      ;; when we could not confirm the shape it promised.
      (str text))
    ))

(defn display-string
  "Compact one-line text for a value: what a table cell and a copy action use.
  Not the renderer -- see `leaf`."
  [v]
  (let [k (kind v)]
    (cond
      (= k :null) "null"
      (= k :string) (str "\"" v "\"")
      (= k :boolean) (str v)
      (= k :number) (str v)
      (legacy-node? v) (legacy-text v k)
      (mt/tagged? v) (tagged-text v k)
      :else (str v))))

(defn type-name
  "Human type label for the Compass-style `field Type` table headers.
  The numeric BSON types collapse to \"Number\", matching Compass."
  [v]
  (case (kind v)
    :objectId "ObjectId"
    :date "Date"
    (:int32 :int64 :double :decimal128 :number) "Number"
    :timestamp "Timestamp"
    :regex "Regex"
    :binary "Binary"
    :code "Code"
    :symbol "Symbol"
    :dbRef "DBRef"
    :minKey "MinKey"
    :maxKey "MaxKey"
    :null "Null"
    :undefined "Undefined"
    :array "Array"
    :object "Object"
    :string "String"
    :boolean "Boolean"
    :raw "Unknown"
    ""))

;; ── Colour ────────────────────────────────────────────────────────────────
;; Type colours ride the Radix scale vars (step 11 = high-contrast text), so
;; they hold in both light and dark themes without dark: variants. This is the
;; convention the tree already used; it is kept so nothing shifts visually for
;; values that already rendered.
;;
;; ObjectId stays purple rather than Compass's red: the JSON view already uses
;; text-error-11 for keys, and two meanings for one colour reads worse than
;; diverging from Compass here.

(def ^:private kind->class
  {:objectId "text-[var(--purple-11)]"
   :binary "text-[var(--purple-11)]"
   :dbRef "text-[var(--purple-11)]"
   :date "text-[var(--teal-11)]"
   :timestamp "text-[var(--teal-11)]"
   :int32 "text-info-11"
   :int64 "text-info-11"
   :double "text-info-11"
   :decimal128 "text-info-11"
   :number "text-info-11"
   :regex "text-[var(--pink-11)]"
   :code "text-[var(--orange-11)]"
   :symbol "text-gray-11"
   :string "text-success-11"
   :boolean "text-warning-11"
   :minKey "text-gray-10"
   :maxKey "text-gray-10"
   :undefined "text-gray-9"
   :raw "text-[var(--amber-11)]"})

(defn class-for [v]
  (get kind->class (kind v) "text-gray-10"))

;; ── Rendering ─────────────────────────────────────────────────────────────

(defn- raw-leaf
  "A value whose string form did not match the shape its type promised. Shown
  as text with a warning marker: a shell whose format we did not anticipate
  degrades visibly here rather than rendering a plausible wrong value."
  [text expected]
  [:span {:class "inline-flex items-baseline gap-1"}
   [:> TriangleAlert {:size 11
                      :class "text-[var(--amber-11)] shrink-0 self-center"
                      :aria-hidden "true"}]
   [:span.font-mono {:class "text-[var(--amber-11)]"
                     :title (if expected
                              (str "Could not read this value as " (name expected)
                                   " — showing the raw text from the database shell")
                              "Unrecognized value — showing the raw text from the database shell")}
    text]])

(defn- date-leaf
  "The raw instant plus the humanized form beside it, matching Compass. The
  humanized half is omitted for an instant outside the JS Date range rather
  than printing \"Invalid Date\" -- MongoDB can store instants JS cannot
  represent."
  [v]
  (let [ms (mt/date-millis v)]
    [:span {:class "inline-flex items-baseline gap-2"}
     [:span.font-mono.whitespace-nowrap {:class (get kind->class :date)}
      (display-string v)]
     (when-let [pretty (formatters/utc-long ms)]
       [:span {:class "text-gray-9 text-[11px] whitespace-nowrap"} pretty])]))

(defn leaf
  "Renders one non-branch value."
  [v]
  (let [k (kind v)]
    (case k
      :null [:span.font-mono.italic {:class "text-gray-9"} "null"]
      :date (date-leaf v)
      :raw (let [{:keys [text expected]} (if (mt/tagged? v)
                                           (mt/value v)
                                           {:text (display-string v)})]
             (raw-leaf (or text (display-string v)) expected))
      [:span.font-mono.whitespace-nowrap {:class (class-for v)}
       (display-string v)])))
