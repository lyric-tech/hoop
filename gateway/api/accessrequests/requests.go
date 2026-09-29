package accessrequests

import (
	"errors"
	"net/http"
	"time"

	"github.com/aws/smithy-go/ptr"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/hoophq/hoop/common/log"
	"github.com/hoophq/hoop/gateway/api/httputils"
	"github.com/hoophq/hoop/gateway/api/openapi"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/services"
	"github.com/hoophq/hoop/gateway/storagev2"
)

// maxAccessDuration is the ceiling applied when a rule sets no
// access_max_duration, mirroring the transport interceptor.
const maxAccessDuration = 48 * time.Hour

// ListRequestableAccessRules
//
//	@Summary		List Requestable Access Rules
//	@Description	List the access request rules the caller may request a time window against, each expanded into the resources one approval covers
//	@Tags			Access Requests
//	@Produce		json
//	@Success		200	{array}		openapi.RequestableAccessRule
//	@Failure		500	{object}	openapi.HTTPError
//	@Router			/access-requests/requestable [get]
func ListRequestableAccessRules(c *gin.Context) {
	ctx := storagev2.ParseContext(c)

	orgID, err := uuid.Parse(ctx.GetOrgID())
	if err != nil {
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "invalid organization ID")
		return
	}

	rules, err := services.ListRequestableRules(orgID, ctx.UserGroups)
	if err != nil {
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "failed listing requestable access rules")
		return
	}

	now := time.Now().UTC()
	items := []openapi.RequestableAccessRule{}
	for _, r := range rules {
		item := openapi.RequestableAccessRule{
			Name:              r.Rule.Name,
			Description:       r.Rule.Description,
			Resources:         r.Resources,
			AccessMaxDuration: r.Rule.AccessMaxDuration,
			ReviewersGroups:   r.Rule.ReviewersGroups,
		}

		grant, err := models.GetApprovedGrantForRule(ctx.OrgID, ctx.UserID, r.Rule.Name, now)
		switch {
		case err == nil:
			item.ActiveGrant = &openapi.ActiveAccessGrant{ReviewID: grant.ID, ExpiresAt: *grant.RevokedAt}
		case errors.Is(err, models.ErrNotFound): // no grant, the rule is requestable
		default:
			httputils.AbortWithErr(c, http.StatusInternalServerError, err, "failed fetching active grant")
			return
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, items)
}

