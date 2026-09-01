// Builds the ONE bash script each dashboard view executes through
// POST /api/sessions. Sections run in parallel on the agent (wall clock ≈ the
// slowest kubectl call, not the sum — the gateway holds the request 50s max),
// and every section's stdout/stderr/rc is emitted between nonce-stamped
// markers so one failing command degrades one panel, never the whole view.
//
// Output rules that keep parsing deterministic without jq on the agent:
//  - No `-o json` anywhere: pods with managedFields run 10-30KB each and a
//    large cluster would freeze the tab. Everything is jsonpath-TSV
//    (~150-400B/pod) or a server-side table print.
//  - Free-text columns (event messages, cron schedules) are always LAST so the
//    parser can tail-join them; every other column is whitespace-free by the
//    Kubernetes API's own field grammar.
//  - Timestamps are raw ISO creationTimestamps; ages are computed client-side.

export const MARKER_PREFIX = '##HOOPK8S'

export function makeNonce() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// $KARGS is defined by the script prologue: kubernetes-token connections
// carry KUBERNETES_CLUSTER_URL / KUBERNETES_BEARER_TOKEN env vars that kubectl
// does not read on its own; when absent (agent running in-cluster with a
// service account) it expands to nothing. Deliberately unquoted at call sites
// so an empty value disappears instead of becoming an empty argv entry.
const K = "kubectl $KARGS --request-timeout=15s"

// range helper: builds '{range .items[*]}<cols joined by \t>{"\n"}{end}'
const tsv = (...cols) =>
  `{range .items[*]}` + cols.join(`{"\\t"}`) + `{"\\n"}{end}`

