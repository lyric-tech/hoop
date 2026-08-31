(ns webapp.webclient.components.connection-dialog
  (:require
   ["cmdk" :refer [CommandGroup CommandItem]]
   ["lucide-react" :refer [ChevronRight Server]]
   ["@radix-ui/themes" :refer [Badge Flex Text]]
   [clojure.string :as cs]
   [reagent.core :as r]
   [re-frame.core :as rf]
   [webapp.connections.constants :as connection-constants]
   [webapp.resources.constants :refer [http-proxy-subtypes]]
   [webapp.components.command-dialog :as command-dialog]
   [webapp.components.infinite-scroll :refer [infinite-scroll]]
   [webapp.formatters :as formatters]))

(defn- connection-result-item
  "Connection search result item"
  [connection selected?]
  [:> CommandItem
   {:key (:id connection)
    :value (:name connection)
    :keywords [(:type connection) (:subtype connection) (:status connection)
               (:cluster connection) "connection"]
    :onSelect #(do
                 (rf/dispatch [:primary-connection/set-selected connection])
                 (rf/dispatch [:primary-connection/toggle-dialog false]))}
   [:> Flex {:align "center" :gap "2" :class "w-full"}
    [:img {:src (connection-constants/get-connection-icon connection)
           :class "w-4"
           :alt (str (:type connection) " connection icon")
           :loading "lazy"}]
    [:> Flex {:direction "column" :class "flex-1"}
     [:> Text {:size "2" :class (if selected? "text-primary-11" "text-[--gray-11]")}
      (formatters/qualified-connection-name connection)]
     (when (= (:status connection) "offline")
       [:> Text {:size "1" :color "gray"} "Offline"])]
    (when selected?
      [:> Badge {:color "indigo" :size "1"} "Selected"])
    [:> ChevronRight {:size 16 :class "ml-auto text-gray-9" :aria-hidden "true"}]]])

