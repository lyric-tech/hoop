// Package modelstest boots the embedded database for tests that need the real
// schema. Import it from external test packages only (package foo_test): the
// models package imports nothing from here, so an internal test would cycle.
package modelstest

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/hoophq/hoop/gateway/models"
	modelsbootstrap "github.com/hoophq/hoop/gateway/models/bootstrap"
	"github.com/hoophq/hoop/gateway/pglite"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// StartDB boots the embedded database, applies every migration, points
// models.DB at it and seeds one organization, whose id it returns.
func StartDB(t testing.TB) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping embedded database test in -short mode")
	}
	ctx := context.Background()
	inst, err := pglite.Start(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("start embedded database: %v", err)
	}
	t.Cleanup(func() { inst.Close(ctx) })

	if err := modelsbootstrap.MigrateDB(inst.MigrateDSN(), ""); err != nil {
		t.Fatalf("migrations failed: %v", err)
	}
	// The embedded backend serves one session at a time.
	if err := models.InitDatabaseConnection(inst.DSN(), 1); err != nil {
		t.Fatalf("open gorm connection: %v", err)
	}
	orgID := uuid.NewString()
	if err := models.DB.Exec(`INSERT INTO private.orgs (id, name) VALUES (?, ?)`, orgID, "modelstest-"+orgID).Error; err != nil {
		t.Fatalf("seed org: %v", err)
	}
	return orgID
}

// SeedSession inserts a minimal session row, so a review can join it.
func SeedSession(t testing.TB, orgID, sid, verb, userID string) {
	t.Helper()
	err := models.DB.Exec(`
		INSERT INTO private.sessions (id, org_id, connection, connection_type, verb, user_id, user_email, status)
		VALUES (?, ?, 'conn-test', 'database', ?, ?, ?, 'open')`,
		sid, orgID, verb, userID, userID+"@test.local").Error
	if err != nil {
		t.Fatalf("seed session %s: %v", sid, err)
	}
}