// parse: 'tsv'   → split rows on \t; `tail: true` joins overflow into the last column
//        'table' → server-side table print, split rows on whitespace runs
// cols document the wire order for the parser and the views.
export const SECTIONS = {
  nodes: {
    parse: 'tsv',
    cols: [
      'name', 'kubeletVersion', 'arch', 'created', 'unschedulable',
      'allocCpu', 'allocMem', 'allocPods', 'capCpu', 'capMem',
      'instanceType', 'zone', 'internalIP', 'ready',
    ],
    cmd: `${K} get nodes -o jsonpath='${tsv(
      '{.metadata.name}',
      '{.status.nodeInfo.kubeletVersion}',
      '{.status.nodeInfo.architecture}',
      '{.metadata.creationTimestamp}',
      '{.spec.unschedulable}',
      '{.status.allocatable.cpu}',
      '{.status.allocatable.memory}',
      '{.status.allocatable.pods}',
      '{.status.capacity.cpu}',
      '{.status.capacity.memory}',
      '{.metadata.labels.node\\.kubernetes\\.io/instance-type}',
      '{.metadata.labels.topology\\.kubernetes\\.io/zone}',
      '{.status.addresses[?(@.type=="InternalIP")].address}',
      '{.status.conditions[?(@.type=="Ready")].status}',
    )}'`,
  },

  // containers = one space-joined "ready:restarts" pair per container — the
  // only multi-valued column, kept last.
  pods: {
    parse: 'tsv',
    cols: [
      'namespace', 'name', 'phase', 'node', 'podIP', 'created',
      'deleting', 'ownerKind', 'ownerName', 'containers',
    ],
    cmd: `${K} get pods -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.status.phase}',
      '{.spec.nodeName}',
      '{.status.podIP}',
      '{.metadata.creationTimestamp}',
      '{.metadata.deletionTimestamp}',
      '{.metadata.ownerReferences[0].kind}',
      '{.metadata.ownerReferences[0].name}',
      '{range .status.containerStatuses[*]}{.ready}:{.restartCount}{" "}{end}',
    )}'`,
  },

  deploys: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'ready', 'desired', 'created'],
    cmd: `${K} get deployments -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.status.readyReplicas}',
      '{.spec.replicas}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  statefulsets: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'ready', 'desired', 'created'],
    cmd: `${K} get statefulsets -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.status.readyReplicas}',
      '{.spec.replicas}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  daemonsets: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'ready', 'desired', 'created'],
    cmd: `${K} get daemonsets -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.status.numberReady}',
      '{.status.desiredNumberScheduled}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  jobs: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'active', 'succeeded', 'failed', 'created'],
    cmd: `${K} get jobs -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.status.active}',
      '{.status.succeeded}',
      '{.status.failed}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  // schedule is free text (contains spaces) — last column, tail-joined.
  cronjobs: {
    parse: 'tsv',
    tail: true,
    cols: ['namespace', 'name', 'suspend', 'created', 'schedule'],
    cmd: `${K} get cronjobs -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.spec.suspend}',
      '{.metadata.creationTimestamp}',
      '{.spec.schedule}',
    )}'`,
  },

  replicasets: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'ownerKind', 'ownerName', 'revision', 'ready', 'desired', 'created'],
    cmd: `${K} get replicasets -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.metadata.ownerReferences[0].kind}',
      '{.metadata.ownerReferences[0].name}',
      '{.metadata.annotations.deployment\\.kubernetes\\.io/revision}',
      '{.status.readyReplicas}',
      '{.spec.replicas}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  namespaces: {
    parse: 'tsv',
    cols: ['name', 'phase', 'created'],
    cmd: `${K} get namespaces -o jsonpath='${tsv(
      '{.metadata.name}',
      '{.status.phase}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  topnodes: {
    parse: 'table',
    cols: ['name', 'cpu', 'cpuPct', 'mem', 'memPct'],
    cmd: `${K} top nodes --no-headers`,
  },

  toppods: {
    parse: 'table',
    cols: ['namespace', 'name', 'cpu', 'mem'],
    cmd: `${K} top pods -A --no-headers`,
  },

  // message is arbitrary text — last column, tail-joined; rows whose message
  // contained a newline lose the continuation lines (counted in parseWarnings).
  events: {
    parse: 'tsv',
    tail: true,
    cols: ['lastSeen', 'namespace', 'kind', 'objectName', 'reason', 'count', 'message'],
    cmd: `${K} get events -A --field-selector type=Warning --sort-by=.lastTimestamp -o jsonpath='${tsv(
      '{.lastTimestamp}',
      '{.metadata.namespace}',
      '{.involvedObject.kind}',
      '{.involvedObject.name}',
      '{.reason}',
      '{.count}',
      '{.message}',
    )}'`,
  },

  services: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'type', 'clusterIP', 'created', 'ports', 'external'],
    cmd: `${K} get services -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.spec.type}',
      '{.spec.clusterIP}',
      '{.metadata.creationTimestamp}',
      '{range .spec.ports[*]}{.port}/{.protocol}{" "}{end}',
      '{range .status.loadBalancer.ingress[*]}{.ip}{.hostname}{" "}{end}',
    )}'`,
  },

  ingresses: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'className', 'created', 'tlsCount', 'hosts', 'lb'],
    cmd: `${K} get ingresses -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.spec.ingressClassName}',
      '{.metadata.creationTimestamp}',
      '{range .spec.tls[*]}x{end}',
      '{range .spec.rules[*]}{.host}{" "}{end}',
      '{range .status.loadBalancer.ingress[*]}{.ip}{.hostname}{" "}{end}',
    )}'`,
  },

  hpa: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'min', 'max', 'current', 'desired', 'targetKind', 'targetName', 'created'],
    cmd: `${K} get hpa -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.spec.minReplicas}',
      '{.spec.maxReplicas}',
      '{.status.currentReplicas}',
      '{.status.desiredReplicas}',
      '{.spec.scaleTargetRef.kind}',
      '{.spec.scaleTargetRef.name}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  // CRD-backed: rc≠0 with "doesn't have a resource type" means not installed —
  // the view hides the panel instead of erroring (parser exposes stderr).
  vpa: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'targetKind', 'targetName', 'updateMode', 'created'],
    cmd: `${K} get verticalpodautoscalers -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.spec.targetRef.kind}',
      '{.spec.targetRef.name}',
      '{.spec.updatePolicy.updateMode}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  gateways: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'className', 'created'],
    cmd: `${K} get gateways.gateway.networking.k8s.io -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.spec.gatewayClassName}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  httproutes: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'created', 'hostnames'],
    cmd: `${K} get httproutes.gateway.networking.k8s.io -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.metadata.creationTimestamp}',
      '{range .spec.hostnames[*]}{@}{" "}{end}',
    )}'`,
  },

  pvcs: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'phase', 'volume', 'storageClass', 'capacity', 'created', 'accessModes'],
    cmd: `${K} get pvc -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.status.phase}',
      '{.spec.volumeName}',
      '{.spec.storageClassName}',
      '{.status.capacity.storage}',
      '{.metadata.creationTimestamp}',
      '{range .spec.accessModes[*]}{@}{" "}{end}',
    )}'`,
  },

  pvs: {
    parse: 'tsv',
    cols: ['name', 'phase', 'capacity', 'reclaim', 'storageClass', 'claimNamespace', 'claimName', 'csiDriver', 'created'],
    cmd: `${K} get pv -o jsonpath='${tsv(
      '{.metadata.name}',
      '{.status.phase}',
      '{.spec.capacity.storage}',
      '{.spec.persistentVolumeReclaimPolicy}',
      '{.spec.storageClassName}',
      '{.spec.claimRef.namespace}',
      '{.spec.claimRef.name}',
      '{.spec.csi.driver}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  storageclasses: {
    parse: 'tsv',
    cols: ['name', 'provisioner', 'reclaim', 'bindingMode', 'isDefault', 'created'],
    cmd: `${K} get storageclasses -o jsonpath='${tsv(
      '{.metadata.name}',
      '{.provisioner}',
      '{.reclaimPolicy}',
      '{.volumeBindingMode}',
      '{.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}',
      '{.metadata.creationTimestamp}',
    )}'`,
  },

  // PVC → workload join source: claim names a pod mounts, space-joined.
  podvolumes: {
    parse: 'tsv',
    cols: ['namespace', 'name', 'ownerKind', 'ownerName', 'claims'],
    cmd: `${K} get pods -A -o jsonpath='${tsv(
      '{.metadata.namespace}',
      '{.metadata.name}',
      '{.metadata.ownerReferences[0].kind}',
      '{.metadata.ownerReferences[0].name}',
      '{range .spec.volumes[*]}{.persistentVolumeClaim.claimName}{" "}{end}',
    )}'`,
  },

  // SECURITY INVARIANT: configmaps and secrets use the server-side table
  // printer ONLY (no -o flag, ever). In table mode the API server never sends
  // the data values — names, counts and age are all that leave the cluster.
  configmaps: {
    parse: 'table',
    cols: ['namespace', 'name', 'data', 'age'],
    cmd: `${K} get configmaps -A --no-headers`,
  },

  secrets: {
    parse: 'table',
    cols: ['namespace', 'name', 'type', 'data', 'age'],
    cmd: `${K} get secrets -A --no-headers`,
  },
}