// CreateAccessRequest
//
//	@Summary		Create Access Request
//	@Description	Request a time window over every resource an access request rule covers. Creates a pending review the rule's reviewers approve once, instead of one approval per command
//	@Tags			Access Requests
//	@Accept			json
//	@Produce		json
//	@Param			request	body		openapi.AccessRequestRequest	true	"The request body resource"
//	@Success		201		{object}	openapi.Review
//	@Failure		400,404,409,422,500	{object}	openapi.HTTPError
//	@Router			/access-requests [post]
func CreateAccessRequest(c *gin.Context) {
	ctx := storagev2.ParseContext(c)

	orgID, err := uuid.Parse(ctx.GetOrgID())
	if err != nil {
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "invalid organization ID")
		return
	}

	var req openapi.AccessRequestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httputils.AbortWithErr(c, http.StatusBadRequest, err, "invalid request body")
		return
	}

	rules, err := services.ListRequestableRules(orgID, ctx.UserGroups)
	if err != nil {
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "failed listing requestable access rules")
		return
	}

	var target *services.RequestableRule
	for i := range rules {
		if rules[i].Rule.Name == req.RuleName {
			target = &rules[i]
			break
		}
	}
	if target == nil {
		httputils.AbortWithErr(c, http.StatusNotFound, nil,
			"access request rule not found or not requestable by your groups")
		return
	}

	duration := time.Duration(req.DurationSec) * time.Second
	if duration <= 0 {
		httputils.AbortWithErr(c, http.StatusUnprocessableEntity, nil, "duration_sec must be greater than zero")
		return
	}
	maxDuration := maxAccessDuration
	if target.Rule.AccessMaxDuration != nil {
		maxDuration = time.Duration(*target.Rule.AccessMaxDuration) * time.Second
	}
	if duration > maxDuration {
		httputils.AbortWithErr(c, http.StatusUnprocessableEntity, nil,
			"requested duration exceeds the rule maximum of "+maxDuration.String())
		return
	}

	now := time.Now().UTC()
	if grant, err := models.GetApprovedGrantForRule(ctx.OrgID, ctx.UserID, target.Rule.Name, now); err == nil {
		httputils.AbortWithErr(c, http.StatusConflict, nil,
			"you already hold access to this group until "+grant.RevokedAt.Format(time.RFC3339))
		return
	} else if !errors.Is(err, models.ErrNotFound) {
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "failed fetching active grant")
		return
	}

	var reviewGroups []models.ReviewGroups
	for _, groupName := range target.Rule.ReviewersGroups {
		reviewGroups = append(reviewGroups, models.ReviewGroups{
			ID:        uuid.NewString(),
			OrgID:     ctx.OrgID,
			GroupName: groupName,
			Status:    models.ReviewStatusPending,
		})
	}
	if len(reviewGroups) == 0 {
		httputils.AbortWithErr(c, http.StatusUnprocessableEntity, nil,
			"the access request rule has no reviewers group configured")
		return
	}

	minApprovals := len(reviewGroups)
	if !target.Rule.AllGroupsMustApprove && target.Rule.MinApprovals != nil {
		minApprovals = *target.Rule.MinApprovals
	}

	// The review carries a representative connection because the approval path
	// resolves one, but the grant is keyed by rule name and so covers every
	// resource the rule lists. The session id is synthetic: a standing request
	// is raised ahead of any session, and reviewers act on it from the access
	// requests page rather than a session page.
	newRev := &models.Review{
		ID:                    uuid.NewString(),
		OrgID:                 ctx.OrgID,
		Type:                  models.ReviewTypeJit,
		SessionID:             uuid.NewString(),
		ConnectionName:        target.Resources[0],
		AccessDurationSec:     int64(duration.Seconds()),
		OwnerID:               ctx.UserID,
		OwnerEmail:            ctx.UserEmail,
		OwnerName:             ptr.String(ctx.UserName),
		OwnerSlackID:          ptr.String(ctx.SlackID),
		Status:                models.ReviewStatusPending,
		ReviewGroups:          reviewGroups,
		ForceApprovalGroups:   target.Rule.ForceApprovalGroups,
		AccessRequestRuleName: &target.Rule.Name,
		MinApprovals:          &minApprovals,
		CreatedAt:             now,
	}

	// the justification rides the review input blob, which is what reviewers
	// already read when deciding on a review
	if err := models.CreateReview(newRev, req.Justification); err != nil {
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "failed saving access request")
		return
	}

	log.With("id", newRev.ID, "org", ctx.OrgID, "user", ctx.UserID, "rule", target.Rule.Name,
		"resources", len(target.Resources), "duration", duration.String()).Infof("created standing access request")

	c.JSON(http.StatusCreated, toAccessRequestOpenApi(newRev))
}

func toAccessRequestOpenApi(r *models.Review) *openapi.Review {
	groups := []openapi.ReviewGroup{}
	for _, rg := range r.ReviewGroups {
		groups = append(groups, openapi.ReviewGroup{
			ID:     rg.ID,
			Group:  rg.GroupName,
			Status: openapi.ReviewRequestStatusType(rg.Status),
		})
	}
	return &openapi.Review{
		ID:                    r.ID,
		Session:               r.SessionID,
		Type:                  openapi.ReviewType(r.Type),
		AccessDuration:        time.Duration(r.AccessDurationSec) * time.Second,
		Status:                openapi.ReviewStatusType(r.Status),
		CreatedAt:             r.CreatedAt,
		ReviewGroupsData:      groups,
		AccessRequestRuleName: r.AccessRequestRuleName,
		MinApprovals:          r.MinApprovals,
		ReviewOwner: &openapi.ReviewOwner{
			ID:      r.OwnerID,
			Name:    ptr.ToString(r.OwnerName),
			Email:   r.OwnerEmail,
			SlackID: ptr.ToString(r.OwnerSlackID),
		},
	}
}
