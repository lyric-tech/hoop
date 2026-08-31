//go:build integration

package integration

import (
	"net/http"
	"testing"

	"github.com/hoophq/hoop/gateway/api/openapi"
	"github.com/hoophq/hoop/gateway/integration/testutil"
	"github.com/hoophq/hoop/gateway/models"
	"github.com/hoophq/hoop/gateway/storagev2"
)

// A resource is displayed and selected as "<cluster>/<resource>". The cluster
// is not stored: it is derived from the name of the agent serving the resource
// by removing a trailing "-agent". These tests pin both halves of that
// contract — the derived value the API reports, and the gateway's ability to
// resolve a qualified name back to the resource.
func TestClusterDerivedFromAgentName(t *testing.T) {
	token := adminToken(t)
	// "remix-agent" must yield the cluster "remix"
	agentID := createAgentReturningID(t, token, "remix-agent")
	defer deleteAgent(t, token, "remix-agent")

	const connName = "cluster-mongodb-remix-ro"
	created := testServer.Post(t, "/connections", token, openapi.Connection{
		Name:               connName,
		Type:               "database",
		SubType:            "postgres",
		AgentId:            agentID,
		Command:            []string{"psql"},
		AccessModeRunbooks: "enabled",
		AccessModeExec:     "enabled",
		AccessModeConnect:  "enabled",
		AccessSchema:       "enabled",
	})
	defer created.Body.Close()
	testutil.RequireStatus(t, created, http.StatusCreated)
	defer func() {
		del := testServer.Delete(t, "/connections/"+connName, token)
		del.Body.Close()
	}()

	// The single-get query resolves the agent name and derives the cluster.
	got := testServer.Get(t, "/connections/"+connName, token)
	defer got.Body.Close()
	testutil.RequireStatus(t, got, http.StatusOK)
	var conn map[string]any
	testutil.DecodeJSON(t, got, &conn)
	if conn["cluster"] != "remix" {
		t.Errorf("get connection: expected cluster %q, got %v", "remix", conn["cluster"])
	}
	if conn["agent_name"] != "remix-agent" {
		t.Errorf("get connection: expected agent_name %q, got %v", "remix-agent", conn["agent_name"])
	}

	// The list query must derive the same value. It joins private.agents
	// separately from the single-get, so a regression there is invisible in
	// the detail view.
	list := testServer.Get(t, "/connections", token)
	defer list.Body.Close()
	testutil.RequireStatus(t, list, http.StatusOK)
	var conns []map[string]any
	testutil.DecodeJSON(t, list, &conns)
	var found bool
	for _, c := range conns {
		if c["name"] != connName {
			continue
		}
		found = true
		if c["cluster"] != "remix" {
			t.Errorf("list connections: expected cluster %q, got %v", "remix", c["cluster"])
		}
	}
	if !found {
		t.Fatalf("list connections: %q not found", connName)
	}

	// The paginated list query is a third, separate SQL statement.
	paginated := testServer.Get(t, "/connections?page=1&page_size=100", token)
	defer paginated.Body.Close()
	testutil.RequireStatus(t, paginated, http.StatusOK)
	var page struct {
		Data []map[string]any `json:"data"`
	}
	testutil.DecodeJSON(t, paginated, &page)
	found = false
	for _, c := range page.Data {
		if c["name"] != connName {
			continue
		}
		found = true
		if c["cluster"] != "remix" {
			t.Errorf("paginated connections: expected cluster %q, got %v", "remix", c["cluster"])
		}
	}
	if !found {
		t.Fatalf("paginated connections: %q not found", connName)
	}

	// Resolution of the qualified form. This is the gateway lookup the gRPC
	// auth interceptor and the exec APIs share, so it is exercised directly:
	// a "/" cannot travel through a Gin :name path parameter.
	ctx := storagev2.NewContext("", testGateway.OrgID)
	for _, tt := range []struct {
		name      string
		nameOrID  string
		wantFound bool
	}{
		{"bare name still resolves", connName, true},
		{"qualified with the derived cluster", "remix/" + connName, true},
		{"qualified with the full agent name", "remix-agent/" + connName, true},
		{"wrong cluster does not resolve", "zeta/" + connName, false},
		{"cluster without the resource does not resolve", "remix/", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			conn, err := models.GetConnectionByNameOrID(ctx, tt.nameOrID)
			if err != nil {
				t.Fatalf("lookup %q: unexpected error: %v", tt.nameOrID, err)
			}
			if tt.wantFound {
				if conn == nil {
					t.Fatalf("lookup %q: expected a resource, got none", tt.nameOrID)
				}
				// the resolved identifier is always the bare name: the
				// qualified form must never reach the agent or a session record
				if conn.Name != connName {
					t.Errorf("lookup %q: resolved name = %q, want %q", tt.nameOrID, conn.Name, connName)
				}
			} else if conn != nil {
				t.Errorf("lookup %q: expected no resource, got %q", tt.nameOrID, conn.Name)
			}
		})
	}
}

