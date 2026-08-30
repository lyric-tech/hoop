package versions

import (
	"fmt"

	"github.com/hoophq/hoop/client/upgrade"
	"github.com/spf13/cobra"
)

var upgradeCmd = &cobra.Command{
	Use:   "upgrade",
	Short: "Install the latest lyric-iam CLI release",
	Long: `Fetch the latest published lyric-iam release version from
` + upgrade.LatestVersionURL + ` and install it.

Unlike ` + "`lyric-iam versions sync`" + `, this command does not consult
the gateway and does not require ` + "`lyric-iam login`" + ` — it always
tracks whatever the public releases server advertises as the latest
version.`,
	SilenceUsage: true,
	RunE: func(_ *cobra.Command, _ []string) error {
		return runUpgradeToLatest()
	},
}

func runUpgradeToLatest() error {
	// Skip the gateway/CLI mismatch warning here for the same reason
	// sync does: the user is on a path where a deliberate version
	// change is about to happen, so the warning would be redundant
	// noise.
	upgrade.SuppressVersionWarning()

	target, err := upgrade.FetchLatestVersion()
	if err != nil {
		return err
	}

	fmt.Printf("Latest released lyric-iam version is %s (from %s)\n", target, upgrade.LatestVersionURL)
	return installAndActivate(target)
}
