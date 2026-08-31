(ns webapp.webclient.components.mongo-query-bar
  "Compass-style find bar for MongoDB connections: pick a collection, type a
  bare filter document, hit Find. Builds
  db.getSiblingDB(<db>).getCollection(<coll>).find(<filter>).limit(<n>).toArray()
  and dispatches :editor-plugin/submit-task, so metadata, JIRA-template gates,
  the review flow and the Documents viewer all apply exactly like an editor
  run. Collections come from the Database Schema state — the bar appears once
  a database is opened in the schema tree.

  The filter input is a single-line CodeMirror, not a plain text field:
  brackets and quotes auto-close, and the same Compass-style completion as
  the editor attaches through the shared mongo language extensions — with
  field suggestions scoped to the PICKED collection, which the bar knows and
  the editor can only guess. The document is validated on every change; an
  unparseable filter disables Find and marks the input instead of shipping a
  script that dies in the shell."
  (:require
   ["@codemirror/lang-javascript" :as cm-js]
   ["@codemirror/state" :refer [EditorState Prec]]
   ["@codemirror/view" :refer [keymap]]
   ["@radix-ui/themes" :refer [Button Flex Select Text TextField]]
   ["@uiw/react-codemirror" :as CodeMirror]
   [clojure.string :as cs]
   [re-frame.core :as rf]
   [reagent.core :as r]
   [webapp.events.database-schema :as db-schema]
   [webapp.subs :as subs]
   [webapp.webclient.components.mongo-autocomplete :as mongo-autocomplete]))

(def ^:private default-limit 25)

(defn- parse-limit [s]
  (let [n (js/parseInt s 10)]
    (when (pos? n) n)))

(defn build-script
  "The find script. Public because its three quirks are pinned by tests:

  * .getCollection(\"..\"), not db.<name>: a collection name is not always a
    legal property chain (user-events, \"a b\", 2024logs).
  * .toArray(), not a bare cursor: the REPL prints a cursor 20 documents at a
    time (DBQuery.shellBatchSize) and then a literal 'Type \"it\" for more'
    line, so any limit above 20 silently truncated and the trailer parsed as
    four junk documents. An array prints every document once, on both shells.
  * db-name needs no escaping (quotes are illegal in MongoDB database names);
    the collection name gets its quotes escaped."
  [db-name collection filter-text limit]
  (str "db.getSiblingDB(\"" db-name "\").getCollection(\""
       (cs/replace collection "\"" "\\\"") "\")"
       ".find(" (if (cs/blank? filter-text) "{}" (cs/trim filter-text)) ")"
       ".limit(" limit ").toArray()"))

(defn valid-filter?
  "True when the text can go into .find(...) as one filter document: blank
  (finds everything), or parses as EXACTLY one object expression. Parsed
  wrapped in parens — at statement position a bare { } is a code block — and
  checked structurally: no error nodes, and the parenthesized expression's
  direct child is an ObjectExpression (a SequenceExpression like
  `{a:1}, {b:2}` would silently become find(filter, projection))."
  [text]
  (let [t (cs/trim (or text ""))]
    (or (cs/blank? t)
        (let [^js lang (.-javascriptLanguage cm-js)
              ^js tree (.parse (.-parser lang) (str "(" t ")"))
              has-error (atom false)]
          (.iterate tree #js {:enter (fn [^js n]
                                       (when ^boolean (.. n -type -isError)
                                         (reset! has-error true))
                                       js/undefined)})
          (boolean
           (and (not @has-error)
                (let [^js stmt (.-firstChild (.-topNode tree))
                      ^js paren (some-> stmt .-firstChild)]
                  (and paren
                       (= "ParenthesizedExpression" (.-name paren))
                       (some? (.getChild paren "ObjectExpression"))))))))))

(def ^:private single-line
  ;; The bar is one line. A multi-line paste is joined with spaces rather
  ;; than rejected — pasting a pretty-printed filter is a real workflow.
  (.of (.-transactionFilter EditorState)
       (fn [^js tr]
         (if (and (.-docChanged tr) (> (.. tr -newDoc -lines) 1))
           (let [text (cs/replace (.toString (.-newDoc tr)) #"[\r\n]+" " ")]
             #js {:changes #js {:from 0
                                :to (.. tr -startState -doc -length)
                                :insert text}
                  :selection #js {:anchor (count text)}})
           tr))))

(defn- enter-keymap
  "Enter runs the find. Prec.highest, but registered after basicSetup's
  completionKeymap (also Prec.highest, earlier wins within a bucket), so an
  open completion popup still takes Enter first — its binding returns false
  when the popup is closed, which is exactly when this one runs."
  [on-enter]
  (.highest Prec
            (.of keymap
                 #js [#js {:key "Enter"
                           :run (fn [_view] (on-enter) true)}])))

