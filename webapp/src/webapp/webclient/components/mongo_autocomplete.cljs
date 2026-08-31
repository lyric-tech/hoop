(ns webapp.webclient.components.mongo-autocomplete
  "Compass-style suggestions for the MongoDB editor: query operators after `$`,
  collection field names, aggregation stages, and BSON constructors as snippets.

  NO NEW DEPENDENCY. Compass gets its catalog from
  @mongodb-js/mongodb-constants, which drags in `bson` as a hard peer. A
  curated list of the operators people actually type is a few hundred bytes and
  avoids that, plus the shadow-cljs resolver risk that comes with it. If the
  list ever needs version gating per server release, that is the point to
  reconsider.

  The completion engine is already running: @uiw/react-codemirror's basicSetup
  pushes `autocompletion()` unless it is explicitly disabled, and panel.cljs
  only disables defaultKeymap and highlightSelectionMatches. So this attaches
  through `languageData` on the mongo language only, and cannot affect the SQL
  dialects."
  (:require
   ["@codemirror/autocomplete" :refer [snippetCompletion]]
   ["@codemirror/lang-javascript" :as cm-js]
   [clojure.string :as cs]
   [re-frame.core :as rf]
   [webapp.subs :as subs]))

;; ── Catalog ───────────────────────────────────────────────────────────────

(def ^:private query-operators
  [["$eq" "Matches values equal to a specified value"]
   ["$ne" "Matches values not equal to a specified value"]
   ["$gt" "Matches values greater than a specified value"]
   ["$gte" "Matches values greater than or equal to a specified value"]
   ["$lt" "Matches values less than a specified value"]
   ["$lte" "Matches values less than or equal to a specified value"]
   ["$in" "Matches any value in an array"]
   ["$nin" "Matches none of the values in an array"]
   ["$and" "Joins clauses with a logical AND"]
   ["$or" "Joins clauses with a logical OR"]
   ["$nor" "Joins clauses with a logical NOR"]
   ["$not" "Inverts the effect of a query expression"]
   ["$exists" "Matches documents that have the specified field"]
   ["$type" "Matches documents where a field is of the specified BSON type"]
   ["$regex" "Matches values against a regular expression"]
   ["$options" "Regular expression options, e.g. \"i\" for case-insensitive"]
   ["$expr" "Uses aggregation expressions inside a query"]
   ["$mod" "Matches values where value modulo a divisor equals a remainder"]
   ["$all" "Matches arrays containing all the specified elements"]
   ["$elemMatch" "Matches arrays with at least one element matching all criteria"]
   ["$size" "Matches arrays of the specified length"]
   ["$text" "Performs a text search"]
   ["$where" "Matches documents against a JavaScript expression"]
   ["$jsonSchema" "Validates documents against the given JSON Schema"]])

(def ^:private stage-operators
  [["$match" "Filters documents"]
   ["$group" "Groups documents by an expression"]
   ["$project" "Reshapes each document"]
   ["$sort" "Orders the documents"]
   ["$limit" "Passes the first N documents"]
   ["$skip" "Skips the first N documents"]
   ["$unwind" "Outputs one document per array element"]
   ["$lookup" "Joins another collection"]
   ["$addFields" "Adds new fields to documents"]
   ["$set" "Adds or overwrites fields (alias of $addFields)"]
   ["$unset" "Removes fields"]
   ["$count" "Counts the documents reaching this stage"]
   ["$facet" "Runs several pipelines on the same input"]
   ["$replaceRoot" "Promotes a sub-document to the top level"]
   ["$sample" "Selects a random sample of documents"]
   ["$sortByCount" "Groups, counts, and sorts by count descending"]
   ["$bucket" "Groups documents into buckets by boundaries"]
   ["$graphLookup" "Performs a recursive search on a collection"]
   ["$setWindowFields" "Computes values over a window of documents"]
   ["$densify" "Fills gaps in a sequence of documents"]
   ["$unionWith" "Concatenates another collection's pipeline results"]])

(def ^:private accumulators
  [["$sum" "Sums numeric values"]
   ["$avg" "Averages numeric values"]
   ["$min" "Smallest value"]
   ["$max" "Largest value"]
   ["$first" "First value in the group"]
   ["$last" "Last value in the group"]
   ["$push" "Collects values into an array"]
   ["$addToSet" "Collects distinct values into an array"]
   ["$count" "Counts documents in the group"]
   ["$stdDevPop" "Population standard deviation"]
   ["$stdDevSamp" "Sample standard deviation"]])

;; Snippets: `#{}` is CodeMirror's placeholder marker, so the cursor lands
;; inside the parentheses ready to type.
(def ^:private bson-constructors
  [["ObjectId" "ObjectId('#{}')" "A 12-byte BSON ObjectId"]
   ["ISODate" "ISODate('#{}')" "A BSON date"]
   ["NumberLong" "NumberLong('#{}')" "A 64-bit integer"]
   ["NumberInt" "NumberInt(#{})" "A 32-bit integer"]
   ["NumberDecimal" "NumberDecimal('#{}')" "A 128-bit decimal"]
   ["UUID" "UUID('#{}')" "A BSON binary UUID"]
   ["BinData" "BinData(0, '#{}')" "BSON binary data"]
   ["Timestamp" "Timestamp(#{}, 0)" "A BSON timestamp"]])

