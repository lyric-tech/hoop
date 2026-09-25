package models

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"gorm.io/gorm"
)

type (
	ReviewStatusType string
	ReviewType       string
)

const (
	ReviewStatusPending    ReviewStatusType = "PENDING"
	ReviewStatusApproved   ReviewStatusType = "APPROVED"
	ReviewStatusRejected   ReviewStatusType = "REJECTED"
	ReviewStatusRevoked    ReviewStatusType = "REVOKED"
	ReviewStatusProcessing ReviewStatusType = "PROCESSING"
	ReviewStatusExecuted   ReviewStatusType = "EXECUTED"
	ReviewStatusUnknown    ReviewStatusType = "UNKNOWN"

	ReviewTypeJit     ReviewType = "jit"
	ReviewTypeOneTime ReviewType = "onetime"
)

func (t ReviewStatusType) Str() string { return string(t) }

// reviewStatusLabels mirrors private.enum_reviews_status. It exists so a caller
// can tell a real status from arbitrary input before comparing against the enum
// column: casting a non-label to enum_reviews_status is an error, not an empty
// result. Keep it in sync when the enum gains a value — an omission only costs
// the index, never correctness.
var reviewStatusLabels = map[ReviewStatusType]struct{}{
	ReviewStatusPending:    {},
	ReviewStatusApproved:   {},
	ReviewStatusRejected:   {},
	ReviewStatusRevoked:    {},
	ReviewStatusProcessing: {},
	ReviewStatusExecuted:   {},
	ReviewStatusUnknown:    {},
}

// IsValidReviewStatus reports whether v is a label of private.enum_reviews_status.
func IsValidReviewStatus(v string) bool {
	_, ok := reviewStatusLabels[ReviewStatusType(v)]
	return ok
}

type Review struct {
	ID                string            `gorm:"column:id"`
	OrgID             string            `gorm:"column:org_id"`
	SessionID         string            `gorm:"column:session_id"`
	Type              ReviewType        `gorm:"column:type"`
	Status            ReviewStatusType  `gorm:"column:status"`
	ConnectionName    string            `gorm:"column:connection_name"`
	ConnectionID      sql.NullString    `gorm:"column:connection_id"`
	BlobInputID       sql.NullString    `gorm:"column:blob_input_id"`
	InputEnvVars      map[string]string `gorm:"column:input_env_vars;serializer:json"`
	InputClientArgs   pq.StringArray    `gorm:"column:input_client_args;type:text[]"`
	AccessDurationSec int64             `gorm:"column:access_duration_sec"`
	OwnerID           string            `gorm:"column:owner_id"`
	OwnerEmail        string            `gorm:"column:owner_email"`
	OwnerName         *string           `gorm:"column:owner_name"`
	OwnerSlackID      *string           `gorm:"column:owner_slack_id"`

	ReviewGroups          []ReviewGroups `gorm:"column:review_groups;serializer:json;->"`
	AccessRequestRuleName *string        `gorm:"column:access_request_rule_name"`
	ForceApprovalGroups   pq.StringArray `gorm:"column:force_approval_groups;type:text[]"`
	MinApprovals          *int           `gorm:"column:min_approvals"`

	CreatedAt       time.Time         `gorm:"column:created_at"`
	RevokedAt       *time.Time        `gorm:"column:revoked_at"`
	TimeWindow      *ReviewTimeWindow `gorm:"column:time_window;serializer:json;"`
	RejectionReason *string           `gorm:"column:rejection_reason"`

	// Verb is the verb of the session that filed the review. Read only: it
	// lives on private.sessions and is joined by the loaders.
	Verb string `gorm:"column:verb;->"`
}

type ReviewTimeWindow struct {
	Type          string            `json:"type"`
	Configuration map[string]string `json:"configuration"`
}

type ReviewGroups struct {
	ID           string           `json:"id"`
	OrgID        string           `json:"org_id"`
	ReviewID     string           `json:"review_id"`
	GroupName    string           `json:"group_name"`
	Status       ReviewStatusType `json:"status"`
	OwnerID      *string          `json:"owner_id"`
	OwnerEmail   *string          `json:"owner_email"`
	OwnerName    *string          `json:"owner_name"`
	OwnerSlackID *string          `json:"owner_slack_id"`
	ReviewedAt   *time.Time       `json:"reviewed_at"`
	ForcedReview bool             `json:"forced_review"`
}

// RejectedByEmail returns the email of the reviewer whose group rejected the
// review, or "" when no rejecting group with an email is recorded. It mirrors
// the web UI, which resolves "Rejected by" from the review group whose status
// is REJECTED.
func (r *Review) RejectedByEmail() string {
	if r == nil {
		return ""
	}
	for _, rg := range r.ReviewGroups {
		if rg.Status == ReviewStatusRejected && rg.OwnerEmail != nil {
			return *rg.OwnerEmail
		}
	}
	return ""
}