(defn main [_ _]
  (let [schema (rf/subscribe [::subs/database-schema])
        filter-text (r/atom "")
        ;; The chosen collection is stored WITH its database: the bar is keyed
        ;; per connection, so switching databases keeps these atoms alive, and
        ;; a bare name would silently query the old (or a same-named)
        ;; collection in the new database.
        collection (r/atom nil)
        limit (r/atom (str default-limit))
        ;; Stable cells the CodeMirror extensions close over: the extension
        ;; array must keep its identity across renders (a new array would
        ;; reconfigure the editor every keystroke), so the completion source
        ;; and the Enter binding read these instead of render-scoped values.
        current-sel (atom nil)
        find-ref (atom (fn []))
        cm-extensions
        (delay
          (clj->js
           (into [single-line
                  (enter-keymap #(@find-ref))]
                 (mongo-autocomplete/language-extensions
                  {:fields-fn (fn [_] (mongo-autocomplete/editor-fields @current-sel))
                   :collections-fn (constantly [])}))))]
    (fn [connection-name dark-mode?]
      (when-let [{:keys [database collections]}
                 (db-schema/mongo-find-target
                  (get-in @schema [:data connection-name]))]
        (let [sel (let [[db coll] @collection]
                    (if (and coll (= db database) (some #{coll} collections))
                      coll
                      (first collections)))
              _ (reset! current-sel sel)
              text @filter-text
              valid? (valid-filter? text)
              find! (fn []
                      (when (valid-filter? @filter-text)
                        (rf/dispatch
                         [:editor-plugin/submit-task
                          {:script (build-script database @current-sel @filter-text
                                                 (or (parse-limit @limit)
                                                     default-limit))}])))
              _ (reset! find-ref find!)]
          [:> Flex {:align "center" :gap "2"
                    :class "px-small py-1.5 bg-gray-2 border-t border-gray-3 flex-shrink-0"}
           [:> Text {:size "1" :class "text-gray-10 whitespace-nowrap"} database]
           [:> Select.Root {:size "1"
                            :value sel
                            :onValueChange
                            (fn [c]
                              (reset! collection [database c])
                              ;; Warm the columns cache so field suggestions
                              ;; are ready by the first keystroke. The event
                              ;; no-ops when the key is already cached.
                              (rf/dispatch [:database-schema->load-columns
                                            connection-name database c database]))}
            [:> Select.Trigger {:placeholder "Collection"}]
            [:> Select.Content
             (for [c collections]
               ^{:key c} [:> Select.Item {:value c} c])]]
           [:div {:class (str "flex-1 min-w-0 overflow-hidden rounded-md border bg-gray-1 "
                              (if valid? "border-gray-6" "border-[var(--red-8)]"))
                  :aria-label "Find filter"}
            [:> CodeMirror/default
             {:value text
              :placeholder "{ createdBy: 'user@lyric.tech' }"
              :className "font-mono text-[13px]"
              :theme (if dark-mode? "dark" "light")
              :basicSetup #js {:lineNumbers false
                               :foldGutter false
                               :highlightActiveLine false
                               :highlightActiveLineGutter false
                               :dropCursor false
                               :allowMultipleSelections false
                               :rectangularSelection false
                               :crosshairCursor false
                               :searchKeymap false
                               :highlightSelectionMatches false}
              :onChange #(reset! filter-text %)
              :extensions @cm-extensions}]]
           [:> Text {:size "1" :class "text-gray-10"} "Limit"]
           [:> TextField.Root
            {:size "1"
             :class "w-14 font-mono"
             :aria-label "Result limit"
             :defaultValue @limit
             :on-change #(reset! limit (-> % .-target .-value))}]
           [:> Button {:size "1" :variant "soft" :color "gray"
                       :on-click #(reset! filter-text "")}
            "Reset"]
           [:> Button {:size "1" :disabled (not valid?) :on-click find!}
            "Find"]])))))
