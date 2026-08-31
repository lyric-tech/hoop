(ns webapp.webclient.components.mongo-autocomplete-test
  "Suggestions for the MongoDB editor. Two things are worth pinning: the
  field-name lookup, which reads a cache shape owned by another namespace, and
  the branch order in the completion source -- an operator, a BSON constructor
  and a field name are all matched by the same token regex, so the order
  decides what the user is offered."
  (:require
   [cljs.test :refer-macros [deftest testing is]]
   [webapp.webclient.components.mongo-autocomplete :as ac]))

;; The shape :database-schema->columns-loaded writes: cache key is
;; "<schema>.<table>", and for MongoDB the gateway reports schema_name as the
;; database name. Values are {field {type {"nullable" bool}}}.
(def ^:private schema-state
  {:current-connection "mongo-prod"
   :data {"mongo-prod"
          {:current-database "lyric"
           :columns-cache
           {"lyric.users" {"_id" {"objectId" {"nullable" false}}
                           "createdBy" {"string" {"nullable" false}}
                           "profile.city" {"string" {"nullable" true}}}
            "lyric.orders" {"_id" {"objectId" {"nullable" false}}
                            "total" {"decimal" {"nullable" false}}}
            ;; a different database must not leak in
            "other.secrets" {"apiKey" {"string" {"nullable" false}}}}}}})

(deftest field-names-come-from-the-schema-cache
  (testing "unioned across the collections the user expanded, sorted, deduped"
    (is (= ["_id" "createdBy" "profile.city" "total"]
           (ac/field-names schema-state "mongo-prod" "lyric"))))

  (testing "_id appears once even though both collections have it"
    (is (= 1 (count (filter #{"_id"} (ac/field-names schema-state "mongo-prod" "lyric"))))))

  (testing "dotted paths for nested fields need no extra work"
    ;; The columns endpoint already flattens nested documents, so
    ;; profile.city arrives ready to suggest.
    (is (some #{"profile.city"} (ac/field-names schema-state "mongo-prod" "lyric"))))

  (testing "another database's fields never leak in"
    (is (not (some #{"apiKey"} (ac/field-names schema-state "mongo-prod" "lyric")))))

  (testing "nothing expanded yet is an empty list, not a guess"
    (is (= [] (ac/field-names schema-state "mongo-prod" "unopened")))
    (is (= [] (ac/field-names schema-state "mongo-prod" nil)))
    (is (= [] (ac/field-names schema-state nil "lyric")))
    (is (= [] (ac/field-names {} "mongo-prod" "lyric")))))

;; ── Completion source ─────────────────────────────────────────────────────

(defn- ctx
  "A stand-in for CodeMirror's CompletionContext: only matchBefore is used."
  [typed]
  (clj->js {:matchBefore (fn [_re]
                           (when (seq typed)
                             #js {:text typed :from 0}))}))

(defn- complete [dialect typed]
  (let [fields (ac/field-names schema-state "mongo-prod" "lyric")
        src (ac/completion-source dialect (constantly fields))]
    (src (ctx typed))))

(defn- labels [result]
  (when result
    (vec (map #(.-label %) (array-seq (.-options result))))))

(deftest a-dollar-offers-operators
  (testing "query dialect offers query operators"
    (let [ls (labels (complete :query "$g"))]
      (is (some #{"$gte"} ls))
      (is (some #{"$in"} ls))))

  (testing "a filter is not offered aggregation stages, which are invalid there"
    (is (not (some #{"$group"} (labels (complete :query "$g"))))))

  (testing "aggregation dialect offers stages and accumulators"
    (let [ls (labels (complete :aggregation "$"))]
      (is (some #{"$match"} ls))
      (is (some #{"$group"} ls))
      (is (some #{"$sum"} ls))))

  (testing "the dialect is passed in, never inferred from the text"
    ;; The surface knows which editor the user is in. Inferring it would be
    ;; harder and sometimes wrong -- $limit is legal in both.
    (is (not= (labels (complete :query "$")) (labels (complete :aggregation "$"))))))

(deftest a-capital-letter-offers-bson-constructors
  (testing "typing Obj offers ObjectId and ISODate"
    (let [ls (labels (complete :query "Obj"))]
      (is (some #{"ObjectId"} ls))
      (is (some #{"ISODate"} ls))))

  (testing "constructors win over field names for a capitalised token"
    ;; A field starting with a capital is possible but rare; a user typing one
    ;; in a filter is almost always reaching for a constructor.
    (is (not (some #{"createdBy"} (labels (complete :query "Obj")))))))

(deftest a-bare-word-offers-field-names
  (testing "typing crea offers the field from the schema cache"
    (is (some #{"createdBy"} (labels (complete :query "crea")))))

  (testing "no suggestions at all when no collection has been expanded"
    ;; nil rather than an empty option list, so CodeMirror leaves the existing
    ;; completions alone instead of showing an empty popup.
    (let [src (ac/completion-source :query (constantly []))]
      (is (nil? (src (ctx "crea")))))))

(deftest no-token-means-no-suggestions
  (testing "an empty position offers nothing rather than the whole catalog"
    (is (nil? (complete :query "")))))
