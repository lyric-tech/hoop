(ns webapp.webclient.components.mongo-query-bar-test
  "Pins the three quirks of the find script. Each one shipped broken once:
  a bare cursor truncated at 20 documents and parsed its 'Type \"it\" for
  more' trailer as junk documents, and a db.<name> property chain broke for
  any collection name that is not a legal identifier."
  (:require
   [cljs.test :refer-macros [deftest testing is]]
   [webapp.webclient.components.mongo-query-bar :as bar]))

(deftest the-find-script-shape
  (testing "getCollection + toArray, always"
    (is (= (str "db.getSiblingDB(\"lyric\").getCollection(\"users\")"
                ".find({ createdBy: 'a@b' }).limit(25).toArray()")
           (bar/build-script "lyric" "users" "{ createdBy: 'a@b' }" 25))))

  (testing "a collection name that is not an identifier chain still works"
    (is (= (str "db.getSiblingDB(\"lyric\").getCollection(\"user-events\")"
                ".find({}).limit(25).toArray()")
           (bar/build-script "lyric" "user-events" "" 25))))

  (testing "quotes in a collection name are escaped, not injected"
    (is (= (str "db.getSiblingDB(\"lyric\").getCollection(\"a\\\"b\")"
                ".find({}).limit(25).toArray()")
           (bar/build-script "lyric" "a\"b" "" 25))))

  (testing "a blank filter finds everything"
    (is (= "db.getSiblingDB(\"lyric\").getCollection(\"users\").find({}).limit(5).toArray()"
           (bar/build-script "lyric" "users" "   " 5))))

  (testing "surrounding whitespace in the filter is trimmed"
    (is (= "db.getSiblingDB(\"lyric\").getCollection(\"users\").find({a: 1}).limit(5).toArray()"
           (bar/build-script "lyric" "users" "  {a: 1}  " 5)))))
