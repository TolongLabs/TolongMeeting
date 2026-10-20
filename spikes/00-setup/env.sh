# Local adaptation: the plan's /srv/spikes server paths become a directory on this machine.
# Source this file; it sets SPIKES_ROOT (state: profiles, data, secrets) and SPIKES_REPO (the repo's spikes/ dir).
SPIKES_ROOT="${SPIKES_ROOT:-$HOME/tm-spikes}"
SPIKES_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SPIKES_ROOT SPIKES_REPO
