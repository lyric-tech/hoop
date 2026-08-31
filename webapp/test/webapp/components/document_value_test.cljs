(ns webapp.components.document-value-test
  "The renderer's central promise: a tagged payload that does not match the
  shape its tag promises degrades VISIBLY (:raw -> warning marker, amber,
  \"Unknown\") instead of rendering a plausible wrong value in the promised
  type's colour. `kind` used to dispatch on the tag alone, which made that
  degradation path unreachable -- these tests pin the extraction-based
  dispatch."
  (:require
   [cljs.test :refer-macros [deftest testing is]]
   [webapp.components.document-value :as dv]))

(defn- tagged
  ([kind] #js {"__ht" kind})
  ([kind s] #js {"__ht" kind "__hv" s}))

(deftest a-degraded-tagged-value-is-raw-not-a-plausible-typed-value
  (let [bad (tagged "objectId" "zz-not-a-hex-id")]
    (testing "kind is :raw, from the extraction, not :objectId from the tag"
      (is (= :raw (dv/kind bad))))
    (testing "so the table header says Unknown and nothing treats it as a branch"
      (is (= "Unknown" (dv/type-name bad)))
      (is (false? (dv/branch? bad))))
    (testing "the shell's own string form is what gets shown"
      (is (= "zz-not-a-hex-id" (dv/display-string bad))))))

(deftest a-valid-tagged-value-keeps-the-kind-its-tag-promises
  (is (= :objectId (dv/kind (tagged "objectId" "ObjectId(\"68f1a2b3c4d5e6f708192a3b\")"))))
  (is (= :int64 (dv/kind (tagged "int64" "NumberLong(\"9007199254740993\")"))))
  (is (= :minKey (dv/kind (tagged "minKey"))))
  (is (= "ObjectId('68f1a2b3c4d5e6f708192a3b')"
         (dv/display-string (tagged "objectId" "ObjectId(\"68f1a2b3c4d5e6f708192a3b\")")))))

(deftest tagged-binary-shows-base64-not-the-raw-wrapper
  ;; :text on an extracted binary is the whole BinData(0, "...") string;
  ;; printing it inside Binary(0, '...') double-wrapped the value.
  (is (= "Binary(0, 'aGVsbG8=')"
         (dv/display-string (tagged "binary" "BinData(0, \"aGVsbG8=\")")))))

(deftest plain-values-are-untouched
  (is (= :string (dv/kind "alice")))
  (is (= :number (dv/kind 42)))
  (is (= :object (dv/kind #js {"a" 1})))
  (is (= :array (dv/kind #js [1 2]))))
