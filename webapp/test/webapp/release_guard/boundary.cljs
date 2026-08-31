(ns webapp.release-guard.boundary
  "Runtime guard for the JS -> ClojureScript boundary, run under :advanced.

  WHY A SEPARATE BUILD
  --------------------
  Closure's advanced pass renames properties on object literals it believes it
  owns. The CLJS side enumerates mongo_types.js results with js-keys and reads
  keys BY NAME, so a renamed key becomes nil -- correct in every dev-mode test,
  broken only in the shipped bundle. This is not hypothetical: a release build
  turned `bytes` into `ag` and `kind` into `k`.

  Grepping the release bundle for the key names does NOT catch it -- those
  strings appear elsewhere in a bundle this size, so the check passes while the
  code is broken. Verified: a deliberate regression slipped straight through a
  grep-based guard. The only honest check is to call the code after advanced
  optimizations and look at what comes back.

    npx shadow-cljs release release-guard && node target/release-guard.js

  Exits non-zero on the first mismatch.

  WHAT THIS GUARD IS AND IS NOT
  -----------------------------
  It is a smoke test, not a proof. Closure renames a property only when name
  pressure in that particular bundle makes it worth doing, so the same unsafe
  pattern can survive one build and break another -- reintroducing a bad
  pattern here by hand does not reliably turn this red.

  So the real defence is that mongo_types.js is safe BY CONSTRUCTION: bracket
  assignment with string literals for every key that crosses the boundary, and
  flat [key, value, ...] arrays wherever keys would otherwise be property names
  in the source. This guard is the backup, and it earned its place -- it found
  three real breakages that all 122 dev-mode tests reported green:

    1. `bytes` renamed to `ag` on a failure object.
    2. EXTRACT as an object literal indexed by a runtime string, so every
       extractor lookup missed and binary/UUID rendering plus the whole
       degraded-value path returned nothing.
    3. EXTRACT rebuilt as `new Map(Object.entries({...}))`, which enumerated
       the already-renamed keys and reproduced the same failure."
  (:require
   [goog.object :as gobj]
   [webapp.components.mongo-types :as mt]))

(def ^:private failures (atom []))

(defn- expect [label expected actual]
  (when-not (= expected actual)
    (swap! failures conj (str label ": expected " (pr-str expected)
                              " but got " (pr-str actual)))))

(defn- tagged [kind s]
  #js {"__ht" kind "__hv" s})

(defn -main [& _]
  ;; value(): :kind and :text must survive, or every typed leaf renders blank.
  (let [v (mt/value (tagged "objectId" "ObjectId(\"68f1a2b3c4d5e6f708192a3b\")"))]
    (expect "value/:kind" :objectId (:kind v))
    (expect "value/:text" "68f1a2b3c4d5e6f708192a3b" (:text v)))

  ;; :expected rides the degraded path, which is the one nobody exercises by
  ;; hand -- exactly where a renamed key would sit unnoticed.
  (let [v (mt/value (tagged "objectId" "not-an-oid"))]
    (expect "value/:kind (degraded)" :raw (:kind v))
    (expect "value/:expected" "objectId" (:expected v)))

  ;; :subtype and :base64 feed the UUID rendering.
  (let [v (mt/value (tagged "binary" "BinData(4, \"cKcnf9x/RFmwo0FCTOOsWg==\")"))]
    (expect "value/:subtype" 4 (:subtype v))
    (expect "value/:base64" "cKcnf9x/RFmwo0FCTOOsWg==" (:base64 v)))
  (expect "uuid-from-binary"
          "70a7277f-dc7f-4459-b0a3-41424ce3ac5a"
          (mt/uuid-from-binary (tagged "binary" "BinData(4, \"cKcnf9x/RFmwo0FCTOOsWg==\")")))

  ;; :t and :i come from a flat pair array rather than an object literal.
  (let [v (mt/value (tagged "timestamp" "Timestamp(1735689600, 7)"))]
    (expect "value/:t" 1735689600 (:t v))
    (expect "value/:i" 7 (:i v)))

  (expect "date-millis" 1769320239097 (mt/date-millis (tagged "date" "1769320239097")))

  ;; read-envelope(): :ok gates every render; :reason and its extras drive the
  ;; error messages.
  (let [env (mt/read-envelope (str mt/sentinel-open
                                   "{\"v\":1,\"ok\":true,\"op\":\"find\",\"documents\":[{\"n\":1}]}"
                                   mt/sentinel-close))]
    (expect "envelope/:ok" true (:ok env))
    (expect "envelope/:op" "find" (:op env))
    ;; documents stay raw JS so field names survive verbatim
    (expect "envelope/documents field name preserved"
            1 (some-> (:documents env) (aget 0) (gobj/get "n"))))

  (let [env (mt/read-envelope (str mt/sentinel-open "{\"v\":99}" mt/sentinel-close))]
    (expect "envelope/:reason" :unsupported-version (:reason env))
    (expect "envelope/:version" 99 (:version env)))

  (let [env (mt/read-envelope (str mt/sentinel-open (apply str (repeat 40 "x"))))]
    (expect "envelope/:reason (truncated)" :truncated (:reason env)))

  ;; The tagger travels into the shell as a string; minification must not touch
  ;; its internals.
  (doseq [needle ["__hoopTag" "__hoopEmit" "_bsontype" "__ht" "__hv"]]
    (when-not (re-find (re-pattern needle) mt/tagger-js)
      (swap! failures conj (str "tagger-js lost " needle))))

  (if-let [fs (seq @failures)]
    (do (println "BOUNDARY BROKEN IN THE RELEASE BUILD:")
        (doseq [f fs] (println "  -" f))
        (println)
        (println "Build the object with bracket assignment and a string literal:")
        (println "    o['kind'] = kind          not   { kind }")
        (println "and pass extra fields as a flat array of alternating key/value")
        (println "elements, whose keys are array ELEMENTS and so cannot be renamed:")
        (println "    leaf(kind, text, ['t', t, 'i', i])")
        (println "See mongo_types.js, \"Stable keys across the JS -> CLJS boundary\".")
        (js/process.exit 1))
    (println "BOUNDARY INTACT (advanced optimizations)")))
