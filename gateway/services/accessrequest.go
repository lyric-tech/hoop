package services

import (
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/utils"
	"gorm.io/gorm"
)

func GetRuleForConnection(orgID uuid.UUID, connectionName, accessType string) (*models.AccessRequestRule, error) {
	connectionAttributes, err := models.GetConnectionAttributes(models.DB, orgID, connectionName)
	if err != nil {
		return nil, fmt.Errorf("failed fetching connection attributes: %s", err)
	}

	if len(connectionAttributes) > 0 {
		rule, err := models.GetRequestRulesByAttributes(models.DB, orgID, connectionAttributes, accessType)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, fmt.Errorf("failed fetching access request rules: %s", err)
		}

		if rule != nil {
			return rule, nil
		}
	}

	rule, err := models.GetAccessRequestRuleByResourceNameAndAccessType(models.DB, orgID, connectionName, accessType)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("failed fetching access request rule: %s", err)
	}

	return rule, nil
}

// RequestableRule pairs a rule with the resources it currently covers, so a
// user can ask for the whole group in one request.
type RequestableRule struct {
	Rule      *models.AccessRequestRule
	Resources []string
}

// ListRequestableRules returns the rules the user may raise a standing access
// request against. A rule is left out when it gates single commands only
// (those approve one statement at a time and grant no window), when the user's
// groups are outside its approval_required_groups, or when they are in its
// skip_review_groups and so already have access.
func ListRequestableRules(orgID uuid.UUID, userGroups []string) ([]RequestableRule, error) {
	rules, _, err := models.ListAccessRequestRules(models.DB, orgID, models.AccessRequestRulesFilterOption{})
	if err != nil {
		return nil, fmt.Errorf("failed listing access request rules: %s", err)
	}

	out := []RequestableRule{}
	for i := range rules {
		rule := rules[i]
		if rule.AccessType == models.AccessTypeCommand {
			continue
		}
		if len(rule.ApprovalRequiredGroups) > 0 {
			if !utils.SlicesHasIntersection(rule.ApprovalRequiredGroups, userGroups) {
				continue
			}
		} else if utils.SlicesHasIntersection(rule.SkipReviewGroups, userGroups) {
			continue
		}

		resources, err := resolveRuleResources(orgID, &rule)
		if err != nil {
			return nil, err
		}
		if len(resources) == 0 {
			continue
		}
		out = append(out, RequestableRule{Rule: &rule, Resources: resources})
	}
	return out, nil
}

// resolveRuleResources expands a rule into the connections it covers: the ones
// it names plus every connection carrying one of its attributes.
func resolveRuleResources(orgID uuid.UUID, rule *models.AccessRequestRule) ([]string, error) {
	seen := map[string]struct{}{}
	resources := []string{}
	add := func(names []string) {
		for _, n := range names {
			if _, ok := seen[n]; ok {
				continue
			}
			seen[n] = struct{}{}
			resources = append(resources, n)
		}
	}

	add(rule.ConnectionNames)

	var attributes []string
	for _, attr := range rule.RuleAttributes {
		attributes = append(attributes, attr.AttributeName)
	}
	if len(attributes) > 0 {
		names, err := models.GetConnectionNamesMatchingAttributes(models.DB, orgID, attributes)
		if err != nil {
			return nil, fmt.Errorf("failed resolving rule attributes: %s", err)
		}
		add(names)
	}

	sort.Strings(resources)
	return resources, nil
}
