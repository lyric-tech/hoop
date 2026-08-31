(ns webapp.webclient.components.mongo-autocomplete
  "Compass-style suggestions for the MongoDB editor and find bar.

  WHERE the cursor sits decides WHAT is offered, read from the Lezer syntax
  tree (the editor uses lang-javascript's real grammar):

    key position    field names as `name: ` pair snippets, plus the operator
                    catalog for the context: query operators in a filter,
                    stage operators at an .aggregate([...]) stage slot,
                    accumulators inside $group
    value position  BSON constructor snippets, true/false/null
    after db.       collection names + shell db methods
    after db.coll.  collection methods (find, aggregate, getIndexes, ...)
    strings         only when the string is an object KEY; never in a value
    comments        nothing

  TWO OBJECT SHAPES, ON PURPOSE. `{ a: 1 }` in expression position parses as
  ObjectExpression > Property > PropertyDefinition, but at statement position
  -- the find bar's whole document -- JavaScript grammar makes it
  Block > LabeledStatement > Label. Both are treated as documents: in a mongo
  surface a brace is a document far more often than a code block.

  The catalogs are curated by hand rather than imported from
  @mongodb-js/mongodb-constants: the import costs a transitive dependency on
  bson and drags in hundreds of niche operators that bury the ones people
  type. These lists cover what Compass's own default suggestions cover.

  Reading app state happens ONLY in editor-fields/editor-collections, which
  read re-frame's app-db directly -- a CompletionSource runs imperatively
  inside CodeMirror, outside any reactive context, where rf/subscribe leaks
  reaction caches. Everything else takes data as arguments, which is what
  makes the zone logic testable against a real EditorState."
  (:require
   ["@codemirror/autocomplete" :refer [snippetCompletion]]
   ["@codemirror/lang-javascript" :as cm-js]
   ["@codemirror/language" :refer [ensureSyntaxTree syntaxTree]]
   [clojure.string :as cs]
   [re-frame.core :as rf]
   [re-frame.db :as rdb]
   [webapp.events.database-schema :as db-schema]))

;; ── Catalogs ────────────────────────────────────────────────────────────────
;; [label template detail]. The template is a CodeMirror snippet: `#{}` marks
;; a tab stop, `#{text}` a selected placeholder. Accepting an operator inserts
;; the shape the operator takes, cursor inside it -- unless a `:` already
;; follows the token, in which case the bare label is inserted (see
;; colon-after? in the source).

(def ^:private query-operators
  [["$eq" "$eq: #{}" "equals"]
   ["$ne" "$ne: #{}" "not equal"]
   ["$gt" "$gt: #{}" "greater than"]
   ["$gte" "$gte: #{}" "greater than or equal"]
   ["$lt" "$lt: #{}" "less than"]
   ["$lte" "$lte: #{}" "less than or equal"]
   ["$in" "$in: [#{}]" "any value in array"]
   ["$nin" "$nin: [#{}]" "no value in array"]
   ["$and" "$and: [{ #{} }]" "all clauses match"]
   ["$or" "$or: [{ #{} }]" "any clause matches"]
   ["$nor" "$nor: [{ #{} }]" "no clause matches"]
   ["$not" "$not: { #{} }" "inverts a clause"]
   ["$exists" "$exists: #{true}" "field is present"]
   ["$type" "$type: '#{}'" "field has BSON type"]
   ["$regex" "$regex: '#{}'" "regular expression"]
   ["$options" "$options: '#{}'" "regex options"]
   ["$expr" "$expr: { #{} }" "aggregation expression"]
   ["$mod" "$mod: [#{}, 0]" "modulo"]
   ["$all" "$all: [#{}]" "array has all values"]
   ["$elemMatch" "$elemMatch: { #{} }" "array element matches"]
   ["$size" "$size: #{}" "array length"]
   ["$text" "$text: { $search: '#{}' }" "text search"]
   ["$where" "$where: function() { #{} }" "JavaScript predicate"]
   ["$jsonSchema" "$jsonSchema: { #{} }" "JSON Schema match"]])

(def ^:private stage-operators
  [["$match" "$match: { #{} }" "filter documents"]
   ["$group" "$group: { _id: #{} }" "group by expression"]
   ["$project" "$project: { #{} }" "reshape documents"]
   ["$sort" "$sort: { #{} }" "order documents"]
   ["$limit" "$limit: #{}" "cap the stream"]
   ["$skip" "$skip: #{}" "skip documents"]
   ["$unwind" "$unwind: '$#{}'" "one document per array element"]
   ["$lookup" "$lookup: { from: '#{}', localField: '#{}', foreignField: '#{}', as: '#{}' }" "left outer join"]
   ["$addFields" "$addFields: { #{} }" "add computed fields"]
   ["$set" "$set: { #{} }" "alias of $addFields"]
   ["$unset" "$unset: '#{}'" "remove fields"]
   ["$count" "$count: '#{}'" "count into a field"]
   ["$facet" "$facet: { #{} }" "multiple pipelines"]
   ["$replaceRoot" "$replaceRoot: { newRoot: #{} }" "promote a subdocument"]
   ["$sample" "$sample: { size: #{} }" "random documents"]
   ["$sortByCount" "$sortByCount: '$#{}'" "group and count, sorted"]
   ["$bucket" "$bucket: { groupBy: '$#{}', boundaries: [#{}] }" "bucket by boundaries"]
   ["$graphLookup" "$graphLookup: { #{} }" "recursive lookup"]
   ["$setWindowFields" "$setWindowFields: { #{} }" "window functions"]
   ["$densify" "$densify: { #{} }" "fill gaps in a sequence"]
   ["$unionWith" "$unionWith: '#{}'" "append another collection"]])

(def ^:private accumulators
  [["$sum" "$sum: #{}" "sum"]
   ["$avg" "$avg: #{}" "average"]
   ["$min" "$min: #{}" "minimum"]
   ["$max" "$max: #{}" "maximum"]
   ["$first" "$first: #{}" "first value in group"]
   ["$last" "$last: #{}" "last value in group"]
   ["$push" "$push: #{}" "collect into an array"]
   ["$addToSet" "$addToSet: #{}" "collect unique values"]
   ["$count" "$count: {}" "count documents"]
   ["$stdDevPop" "$stdDevPop: #{}" "population std deviation"]
   ["$stdDevSamp" "$stdDevSamp: #{}" "sample std deviation"]])

(def ^:private bson-constructors
  [["ObjectId" "ObjectId('#{}')" "12-byte object id"]
   ["ISODate" "ISODate('#{}')" "date from ISO-8601"]
   ["NumberLong" "NumberLong('#{}')" "64-bit integer"]
   ["NumberInt" "NumberInt(#{})" "32-bit integer"]
   ["NumberDecimal" "NumberDecimal('#{}')" "128-bit decimal"]
   ["UUID" "UUID('#{}')" "UUID (binary subtype 4)"]
   ["BinData" "BinData(0, '#{}')" "binary data"]
   ["Timestamp" "Timestamp(#{}, 0)" "internal timestamp"]])

(def ^:private db-methods
  [["getCollection" "getCollection('#{}')" "collection by name"]
   ["getSiblingDB" "getSiblingDB('#{}')" "another database"]
   ["getCollectionNames" "getCollectionNames()" "list collections"]
   ["runCommand" "runCommand({ #{} })" "database command"]])

(def ^:private collection-methods
  [["find" "find({ #{} })" "query documents"]
   ["findOne" "findOne({ #{} })" "first matching document"]
   ["aggregate" "aggregate([{ #{} }])" "aggregation pipeline"]
   ["countDocuments" "countDocuments({ #{} })" "count matches"]
   ["estimatedDocumentCount" "estimatedDocumentCount()" "fast collection count"]
   ["distinct" "distinct('#{}')" "distinct values of a field"]
   ["getIndexes" "getIndexes()" "list indexes"]
   ["stats" "stats()" "collection statistics"]
   ["insertOne" "insertOne({ #{} })" "insert a document"]
   ["insertMany" "insertMany([{ #{} }])" "insert documents"]
   ["updateOne" "updateOne({ #{} }, { $set: { #{} } })" "update first match"]
   ["updateMany" "updateMany({ #{} }, { $set: { #{} } })" "update all matches"]
   ["deleteOne" "deleteOne({ #{} })" "delete first match"]
   ["deleteMany" "deleteMany({ #{} })" "delete all matches"]])

;; ── Field data (pure) ───────────────────────────────────────────────────────

(defn collection-fields
  "[[name type] ...] for one collection's columns-cache entry, sorted by name.
  Only string keys are field names: a failed load caches {:error \"...\"}
  under the same \"<db>.<coll>\" key a success uses, and the keyword must
  never reach the option list (it once made `sort` throw on every keystroke)."
  [columns]
  (if-not (map? columns)
    []
    (->> columns
         (keep (fn [[fname types]]
                 (when (string? fname)
                   [fname (when (map? types) (first (keys types)))])))
         (sort-by first)
         vec)))

(defn database-fields
  "Union of [[name type] ...] across every collection the user has expanded
  in the database (the app tracks the open database, not an open collection,
  so the union is the honest superset). First type wins for a field that
  appears in several collections."
  [schema-state connection-name database]
  (if (or (cs/blank? connection-name) (cs/blank? database))
    []
    (let [prefix (str database ".")]
      (->> (get-in schema-state [:data connection-name :columns-cache])
           (filter (fn [[k _]] (cs/starts-with? (str k) prefix)))
           (mapcat (fn [[_ columns]] (collection-fields columns)))
           (reduce (fn [acc [n t]] (if (contains? acc n) acc (assoc acc n t))) {})
           (sort-by first)
           (mapv vec)))))

;; ── Cursor context ──────────────────────────────────────────────────────────

(defn- nname [^js n] (.-name n))

(defn- first-container
  "Nearest node, itself included, whose type name is in `names`."
  [^js node names]
  (loop [^js n node]
    (when n
      (if (contains? names (nname n)) n (recur (.-parent n))))))

(def ^:private containers
  #{"Property" "LabeledStatement" "ObjectExpression" "Block"
    "ArrayExpression" "ArgList" "MemberExpression"})

(defn- key-of
  "The key node of a Property (PropertyDefinition/String/Number) or a
  LabeledStatement (Label): always its first child."
  [^js prop]
  (.-firstChild prop))

(defn- aggregate-array?
  "True when the ArrayExpression is the argument of an .aggregate(...) call."
  [^js state ^js arr]
  (let [^js arglist (.-parent arr)
        ^js call (some-> arglist .-parent)]
    (boolean
     (and arglist (= "ArgList" (nname arglist))
          call (= "CallExpression" (nname call))
          (let [^js callee (.-firstChild call)]
            (and callee
                 (cs/ends-with? (.sliceDoc state (.-from callee) (.-to callee))
                                ".aggregate")))))))

(defn- aggregate-stage
  "Walks up from `start`. Returns nil outside .aggregate([...]); :stage-level
  when the cursor sits at a stage object's key slot; otherwise the enclosing
  stage name (the property key closest to the pipeline array, e.g. \"$group\")."
  [^js state ^js start]
  (loop [^js n start, ks []]
    (when n
      (case (nname n)
        "ArrayExpression"
        (when (aggregate-array? state n)
          (if (seq ks) (peek ks) :stage-level))

        ("Property" "LabeledStatement")
        (let [^js k (key-of n)]
          (recur (.-parent n)
                 (cond-> ks k (conj (.sliceDoc state (.-from k) (.-to k))))))

        (recur (.-parent n) ks)))))

(defn- zone-at
  "Which completion applies at pos: {:zone :key|:value|:member|:top|:none}
  plus :quoted? for a key typed inside quotes, :member :collections|:methods,
  and :prop (the enclosing Property/LabeledStatement, when there is one)."
  [^js state pos ^js node]
  (cond
    (some? (first-container node #{"LineComment" "BlockComment"}))
    {:zone :none}

    ;; A string completes only as an object KEY. Property form: the string IS
    ;; the property's first token. Block form (the find bar's bare document):
    ;; { "crea" } parses as an expression statement directly inside a Block.
    (contains? #{"String" "TemplateString"} (nname node))
    (let [^js p (.-parent node)]
      (if (or (and p (= "Property" (nname p)) (= (.-from node) (.-from p)))
              (and p (= "ExpressionStatement" (nname p))
                   (some-> ^js (.-parent p) nname (= "Block"))))
        {:zone :key :quoted? true}
        {:zone :none}))

    :else
    (let [^js c (first-container node containers)]
      (case (some-> c nname)
        "MemberExpression"
        (let [^js obj (.-firstChild c)
              obj-text (when obj (.sliceDoc state (.-from obj) (.-to obj)))]
          {:zone :member
           :member (if (or (= obj-text "db")
                           (and obj-text (re-find #"getSiblingDB\([^()]*\)$" obj-text)))
                     :collections
                     :methods)})

        ("Property" "LabeledStatement")
        (let [^js k (key-of c)]
          (if (and k (cs/includes? (.sliceDoc state (.-to k) pos) ":"))
            {:zone :value :prop c}
            {:zone :key :prop c}))

        ;; A brace in a mongo surface is a document far more often than a
        ;; code block, so Block completes like an object.
        ("ObjectExpression" "Block") {:zone :key}
        ("ArrayExpression" "ArgList") {:zone :value}
        {:zone :top}))))

(defn- target-collection
  "The collection the enclosing chain names -- db.<coll>. or
  getCollection('<coll>') -- or nil. Textual over the 500 chars before pos:
  this only scopes field suggestions, so a miss falls back to the union."
  [^js state pos]
  (let [text (.sliceDoc state (max 0 (- pos 500)) pos)
        by-call (last (re-seq #"getCollection\(\s*['\"]([^'\"]+)['\"]\s*\)" text))
        db-fns #{"getCollection" "getSiblingDB" "getCollectionNames"
                 "runCommand" "adminCommand" "createCollection"}
        by-dot (last (remove (fn [[_ n]] (contains? db-fns n))
                             (re-seq #"\bdb\s*\.\s*([A-Za-z_][\w-]*)\s*\." text)))]
    (or (second by-call) (second by-dot))))

;; ── Options ─────────────────────────────────────────────────────────────────

(defn- plain [label detail type]
  #js {:label label :detail detail :type type})

(defn- tmpl [[label template detail] type]
  (snippetCompletion template #js {:label label :detail detail :type type}))

(defn- needs-quotes? [s]
  (not (re-matches #"[A-Za-z_$][A-Za-z0-9_$]*" s)))

(defn- field-key-option
  "A field in key position inserts `name: ` with the cursor after the colon
  (quoted when the name is not a legal identifier, e.g. profile.city). When a
  colon already follows the token -- the user is editing an existing key --
  or the key is being typed inside quotes, only the name goes in."
  [[fname ftype] colon-after? quoted?]
  (let [written (if (needs-quotes? fname) (str "'" fname "'") fname)]
    (cond
      quoted? (plain fname ftype "property")
      colon-after? #js {:label fname :detail ftype :type "property" :apply written}
      :else (snippetCompletion (str written ": #{}")
                               #js {:label fname :detail ftype :type "property"}))))

(defn- op-option [[label _template detail :as op] colon-after?]
  (if colon-after?
    (plain label detail "keyword")
    (tmpl op "keyword")))

(def ^:private valid-token #"[$A-Za-z0-9_.]*")

(defn- result [from options]
  (when (seq options)
    #js {:from from :options (into-array options) :validFor valid-token}))

;; ── Completion source ───────────────────────────────────────────────────────

(defn completion-source
  "A CodeMirror CompletionSource driven by the syntax tree.

  `fields-fn` takes the collection the enclosing chain names (or nil) and
  returns [[name type] ...]; `collections-fn` returns the current database's
  collection names. Both are functions so app state stays out of this
  namespace's logic."
  [{:keys [fields-fn collections-fn]
    :or {fields-fn (constantly []) collections-fn (constantly [])}}]
  (fn [^js ctx]
    (let [^js state (.-state ctx)
          pos (.-pos ctx)
          token (.matchBefore ctx #"[$A-Za-z_][$A-Za-z0-9_.]*")]
      (when (or token (.-explicit ctx))
        (let [from (if token (.-from token) pos)
              tree (or (ensureSyntaxTree state pos 80) (syntaxTree state))
              ^js node (.resolveInner tree pos -1)
              {:keys [zone quoted? member ^js prop]} (zone-at state pos node)
              doc-len (.. state -doc -length)
              colon-after? (boolean (re-find #"^\s*:" (.sliceDoc state pos (min doc-len (+ pos 40)))))]
          (case zone
            :none nil

            :member
            (result from
                    (if (= member :collections)
                      (concat (map (fn [c] (plain c "collection" "class"))
                                   (collections-fn))
                              (map #(tmpl % "method") db-methods))
                      (map #(tmpl % "method") collection-methods)))

            :key
            ;; Everything valid at this key slot goes in one list; the typed
            ;; prefix separates them ($ reaches only operators, a bare word
            ;; only fields). At a pipeline's stage slot only stages are valid.
            (let [stage (aggregate-stage state (or (some-> prop .-parent) node))
                  ops (cond
                        (= stage :stage-level) stage-operators
                        (= stage "$group") accumulators
                        :else query-operators)
                  fields (when-not (= stage :stage-level)
                           (fields-fn (target-collection state pos)))]
              (result from
                      (concat (map #(field-key-option % colon-after? quoted?) fields)
                              (map #(op-option % (or colon-after? quoted?)) ops))))

            :value
            (result from
                    (concat (map #(tmpl % "function") bson-constructors)
                            (map #(plain % nil "keyword") ["true" "false" "null"])))

            :top
            ;; Statement level: the db entry point, plus constructors so a
            ;; capitalised token still completes outside any document.
            (result from
                    (concat [(plain "db" "database object" "variable")]
                            (map #(tmpl % "function") bson-constructors)))))))))

;; ── App-state readers ───────────────────────────────────────────────────────
;; The ONLY functions here that touch app state. They read re-frame's app-db
;; directly: a CompletionSource runs outside any reactive context, where
;; @(rf/subscribe ...) is the documented leak.

(defn- schema-state []
  (:database-schema @rdb/app-db))

(defn editor-fields
  "[[name type] ...] to suggest. Scoped to `collection` when its columns are
  cached; on a cache miss the load is kicked off (the columns endpoint the
  schema tree already uses) and the union of expanded collections answers
  meanwhile, so suggestions no longer require expanding the tree by hand."
  [collection]
  (let [schema (schema-state)
        conn (:current-connection schema)
        database (get-in schema [:data conn :current-database])]
    (or (when (and collection conn database)
          (let [ck (str database "." collection)
                cached (get-in schema [:data conn :columns-cache ck])
                loading? (contains? (or (get-in schema [:data conn :loading-columns]) #{}) ck)]
            (if (map? cached)
              (not-empty (collection-fields cached))
              (when-not loading?
                (rf/dispatch [:database-schema->load-columns conn database collection database])
                nil))))
        (database-fields schema conn database))))

(defn editor-collections
  "The open database's collection names, for db. completion."
  []
  (let [schema (schema-state)
        conn (:current-connection schema)]
    (or (:collections (db-schema/mongo-find-target (get-in schema [:data conn])))
        [])))

;; ── Editor extensions ───────────────────────────────────────────────────────

(defn language-extensions
  "CodeMirror extensions for a MongoDB surface: lang-javascript's real grammar
  (the zone logic needs its tree) plus the completion source above, attached
  through languageData so no other language is affected.

  `javascriptLanguage` is the bare language, not `javascript()`: the latter
  ships its own JavaScript completions, which would bury the mongo
  suggestions in local-variable noise."
  ([] (language-extensions {:fields-fn editor-fields
                            :collections-fn editor-collections}))
  ([opts]
   (let [lang (.-javascriptLanguage cm-js)]
     [lang
      (.of (.-data lang) #js {:autocomplete (completion-source opts)})])))
