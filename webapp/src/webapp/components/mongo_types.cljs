(ns webapp.components.mongo-types
  "ClojureScript face of mongo_types.js: the typed reader for the MongoDB
  Compass surfaces.

  The JS half is where the logic lives, because half of it is a string of
  JavaScript that runs inside the mongo shell (TAGGER_JS) and the other half
  reads what that produces -- writing either in CLJS would mean escaping
  JavaScript through ClojureScript string literals. This namespace exists so
  app code and tests share one surface, and so callers get CLJS values
  (keywords, maps, vectors) rather than doing js->clj at every site.

  See mongo_types.js for why the tagger is shell-agnostic and why an
  unrecognized payload degrades to :raw instead of a plausible wrong value."
  (:require
   [goog.object :as gobj]
   ["./mongo_types.js" :as mt]))

;; --- constants ------------------------------------------------------------

(def tagger-js
  "JavaScript source injected verbatim into every generated script. Defines
  __hoopTag(value) and __hoopEmit(envelope)."
  mt/TAGGER_JS)

(def sentinel-open mt/SENTINEL_OPEN)
(def sentinel-close mt/SENTINEL_CLOSE)
(def max-parse-bytes mt/MAX_PARSE_BYTES)

;; --- per-value reading ----------------------------------------------------

(defn classify
  "Returns the kind of one node as a keyword: :null :string :number :boolean
  :array :object, or a BSON kind such as :objectId :int64 :date.

  O(1). Called at render time on the node the renderer is already visiting, so
  a collapsed subtree costs nothing and the page is never walked."
  [v]
  (keyword (mt/classify v)))

(defn tagged?
  "True when the node is a tagged BSON leaf rather than a document or array."
  [v]
  (mt/isTagged v))

(defn value
  "Returns {:kind <keyword> :text <string>} for a leaf, plus :t/:i for a
  timestamp and :subtype/:base64 for binary.

  :kind :raw means the shell's string form did not match the shape its type
  promised. The renderer shows the text with a marker: a shell whose format we
  did not anticipate degrades visibly rather than rendering a wrong value."
  [v]
  (-> (js->clj (mt/value v) :keywordize-keys true)
      (update :kind keyword)))

(defn date-millis
  "Epoch millis for a date leaf, or nil.

  nil for an instant outside the JS Date range: the renderer then omits the
  humanized form instead of printing \"Invalid Date\". MongoDB can store
  instants JavaScript cannot represent."
  [v]
  (mt/dateMillis v))

(defn uuid-from-binary
  "Hyphenated UUID for a binary leaf of subtype 4, else nil. Matches Compass."
  [v]
  (mt/uuidFromBinary v))

;; --- envelope -------------------------------------------------------------

(def ^:private payload-keys
  "Envelope keys whose values are user data, passed through as raw JS rather
  than converted to CLJS.

  Two reasons, both load-bearing:

  * js->clj with :keywordize-keys would turn document FIELD NAMES into
    keywords. A MongoDB field name is an arbitrary string -- a space, a
    leading dollar and an embedded dot are all legal -- so keywordizing is
    lossy, and for a name containing a dot it is ambiguous.
  * The renderers walk these with gobj/get, js-keys and js/Array.isArray. They
    want JS objects; handing them CLJS maps would render nothing.

  Envelope metadata (count, page, ns, warnings) IS converted, because that is
  a fixed vocabulary this code owns."
  #{"documents" "previews" "explain" "sample" "indexes" "index_stats"})

(defn read-envelope
  "Reads the sentinel-delimited envelope out of raw command output.

  Returns nil when there is no envelope at all -- the caller then falls back to
  the legacy mongo_shell.js reader, which is what a Shell-tab run and every
  session recorded before this feature produce.

  Returns {:ok false :reason <keyword>} for :truncated, :too-large, :malformed
  or :unsupported-version. These are kept distinct on purpose: truncation means
  \"reduce the limit\", malformed means \"this is a bug\", and an unknown
  version means \"this resource runs a newer gateway than this UI\" -- one
  return value for all of them is what makes a cut result look like a broken
  agent.

  Never throws."
  [raw]
  (when-let [env (mt/readEnvelope raw)]
    (let [m (reduce (fn [acc k]
                      (assoc acc (keyword k)
                             (if (contains? payload-keys k)
                               ;; Left as a raw JS value on purpose.
                               (gobj/get env k)
                               (js->clj (gobj/get env k) :keywordize-keys true))))
                    {}
                    (array-seq (js-keys env)))]
      (cond-> m
        (contains? m :reason) (update :reason keyword)))))

(defn field-paths
  "Sorted dotted field paths present in the given documents. Feeds autocomplete
  for a collection the schema tree has not loaded."
  [docs]
  (vec (mt/fieldPaths docs)))