;; ── Field names ───────────────────────────────────────────────────────────

(defn field-names
  "Dotted field paths to suggest, for every collection the user has expanded in
  the given database.

  Reads the cache :database-schema->load-columns already fills, keyed
  \"<schema>.<table>\". For MongoDB the gateway reports schema_name = the
  database name, so the keys are \"<db>.<collection>\", and the columns
  endpoint already returns dotted paths for nested fields -- so nested
  suggestions need no extra work.

  Unioned across collections rather than scoped to one, because the app has no
  notion of a \"currently selected collection\": the schema tree tracks the
  open database, not the open collection. A union of the collections the user
  actually expanded is a useful superset and needs no new state. Scoping this
  properly is a change to the tree, not to the suggestions.

  Returns [] when nothing has been expanded yet. That is the honest answer --
  operators and BSON constructors still suggest, because they do not depend on
  a collection."
  [schema-state connection-name database]
  (if (or (cs/blank? connection-name) (cs/blank? database))
    []
    (let [prefix (str database ".")
          cache (get-in schema-state [:data connection-name :columns-cache])]
      (->> cache
           (filter (fn [[k _]] (cs/starts-with? (str k) prefix)))
           (mapcat (fn [[_ columns]] (keys columns)))
           distinct
           sort
           vec))))

;; ── Completion source ─────────────────────────────────────────────────────

(defn- ->completion [label detail type]
  #js {:label label :detail detail :type type})

(defn- ->snippet [label template detail]
  (snippetCompletion template #js {:label label :detail detail :type "function"}))

(defn- operator-options [dialect]
  (into-array
   (map (fn [[label detail]] (->completion label detail "keyword"))
        (case dialect
          :aggregation (concat stage-operators accumulators)
          (concat query-operators)))))

(defn- field-options [fields]
  (into-array (map (fn [f] (->completion f nil "property")) fields)))

(defn completion-source
  "A CodeMirror CompletionSource.

  `dialect` is passed in by the surface (:query for a find filter,
  :aggregation for a pipeline) rather than inferred from the text: the surface
  already knows, and guessing would be both harder and sometimes wrong.

  `fields-fn` is a 0-arg function returning the field names to suggest. Taking
  the names rather than reading app state keeps this function pure -- every
  re-frame subscription lives in `editor-fields` instead, which is what makes
  the branch order testable without an app-db."
  [dialect fields-fn]
  (fn [^js ctx]
    (let [token (.matchBefore ctx #"[\$A-Za-z_][\$A-Za-z0-9_.]*")]
      (when token
        (let [text (.-text token)
              from (.-from token)]
          (cond
            ;; `$` starts an operator or a stage. Unambiguous, so it wins.
            (cs/starts-with? text "$")
            #js {:from from
                 :options (operator-options dialect)
                 :validFor #"\$[A-Za-z]*"}

            ;; A capital letter starts a BSON constructor: ObjectId, ISODate.
            (re-matches #"[A-Z][A-Za-z]*" text)
            #js {:from from
                 :options (into-array
                           (map (fn [[label template detail]]
                                  (->snippet label template detail))
                                bson-constructors))}

            ;; Otherwise: field names for the open collection.
            :else
            (let [fields (fields-fn)]
              (when (seq fields)
                #js {:from from
                     :options (field-options fields)
                     :validFor #"[A-Za-z0-9_.]*"}))))))))

(defn editor-fields
  "Field names to suggest in the main editor: every collection the user has
  expanded, in the database the schema tree currently has open.

  Both the connection and the database come from the schema tree's own state,
  the same source the tree and the exec path use, so suggestions cannot drift
  from what the user sees expanded in the panel. This is the only function here
  that touches app state."
  []
  (let [schema @(rf/subscribe [::subs/database-schema])
        connection (:current-connection schema)]
    (field-names schema connection (get-in schema [:data connection :current-database]))))

(defn language-extensions
  "CodeMirror extensions for the MongoDB editor: a real JavaScript grammar plus
  the completion source above.

  The grammar switch matters for more than colours. The previous
  StreamLanguage produced a flat tree with no structure, so nothing could ask
  where the cursor sits; lang-javascript gives a real parse tree, which is what
  lets later work distinguish a key position from a value position.

  `javascriptLanguage` is the bare language, not `javascript()`: the latter
  ships its own JavaScript completions, which would bury the mongo suggestions
  in local-variable noise."
  [dialect fields-fn]
  (let [lang (.-javascriptLanguage cm-js)]
    [lang
     (.of (.-data lang) #js {:autocomplete (completion-source dialect fields-fn)})]))