// RevokedByEmail returns the email of whoever revoked the review, from the
// latest REVOKED group row, or "" when none is recorded.
func (r *Review) RevokedByEmail() string {
	if r == nil {
		return ""
	}
	for i := len(r.ReviewGroups) - 1; i >= 0; i-- {
		rg := r.ReviewGroups[i]
		if rg.Status == ReviewStatusRevoked && rg.OwnerEmail != nil {
			return *rg.OwnerEmail
		}
	}
	return ""
}

type ReviewJit struct {
	ID                string     `gorm:"column:id"`
	OrgID             string     `gorm:"column:org_id"`
	SessionID         string     `gorm:"column:session_id"`
	Type              string     `gorm:"column:type"`
	AccessDurationSec int64      `gorm:"column:access_duration_sec"`
	OwnerEmail        string     `gorm:"column:owner_email"`
	CreatedAt         time.Time  `gorm:"column:created_at"`
	RevokedAt         *time.Time `gorm:"column:revoked_at"`
}

func generateBlobInputID(reviewID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, fmt.Appendf(nil, "reviewinput:%s", reviewID)).String()
}

// GetBlobInput returns the input if the blob input id is set
func (r *Review) GetBlobInput() (string, error) {
	if !r.BlobInputID.Valid {
		return "", nil
	}
	blobID := generateBlobInputID(r.ID)
	var blob Blob
	err := DB.Table("private.blobs").
		Where("org_id = ? AND id = ?", r.OrgID, blobID).
		First(&blob).
		Error
	if err != nil {
		return "", err
	}

	result := []string{}
	if err := json.Unmarshal(blob.BlobStream, &result); err != nil {
		return "", fmt.Errorf("failed decoding blob input to []string: %v", err)
	}
	if len(result) == 0 {
		return "", nil
	}
	return result[0], nil
}

// reviewGroupsJSONSQL aggregates the group rows of the review aliased rv, in
// decision order. forced_review must stay in the object: UpdateReview saves
// every loaded group row with all of its columns, so a row loaded without it
// would be written back as false and erase a forced approval.
const reviewGroupsJSONSQL = `(
	SELECT jsonb_agg(
		jsonb_build_object(
			'id', rg.id,
			'org_id', rg.org_id,
			'review_id', rg.review_id,
			'group_name', rg.group_name,
			'status', rg.status,
			'owner_id', rg.owner_id,
			'owner_email', rg.owner_email,
			'owner_name', rg.owner_name,
			'owner_slack_id', rg.owner_slack_id,
			'reviewed_at', to_char(rg.reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'forced_review', rg.forced_review
		) ORDER BY rg.reviewed_at ASC NULLS LAST, rg.id
	)
	FROM private.review_groups AS rg
	WHERE rg.review_id = rv.id
)`

// reviewColumnsSQL is the column list every review loader selects from
// private.reviews aliased rv.
const reviewColumnsSQL = `
	rv.id, rv.org_id, rv.session_id, rv.connection_name, rv.connection_id, rv.type,
	rv.access_duration_sec, rv.status, rv.blob_input_id, rv.input_env_vars, rv.input_client_args,
	rv.time_window, rv.access_request_rule_name, rv.force_approval_groups, rv.min_approvals,
	rv.owner_id, rv.owner_email, rv.owner_name, rv.owner_slack_id,
	` + reviewGroupsJSONSQL + ` AS review_groups,
	(SELECT s.verb FROM private.sessions s WHERE s.org_id = rv.org_id AND s.id = rv.session_id) AS verb,
	rv.created_at, rv.revoked_at, rv.rejection_reason`

func GetReviewByIdOrSid(orgID, id string) (*Review, error) {
	var review Review
	err := DB.Raw(`SELECT `+reviewColumnsSQL+`
	FROM private.reviews rv
	WHERE rv.org_id = ? AND (rv.id = ? OR rv.session_id = ?)`, orgID, id, id).
		First(&review).
		Error
	if err == gorm.ErrRecordNotFound {
		return nil, ErrNotFound
	}
	return &review, err
}

func ListReviews(orgID string) (*[]Review, error) {
	var reviews []Review
	err := DB.Raw(`SELECT `+reviewColumnsSQL+`
	FROM private.reviews rv
	WHERE rv.org_id = ?`, orgID).
		Find(&reviews).
		Error
	if err != nil {
		return nil, err
	}

	return &reviews, nil
}

const (
	MaxReviewListLimit  = 100
	MaxReviewListOffset = 10000
)

// ReviewListOptions narrows ListReviewsFiltered. Zero values mean no filter;
// Limit 0 means every matching review, which keeps the unpaged callers
// working.
type ReviewListOptions struct {
	Statuses       []ReviewStatusType
	Type           ReviewType
	ConnectionName string
	OwnerID        string
	OwnerEmail     string
	StartDate      *time.Time
	EndDate        *time.Time
	Limit          int
	Offset         int
}