(defn- cluster-result-item
  "Cluster row. Selecting it drills into the resources of that cluster."
  [{:keys [id label]} on-select]
  [:> CommandItem
   {:key id
    :value (str "cluster:" label)
    :keywords [label "cluster"]
    :onSelect #(on-select id label)}
   [:> Flex {:align "center" :gap "2" :class "w-full"}
    [:> Server {:size 16 :class "text-[--gray-11]" :aria-hidden "true"}]
    [:> Text {:size "2" :class "flex-1 text-[--gray-11]"} label]
    [:> ChevronRight {:size 16 :class "text-gray-9" :aria-hidden "true"}]]])

(defn- clusters-list
  "Cluster list: the first step of the picker.

  Built from the agents list, not from the loaded resource pages, so every
  cluster is offered even when none of its resources are on the current page.
  Picking one refetches the resources filtered by that agent, so the second
  step is a complete list rather than whatever happened to be loaded."
  [agents on-select]
  (let [clusters (->> agents
                      (map (fn [{:keys [id name]}]
                             {:id id :label (formatters/cluster-from-agent-name name)}))
                      (sort-by :label))]
    [:<>
     [:div {:class "sr-only" :role "status" :aria-live "polite" :aria-atomic "true"}
      (str (count clusters) " cluster" (when (not= 1 (count clusters)) "s") " found")]
     (if (seq clusters)
       [:> CommandGroup
        (for [cluster clusters]
          ^{:key (:id cluster)}
          [cluster-result-item cluster on-select])]
       [:div {:class "py-6 text-center text-sm text-gray-11" :role "status"}
        "No clusters found"])]))

(defn- connections-list
  "Connections list with search results"
  [connections selected-connection]
  [:<>
   ;; Screen reader announcement for search results
   [:div {:class "sr-only"
          :role "status"
          :aria-live "polite"
          :aria-atomic "true"}
    (when (seq connections)
      (str (count connections) " resource role" (when (not= 1 (count connections)) "s") " found"))]
   
   (if (seq connections)
     [:> CommandGroup
      (for [connection connections]
        ^{:key (:id connection)}
        [connection-result-item connection (= (:name connection) (:name selected-connection))])]
     [:div {:class "py-6 text-center text-sm text-gray-11"
            :role "status"}
      "No resource roles found"])])

(defn connection-dialog []
  (let [open? (rf/subscribe [:primary-connection/dialog-open?])
        selected (rf/subscribe [:primary-connection/selected])
        connections (rf/subscribe [:connections->pagination])
        search-term (r/atom "")
        search-debounce-timer (r/atom nil)
        agents (rf/subscribe [:agents])
        ;; nil = showing the cluster list; {:id :label} = drilled into one.
        ;; The id is the agent serving the cluster, which is how the resource
        ;; list is filtered server-side.
        open-cluster (r/atom nil)
        ;; Refetch the resources for the current step. Every fetch carries the
        ;; open cluster, so search stays scoped to it.
        fetch-resources! (fn [{:keys [search]}]
                           (let [cluster @open-cluster
                                 request (cond-> {:page 1 :force-refresh? true}
                                           (not (cs/blank? search)) (assoc :search search)
                                           cluster (assoc :filters {:agent_id (:id cluster)}))]
                             (rf/dispatch [:connections/get-connections-paginated request])))]

    (rf/dispatch [:agents->get-agents])

    (fn []
      (let [all-connections (or (:data @connections) [])
            connections-loading? (= :loading (:loading @connections))
            valid-connections (filter #(and
                                        (not (or (#{"tcp" "ssh" "ssh-local"} (:subtype %))
                                                 (http-proxy-subtypes (:subtype %))))
                                        (= "enabled" (:access_mode_exec %)))
                                      all-connections)
            show-clusters? (nil? @open-cluster)]
        [command-dialog/command-dialog
         {:open? @open?
          ;; the cluster step needs the agents list, so keep the spinner up
          ;; until it arrives rather than flashing "No clusters found"
          :loading? (or connections-loading?
                        (and show-clusters? (nil? (:data @agents))))
          :on-open-change (fn [open?]
                            (rf/dispatch [:primary-connection/toggle-dialog open?])
                            (when-not open?
                              ;; drop the cluster filter as well as the search,
                              ;; so the next open starts at the cluster list
                              ;; with an unfiltered pool behind it
                              (let [was-filtered? (or (some? @open-cluster)
                                                      (not (cs/blank? @search-term)))]
                                (reset! open-cluster nil)
                                (reset! search-term "")
                                (when @search-debounce-timer
                                  (js/clearTimeout @search-debounce-timer)
                                  (reset! search-debounce-timer nil))
                                (when was-filtered?
                                  (rf/dispatch [:connections/get-connections-paginated
                                                {:page 1 :force-refresh? true}])))))
          :title "Select or search a resource role"
          :search-config {:show-search-icon true
                          :show-input true
                          :placeholder "Select or search a resource role"
                          :value @search-term
                          :on-value-change (fn [value]
                                             (reset! search-term value)
                                             (when @search-debounce-timer
                                               (js/clearTimeout @search-debounce-timer))
                                             (let [trimmed (cs/trim value)
                                                   should-search? (or (cs/blank? trimmed) (> (count trimmed) 2))]
                                               (when should-search?
                                                 (reset! search-debounce-timer
                                                         (js/setTimeout
                                                          (fn [] (fetch-resources! {:search trimmed}))
                                                          500)))))
                          :on-key-down (fn [e]
                                         (when (= (.-key e) "Escape")
                                           (.preventDefault e)
                                           ;; inside a cluster, Escape steps back
                                           ;; to the cluster list before closing
                                           (if (and @open-cluster (cs/blank? @search-term))
                                             (do
                                               (reset! open-cluster nil)
                                               (fetch-resources! {}))
                                             (rf/dispatch [:primary-connection/toggle-dialog false]))))}
          :breadcrumb-config (if @open-cluster
                               {:context "Terminal"
                                :current-page (:label @open-cluster)
                                :on-close (fn []
                                            (reset! open-cluster nil)
                                            (reset! search-term "")
                                            (fetch-resources! {}))}
                               {:context "Terminal" :current-page "Resource Roles"})
          :content
          [infinite-scroll
           {:on-load-more (fn []
                            (when (not connections-loading?)
                              (let [current-page (:current-page @connections 1)
                                    next-page (inc current-page)
                                    active-search (:active-search @connections)
                                    next-request (cond-> {:page next-page
                                                          :force-refresh? false}
                                                   (not (cs/blank? active-search)) (assoc :search active-search)
                                                   @open-cluster (assoc :filters {:agent_id (:id @open-cluster)}))]
                                (rf/dispatch [:connections/get-connections-paginated next-request]))))
            :has-more? (:has-more? @connections)
            :loading? connections-loading?}
           (if show-clusters?
             [clusters-list (:data @agents)
              (fn [id label]
                (reset! open-cluster {:id id :label label})
                (reset! search-term "")
                (fetch-resources! {}))]
             [connections-list valid-connections @selected])]}]))))
