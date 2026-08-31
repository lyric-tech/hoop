(ns webapp.components.document-tree-test
  "An empty find must reach the Documents viewer as an empty result rather
  than as unparseable output, so the user sees \"No results found\" instead
  of a bare \"switched to db <name>\". Errors must still fall through."
  (:require
   [cljs.test :refer-macros [deftest testing is]]
   [goog.object :as gobj]
   [webapp.components.document-tree :as doc-tree]
   [webapp.components.mongo-types :as mt]))

(def ^:private preamble "switched to db lyric\n")

(deftest empty-find-is-an-empty-result-not-a-parse-failure
  (testing "only the `use <db>` preamble means zero matches"
    (is (= [] (doc-tree/parse-documents "mongodb" preamble))))
  (testing "trailing whitespace still counts as empty"
    (is (= [] (doc-tree/parse-documents "mongodb" (str preamble "\n  \n")))))
  (testing "no output at all"
    (is (= [] (doc-tree/parse-documents "mongodb" "")))))

(deftest errors-still-fall-through-to-logs
  (testing "a server error must not be reported as \"no results\""
    (is (nil? (doc-tree/parse-documents
               "mongodb"
               (str preamble "MongoServerError: unknown operator: $fo\n")))))
  (testing "a shell syntax error must not be reported as \"no results\""
    (is (nil? (doc-tree/parse-documents
               "mongodb"
               (str preamble "SyntaxError: Unexpected token, expected \",\"\n"))))))

(deftest documents-still-parse
  (let [docs (doc-tree/parse-documents
              "mongodb"
              (str preamble
                   "{ _id: ObjectId('64f1a2b3c4d5e6f7a8b9c0d1'), name: 'alice' }\n"
                   "{ _id: ObjectId('64f1a2b3c4d5e6f7a8b9c0d2'), name: 'bob' }\n"))]
    (is (= 2 (count docs)))))

(deftest a-toarray-run-unwraps-into-document-cards
  ;; The find bar appends .toArray(), which prints ONE array holding every
  ;; document (a bare cursor stops at DBQuery.shellBatchSize = 20 and prints
  ;; 'Type "it" for more', which parsed as four junk documents).
  (testing "one top-level array becomes N documents, not one [N elements] node"
    (let [docs (doc-tree/parse-documents
                "mongodb"
                (str preamble "[ { \"n\" : 1 }, { \"n\" : 2 }, { \"n\" : 3 } ]"))]
      (is (= 3 (count docs)))
      (is (= 1 (gobj/get (first docs) "n")))))

  (testing "an empty array is a real empty result -> \"No results found\""
    (is (= [] (doc-tree/parse-documents "mongodb" (str preamble "[ ]"))))
    (is (= [] (doc-tree/parse-documents "mongodb" "[]"))))

  (testing "several top-level values stay separate documents"
    (is (= 2 (count (doc-tree/parse-documents
                     "mongodb"
                     (str preamble "{ \"a\" : 1 }\n{ \"a\" : 2 }")))))))

(deftest other_connection_types_are_untouched
  (testing "an empty postgres response is not a mongo empty result"
    (is (nil? (doc-tree/parse-documents "postgres" preamble)))
    (is (nil? (doc-tree/parse-documents nil preamble)))))

;; ── The tagged envelope ───────────────────────────────────────────────────

(defn- envelope [body]
  (str mt/sentinel-open body mt/sentinel-close))

(deftest tagged-envelope-wins-over-the-legacy-scanner
  (testing "an envelope is used even when its body would also scan as pseudo-JSON"
    ;; THIS IS THE RETIREMENT TRIGGER. mongo_shell.js and the :legacy branch of
    ;; parse-result exist only for Shell-tab runs and for sessions recorded
    ;; before the tagger. When both have aged out, deleting them makes this
    ;; test red -- so the removal is a deliberate act with a test to update,
    ;; not a silent drift.
    (let [raw (str preamble
                   (envelope "{\"v\":1,\"ok\":true,\"op\":\"find\",\"documents\":[{\"n\":1}]}")
                   "\n{ \"_id\" : ObjectId(\"68f1a2b3c4d5e6f708192a3b\") }")
          {:keys [reader docs]} (doc-tree/parse-result "mongodb" raw)]
      (is (= :tagged reader) "the envelope must win")
      (is (= 1 (count docs)))
      ;; gobj/get, not get: a document is a RAW JS object. Field names are
      ;; arbitrary strings in MongoDB, so they are never keywordized, and the
      ;; renderers walk them with gobj/get and js-keys.
      (is (= 1 (gobj/get (first docs) "n"))))))

(deftest tagged-empty-result-is-not-a-parse-failure
  (testing "an envelope with no documents is a real empty result"
    (let [{:keys [reader docs error]}
          (doc-tree/parse-result
           "mongodb" (envelope "{\"v\":1,\"ok\":true,\"op\":\"find\",\"documents\":[]}"))]
      (is (= :tagged reader))
      (is (nil? error))
      (is (= [] docs)) "so the viewer says \"No results found\""))

  (testing "and parse-documents keeps returning [] for it, as its callers expect"
    (is (= [] (doc-tree/parse-documents
               "mongodb" (envelope "{\"v\":1,\"ok\":true,\"documents\":[]}"))))))

(deftest an-unreadable-envelope-reports-why
  (testing "each failure is distinguishable, so the message can be specific"
    (is (= :truncated
           (:error (doc-tree/parse-result "mongodb" (str mt/sentinel-open "{\"v\":1")))))
    (is (= :malformed
           (:error (doc-tree/parse-result "mongodb" (envelope "not json")))))
    (is (= :unsupported-version
           (:error (doc-tree/parse-result "mongodb" (envelope "{\"v\":99}"))))))

  (testing "parse-documents hides an unreadable envelope rather than showing []"
    ;; [] would read as \"the query matched nothing\", which is a different and
    ;; wrong claim. nil sends the user to the Logs tab where the raw output is.
    (is (nil? (doc-tree/parse-documents "mongodb" (envelope "{\"v\":99}"))))
    (is (nil? (doc-tree/parse-documents "mongodb" (str mt/sentinel-open "{\"v\":1"))))))

(deftest legacy-output-still-reads-for-historical-sessions
  (testing "no envelope means the legacy scanner, and it still works"
    (let [raw (str preamble "{ \"_id\" : ObjectId(\"68f1a2b3c4d5e6f708192a3b\"), \"n\" : 1 }")
          {:keys [reader docs]} (doc-tree/parse-result "mongodb" raw)]
      (is (= :legacy reader))
      (is (= 1 (count docs)))))

  (testing "a zero-match legacy find is still an empty result, not a failure"
    (is (= :legacy (:reader (doc-tree/parse-result "mongodb" preamble))))
    (is (= [] (:docs (doc-tree/parse-result "mongodb" preamble))))))

(deftest non-mongo-connection-types-are-untouched
  (testing "parse-result only speaks for mongodb"
    (is (nil? (doc-tree/parse-result "postgres" (envelope "{\"v\":1,\"ok\":true}"))))
    (is (nil? (doc-tree/parse-result nil "anything")))))
