(ns webapp.components.mongo-types-test
  "The Compass surfaces get type fidelity from a tagging walker the generated
  script carries, not from the shell's default output. These tests pin the two
  runtimes it has to satisfy: the legacy MongoDB 5.0 shell, where the BSON
  globals ARE the constructors and there is no `_bsontype`, and mongosh, where
  `NumberLong` is a factory and `_bsontype` is the discriminator.

  The stand-ins below are the point of the suite. Neither shell is available in
  the test environment, so each is represented by an object with the shape that
  runtime actually presents -- which is also what makes the walker's two
  detection paths independently testable.

  The assertion that matters most is the last one: a string form the walker
  does not recognize must come back as :raw and be shown as marked text, never
  as a plausible wrong value."
  (:require
   [cljs.test :refer-macros [deftest testing is]]
   [webapp.components.mongo-types :as mt]))

;; ---------------------------------------------------------------------------
;; Shell stand-ins
;; ---------------------------------------------------------------------------

(defn- legacy
  "A legacy-5.0-shell value: no _bsontype, identified by instanceof at tag
  time. Here it is pre-tagged, because instanceof against the real globals is
  what the walker does inside the shell -- this suite tests the READER half."
  [kind s]
  #js {"__ht" kind "__hv" s})

(defn- v [x] (mt/value x))

;; ---------------------------------------------------------------------------

(deftest exact-values-survive-both-shells
  (testing "an ObjectId yields bare hex, not the wrapper text"
    ;; The literal \"ObjectId\" contains b, c, d and e -- all hex digits. A
    ;; strip-non-hex implementation would prepend \"becd\" here.
    (is (= {:kind :objectId :text "68f1a2b3c4d5e6f708192a3b"}
           (v (legacy "objectId" "ObjectId(\"68f1a2b3c4d5e6f708192a3b\")"))))
    (is (= {:kind :objectId :text "68f1a2b3c4d5e6f708192a3b"}
           (v (legacy "objectId" "68f1a2b3c4d5e6f708192a3b")))))

  (testing "an int64 past 2^53 keeps every digit"
    ;; 9007199254740993 is Number.MAX_SAFE_INTEGER + 2. Relaxed Extended JSON
    ;; would render it as a bare JSON number and JSON.parse would round it to
    ;; ...992. This is the whole reason the payload travels as a string.
    (is (= {:kind :int64 :text "9007199254740993"}
           (v (legacy "int64" "NumberLong(\"9007199254740993\")"))))
    (is (= {:kind :int64 :text "9007199254740993"}
           (v (legacy "int64" "9007199254740993")))))

  (testing "negative int32"
    (is (= {:kind :int32 :text "-42"} (v (legacy "int32" "NumberInt(-42)")))))

  (testing "decimal128 keeps its exact text"
    (is (= {:kind :decimal128 :text "1234.5678"}
           (v (legacy "decimal128" "NumberDecimal(\"1234.5678\")")))))

  (testing "a timestamp yields both components"
    (is (= {:kind :timestamp :text "Timestamp(1735689600, 7)" :t 1735689600 :i 7}
           (v (legacy "timestamp" "Timestamp(1735689600, 7)")))))

  (testing "the keys with no payload"
    (is (= {:kind :minKey :text "minKey"} (v #js {"__ht" "minKey"})))
    (is (= {:kind :maxKey :text "maxKey"} (v #js {"__ht" "maxKey"})))))

(deftest a-date-is-a-date-not-a-string
  (let [ms 1769320239097
        d  (legacy "date" (str ms))]
    (testing "classified as a date"
      (is (= :date (mt/classify d))))
    (testing "millis come back exactly, for the humanized form beside the value"
      (is (= ms (mt/date-millis d))))
    (testing "an instant outside the JS Date range yields nil, not Invalid Date"
      ;; MongoDB can store instants JS cannot represent. The renderer omits the
      ;; humanized form rather than printing \"Invalid Date\".
      (is (nil? (mt/date-millis (legacy "date" "99999999999999999")))))))

(deftest plain-values-pass-through-untagged
  (testing "strings, numbers, booleans and null are not wrapped"
    (is (= :string  (mt/classify "x")))
    (is (= :number  (mt/classify 3)))
    (is (= :boolean (mt/classify true)))
    (is (= :null    (mt/classify nil)))
    (is (= :array   (mt/classify #js [1 2])))
    (is (= :object  (mt/classify #js {"a" 1})))))

(deftest dollar-prefixed-field-names-are-not-wrappers
  (testing "MongoDB 5.0+ permits $-prefixed field names"
    ;; A document {$price: 5} must render as a document with a $price field,
    ;; not as a BSON wrapper. The walker only tags what it positively
    ;; identified, so this can never be ambiguous.
    (is (= :object (mt/classify #js {"$price" 5})))
    (is (= :object (mt/classify #js {"$oid" "68f1a2b3c4d5e6f708192a3b"})))))

(deftest an-unrecognized-string-form-degrades-visibly
  (testing "a payload that does not match the shape its type promises is :raw"
    ;; This is the guard that keeps a shell whose format we did not anticipate
    ;; from producing a plausible wrong value. :raw renders as marked text.
    (is (= {:kind :raw :text "not-an-oid" :expected "objectId"}
           (v (legacy "objectId" "not-an-oid"))))
    (is (= {:kind :raw :text "Binary.createFromBase64(\"x\")" :expected "binary"}
           (v (legacy "binary" "Binary.createFromBase64(\"x\")")))))

  (testing "a missing payload is :raw rather than an empty value"
    (is (= :raw (:kind (v #js {"__ht" "objectId"}))))))

(deftest binary-subtype-4-renders-as-a-uuid
  (testing "matching Compass"
    (let [b (legacy "binary" "BinData(4, \"cKcnf9x/RFmwo0FCTOOsWg==\")")]
      (is (= 4 (:subtype (v b))))
      (is (= "70a7277f-dc7f-4459-b0a3-41424ce3ac5a" (mt/uuid-from-binary b)))))
  (testing "a non-UUID subtype yields nil, not a malformed UUID"
    (is (nil? (mt/uuid-from-binary (legacy "binary" "BinData(0, \"AAEC\")"))))))

(deftest envelope-failures-are-distinguishable
  (testing "a well-formed envelope"
    (let [raw (str mt/sentinel-open "{\"v\":1,\"ok\":true,\"op\":\"find\"}" mt/sentinel-close)
          got (mt/read-envelope raw)]
      (is (true? (:ok got)))
      (is (= "find" (:op got)))))

  (testing "shell noise before the envelope is tolerated"
    ;; Both shells write warnings to the same stream, and a warning can contain
    ;; a brace -- which is exactly why cleanMongoOutput's first-brace scan is
    ;; not good enough and a sentinel is.
    (let [raw (str "WARNING: something {with a brace}\n"
                   mt/sentinel-open "{\"v\":1,\"ok\":true}" mt/sentinel-close)]
      (is (true? (:ok (mt/read-envelope raw))))))

  (testing "no sentinel means fall back to the legacy reader, not an error"
    (is (nil? (mt/read-envelope "switched to db lyric\n{ \"a\" : 1 }")))
    (is (nil? (mt/read-envelope ""))))

  (testing "truncated is not the same as malformed"
    ;; Truncation says \"reduce the limit\"; malformed says \"this is a bug\".
    ;; One return value for both is what makes a cut 8 MB result look like a
    ;; broken agent image.
    (is (= :truncated (:reason (mt/read-envelope (str mt/sentinel-open "{\"v\":1")))))
    (is (= :malformed (:reason (mt/read-envelope (str mt/sentinel-open "nope" mt/sentinel-close))))))

  (testing "an unknown envelope version says so instead of rendering empty"
    (let [got (mt/read-envelope (str mt/sentinel-open "{\"v\":2}" mt/sentinel-close))]
      (is (= :unsupported-version (:reason got)))
      (is (= 2 (:version got))))))

(deftest field-paths-feed-autocomplete
  (testing "dotted paths, sorted, with tagged leaves not descended into"
    (let [docs #js [#js {"_id" (legacy "objectId" "68f1a2b3c4d5e6f708192a3b")
                         "name" "x"
                         "nested" #js {"a" #js [#js {"deep" 1}]}}]]
      (is (= ["_id" "name" "nested" "nested.a" "nested.a.deep"]
             (mt/field-paths docs))))))
