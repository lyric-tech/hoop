package accessrequestinterceptor

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/aws/smithy-go/ptr"
	"github.com/google/uuid"
	"github.com/hoophq/hoop/common/log"
	pb "github.com/hoophq/hoop/common/proto"
	pbagent "github.com/hoophq/hoop/common/proto/agent"
	pbclient "github.com/hoophq/hoop/common/proto/client"
	"github.com/hoophq/hoop/gateway/appconfig"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/services"
	plugintypes "github.com/hoophq/hoop/gateway/transport/plugins/types"
	"github.com/hoophq/hoop/gateway/utils"
)

// grantWindow returns how long an approved grant still covers the caller. It
// reports false when the record carries no expiry (an inconsistent jit row) or
// the window already closed, so the caller falls back to creating a review.
func grantWindow(revokedAt *time.Time, now time.Time) (time.Duration, bool) {
	if revokedAt == nil || revokedAt.IsZero() {
		return 0, false
	}
	remaining := revokedAt.Sub(now)
	return remaining, remaining > 0
}

// getValidatedGrant looks for an approved grant the user already holds under
// this access request rule. A grant covers every connection the rule lists and
// every verb, so within the window neither a session nor an ad-hoc command
// raises a new approval.
func getValidatedGrant(pctx plugintypes.Context, ruleName string) (*plugintypes.ConnectResponse, error) {
	now := time.Now().UTC()
	grant, err := models.GetApprovedGrantForRule(pctx.OrgID, pctx.UserID, ruleName, now)
	if err != nil && err != models.ErrNotFound {
		return nil, plugintypes.InternalErr("failed listing time based reviews", err)
	}

	if grant != nil {
		remaining, ok := grantWindow(grant.RevokedAt, now)
		if !ok {
			return nil, plugintypes.InternalErr("found inconsistent jit record",
				fmt.Errorf("revoked_at attribute is empty for %s", grant.ID))
		}
		log.With("sid", pctx.SID, "id", grant.ID, "user", grant.OwnerEmail, "org", pctx.OrgID,
			"rule", ruleName, "revoke-at", grant.RevokedAt.Format(time.RFC3339),
			"remaining", fmt.Sprintf("%vs", remaining.Seconds())).Infof("grant access granted")
		newCtx, cancel := context.WithTimeout(pctx.Context, remaining)
		_ = cancel // cancel is not called here; the context expires via timeout or when the parent context is done
		return &plugintypes.ConnectResponse{Context: newCtx, ClientPacket: nil}, nil
	}

	log.With("sid", pctx.SID, "orgid", pctx.GetOrgID(), "user-id", pctx.UserID,
		"connection-id", pctx.ConnectionID, "rule", ruleName).Infof("no active grant found")

	return nil, nil
}

func getValidatedOneTimeReview(pctx plugintypes.Context) (bool, *plugintypes.ConnectResponse, error) {
	otrev, err := models.GetReviewByIdOrSid(pctx.OrgID, pctx.SID)
	if err != nil && err != models.ErrNotFound {
		log.With("sid", pctx.SID).Error("failed fetching session, err=%v", err)
		return false, nil, plugintypes.InternalErr("failed fetching review", err)
	}

	if otrev != nil && otrev.Type == models.ReviewTypeOneTime {
		log.With("id", otrev.ID, "sid", pctx.SID, "user", otrev.OwnerEmail, "org", pctx.OrgID,
			"status", otrev.Status).Info("one time review")

		if !(otrev.Status == models.ReviewStatusApproved || otrev.Status == models.ReviewStatusProcessing) {
			reviewURL := fmt.Sprintf("%s/sessions/%s", appconfig.Get().FullApiURL(), otrev.SessionID)
			return false, &plugintypes.ConnectResponse{Context: nil, ClientPacket: &pb.Packet{
				Type:    pbclient.SessionOpenWaitingApproval,
				Payload: []byte(reviewURL),
				Spec:    map[string][]byte{pb.SpecGatewaySessionID: []byte(pctx.SID)},
			}}, nil
		}

		if otrev.Status == models.ReviewStatusApproved {
			if err := models.UpdateReviewStatus(otrev.OrgID, otrev.ID, models.ReviewStatusProcessing); err != nil {
				return false, nil, plugintypes.InternalErr("failed updating approved review", err)
			}
		}

		// if the review is already approved or processing, just continue without returning a response
		return true, nil, nil
	}

	return false, nil, nil
}

