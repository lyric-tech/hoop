package reviewapi

import (
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/aws/smithy-go/ptr"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/hoophq/hoop/gateway/api/httputils"
	"github.com/hoophq/hoop/gateway/api/openapi"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/storagev2"
)

const (
	TimelineRequested = "requested"
	TimelineApproved  = "approved"
	TimelineRejected  = "rejected"
	TimelineForced    = "forced"
	TimelineRevoked   = "revoked"
	TimelineExpired   = "expired"
	TimelineSession   = "session"
)

// Timeline
//
//	@Summary		Get Review Timeline
//	@Description	The history of a review, oldest first: the request, each group decision, a revoke or expiry, and the sessions it covered.
//	@Tags			Reviews
//	@Param			id	path	string	true	"Resource identifier of the review"
//	@Produce		json
//	@Success		200			{object}	openapi.ReviewTimeline
//	@Failure		403,404,500	{object}	openapi.HTTPError
//	@Router			/reviews/{id}/timeline [get]
func (h *handler) Timeline(c *gin.Context) {
	ctx := storagev2.ParseContext(c)
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": models.ErrNotFound.Error()})
		return
	}
	rev, err := models.GetReviewByIdOrSid(ctx.GetOrgID(), id)
	switch err {
	case nil:
	case models.ErrNotFound:
		c.JSON(http.StatusNotFound, gin.H{"message": models.ErrNotFound.Error()})
		return
	default:
		httputils.AbortWithErr(c, http.StatusInternalServerError, err, "failed fetching review: %v", err)
		return
	}
	if !canAccessReview(ctx, rev) {
		c.JSON(http.StatusForbidden, gin.H{"message": "user is not allowed to access this review"})
		return
	}

	c.JSON(http.StatusOK, openapi.ReviewTimeline{
		Review: *toOpenApiReview(rev),
		Events: buildTimeline(rev, nil, time.Now().UTC()),
	})
}

// buildTimeline turns a review, its group rows and the sessions that ran
// under it into events ordered by time. The session that filed the review is
// the request itself, so it rides on the requested event instead of being a
// session event of its own.
func buildTimeline(rev *models.Review, sessions []models.Session, now time.Time) []openapi.ReviewTimelineEvent {
	requested := fmt.Sprintf("command on %s", rev.ConnectionName)
	if rev.Type == models.ReviewTypeJit {
		requested = fmt.Sprintf("%s on %s", formatAccessDuration(rev.AccessDurationSec), rev.ConnectionName)
	}
	events := []openapi.ReviewTimelineEvent{{
		At: rev.CreatedAt, Kind: TimelineRequested, By: rev.OwnerEmail, Detail: requested, SessionID: rev.SessionID,
	}}

	for _, rg := range rev.ReviewGroups {
		if rg.ReviewedAt == nil {
			continue
		}
		var kind string
		switch rg.Status {
		case models.ReviewStatusApproved:
			kind = TimelineApproved
			if rg.ForcedReview {
				kind = TimelineForced
			}
		case models.ReviewStatusRejected:
			kind = TimelineRejected
		case models.ReviewStatusRevoked:
			kind = TimelineRevoked
		default:
			continue
		}
		detail := "group " + rg.GroupName
		if kind != TimelineApproved && kind != TimelineForced && rev.RejectionReason != nil && *rev.RejectionReason != "" {
			detail = *rev.RejectionReason
		}
		events = append(events, openapi.ReviewTimelineEvent{
			At: *rg.ReviewedAt, Kind: kind, By: ptr.ToString(rg.OwnerEmail), Detail: detail,
		})
	}

	for _, s := range sessions {
		events = append(events, openapi.ReviewTimelineEvent{
			At: s.CreatedAt, Kind: TimelineSession, By: s.UserEmail, Detail: sessionDetail(s), SessionID: s.ID,
		})
	}

	// revoked_at holds the planned expiry of an approved time-based review.
	if rev.Type == models.ReviewTypeJit && rev.Status == models.ReviewStatusApproved &&
		rev.RevokedAt != nil && rev.RevokedAt.Before(now) {
		events = append(events, openapi.ReviewTimelineEvent{
			At: *rev.RevokedAt, Kind: TimelineExpired, Detail: "access window ended",
		})
	}

	sort.SliceStable(events, func(i, j int) bool { return events[i].At.Before(events[j].At) })
	return events
}

func sessionDetail(s models.Session) string {
	detail := s.Verb
	if s.EndSession != nil {
		detail += " · " + s.EndSession.Sub(s.CreatedAt).Round(100*time.Millisecond).String()
	}
	if s.ExitCode != nil {
		detail += fmt.Sprintf(" · exit %d", *s.ExitCode)
	}
	return detail
}

// formatAccessDuration renders seconds as "1h", "30m" or "1h30m".
func formatAccessDuration(sec int64) string {
	d := time.Duration(sec) * time.Second
	h, m := int(d.Hours()), int(d.Minutes())%60
	switch {
	case h > 0 && m > 0:
		return fmt.Sprintf("%dh%dm", h, m)
	case h > 0:
		return fmt.Sprintf("%dh", h)
	default:
		return fmt.Sprintf("%dm", m)
	}
}
