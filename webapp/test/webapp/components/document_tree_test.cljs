(ns webapp.components.document-tree-test
  "An empty find must reach the Documents viewer as an empty result rather
  than as unparseable output, so the user sees \"No results found\" instead
  of a bare \"switched to db <name>\". Errors must still fall through."
  (:require
   [cljs.test :refer-macros [deftest testing is]]
   [webapp.components.document-tree :as doc-tree]))

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

(deftest other_connection_types_are_untouched
  (testing "an empty postgres response is not a mongo empty result"
    (is (nil? (doc-tree/parse-documents "postgres" preamble)))
    (is (nil? (doc-tree/parse-documents nil preamble)))))
