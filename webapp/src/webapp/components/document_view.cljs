(ns webapp.components.document-view
  "Compass-style chrome over document output: List / JSON / Table view toggle
  plus an Expand all / Collapse all dropdown. All three views render through
  document-tree."
  (:require
   ["@radix-ui/themes" :refer [DropdownMenu Flex IconButton SegmentedControl Text]]
   ["lucide-react" :refer [Braces ChevronDown List Table]]
   [reagent.core :as r]
   [webapp.components.document-tree :as doc-tree]))

(defn main [_]
  (let [view-mode (r/atom "List")
        ;; Bumping :epoch remounts the tree so every node re-reads the new
        ;; :default-depth (see document-tree/node).
        expand-state (r/atom {:epoch 0 :default-depth 1})
        set-depth! (fn [depth]
                     (swap! expand-state
                            (fn [s] {:epoch (inc (:epoch s)) :default-depth depth})))]
    (fn [docs]
      (let [tree-opts @expand-state
            table? (= @view-mode "Table")]
        [:div.h-full.flex.flex-col
         [:> Flex {:justify "between" :align "center" :gap "2"
                   :class "px-2 py-1 flex-shrink-0"}
          [:> Text {:size "1" :class "text-gray-10"}
           (let [n (count docs)]
             (str n (if (= n 1) " document" " documents")))]
          [:> Flex {:align "center" :gap "2"}
           (when-not table?
             [:> DropdownMenu.Root
              [:> DropdownMenu.Trigger
               [:> IconButton {:size "1" :variant "ghost" :color "gray"
                               :aria-label "Document display options"}
                [:> ChevronDown {:size 14}]]]
              [:> DropdownMenu.Content {:size "1"}
               [:> DropdownMenu.Item {:onClick #(set-depth! 9999)}
                "Expand all documents"]
               [:> DropdownMenu.Item {:onClick #(set-depth! 0)}
                "Collapse all documents"]]])
           [:> SegmentedControl.Root {:size "1"
                                      :value @view-mode
                                      :onValueChange #(reset! view-mode %)}
            [:> SegmentedControl.Item {:value "List" :aria-label "List view"}
             [:> List {:size 14}]]
            [:> SegmentedControl.Item {:value "JSON" :aria-label "JSON view"}
             [:> Braces {:size 14}]]
            [:> SegmentedControl.Item {:value "Table" :aria-label "Table view"}
             [:> Table {:size 14}]]]]]
         [:div.flex-1.min-h-0.overflow-auto
          (case @view-mode
            "JSON" [doc-tree/json-main docs tree-opts]
            "Table" [doc-tree/table-main docs]
            [doc-tree/main docs tree-opts])]]))))