// ReviewListCaller is who is listing. A caller that is neither admin nor
// auditor sees the reviews they own and the reviews one of their groups can
// decide, the same rule GET /reviews/:id applies.
type ReviewListCaller struct {
	UserID           string
	UserGroups       []string
	IsAuditorOrAdmin bool
}

// reviewListWhere builds the WHERE clause for ListReviewsFiltered. Only the
// predicates whose option is set are emitted; every value is a named
// parameter.
func reviewListWhere(caller ReviewListCaller, opt ReviewListOptions) string {
	preds := []string{"rv.org_id = @org_id"}
	if len(opt.Statuses) > 0 {
		preds = append(preds, "rv.status = ANY(CAST(@statuses AS private.enum_reviews_status[]))")
	}
	if opt.Type != "" {
		preds = append(preds, "rv.type = CAST(@type AS private.enum_reviews_type)")
	}
	if opt.ConnectionName != "" {
		preds = append(preds, "rv.connection_name = @connection")
	}
	if opt.OwnerID != "" {
		preds = append(preds, "rv.owner_id = @owner_id")
	}
	if opt.OwnerEmail != "" {
		preds = append(preds, "LOWER(rv.owner_email) = LOWER(@owner_email)")
	}
	if opt.StartDate != nil {
		preds = append(preds, "rv.created_at >= @start_date")
	}
	if opt.EndDate != nil {
		preds = append(preds, "rv.created_at <= @end_date")
	}
	if !caller.IsAuditorOrAdmin {
		preds = append(preds, `(rv.owner_id = @user_id OR EXISTS (
		SELECT 1 FROM private.review_groups rg
		WHERE rg.review_id = rv.id AND rg.group_name = ANY(CAST(@user_groups AS TEXT[]))))`)
	}
	return strings.Join(preds, "\n\tAND ")
}

// ListReviewsFiltered returns the reviews of an org visible to caller,
// newest first.
func ListReviewsFiltered(db *gorm.DB, orgID string, caller ReviewListCaller, opt ReviewListOptions) ([]Review, error) {
	if opt.Limit < 0 || opt.Limit > MaxReviewListLimit {
		return nil, fmt.Errorf("limit must be between 0 and %d, got %d", MaxReviewListLimit, opt.Limit)
	}
	if opt.Offset < 0 || opt.Offset > MaxReviewListOffset {
		return nil, fmt.Errorf("offset must be between 0 and %d, got %d", MaxReviewListOffset, opt.Offset)
	}
	statuses := make([]string, 0, len(opt.Statuses))
	for _, st := range opt.Statuses {
		if !IsValidReviewStatus(string(st)) {
			return nil, fmt.Errorf("invalid review status %q", st)
		}
		statuses = append(statuses, string(st))
	}
	userGroups := caller.UserGroups
	if userGroups == nil {
		userGroups = []string{}
	}
	params := map[string]any{
		"org_id":      orgID,
		"statuses":    pq.StringArray(statuses),
		"type":        string(opt.Type),
		"connection":  opt.ConnectionName,
		"owner_id":    opt.OwnerID,
		"owner_email": opt.OwnerEmail,
		"start_date":  opt.StartDate,
		"end_date":    opt.EndDate,
		"user_id":     caller.UserID,
		"user_groups": pq.StringArray(userGroups),
		"offset":      opt.Offset,
	}
	query := `SELECT ` + reviewColumnsSQL + `
	FROM private.reviews rv
	WHERE ` + reviewListWhere(caller, opt) + `
	ORDER BY rv.created_at DESC, rv.id DESC`
	if opt.Limit > 0 {
		query += "\n\tLIMIT @limit"
		params["limit"] = opt.Limit
	}
	query += "\n\tOFFSET @offset"

	reviews := []Review{}
	if err := db.Raw(query, params).Find(&reviews).Error; err != nil {
		return nil, err
	}
	return reviews, nil
}