func createReview(pctx plugintypes.Context, isJitReview bool, accessRequestRule *models.AccessRequestRule, accessDuration time.Duration, sessionInput string, inputEnvVars map[string]string, inputClientArgs []string) (*models.Review, error) {
	var reviewGroups []models.ReviewGroups
	for _, approvalGroupName := range accessRequestRule.ReviewersGroups {
		reviewGroups = append(reviewGroups, models.ReviewGroups{
			ID:        uuid.NewString(),
			OrgID:     pctx.OrgID,
			GroupName: approvalGroupName,
			Status:    models.ReviewStatusPending,
		})
	}

	reviewType := models.ReviewTypeOneTime
	if isJitReview {
		reviewType = models.ReviewTypeJit
	}

	var minApprovals int
	if accessRequestRule.AllGroupsMustApprove {
		minApprovals = len(reviewGroups)
	} else {
		minApprovals = *accessRequestRule.MinApprovals
	}

	newRev := &models.Review{
		ID:                    uuid.NewString(),
		OrgID:                 pctx.OrgID,
		Type:                  reviewType,
		SessionID:             pctx.SID,
		ConnectionName:        pctx.ConnectionName,
		ConnectionID:          sql.NullString{String: pctx.ConnectionID, Valid: true},
		AccessDurationSec:     int64(accessDuration.Seconds()),
		InputEnvVars:          inputEnvVars,
		InputClientArgs:       inputClientArgs,
		OwnerID:               pctx.UserID,
		OwnerEmail:            pctx.UserEmail,
		OwnerName:             ptr.String(pctx.UserName),
		OwnerSlackID:          ptr.String(pctx.UserSlackID),
		Status:                models.ReviewStatusPending,
		ReviewGroups:          reviewGroups,
		ForceApprovalGroups:   accessRequestRule.ForceApprovalGroups,
		AccessRequestRuleName: &accessRequestRule.Name,
		MinApprovals:          &minApprovals,
		CreatedAt:             time.Now().UTC(),
		RevokedAt:             nil,
	}

	log.With("sid", pctx.SID, "id", newRev.ID, "user", pctx.UserID, "org", pctx.OrgID,
		"type", reviewType, "duration", fmt.Sprintf("%vm", accessDuration.Minutes())).
		Infof("creating review")

	if err := models.CreateReview(newRev, sessionInput); err != nil {
		return nil, plugintypes.InternalErr("failed saving review", err)
	}

	// update session input when executing ad-hoc executions via cli
	if strings.HasPrefix(pctx.ClientOrigin, pb.ConnectionOriginClient) {
		if err := models.UpdateSessionInput(pctx.OrgID, pctx.SID, sessionInput); err != nil {
			return nil, plugintypes.InternalErr("failed updating session input", err)
		}
	}

	return newRev, nil
}