// An agent that does not follow the "<cluster>-agent" convention is its own
// cluster label, and the resource still resolves both bare and qualified.
func TestClusterFromAgentWithoutSuffix(t *testing.T) {
	token := adminToken(t)
	agentID := createAgentReturningID(t, token, "arqa-prod")
	defer deleteAgent(t, token, "arqa-prod")

	const connName = "cluster-arqa-role"
	created := testServer.Post(t, "/connections", token, openapi.Connection{
		Name:               connName,
		Type:               "database",
		SubType:            "postgres",
		AgentId:            agentID,
		Command:            []string{"psql"},
		AccessModeRunbooks: "enabled",
		AccessModeExec:     "enabled",
		AccessModeConnect:  "enabled",
		AccessSchema:       "enabled",
	})
	defer created.Body.Close()
	testutil.RequireStatus(t, created, http.StatusCreated)
	defer func() {
		del := testServer.Delete(t, "/connections/"+connName, token)
		del.Body.Close()
	}()

	got := testServer.Get(t, "/connections/"+connName, token)
	defer got.Body.Close()
	testutil.RequireStatus(t, got, http.StatusOK)
	var conn map[string]any
	testutil.DecodeJSON(t, got, &conn)
	if conn["cluster"] != "arqa-prod" {
		t.Errorf("expected cluster %q, got %v", "arqa-prod", conn["cluster"])
	}

	ctx := storagev2.NewContext("", testGateway.OrgID)
	resolved, err := models.GetConnectionByNameOrID(ctx, "arqa-prod/"+connName)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved == nil {
		t.Fatal("expected the resource to resolve by its full agent name")
	}
}

// A role created under a resource inherits the resource's agent rather than
// storing its own, so the cluster must resolve through that fallback. The
// single-get, the two list queries and the qualified lookup each join agents
// independently, so all four are checked.
func TestClusterInheritedFromResourceAgent(t *testing.T) {
	token := adminToken(t)
	agentID := createAgentReturningID(t, token, "inherited-agent")
	defer deleteAgent(t, token, "inherited-agent")

	const resourceName = "cluster-inherited-resource"
	const roleName = "cluster-inherited-role"
	created := testServer.Post(t, "/resources", token, openapi.ResourceRequest{
		Name:    resourceName,
		Type:    "database",
		SubType: "postgres",
		AgentID: agentID,
		EnvVars: map[string]string{},
		Roles: []openapi.ResourceRoleRequest{
			{
				Name:    roleName,
				Type:    "database",
				SubType: "postgres",
				Command: []string{"psql"},
			},
		},
	})
	defer created.Body.Close()
	testutil.RequireStatus(t, created, http.StatusCreated)
	defer func() {
		// Connections must go before the resource.
		del := testServer.Delete(t, "/connections/"+roleName, token)
		del.Body.Close()
		delRes := testServer.Delete(t, "/resources/"+resourceName, token)
		delRes.Body.Close()
	}()

	got := testServer.Get(t, "/connections/"+roleName, token)
	defer got.Body.Close()
	testutil.RequireStatus(t, got, http.StatusOK)
	var conn map[string]any
	testutil.DecodeJSON(t, got, &conn)
	if conn["cluster"] != "inherited" {
		t.Errorf("get connection: expected cluster %q, got %v", "inherited", conn["cluster"])
	}

	list := testServer.Get(t, "/connections", token)
	defer list.Body.Close()
	testutil.RequireStatus(t, list, http.StatusOK)
	var conns []map[string]any
	testutil.DecodeJSON(t, list, &conns)
	for _, c := range conns {
		if c["name"] == roleName && c["cluster"] != "inherited" {
			t.Errorf("list connections: expected cluster %q, got %v", "inherited", c["cluster"])
		}
	}

	paginated := testServer.Get(t, "/connections?page=1&page_size=100", token)
	defer paginated.Body.Close()
	testutil.RequireStatus(t, paginated, http.StatusOK)
	var page struct {
		Data []map[string]any `json:"data"`
	}
	testutil.DecodeJSON(t, paginated, &page)
	for _, c := range page.Data {
		if c["name"] == roleName && c["cluster"] != "inherited" {
			t.Errorf("paginated connections: expected cluster %q, got %v", "inherited", c["cluster"])
		}
	}

	ctx := storagev2.NewContext("", testGateway.OrgID)
	resolved, err := models.GetConnectionByNameOrID(ctx, "inherited/"+roleName)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved == nil {
		t.Fatal("expected the inherited-agent role to resolve by its qualified name")
	}
}
