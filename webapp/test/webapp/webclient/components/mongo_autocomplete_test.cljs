(ns webapp.webclient.components.mongo-autocomplete-test
  "Suggestions for the MongoDB editor, tested against a REAL EditorState and
  CompletionContext: the completion source reads the Lezer syntax tree to
  decide what the cursor position means, so a stub that only fakes
  matchBefore would test nothing.

  Docs use | for the cursor; the helper strips it."
  (:require
   ["@codemirror/autocomplete" :refer [CompletionContext]]
   ["@codemirror/state" :refer [EditorState]]
   [cljs.test :refer-macros [deftest testing is]]
   [clojure.string :as cs]
   [webapp.webclient.components.mongo-autocomplete :as ac]))

(def ^:private fields
  [["_id" "objectId"] ["createdBy" "string"] ["profile.city" "string"] ["total" "decimal"]])

(def ^:private opts
  {:fields-fn (fn [collection]
                ;; scoped when the enclosing chain names a known collection,
                ;; union otherwise -- mirrors editor-fields' contract
                (if (= collection "orders") [["total" "decimal"]] fields))
   :collections-fn (constantly ["orders" "users"])})

(defn- complete
  ([doc] (complete doc false))
  ([doc explicit?]
   (let [pos (cs/index-of doc "|")
         text (str (subs doc 0 pos) (subs doc (inc pos)))
         state (.create EditorState
                        #js {:doc text
                             :extensions (clj->js (ac/language-extensions opts))})
         src (ac/completion-source opts)]
     (src (CompletionContext. state pos explicit?)))))