func OnReceive(pctx plugintypes.Context, pkt *pb.Packet) (*plugintypes.ConnectResponse, error) {
	// for plain exec we don't require or create any review, just proceed with the execution
	if pctx.ClientVerb == pb.ClientVerbPlainExec {
		return nil, nil
	}

	if pkt.Type != pbagent.SessionOpen {
		return nil, nil
	}

	// 1. check if there's an existing one-time review for this session, if yes validate and return it
	isApproved, resp, err := getValidatedOneTimeReview(pctx)
	if err != nil {
		return nil, err
	}
	if resp != nil {
		setSpecReview(pkt)
		return resp, nil
	}
	if isApproved {
		return nil, nil
	}

	// 2. resolve the rule that gates this resource
	isConnectVerb := pctx.ClientVerb == pb.ClientVerbConnect
	accessType := models.AccessTypeCommand
	if isConnectVerb {
		accessType = models.AccessTypeJit
	}

	orgID := uuid.MustParse(pctx.OrgID)
	accessRule, err := services.GetRuleForConnection(orgID, pctx.ConnectionName, accessType)
	if err != nil {
		return nil, plugintypes.InternalErr("failed fetching access request rule", err)
	}

	if accessRule == nil {
		log.With("sid", pctx.SID, "orgid", pctx.OrgID, "user-id", pctx.UserID, "connection-id", pctx.ConnectionID,
			"access-type", accessType).Infof("no access rule found for this resource and access type")
		return nil, nil
	}

	if len(accessRule.ApprovalRequiredGroups) > 0 {
		needsReview := utils.SlicesHasIntersection(accessRule.ApprovalRequiredGroups, pctx.UserGroups)
		if !needsReview {
			log.With("sid", pctx.SID, "orgid", pctx.GetOrgID(), "user-id", pctx.UserID, "connection-id", pctx.ConnectionID,
				"access-rule-id", accessRule.ID).Infof("user is not part of access rule approval groups, skipping review")
			return nil, nil
		}
	}

	if len(accessRule.ApprovalRequiredGroups) == 0 && len(accessRule.SkipReviewGroups) > 0 &&
		utils.SlicesHasIntersection(accessRule.SkipReviewGroups, pctx.UserGroups) {
		log.With("sid", pctx.SID, "orgid", pctx.GetOrgID(), "user-id", pctx.UserID, "connection-id", pctx.ConnectionID,
			"access-rule-id", accessRule.ID).Infof("user is part of access rule skip review groups, skipping review")
		return nil, nil
	}

	// 3. an approved grant on this rule already covers every resource it lists,
	// for any verb, until the window closes
	resp, err = getValidatedGrant(pctx, accessRule.Name)
	if err != nil {
		return nil, err
	}
	if resp != nil {
		setSpecReview(pkt)
		return resp, nil
	}

	// 4. no grant, create a review. A rule that gates sessions grants a time
	// window on approval; a command-only rule keeps approving one statement at
	// a time.
	isJitReview := accessRule.AccessType != models.AccessTypeCommand

	var accessDuration time.Duration
	if isJitReview {
		// this is the minimum duration to not conflict with the access rule max duration attribute
		// so it won't have cli issues when the user doesn't provide any jit duration
		durationStr := []byte("15m")
		if d, ok := pkt.Spec[pb.SpecJitTimeout]; ok {
			durationStr = d
		}

		accessDuration, err = time.ParseDuration(string(durationStr))
		if err != nil {
			return nil, plugintypes.InvalidArgument("invalid access time duration, got=%v", string(durationStr))
		}

		if accessRule.AccessMaxDuration != nil {
			maxDuration := time.Duration(*accessRule.AccessMaxDuration) * time.Second

			if accessDuration > maxDuration {
				return nil, plugintypes.InvalidArgument("jit access input exceeds connection max duration of %vs",
					maxDuration.Seconds())
			}
		} else if accessDuration.Hours() > 48 {
			return nil, plugintypes.InvalidArgument("jit access input must not be greater than 48 hours")
		}
	}

	// the input is recorded for the session audit trail even when the review
	// grants a window rather than approving this single statement
	var sessionInput string
	var inputEnvVars map[string]string
	var inputClientArgs []string
	if !isConnectVerb {
		sessionInput = string(pkt.Payload)
		if encInputEnvVars, ok := pkt.Spec[pb.SpecClientExecEnvVar]; ok {
			if err := pb.GobDecodeInto(encInputEnvVars, &inputEnvVars); err != nil {
				return nil, plugintypes.InternalErr("failed decoding input env vars", err)
			}
		}
		if encInputClientArgs, ok := pkt.Spec[pb.SpecClientExecArgsKey]; ok {
			if err := pb.GobDecodeInto(encInputClientArgs, &inputClientArgs); err != nil {
				return nil, plugintypes.InternalErr("failed decoding input client args", err)
			}
		}
	}

	newRev, err := createReview(pctx, isJitReview, accessRule, accessDuration, sessionInput, inputEnvVars, inputClientArgs)
	if err != nil {
		return nil, err
	}

	setSpecReview(pkt)

	return &plugintypes.ConnectResponse{Context: nil, ClientPacket: &pb.Packet{
		Type:    pbclient.SessionOpenWaitingApproval,
		Payload: fmt.Appendf(nil, "%s/sessions/%s", appconfig.Get().FullApiURL(), newRev.SessionID),
		Spec:    map[string][]byte{pb.SpecGatewaySessionID: []byte(pctx.SID)},
	}}, nil
}

// indicate to other plugins that this packet has the review enabled
// it will allow applying special logic for these cases
func setSpecReview(pkt *pb.Packet) { pkt.Spec[pb.SpecHasReviewKey] = []byte("true") }