export const VIEW_SECTIONS = {
  overview: ['nodes', 'pods', 'deploys', 'cronjobs', 'topnodes', 'events'],
  pods: ['pods', 'toppods'],
  nodes: ['nodes', 'pods', 'topnodes'],
  namespaces: ['namespaces', 'pods', 'deploys', 'statefulsets', 'daemonsets', 'services'],
  workloads: ['deploys', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs'],
  replicasets: ['replicasets'],
  networking: ['services', 'ingresses', 'hpa', 'vpa', 'gateways', 'httproutes'],
  storage: ['pvcs', 'pvs', 'storageclasses', 'podvolumes'],
  config: ['configmaps', 'secrets'],
}

export const VIEW_IDS = Object.keys(VIEW_SECTIONS)

/**
 * The generated script:
 *  - `set -u` only: no -e/pipefail — a failing section must not kill its
 *    siblings; each section's rc travels in its own marker instead.
 *  - always exits 0, so output_status:"failed" from the gateway means the
 *    script itself never ran (exec disabled, agent gone), not a kubectl error.
 *  - `emit` prints an unconditional trailing newline after each payload —
 *    kubectl output does not always end with one and a glued marker would be
 *    unparseable. The parser drops the resulting empty line.
 */
export function buildViewScript(view, nonce) {
  const ids = VIEW_SECTIONS[view]
  if (!ids) throw new Error(`unknown dashboard view: ${view}`)

  const m = `${MARKER_PREFIX}:${nonce}`
  const runs = ids.map((id) => `run ${id} ${SECTIONS[id].cmd}`).join('\n  ')
  const emits = ['precheck', ...ids].map((id) => `emit ${id}`).join('\n')

  return `set -u
export LC_ALL=C
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
KARGS=""
if [ -n "\${KUBERNETES_CLUSTER_URL:-}" ]; then KARGS="--server=\${KUBERNETES_CLUSTER_URL}"; fi
if [ -n "\${KUBERNETES_BEARER_TOKEN:-}" ]; then KARGS="$KARGS --token=\${KUBERNETES_BEARER_TOKEN}"; fi
if [ "\${KUBERNETES_INSECURE_SKIP_VERIFY:-}" = "true" ]; then KARGS="$KARGS --insecure-skip-tls-verify=true"; fi
# The agent sanitizes the exec environment, so kubectl never sees the pod's
# KUBERNETES_SERVICE_HOST and would dial localhost:8080. When no cluster URL
# is configured on the connection, authenticate with the pod's mounted
# service account instead (token + CA are files, unaffected by env scrubbing).
SA=/var/run/secrets/kubernetes.io/serviceaccount
if [ -z "$KARGS" ] && [ -f "$SA/token" ]; then
  KARGS="--server=https://kubernetes.default.svc --token=$(cat $SA/token) --certificate-authority=$SA/ca.crt"
fi
emit() {
  sid="$1"
  echo "${m}:BEGIN:\${sid}##"
  cat "$TMP/\${sid}.out" 2>/dev/null
  echo
  echo "${m}:RC:\${sid}:$(cat "$TMP/\${sid}.rc" 2>/dev/null || echo 125)##"
  if [ -s "$TMP/\${sid}.err" ]; then
    echo "${m}:ERR:\${sid}##"
    cat "$TMP/\${sid}.err"
    echo
  fi
  echo "${m}:END:\${sid}##"
}
run() {
  sid="$1"; shift
  ( "$@" >"$TMP/\${sid}.out" 2>"$TMP/\${sid}.err"; echo $? >"$TMP/\${sid}.rc" ) &
}
if command -v kubectl >/dev/null 2>&1; then
  echo 0 >"$TMP/precheck.rc"
  ${runs}
  wait
else
  echo 127 >"$TMP/precheck.rc"
  echo "kubectl: command not found" >"$TMP/precheck.err"
fi
${emits}
exit 0`
}