// Create the review object, when input is not empty it generates a blob id
// and save the input as well.
func CreateReview(rev *Review, input string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		blobID := generateBlobInputID(rev.ID)
		if input != "" {
			rev.BlobInputID = sql.NullString{String: blobID, Valid: true}
		}
		err := tx.Table("private.reviews").
			Create(rev).
			Error
		if err != nil {
			return err
		}

		if input != "" {
			blobInput := Blob{
				ID:         blobID,
				OrgID:      rev.OrgID,
				Type:       "review-input",
				BlobStream: json.RawMessage(fmt.Sprintf("[%q]", input)),
			}
			err = tx.Table("private.blobs").
				Create(blobInput).
				Error
			if err != nil {
				return fmt.Errorf("failed creating review blob input, reason=%v", err)
			}
		}

		var errs []string
		for _, rg := range rev.ReviewGroups {
			err = tx.Table("private.review_groups").
				Create(map[string]any{
					"id":             rg.ID,
					"org_id":         rg.OrgID,
					"review_id":      rev.ID,
					"group_name":     rg.GroupName,
					"status":         rg.Status,
					"owner_id":       rg.OwnerID,
					"owner_email":    rg.OwnerEmail,
					"owner_slack_id": rg.OwnerSlackID,
					"reviewed_at":    rg.ReviewedAt,
				}).
				Error

			if err != nil {
				errs = append(errs, fmt.Sprintf("%v", err))
			}
		}
		if len(errs) > 0 {
			return fmt.Errorf("%v", errs)
		}
		return nil
	})
}

// Lookup for the latest review jit approved
func GetApprovedReviewJit(orgID, ownerUserID, connectionID string) (*ReviewJit, error) {
	var jit ReviewJit
	err := DB.Raw(`
	SELECT id, org_id, session_id, type, access_duration_sec, owner_email, created_at, revoked_at
	FROM private.reviews
	WHERE org_id = ? AND type = 'jit' AND status = 'APPROVED' AND owner_id = ? AND connection_id = ?
	ORDER BY created_at DESC
	LIMIT 1`, orgID, ownerUserID, connectionID).
		First(&jit).
		Error
	if err == gorm.ErrRecordNotFound {
		return nil, ErrNotFound
	}
	return &jit, err
}

// update the review resource,
// it updates the session status when the review status is approved, rejected or revoked
func UpdateReview(rev *Review) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		res := tx.Table("private.reviews").
			Where("org_id = ?", rev.OrgID).
			Updates(rev)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return fmt.Errorf("no record updated for review %s", rev.ID)
		}
		var errs []string
		for _, rg := range rev.ReviewGroups {
			res = tx.Table("private.review_groups").
				Where("org_id = ? AND review_id = ?", rev.OrgID, rev.ID).
				Save(rg)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				errs = append(errs, fmt.Sprintf("no rows updated for review group, gid=%v, name=%v, status=%v",
					rg.ID, rg.GroupName, rg.Status))
			}
		}
		if len(errs) > 0 {
			return fmt.Errorf("%v", errs)
		}

		var sessionStatus string
		switch rev.Status {
		case ReviewStatusApproved:
			sessionStatus = "ready"
		case ReviewStatusRejected, ReviewStatusRevoked:
			sessionStatus = "done"
		}

		if sessionStatus != "" {
			return tx.Table("private.sessions").
				Where("org_id = ? AND id = ?", rev.OrgID, rev.SessionID).
				UpdateColumn("status", sessionStatus).
				Error
		}
		return nil
	})
}

func UpdateReviewStatus(orgID, id string, status ReviewStatusType) error {
	res := DB.Table("private.reviews").
		Where("org_id = ? AND id = ?", orgID, id).
		UpdateColumn("status", status)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

// SetReviewStatusExecutedIfFinished settles the one-time review of the given
// session as EXECUTED once the session has finished. A review stays in
// PROCESSING while the execution runs in the agent (legacy rows may hold
// UNKNOWN); the session is the source of truth for the execution outcome, so
// when it reaches the done status the review is considered consumed. It is a
// no-op (false, nil) when the session has no review, the review is in any
// other status or the session has not finished.
func SetReviewStatusExecutedIfFinished(db *gorm.DB, orgID, sessionID string) (bool, error) {
	res := db.Exec(`
	UPDATE private.reviews AS r
	SET status = ?
	FROM private.sessions AS s
	WHERE s.org_id = r.org_id AND s.id = r.session_id
	AND r.org_id = ? AND r.session_id = ? AND r.type = ?
	AND r.status IN (?, ?) AND s.status = 'done'`,
		ReviewStatusExecuted, orgID, sessionID, ReviewTypeOneTime,
		ReviewStatusProcessing, ReviewStatusUnknown)
	return res.RowsAffected > 0, res.Error
}

// ReconcileStaleReviews settles as EXECUTED every one-time review left in
// PROCESSING or UNKNOWN whose session already finished. These reviews are
// normally settled when the session closes, but a gateway restart in between
// leaves them stale; this runs once at startup. It returns the number of
// reviews updated.
func ReconcileStaleReviews(db *gorm.DB) (int64, error) {
	res := db.Exec(`
	UPDATE private.reviews AS r
	SET status = ?
	FROM private.sessions AS s
	WHERE s.org_id = r.org_id AND s.id = r.session_id
	AND r.type = ? AND r.status IN (?, ?) AND s.status = 'done'`,
		ReviewStatusExecuted, ReviewTypeOneTime,
		ReviewStatusProcessing, ReviewStatusUnknown)
	return res.RowsAffected, res.Error
}
