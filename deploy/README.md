# Running the meal planner on microk8s

One pod, one volume, no inbound ports. The agent dials out to Slack over Socket
Mode and to Kroger over HTTPS, so there is no Service, no Ingress and no
certificate to manage.

Everything irreplaceable — two years of purchase history, the recipe library,
the cart ledger, the Kroger refresh token the app rotates for itself — lives on
one PVC on local SSD.

## 1. Move the secrets to a shared vault

A 1Password service account can only be granted vaults its creator can share,
and a personal vault is not one of those. The items currently live in `Private`,
so move them to a shared vault (this guide assumes one called `Homelab`):

- `kroger.developer` — fields `client_id`, `client_secret`
- `slack.mealplanner` — fields `bot_token`, `app_token`, `user_id`,
  `allowed_users`, `channel_id`

When you create the service account, check that the vault appears in its list.
If it does not, service accounts are turned off for that vault.

## 2. Install the 1Password Kubernetes operator

Service account mode — no Connect server to run, patch or back up.

```sh
microk8s enable helm3 hostpath-storage registry
microk8s helm3 repo add 1password https://1password.github.io/connect-helm-charts
microk8s helm3 repo update
```

Create the token secret yourself. It should not pass through a chat window, and
`read -rs` keeps it out of your shell history:

```sh
read -rs OP_TOKEN            # paste the service account token, then Enter
microk8s kubectl create namespace onepassword
microk8s kubectl -n onepassword create secret generic onepassword-service-account \
  --from-literal=token="$OP_TOKEN"
unset OP_TOKEN
```

Then install the operator alone, with Connect switched off:

```sh
microk8s helm3 upgrade --install onepassword 1password/connect \
  --namespace onepassword \
  --set connect.create=false \
  --set operator.create=true \
  --set operator.watchNamespace="{meal-planner}"
```

The operator reads its credential from `OP_SERVICE_ACCOUNT_TOKEN`. The chart's
value name for this has moved between versions, so check yours rather than
trusting a flag from a blog post:

```sh
microk8s helm3 show values 1password/connect | grep -i -A3 'serviceaccount\|token'
```

If the chart has no value for it, set it on the deployment directly — it is one
environment variable:

```sh
microk8s kubectl -n onepassword set env deploy/onepassword-connect-operator \
  --from=secret/onepassword-service-account --keys=token \
  --prefix=OP_SERVICE_ACCOUNT_
```

Confirm it came up clean before going further:

```sh
microk8s kubectl -n onepassword logs deploy/onepassword-connect-operator | tail -20
```

## 3. Build and push the image

```sh
microk8s ctr images ls | head -1                  # registry addon is at :32000
podman build -f deploy/Containerfile -t localhost:32000/meal-planner:0.1.0 .
podman push --tls-verify=false localhost:32000/meal-planner:0.1.0
```

## 4. Seed the volume before the first start

The database and the Kroger refresh token already exist on your Mac. Create the
claim, then copy them in — a fresh start would lose two years of history and
force a re-auth.

```sh
microk8s kubectl apply -f k8s/namespace.yaml -f k8s/pvc.yaml

# A throwaway pod just to get a shell on the volume.
microk8s kubectl -n meal-planner run seed --rm -it --restart=Never \
  --image=busybox --overrides='
{"spec":{"containers":[{"name":"seed","image":"busybox","command":["sh"],
"stdin":true,"tty":true,"volumeMounts":[{"name":"d","mountPath":"/data"}]}],
"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"meal-planner-data"}}]}}'

# From another terminal:
microk8s kubectl -n meal-planner cp \
  ~/.claude-grocery/claude-grocery.db seed:/data/claude-grocery.db
microk8s kubectl -n meal-planner cp \
  ~/.config/claude-grocery/kroger-token.json seed:/data/kroger-token.json
microk8s kubectl -n meal-planner cp \
  ~/src/claude-grocery-kroger-agent/data/week-events.json seed:/data/week-events.json
```

Copy the database while the bot is **stopped**, or you will copy a half-written
WAL. If `claude-grocery.db-wal` exists and is large, open the database once
locally and close it cleanly first.

## 5. Deploy

```sh
microk8s kubectl apply -k k8s/
microk8s kubectl -n meal-planner get onepassworditem               # want: both present
microk8s kubectl -n meal-planner get secret kroger-credentials slack-credentials
microk8s kubectl -n meal-planner logs -f deploy/meal-planner
```

The `--push` arg in `deployment.yaml` makes it post the week on start, which is
a useful smoke test. Remove it once a real timer exists.

## What is deliberately not here

**No Service, no Ingress.** Nothing connects in.

**No HorizontalPodAutoscaler, and `replicas: 1` is an invariant.** Two instances
mean duplicate Slack events and two processes adding to the same cart. The Cart
API only adds — it cannot read the cart back or clear it — so a doubled order is
fixed by hand or not at all. For the same reason the update strategy is
`Recreate`: a rolling update would overlap the pods.

**No CronJob for the Saturday push.** The plan being edited currently lives in
the bot's memory, so a second process could not post or approve it — it would
race the one holding the socket. Until the pending plan is persisted to SQLite,
the timer has to run inside the process. That change is worth making on its own:
it also means a restart or a reschedule stops losing a week someone was
part-way through editing.

**No probes.** See the comment in `deployment.yaml`.

## On 1Password Environments

[Environments](https://www.1password.dev/environments/local-env-file) are a good
replacement for `op run --env-file=.env.op` on a laptop, but the local workflow
mounts the file through a named pipe behind an interactive authorization prompt,
on Mac and Linux desktops only, and is explicitly not built for concurrent
unattended readers. A pod has nobody to approve the prompt.

So: Environments locally if you like them, `OnePasswordItem` in the cluster. The
values are the same either way — only the way they are read differs.

## Why this operator and not External Secrets

External Secrets would also work, and its 1Password SDK provider needs no
Connect server either. The official operator wins here on two specifics: it
restarts the deployment itself when an item changes, which otherwise means
running Stakater Reloader as well, and it is one less layer between a secret and
the thing using it. External Secrets earns its keep when secrets come from
several backends at once; here they all come from 1Password.

The tradeoff taken on purpose: the operator maps a whole item to a Secret and
cannot cherry-pick fields across items, which is why there are two Secrets here
and why `deployment.yaml` maps them field by field.