(defn- labels [result]
  (when result
    (vec (map #(.-label %) (array-seq (.-options result))))))

(defn- option [result label]
  (when result
    (first (filter #(= label (.-label %)) (array-seq (.-options result))))))

;; ── Key position ────────────────────────────────────────────────────────────

(deftest a-key-slot-offers-fields-and-query-operators
  (let [ls (labels (complete "db.users.find({ crea| })"))]
    (testing "fields from the schema"
      (is (some #{"createdBy"} ls))
      (is (some #{"profile.city"} ls)))
    (testing "query operators share the list; the typed prefix separates them"
      (is (some #{"$gt"} ls))
      (is (not (some #{"$group"} ls))))
    (testing "BSON constructors are value-side, not key-side"
      (is (not (some #{"ObjectId"} ls))))))

(deftest a-field-completion-is-a-key-value-pair
  (testing "accepting a field inserts `name: ` (a snippet, applied as a fn)"
    (is (fn? (.-apply (option (complete "db.users.find({ crea| })") "createdBy")))))

  (testing "unless a colon already follows -- editing an existing key"
    (is (= "createdBy"
           (.-apply (option (complete "db.users.find({ crea|: 1 })") "createdBy")))))

  (testing "a field that is not a legal identifier gets quotes"
    (is (= "'profile.city'"
           (.-apply (option (complete "db.users.find({ profile|: 1 })") "profile.city"))))))

(deftest a-quoted-key-completes-the-name-inside-the-quotes
  (let [ls (labels (complete "db.users.find({ \"cre|\" })"))]
    (is (some #{"createdBy"} ls))
    (testing "as the bare name -- the quotes are already there"
      (is (nil? (.-apply (option (complete "db.users.find({ \"cre|\" })") "createdBy")))))))

(deftest the-find-bar-bare-document-is-a-document-not-a-code-block
  ;; At statement position { a: 1 } parses as Block > LabeledStatement, not
  ;; ObjectExpression > Property. Both shapes must complete.
  (testing "key slot"
    (is (some #{"createdBy"} (labels (complete "{ crea| }")))))
  (testing "value slot"
    (is (some #{"ISODate"} (labels (complete "{ createdAt: | }" true))))))

(deftest explicit-invoke-works-on-an-empty-slot
  (testing "Ctrl-Space right after { offers the key catalog"
    (let [ls (labels (complete "db.users.find({ | })" true))]
      (is (some #{"createdBy"} ls))
      (is (some #{"$exists"} ls))))
  (testing "but nothing pops uninvited with no token"
    (is (nil? (complete "db.users.find({ | })")))))

(deftest fields-scope-to-the-collection-the-chain-names
  (let [ls (labels (complete "db.orders.find({ | })" true))]
    (is (some #{"total"} ls))
    (is (not (some #{"createdBy"} ls)))))

;; ── Aggregation context ─────────────────────────────────────────────────────

(deftest a-stage-slot-offers-stages-only
  (let [ls (labels (complete "db.users.aggregate([{ $| }])"))]
    (is (some #{"$match"} ls))
    (is (some #{"$group"} ls))
    (testing "no query operators, no fields at the stage level"
      (is (not (some #{"$eq"} ls)))
      (is (not (some #{"createdBy"} ls))))))

(deftest inside-group-offers-accumulators
  (let [ls (labels (complete "db.users.aggregate([{ $group: { _id: 1, t: { $s| } } }])"))]
    (is (some #{"$sum"} ls))
    (is (not (some #{"$match"} ls)))))

(deftest inside-match-offers-query-operators-and-fields
  (let [ls (labels (complete "db.users.aggregate([{ $match: { crea| } }])"))]
    (is (some #{"createdBy"} ls))
    (is (some #{"$gt"} ls))
    (is (not (some #{"$match"} ls)))))

;; ── Value position ──────────────────────────────────────────────────────────

(deftest a-value-slot-offers-constructors-and-literals
  (let [ls (labels (complete "db.users.find({ createdAt: I| })"))]
    (is (some #{"ISODate"} ls))
    (is (some #{"true"} ls))
    (is (some #{"null"} ls))
    (is (not (some #{"createdBy"} ls)))))

;; ── Member position ─────────────────────────────────────────────────────────

(deftest after-db-dot-offers-collections
  (let [ls (labels (complete "db.us|"))]
    (is (some #{"users"} ls))
    (is (some #{"orders"} ls))
    (is (some #{"getCollection"} ls))))

(deftest after-a-collection-offers-methods
  (let [ls (labels (complete "db.users.fi|"))]
    (is (some #{"find"} ls))
    (is (some #{"aggregate"} ls))
    (is (not (some #{"users"} ls)))))

;; ── Suppression ─────────────────────────────────────────────────────────────

(deftest nothing-completes-where-nothing-belongs
  (testing "inside a value string"
    (is (nil? (complete "db.users.find({ a: \"te|xt\" })"))))
  (testing "inside a comment"
    (is (nil? (complete "// crea|"))))
  (testing "empty doc, not explicit"
    (is (nil? (complete "|")))))

;; ── Field data (pure) ───────────────────────────────────────────────────────

(deftest a-failed-columns-load-never-breaks-field-suggestions
  ;; :database-schema->columns-failure caches {:error "..."} under the same
  ;; "<db>.<coll>" key a success uses. The keyword once reached `sort` and
  ;; threw on every keystroke, killing completion for the whole database.
  (let [state {:data {"mongo-prod"
                      {:columns-cache
                       {"lyric.users" {"createdBy" {"string" {"nullable" false}}}
                        "lyric.broken" {:error "columns load failed"}
                        "other.secrets" {"apiKey" {"string" {"nullable" false}}}}}}}]
    (testing "one broken collection does not poison the others"
      (is (= [["createdBy" "string"]]
             (ac/database-fields state "mongo-prod" "lyric"))))
    (testing "an error entry yields no fields, not a keyword"
      (is (= [] (ac/collection-fields {:error "boom"}))))
    (testing "another database's fields never leak in"
      (is (not (some #{"apiKey"} (map first (ac/database-fields state "mongo-prod" "lyric"))))))
    (testing "blank coordinates are an empty list"
      (is (= [] (ac/database-fields state nil "lyric")))
      (is (= [] (ac/database-fields state "mongo-prod" nil))))))
