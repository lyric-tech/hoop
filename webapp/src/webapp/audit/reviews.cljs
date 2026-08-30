(ns webapp.audit.reviews
  "Review predicates shared by the session-details modal and the Terminal
  review banner, so the eligibility rule lives in exactly one place.")

(defn can-review?
  "True when the review is PENDING and the user belongs to a review group
  whose own status is still PENDING."
  [review user-groups]
  (let [groups (set user-groups)]
    (boolean
     (and (= "PENDING" (:status review))
          (some (fn [rg]
                  (and (= "PENDING" (:status rg))
                       (contains? groups (:group rg))))
                (:review_groups_data review))))))
