package reviewapi

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hoophq/hoop/gateway/models"
)

// Query string keys accepted by GET /reviews. All are optional; with none set
// the endpoint returns every review the caller can see, as it always did.
const (
	reviewOptionStatus     = "status"
	reviewOptionType       = "type"
	reviewOptionConnection = "connection"
	reviewOptionUser       = "user"
	reviewOptionStartDate  = "start_date"
	reviewOptionEndDate    = "end_date"
	reviewOptionLimit      = "limit"
	reviewOptionOffset     = "offset"
)

var availableReviewOptions = []string{
	reviewOptionStatus, reviewOptionType, reviewOptionConnection, reviewOptionUser,
	reviewOptionStartDate, reviewOptionEndDate, reviewOptionLimit, reviewOptionOffset,
}

// invalidReviewListOptionError is a query string the caller can fix; the
// handler renders it as 422.
type invalidReviewListOptionError struct {
	option string
	reason string
}

func (e *invalidReviewListOptionError) Error() string {
	return fmt.Sprintf("failed listing reviews, invalid %q option: %s", e.option, e.reason)
}

func invalidReviewOption(key, format string, args ...any) error {
	return &invalidReviewListOptionError{option: key, reason: fmt.Sprintf(format, args...)}
}

// parseReviewListOptions builds the model options for GET /reviews. userID is
// the caller, so user=me resolves without trusting the query string.
func parseReviewListOptions(qs url.Values, userID string) (models.ReviewListOptions, error) {
	var opt models.ReviewListOptions
	for _, key := range availableReviewOptions {
		val := strings.TrimSpace(qs.Get(key))
		if val == "" {
			continue
		}
		switch key {
		case reviewOptionStatus:
			for _, st := range strings.Split(val, ",") {
				st = strings.ToUpper(strings.TrimSpace(st))
				if !models.IsValidReviewStatus(st) {
					return opt, invalidReviewOption(key, "unknown status %q", st)
				}
				opt.Statuses = append(opt.Statuses, models.ReviewStatusType(st))
			}
		case reviewOptionType:
			switch models.ReviewType(val) {
			case models.ReviewTypeJit, models.ReviewTypeOneTime:
				opt.Type = models.ReviewType(val)
			default:
				return opt, invalidReviewOption(key, "must be %q or %q, got %q",
					models.ReviewTypeJit, models.ReviewTypeOneTime, val)
			}
		case reviewOptionConnection:
			opt.ConnectionName = val
		case reviewOptionUser:
			switch {
			case val == "me":
				opt.OwnerID = userID
			case strings.Contains(val, "@"):
				opt.OwnerEmail = val
			default:
				return opt, invalidReviewOption(key, "must be \"me\" or an email, got %q", val)
			}
		case reviewOptionStartDate, reviewOptionEndDate:
			t, err := time.Parse(time.RFC3339, val)
			if err != nil {
				return opt, invalidReviewOption(key, "must be RFC3339, got %q", val)
			}
			t = t.UTC()
			if key == reviewOptionStartDate {
				opt.StartDate = &t
			} else {
				opt.EndDate = &t
			}
		case reviewOptionLimit:
			limit, err := strconv.Atoi(val)
			if err != nil {
				return opt, invalidReviewOption(key, "%q is not a number", val)
			}
			if limit < 1 {
				return opt, invalidReviewOption(key, "must be at least 1, got %d", limit)
			}
			// Clamped, like GET /sessions: asking for more than a page holds
			// returns the largest page.
			opt.Limit = min(limit, models.MaxReviewListLimit)
		case reviewOptionOffset:
			offset, err := strconv.Atoi(val)
			if err != nil {
				return opt, invalidReviewOption(key, "%q is not a number", val)
			}
			if offset < 0 || offset > models.MaxReviewListOffset {
				return opt, invalidReviewOption(key, "must be between 0 and %d, got %d",
					models.MaxReviewListOffset, offset)
			}
			opt.Offset = offset
		}
	}
	return opt, nil
}
