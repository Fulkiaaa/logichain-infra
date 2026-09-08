# RUNBOOK — logichain-infra

Document d'exploitation et de reprise d'activité de l'infrastructure LogiChain.
Destiné à quelqu'un qui **découvre le projet** : chaque commande ci-dessous est
copiable telle quelle (aucune variable à deviner), et chaque procédure indique
d'abord **quand l'appliquer**.

> **Avant de faire confiance à ce document, lisez ce paragraphe.**
> Toutes les commandes des sections 3, 4, 6, 7 et les diagnostics de la
> section 8 ont été **rejouées réellement** le 2026-09-08 contre la cible de
> référence (VM Multipass `logichain-staging`, Ubuntu 24.04) pendant la
> rédaction de ce Runbook — pas seulement relues dans le code. Les
> procédures qui n'ont **pas** pu être testées sans risquer de casser cet
> environnement (reconstruction complète depuis zéro, rollback réel,
> rotation réelle des secrets) sont signalées explicitement comme telles à
> l'endroit où elles apparaissent, avec ce qui a été vérifié à la place.
> Ce dépôt est **public** : aucune valeur réelle de secret ne figure dans ce
> document.

---

## 1. Architecture

### Schéma de la cible

```
                                   Internet / réseau local
                                            │
                                            │ HTTPS (443) / HTTP (80 → redirigé)
                                            ▼
                            ┌───────────────────────────────┐
                            │   VM logichain-staging          │
                            │   (Multipass, Ubuntu 24.04)     │
                            │                                  │
                            │   UFW : 22, 80, 443 autorisés,  │
                            │   tout le reste entrant refusé  │
                            │   Fail2Ban actif sur sshd        │
                            │                                  │
                            │  ┌────────────────────────────┐ │
                            │  │ Nginx (80/443, TLS)         │ │
                            │  │ /etc/nginx/sites-available/ │ │
                            │  │   logichain.conf             │ │
                            │  └──────────────┬───────────────┘ │
                            │                 │ proxy_pass       │
                            │                 │ 127.0.0.1:3000   │
                            │                 ▼                  │
                            │  ┌────────────────────────────┐ │
                            │  │ API Node.js sous PM2         │ │
                            │  │ /opt/logichain (user         │ │
                            │  │ système "logichain")         │ │
                            │  │ dist/index.js, .env (0600)  │ │
                            │  └──────────────┬───────────────┘ │
                            │                 │ MONGO_URI         │
                            │                 │ 127.0.0.1:27017   │
                            │                 ▼                  │
                            │  ┌────────────────────────────┐ │
                            │  │ MongoDB (replica set rs0,   │ │
                            │  │ 1 membre), bindIp 127.0.0.1 │ │
                            │  │ /var/lib/mongodb             │ │
                            │  └────────────────────────────┘ │
                            └───────────────────────────────┘
```

MongoDB n'écoute **que** sur `127.0.0.1` : il n'est jamais exposé
directement, seule l'API y accède en local. C'est Nginx qui expose le seul
port public utile (443, avec redirection 80→443).

### Flux d'une requête

1. Le client appelle `https://<ip-ou-nom>/...`.
2. Nginx termine le TLS (certificat auto-signé en staging), ajoute les
   en-têtes de sécurité (HSTS, `X-Content-Type-Options`, etc.) et proxifie
   vers `http://127.0.0.1:3000` (`location /` du vhost).
3. L'API Node.js (process PM2 `logichain-api`, un seul fork) traite la
   requête, interroge MongoDB via `logichain_app` (utilisateur applicatif,
   droits `readWrite` sur la seule base `logichain`) si besoin.
4. `location /health` est proxifiée sans journalisation d'accès
   (`access_log off`), utilisée par les smoke tests CD et par les
   diagnostics de la section 8.

### Emplacement des fichiers (dépôt et cible)

| Élément | Dans ce dépôt | Sur la cible |
|---|---|---|
| Provisionnement complet | `site.yml` | — |
| Déploiement applicatif seul | `playbooks/deploy.yml` | — |
| Rôles | `roles/{system_security,nodejs,database,web_proxy,app_runtime}/` | — |
| Inventaire staging (IP, utilisateur SSH) | `inventories/staging/hosts.yml` | — |
| Variables non secrètes | `inventories/staging/group_vars/all/vars.yml` | — |
| Secrets chiffrés (vault) | `inventories/staging/group_vars/all/vault.yml` | — |
| Code applicatif, build | — | `/opt/logichain` (`dist/index.js`) |
| Fichier d'environnement de l'API | rendu depuis `roles/app_runtime/templates/env.j2` | `/opt/logichain/.env` (0600) |
| Configuration PM2 | rendu depuis `roles/app_runtime/templates/ecosystem.config.js.j2` | `/opt/logichain/ecosystem.config.js` |
| Journaux applicatifs | — | `/opt/logichain/logs/{out-0,error-0}.log`¹ |
| Vhost Nginx | rendu depuis `roles/web_proxy/templates/logichain.conf.j2` | `/etc/nginx/sites-available/logichain.conf` |
| Certificat / clé TLS | — | `/etc/nginx/tls/logichain.{crt,key}` |
| Configuration MongoDB | rendu depuis `roles/database/templates/mongod.conf.j2` | `/etc/mongod.conf` |
| Données MongoDB | — | `/var/lib/mongodb` |
| Script de sauvegarde | rendu depuis `roles/database/templates/mongodb-backup.sh.j2` | `/usr/local/bin/mongodb-backup.sh` (0700 root:root) |
| Archives de sauvegarde | — | `/var/backups/mongodb/` (0700 root:root) |

¹ Le template `ecosystem.config.js.j2` déclare `logs/out.log` et
`logs/error.log`, mais PM2 y ajoute lui-même le suffixe de l'index
d'instance (`-0`, une seule instance étant configurée) : sur la cible, les
fichiers réellement écrits sont `out-0.log` et `error-0.log`, jamais
`out.log`/`error.log`. C'est la cause identifiée du `No such file or
directory` observé en diagnostic de la CD (voir `cd.yml`, étape
« Diagnostiquer un échec de provisionnement ») quand celle-ci tentait de
lire les chemins déclarés dans le template plutôt que les chemins réels.

### Limite connue — `/docs` (documentation Swagger/OpenAPI de l'API) n'est pas protégée

Le fichier `.env` généré par `roles/app_runtime/templates/env.j2` **ne
définit pas** `DOCS_USER` ni `DOCS_PASSWORD` : si l'API `logichain-api`
prévoit une authentification basique optionnelle sur sa documentation
(`/docs`), elle n'est aujourd'hui **jamais activée** par ce rôle — la
documentation de l'API est donc ouverte à quiconque atteint la cible.

Sans conséquence sur une VM Multipass locale, injoignable depuis Internet.
**À durcir avant toute exposition publique** :

1. Ajouter deux variables au vault de l'environnement concerné :
   ```bash
   ansible-vault edit inventories/staging/group_vars/all/vault.yml
   # ajouter : vault_docs_user: "..." / vault_docs_password: "..."
   ```
2. Ajouter au template `roles/app_runtime/templates/env.j2` :
   ```
   DOCS_USER={{ vault_docs_user }}
   DOCS_PASSWORD={{ vault_docs_password }}
   ```
3. Rejouer le déploiement applicatif (section 4) pour que le `.env` mis à
   jour soit livré et l'application rechargée.

Non fait à ce jour, non testé dans le cadre de ce Runbook (nécessiterait de
committer une modification de rôle, hors périmètre de ce document).

---

## 2. Prérequis

| Prérequis | Détail | Vérification |
|---|---|---|
| Python 3.12 | requis par Ansible | `python3 --version` |
| Ansible | `pip install ansible` | `ansible --version` |
| Collections Ansible | `community.general`, `community.mongodb`, `community.crypto`, `ansible.posix` — listées dans `requirements.yml` | `ansible-galaxy collection install -r requirements.yml` |
| `ansible-lint` / `yamllint` | reproduisent en local le check CI « Lint et secrets » | `pip install ansible-lint yamllint` |
| Mot de passe du vault (`.vault-pass`) | **jamais committé** (`.gitignore`), fourni hors dépôt (voir section 10) — `ansible.cfg` le référence déjà (`vault_password_file = .vault-pass`) | `chmod 600 .vault-pass` puis `ansible-vault view inventories/staging/group_vars/all/vault.yml` (doit s'afficher sans erreur) |
| Accès SSH à la cible | clé privée `~/.ssh/id_ed25519`, utilisateur `ubuntu` — voir `inventories/staging/hosts.yml`. La clé publique correspondante doit être celle embarquée dans `cloud-init.yaml` (`ssh_authorized_keys`) au moment de la création de la VM | `ssh -i ~/.ssh/id_ed25519 ubuntu@<ip-de-la-vm> echo ok` |
| Multipass | pour rejouer le provisionnement en local (VM Ubuntu 24.04) | `multipass version` |
| `gh` (GitHub CLI), authentifié | pour les commandes de passation (section 10) et la procédure d'urgence sur les rulesets | `gh auth status` |

Commande groupée de vérification (à rejouer telle quelle) :

```bash
ansible --version && \
ansible-galaxy collection install -r requirements.yml && \
multipass version && \
gh auth status
```

---

## 3. Reconstruction complète

**Quand l'appliquer** : la VM cible n'existe plus (détruite, corrompue), ou
on doit prouver que l'infrastructure est intégralement reproductible depuis
zéro (démonstration, changement de machine).

### VM absente — la créer d'abord

```bash
multipass launch 24.04 --name logichain-staging --memory 2G --disk 10G --cloud-init cloud-init.yaml
multipass info logichain-staging | grep IPv4
```

> **L'IP attribuée par Multipass change à chaque (re)création de la VM.**
> Reporter la nouvelle IP dans `inventories/staging/hosts.yml`
> (`ansible_host: "<nouvelle-ip>"`) avant de continuer — voir aussi
> l'incident dédié en section 8.

### Provisionnement complet, en une seule commande

```bash
ansible-playbook site.yml -i inventories/staging
```

**Durée mesurée : 1 min 38 s (1:38.14)**, sur la cible de référence
(VM Multipass `logichain-staging`, Ubuntu 24.04, machine réellement vierge,
**détruite puis recréée avant la mesure** — `multipass delete
logichain-staging --purge` puis `multipass launch`). Mesurée avec :

```bash
time ansible-playbook site.yml -i inventories/staging
```

`time` (builtin zsh) chronomètre directement `ansible-playbook` — la
sortie standard de la commande est capturée telle quelle dans le journal
de preuve, sans intermédiaire (`script` avait été utilisé pour une mesure
antérieure ; sa sortie ne reflétait pas la commande réellement exécutée et
n'a pas été reconduite). PLAY RECAP obtenu :
`ok=76 changed=57 unreachable=0 failed=0 skipped=0`. Le journal complet
est conservé dans `soutenance/preuves/rebuild-2026-09-08.log`.

**Idempotence** : un second passage donne `changed=0`
(`ok=58 changed=0 skipped=11`) — journal complet dans
`soutenance/preuves/idempotence-2026-09-08.log`.

```bash
ansible-playbook site.yml -i inventories/staging   # second passage attendu : changed=0
```

### Vérification du service après reconstruction

```bash
IP=$(multipass info logichain-staging | awk '/IPv4/{print $2}')
curl -sk https://$IP/health
curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://$IP/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"personne-inexistante@example.com","password":"mot-de-passe-inexistant-1!"}'
# attendu : {"status":"ok",...} puis 200 ; puis 401 (preuve que MongoDB est réellement interrogé)
```

**Ce qui a été vérifié.** La reconstruction complète depuis une VM
réellement détruite puis recréée a été rejouée le 2026-09-08 lors de la
répétition finale de soutenance (tâche 17) : `multipass delete
logichain-staging --purge`, `multipass launch`, mise à jour de l'IP dans
l'inventaire, puis `time ansible-playbook site.yml`. C'est cette
répétition qui a produit les journaux de preuve actuels
(`rebuild-2026-09-08.log`, `idempotence-2026-09-08.log`) et les chiffres
ci-dessus — répéter sur une VM déjà provisionnée aurait masqué
précisément ce qu'on cherche à découvrir (`apt` lent, dépôt momentanément
injoignable, timeout). L'environnement obtenu est neuf : les données de
démonstration (`LC-POWER-002`) n'y existent plus tant qu'elles n'ont pas
été rejouées.

---

## 4. Déploiement applicatif seul

**Quand l'appliquer** : un nouveau commit est disponible sur `logichain-api`
et l'infrastructure sous-jacente (système, Node.js, MongoDB, Nginx) est déjà
en place et stable — c'est la commande que la CD rejoue à chaque déploiement.

```bash
ansible-playbook playbooks/deploy.yml -i inventories/staging
```

Ne rejoue que le rôle `app_runtime` : récupération du code (`app_version`,
`main` par défaut), build TypeScript si le checkout a changé, fichier
`.env`, configuration PM2, rechargement (`pm2 reload --update-env`).

**Testé réellement** le 2026-09-08 contre la cible de référence :

```
PLAY RECAP
logichain-staging          : ok=13   changed=0    unreachable=0    failed=0    skipped=4    rescued=0    ignored=0
```

`changed=0` ici signifie qu'aucun nouveau commit n'était disponible sur
`app_repo` au moment du test — c'est le comportement attendu d'un
déploiement idempotent sans changement de code.

---

## 5. Rollback

**Quand l'appliquer** : un déploiement applicatif (section 4) a introduit
une régression détectée après coup (smoke tests en échec, erreurs en
production, comportement métier cassé), et revenir à la version précédente
est plus rapide et plus sûr qu'un correctif en urgence sur le code en
cours.

**Critères de décision — rollback plutôt que correctif en avant :**

- La cause du problème n'est pas identifiée avec certitude, ou l'identifier
  prendrait plus de temps que de revenir à un état connu-bon.
- Le déploiement précédent (`app_version` actuel avant le déploiement
  fautif) est connu comme fonctionnel — c'est le cas normal, puisque la CD
  ne promeut vers `main` (donc vers un déploiement réel) qu'après tests de
  fumée verts.
- **Vérifier avant de décider** qu'aucune migration de données irréversible
  (nouvel index MongoDB incompatible avec l'ancien code, changement de
  schéma) n'a été introduite par le déploiement fautif : ce rôle ne gère
  aucune migration de données, donc un rollback de code seul est sûr tant
  que le déploiement fautif n'a pas changé la forme des données en base.

**Mécanisme :**

```bash
ansible-playbook playbooks/deploy.yml -i inventories/staging -e app_version=v1.0.0
```

`app_version` est passé tel quel au module `ansible.builtin.git`
(`roles/app_runtime/tasks/main.yml`, tâche « Récupérer le code source ») :
n'importe quelle réf Git valide fonctionne — tag, branche, ou SHA de commit
**à condition qu'il soit exposé comme réf par le serveur Git** (voir
ci-dessous).

> **Écart constaté en rédigeant cette section, corrigé depuis (tâche 17,
> répétition finale du 2026-09-08).** Au moment de la rédaction initiale de
> ce Runbook, `logichain-api` **ne possédait aucun tag**
> (`git ls-remote --tags` renvoyait une liste vide). Rollback vers un SHA
> de commit arbitraire non exposé comme réf échouait : testé avec
> `-e app_version=c4725a6 --check`, le module `git` échoue avec `fatal:
> couldn't find remote ref c4725a6` (`git fetch --dry-run origin c4725a6`
> ne trouve pas de réf de ce nom — un SHA brut n'est pas une réf tant qu'il
> n'est pas la pointe d'une branche ou d'un tag). Testé à l'inverse avec
> une **branche réelle** (`-e app_version=develop --check`) : le checkout
> est correctement pris en compte (`changed` sur la tâche « Récupérer le
> code source »).
>
> **Corrigé** : le tag annoté `v1.0.0` a été créé sur `main` et poussé
> (`git tag -a v1.0.0 && git push origin v1.0.0`, 2026-09-08). Rejoué
> réellement contre la cible de référence pour confirmer que la procédure
> devient exécutable : la cible a d'abord été déployée sur `develop` (pour
> forcer un vrai changement de code, `changed=4`), puis ramenée sur le tag
> avec `-e app_version=v1.0.0` — checkout réussi, `changed=4` de nouveau,
> et `sudo -u logichain git -C /opt/logichain rev-parse HEAD` sur la cible
> confirme le retour exact au commit tagué. Voir « Durée attendue » ci-dessous pour la mesure
> complète. **Recommandation maintenue pour la suite : tagger chaque
> release** (`git tag vX.Y.Z && git push --tags` sur `logichain-api`, au
> moment de la fusion vers `main`) pour disposer d'une réf stable et
> lisible pour `app_version`. Pour une release antérieure non taguée, la
> seule solution de repli reste de créer une branche temporaire sur le
> commit voulu (`git push origin <sha>:refs/heads/rollback-tmp`) puis
> `-e app_version=rollback-tmp`.

Après le checkout, PM2 est rechargé automatiquement (handler « Recharger
l'application » de `app_runtime`, déclenché par le changement du fichier
`.env` ou de `ecosystem.config.js` — pas systématiquement déclenché par le
seul changement de code source ; si le rollback ne change que
`dist/index.js` sans toucher `.env`, forcer un reload explicite) :

```bash
multipass exec logichain-staging -- sudo -u logichain -H bash -lc \
  'cd /opt/logichain && pm2 reload logichain-api --update-env && pm2 save'
```

**Durée mesurée : 14,3 s** (`ansible-playbook playbooks/deploy.yml
-e app_version=v1.0.0`, `changed=4`), rollback réel exécuté le 2026-09-08
lors de la répétition finale (tâche 17) sur la cible de référence : la
cible avait d'abord été déployée sur `develop` pour forcer un vrai
changement de code, puis ramenée sur le tag `v1.0.0`. Après le rollback,
`sudo -u logichain git -C /opt/logichain rev-parse HEAD` confirme le retour
exact au commit tagué, `/health` répond `200`, et `POST /api/v1/auth/login`
avec des identifiants inexistants répond `401` avec le corps d'erreur
métier. Les
étapes qu'il traverse (checkout Git, `npm ci`, build TypeScript,
`npm prune`, rechargement PM2) sont les mêmes que celles d'un déploiement
normal (section 4) sur un code déjà présent en cache local Git : comme
attendu, très inférieur à la reconstruction complète (1 min 38 s pour
*tous* les rôles).

---

## 6. Sauvegarde MongoDB

**Quand la vérifier** : à chaque prise de poste sur le projet, et
périodiquement pour s'assurer que les sauvegardes automatiques tournent
bien.

| | |
|---|---|
| Emplacement des archives | `/var/backups/mongodb/` sur la cible (répertoire `0700 root:root`) |
| Script | `/usr/local/bin/mongodb-backup.sh` (`0700 root:root`, contient le mot de passe administrateur MongoDB — jamais lisible hors root) |
| Planification | cron root, tous les jours à **03h00** |
| Rétention | **7 jours** (purge par `find -mtime +7 -delete`, exécutée à chaque passage du script) |
| Format | `mongodump --archive --gzip` — un fichier `logichain-<date>-<heure>.archive.gz` par exécution, **`0600 root:root`** (`umask 077` appliqué par le script dès la première ligne) |
| Fichier d'état | `/var/backups/mongodb/.last-status` — `OK <horodatage> <archive>` en cas de succès, `FAILED <horodatage>` sinon ; **c'est le contrôle d'exploitation à lire en premier** (section suivante), écrit à chaque exécution, succès ou échec |
| Fichier transitoire | `/root/.mongodump-auth.yaml` — contient le mot de passe administrateur le temps de l'exécution de `mongodump` (lu via `--config`, jamais via `--password` en argument) ; supprimé par le script avant sa sortie, succès ou échec (`trap cleanup EXIT`) — **ne doit jamais être trouvé présent en dehors d'une exécution en cours** |

### Contrôle d'exploitation : l'état de la dernière sauvegarde

Le moyen le plus rapide de vérifier qu'une sauvegarde nocturne s'est bien
passée, sans avoir à parcourir le journal cron ni à lister les archives :

```bash
multipass exec logichain-staging -- sudo cat /var/backups/mongodb/.last-status
# attendu : OK <horodatage-ISO8601> /var/backups/mongodb/<archive>.archive.gz
# en cas d'échec : FAILED <horodatage-ISO8601> — creuser alors le journal
# cron (commande suivante) pour la cause
```

Ce fichier est réécrit à **chaque** exécution du script (succès ou échec) :
un `OK` obsolète (horodatage antérieur à la nuit dernière) est en soi le
signe qu'une exécution a été manquée ou n'a pas pu écrire son état.

### Vérifier que la sauvegarde tourne réellement

```bash
# La tâche cron est bien programmée
multipass exec logichain-staging -- sudo crontab -l

# Permissions correctes (secret dans le script → doit être 0700 root:root ;
# archives → 0600 root:root)
multipass exec logichain-staging -- sudo stat -c '%a %U:%G %n' /usr/local/bin/mongodb-backup.sh /var/backups/mongodb

# Dernières archives produites
multipass exec logichain-staging -- sudo ls -lh /var/backups/mongodb

# Le fichier transitoire ne doit jamais être présent hors exécution
multipass exec logichain-staging -- sudo test -e /root/.mongodump-auth.yaml && echo "ANOMALIE : présent hors exécution" || echo "absent, comme attendu"

# Journal des exécutions cron (utile si une nuit s'est mal passée)
# — le fichier n'existe qu'après le premier passage du cron (03h00) ; sur
# une VM tout juste provisionnée et pas encore restée active jusqu'à 3h,
# cette commande échoue avec « No such file or directory », ce qui est
# attendu et non une anomalie. Utiliser la sauvegarde manuelle ci-dessous
# pour obtenir un journal immédiatement.
multipass exec logichain-staging -- sudo tail -n 50 /var/log/mongodb-backup.log
```

### Déclencher une sauvegarde manuelle (hors planification)

```bash
multipass exec logichain-staging -- sudo /usr/local/bin/mongodb-backup.sh
```

**Testé réellement** le 2026-09-08 :

```
$ multipass exec logichain-staging -- sudo crontab -l
#Ansible: sauvegarde mongodb logichain
0 3 * * * /usr/local/bin/mongodb-backup.sh >> /var/log/mongodb-backup.log 2>&1

$ multipass exec logichain-staging -- sudo stat -c '%a %U:%G %n' /usr/local/bin/mongodb-backup.sh /var/backups/mongodb
700 root:root /usr/local/bin/mongodb-backup.sh
700 root:root /var/backups/mongodb

$ multipass exec logichain-staging -- sudo /usr/local/bin/mongodb-backup.sh
2026-09-08T15:57:45+02:00 sauvegarde terminée : /var/backups/mongodb/logichain-2026-09-08-1557.archive.gz
```
Nouvelle archive confirmée présente dans le répertoire après exécution.

---

## 7. Restauration

**Quand l'appliquer** : perte ou corruption de données constatée en base,
et une archive de sauvegarde antérieure au problème est disponible.

**Procédure réellement testée — restauration ciblée, pas intégrale.** La
commande ci-dessous restaure **une collection précise** depuis une archive
qui contient le dump complet de la base `logichain`. C'est volontaire : une
restauration intégrale avec `--drop` écraserait aussi les données de
démonstration réelles (`items`, `events`, `users`) ; sans `--drop`, elle
échouerait sur chaque document déjà présent (clé dupliquée). Pour restaurer
l'intégralité de la base (perte totale), retirer `--nsInclude=...` et
garder `--drop` — non testé en conditions réelles pour la même raison que
ci-dessus (aurait détruit l'environnement de démonstration).

```bash
# 1. Identifier l'archive à restaurer
multipass exec logichain-staging -- sudo ls -lh /var/backups/mongodb

# 2. Restaurer une collection précise depuis cette archive (exemple : "items")
multipass exec logichain-staging -- sudo mongorestore \
  --username=logichain_admin --authenticationDatabase=admin \
  --nsInclude=logichain.items --drop --gzip \
  --archive=/var/backups/mongodb/<fichier-choisi>.archive.gz
# (mot de passe demandé de façon interactive — jamais en argument --password
#  en clair sur une ligne de commande partagée ; voir section 9 pour la
#  bonne pratique en playbook)

# 3. Vérifier que la collection restaurée contient les documents attendus
multipass exec logichain-staging -- mongosh --quiet \
  --eval 'db.getSiblingDB("admin").auth("logichain_admin", passwordPrompt()); db.getSiblingDB("logichain").items.countDocuments()'
```

**Ce qui a été réellement mesuré** (procédure témoin, rejouée de bout en
bout le 2026-09-08, sur la collection isolée `temoin` — sans aucun effet
sur les données de démonstration) :

1. Insertion d'un document témoin dans `logichain.temoin`.
2. Sauvegarde (`/usr/local/bin/mongodb-backup.sh`) — l'archive produite
   contient donc le témoin.
3. Suppression de la collection `temoin` (simulation de la perte de
   données).
4. Restauration ciblée :
   ```
   mongorestore --username=logichain_admin --authenticationDatabase=admin \
     --nsInclude=logichain.temoin --drop --gzip \
     --archive=/var/backups/mongodb/logichain-2026-09-08-1558.archive.gz
   ```
   → `finished restoring logichain.temoin (1 document, 0 failures)`
5. Vérification : le document retrouvé (même `_id`, même valeur) après
   restauration.
6. Nettoyage : le témoin restauré a été supprimé pour ne pas laisser de
   trace, et l'API a été revérifiée saine juste après
   (`GET /health` → 200, `POST /api/v1/auth/login` avec des identifiants
   inexistants → 401).

**Durée mesurée : 0,21 s** (tâche de restauration seule, chronométrée par
le callback `ansible.posix.profile_tasks`) — cohérent avec la mesure de
0,24 s obtenue lors du premier test de cette procédure (Tâche 14, même
méthode).

> **Ce chiffre ne représente PAS une durée de restauration complète de la
> base.** Il porte sur : (a) une restauration **ciblée** sur une seule
> collection (`--nsInclude`), pas la base entière, (b) un **très faible
> volume de données** (base de démonstration, quelques documents par
> collection). `mongorestore` est dominé par le volume de données à
> réinjecter : sur un jeu de données de production réel, la durée sera
> largement supérieure. **À réévaluer si le volume de données croît
> significativement.**

---

## 8. Incidents courants

Pour chacun : symptôme, commande de diagnostic (**testée réellement** le
2026-09-08 sauf mention contraire), remède.

### API muette (ne répond plus)

**Symptôme** : `curl` sur `/health` timeout ou refuse la connexion ; la
plateforme est inutilisable.

```bash
# Diagnostic — état du process PM2
multipass exec logichain-staging -- sudo -u logichain -H bash -lc 'cd /opt/logichain && pm2 status'

# Diagnostic complémentaire — dernières lignes de log applicatif
multipass exec logichain-staging -- sudo -u logichain -H bash -lc 'cd /opt/logichain && pm2 logs --nostream --lines 50'
```

**Remède** :

```bash
multipass exec logichain-staging -- sudo -u logichain -H bash -lc 'cd /opt/logichain && pm2 restart logichain-api'
```

Si le process n'existe plus du tout dans PM2 (crash au démarrage,
supprimé), rejouer le déploiement applicatif complet (section 4) plutôt
qu'un simple restart.

### 502 Bad Gateway (Nginx)

**Symptôme** : Nginx répond, mais renvoie 502 — le proxy ne joint pas
l'API en amont.

```bash
# Diagnostic — configuration Nginx valide ?
multipass exec logichain-staging -- sudo nginx -t

# Diagnostic — Nginx est-il actif ?
multipass exec logichain-staging -- sudo systemctl is-active nginx

# Diagnostic — l'API écoute-t-elle bien en local sur le port attendu ?
multipass exec logichain-staging -- sudo ss -tlnp
```

**Remède** : un 502 avec `nginx -t` correct et Nginx actif signifie presque
toujours que l'API en amont ne répond pas — traiter comme l'incident « API
muette » ci-dessus. Si `nginx -t` échoue (vhost invalide déployé
manuellement, hors Ansible), rejouer le rôle `web_proxy` seul :

```bash
ansible-playbook site.yml -i inventories/staging --tags web_proxy
```

> Note : `site.yml` n'utilise pas de tags par rôle aujourd'hui (aucun
> `tags:` déclaré dans les rôles) — cette commande listera « nothing to do »
> tant qu'aucun tag n'est ajouté aux tâches de `web_proxy`. À défaut,
> rejouer `site.yml` complet (idempotent, ne modifie que ce qui a dérivé).

### `mongod` ne démarre pas

**Symptôme** : l'API répond des erreurs de connexion base de données ; les
tests de fumée « identifiants inexistants → 401 » échouent avec une erreur
différente (500, timeout) au lieu de 401.

```bash
# Diagnostic — état du service
multipass exec logichain-staging -- sudo systemctl is-active mongod

# Diagnostic — journal détaillé
multipass exec logichain-staging -- sudo journalctl -u mongod -n 50 --no-pager

# Diagnostic — journal applicatif de mongod lui-même
multipass exec logichain-staging -- sudo tail -n 50 /var/log/mongodb/mongod.log
```

**Remède** : les causes les plus fréquentes sont un `/etc/mongod.conf`
invalide (édité à la main, hors Ansible) ou un disque plein (voir incident
suivant — MongoDB refuse d'écrire au-delà d'un certain seuil). Restaurer la
configuration gérée par Ansible et redémarrer :

```bash
ansible-playbook site.yml -i inventories/staging   # régénère /etc/mongod.conf si dérivé
multipass exec logichain-staging -- sudo systemctl restart mongod
```

### Certificat TLS expiré

**Symptôme** : les navigateurs et `curl` (sans `-k`) rejettent la connexion
HTTPS avec une erreur de certificat expiré.

```bash
# Diagnostic — date d'expiration du certificat déployé
multipass exec logichain-staging -- sudo openssl x509 -enddate -noout -in /etc/nginx/tls/logichain.crt
```

**Testé réellement** — sortie obtenue le 2026-09-08 (certificat en cours de
validité, généré pour 365 jours) :
```
notAfter=Sep  8 11:19:56 2027 GMT
```

**Remède** (certificat auto-signé, `web_proxy_tls_mode: selfsigned`) : le
module `community.crypto.openssl_privatekey` / `x509_certificate` ne
régénère un certificat que si le fichier est absent — il faut le supprimer
explicitement avant de rejouer le rôle :

```bash
multipass exec logichain-staging -- sudo rm -f /etc/nginx/tls/logichain.crt /etc/nginx/tls/logichain.key
ansible-playbook site.yml -i inventories/staging
```

> **Non testé en conditions réelles** : supprimer le certificat en
> production réamorcerait une brève coupure TLS (le temps du prochain
> `ansible-playbook site.yml`) — non rejoué contre la cible de référence
> pour ne pas interrompre l'environnement de démonstration sans besoin
> réel. Le mécanisme (régénération conditionnée par l'absence du fichier)
> est vérifié par lecture de `roles/web_proxy/tasks/main.yml`.

### Disque plein

**Symptôme** : MongoDB ou l'API refusent d'écrire, `mongod` peut s'arrêter
de lui-même, les sauvegardes échouent silencieusement.

```bash
# Diagnostic — occupation disque
multipass exec logichain-staging -- df -h /
```

**Testé réellement** le 2026-09-08 :
```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       8.7G  3.9G  4.8G  45% /
```

**Remède** : la rétention des sauvegardes (7 jours, section 6) purge déjà
automatiquement les vieilles archives — vérifier d'abord qu'un incident
antérieur (script bloqué, purge en échec) n'a pas fait déborder
`/var/backups/mongodb` :

```bash
multipass exec logichain-staging -- sudo du -sh /var/backups/mongodb /var/log/mongodb
```

Si le disque est plein hors sauvegardes (volume de données MongoDB
lui-même, ou journaux système), agrandir le disque de la VM :

```bash
multipass stop logichain-staging
multipass set local.logichain-staging.disk=20G
multipass start logichain-staging
```

### IP de la VM changée après redémarrage

**Symptôme** : `ansible-playbook` (toute commande de ce Runbook) échoue
avec un timeout de connexion SSH, alors que la VM est bien démarrée.

**Cause** : l'adresse IP attribuée par Multipass à `logichain-staging`
**peut changer après un redémarrage de la VM ou de la machine hôte**
(attribution DHCP). `inventories/staging/hosts.yml` référence une IP figée
— elle devient obsolète.

```bash
# Diagnostic — IP réellement attribuée aujourd'hui
multipass info logichain-staging | grep IPv4
```

**Testé réellement** le 2026-09-08 : `192.168.252.5` (IP actuellement
active et déjà à jour dans l'inventaire au moment de la rédaction).

**Remède** :

```bash
NOUVELLE_IP=$(multipass info logichain-staging | awk '/IPv4/{print $2}')
sed -i '' "s/ansible_host: \".*\"/ansible_host: \"${NOUVELLE_IP}\"/" inventories/staging/hosts.yml
# (sed -i '' est la syntaxe macOS/BSD ; sur Linux : sed -i "s/.../" ...)
git diff inventories/staging/hosts.yml   # vérifier le changement avant de committer
```

Committer ce changement sur une branche `fix/ip-staging` (voir
`CONTRIBUTING.md`) si l'IP doit rester à jour pour l'équipe suivante.

---

## 9. Rotation des secrets

**Quand l'appliquer** : compromission suspectée d'un secret, rotation
périodique de sécurité, ou changement d'équipe (voir aussi section 10).

### Mot de passe du vault Ansible lui-même

Le vault protège `inventories/<env>/group_vars/all/vault.yml`. Le rotation
du **mot de passe du vault** (pas des secrets qu'il contient) se fait avec :

```bash
ansible-vault rekey inventories/staging/group_vars/all/vault.yml
ansible-vault rekey inventories/ci/group_vars/all/vault.yml
```

Puis mettre à jour `.vault-pass` en local (transmission hors dépôt — voir
section 10) **et** le secret GitHub Actions `ANSIBLE_VAULT_PASSWORD`
(`gh secret set ANSIBLE_VAULT_PASSWORD --repo Fulkiaaa/logichain-infra`) —
sinon `ci.yml`/`cd.yml` échouent au prochain run.

**Testé réellement** — la lecture du vault avec `.vault-pass` fonctionne
(commande rejouée le 2026-09-08, sortie non affichée par construction) :

```bash
ansible-vault view inventories/staging/group_vars/all/vault.yml > /dev/null && echo "vault déchiffré avec succès"
```
→ `vault déchiffré avec succès`. `ansible-vault rekey` lui-même **n'a pas
été exécuté** : rejouer cette commande sur le vault réel du projet
changerait effectivement le mot de passe de déchiffrement en vigueur, sans
disposer d'un canal pour redistribuer le nouveau mot de passe dans le cadre
de ce Runbook — aurait cassé l'accès au vault pour la suite du projet sans
bénéfice réel de test.

### `JWT_SECRET`

Consommé sans condition par `roles/app_runtime/templates/env.j2`
(`JWT_SECRET={{ vault_jwt_secret }}`) : éditer le vault suffit, un
redéploiement applicatif propage le changement.

```bash
ansible-vault edit inventories/staging/group_vars/all/vault.yml
# modifier la ligne vault_jwt_secret: "..."
ansible-playbook playbooks/deploy.yml -i inventories/staging
```

**Effet de bord à anticiper** : changer `JWT_SECRET` invalide
**immédiatement tous les tokens JWT déjà émis** — tous les utilisateurs
connectés sont déconnectés de force. À planifier en dehors d'une
démonstration ou d'une période d'usage actif.

**Non testé en conditions réelles** (aurait invalidé les sessions actives
de l'environnement de démonstration sans les moyens de vérifier ensuite
côté client) — mécanisme vérifié par lecture du template (pas de `when`
conditionnant cette ligne : toujours régénérée) et par le fait que le
rechargement PM2 déclenché par le changement de `.env`
(`notify: Recharger l'application` → `pm2 reload --update-env`) est
**exercé à chaque déploiement testé dans ce Runbook** (sections 3 et 4).

### Mots de passe MongoDB (`vault_mongodb_admin_password`, `vault_mongodb_app_password`)

> **Piège vérifié en lisant `roles/database/tasks/main.yml` : éditer le
> vault seul NE SUFFIT PAS.** Les tâches « Créer l'administrateur MongoDB »
> et « Créer l'utilisateur applicatif » ne s'exécutent que
> `when: not mongodb_bootstrap_marker.stat.exists` — c'est-à-dire **une
> seule fois**, au tout premier amorçage de la base. Une fois la base
> amorcée (cas de `logichain-staging` aujourd'hui), rejouer `site.yml`
> après avoir changé le mot de passe dans le vault régénère bien le `.env`
> de l'API avec le **nouveau** mot de passe, sans que MongoDB ne connaisse
> ce nouveau mot de passe pour l'utilisateur concerné — l'API ne peut alors
> plus se connecter à la base.

**Procédure correcte, dans cet ordre :**

```bash
# 1. Se connecter à mongod en tant qu'admin et changer le mot de passe EN BASE d'abord
multipass exec logichain-staging -- mongosh --quiet --eval '
  db.getSiblingDB("admin").auth("logichain_admin", passwordPrompt());
  db.getSiblingDB("logichain").updateUser("logichain_app", {pwd: passwordPrompt()});
'

# 2. Seulement ensuite, mettre à jour le vault avec la même nouvelle valeur
ansible-vault edit inventories/staging/group_vars/all/vault.yml

# 3. Redéployer pour que le .env de l'API corresponde au mot de passe désormais actif en base
ansible-playbook playbooks/deploy.yml -i inventories/staging
```

Inverser l'ordre (vault puis base) provoque une fenêtre d'indisponibilité
de l'API entre le redéploiement et la mise à jour effective du mot de
passe MongoDB.

**Non testé en conditions réelles** — rotation d'un mot de passe MongoDB
sur l'environnement de démonstration : risque réel d'y laisser l'API
inaccessible si l'un des deux mots de passe (base, vault) diverge pendant
la manipulation, pour un bénéfice de test nul (le piège identifié ci-dessus
vient d'une lecture de code, pas d'un essai raté). Le mécanisme
`when: not mongodb_bootstrap_marker...` est, lui, directement vérifiable
dans `roles/database/tasks/main.yml` (cité ci-dessus).

---

## 10. Passation

**Quand l'appliquer** : dès qu'un second contributeur rejoint le projet
(voir aussi `CONTRIBUTING.md` § 8, qui documente pourquoi ces réglages sont
à `0`/manuel aujourd'hui).

### 1. Activer la revue obligatoire à 1 approbation

Aujourd'hui, `required_approving_review_count` vaut délibérément `0` sur
les rulesets `protection-main` et `protection-develop` des trois dépôts :
projet mené en solo, et GitHub interdit d'approuver sa propre Pull
Request — mettre `1` avant l'arrivée d'un second contributeur aurait
bloqué toute fusion. Commande exacte (nécessite `gh` authentifié avec le
scope `repo`, propriétaire du dépôt) :

```bash
REPO="Fulkiaaa/logichain-infra"

for RULESET in protection-main protection-develop; do
  ID=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$RULESET\") | .id")
  gh api "repos/$REPO/rulesets/$ID" \
    | jq '(.rules[] | select(.type=="pull_request") | .parameters.required_approving_review_count) = 1
          | {name, target, enforcement, conditions, rules, bypass_actors}' \
    > /tmp/ruleset-$RULESET.json
  gh api -X PUT "repos/$REPO/rulesets/$ID" --input "/tmp/ruleset-$RULESET.json"
done
```

Vérifier ensuite :

```bash
gh api repos/Fulkiaaa/logichain-infra/rulesets/$ID --jq '.rules[] | select(.type=="pull_request")'
```

Répéter (avec `REPO` ajusté) sur `logichain-api` et `LogiChainMobile`.

**Non exécutée** dans le cadre de ce Runbook : l'exécuter réellement
aujourd'hui aurait immédiatement bloqué la fusion de la Pull Request de
cette tâche elle-même (aucun second contributeur pour approuver, projet
toujours en solo au moment de la rédaction). Commande vérifiée par lecture
(reprend exactement celle déjà documentée et utilisée en Tâche 13,
`CONTRIBUTING.md` § 8) — c'est la première action à exécuter dès qu'un
second contributeur est disponible pour approuver derrière.

### 2. Transmettre `.vault-pass` hors dépôt

`.vault-pass` n'est **jamais** committé (`.gitignore`) et ne doit **jamais**
transiter par un canal non chiffré (messagerie en clair, ticket, PR). Le
transmettre via un gestionnaire de secrets partagé (coffre-fort d'équipe :
1Password, Bitwarden, Vault HashiCorp...) ou, à défaut, un canal chiffré de
bout en bout, hors de tout historique versionné. À réception :

```bash
echo '<mot-de-passe-du-vault-reçu>' > .vault-pass
chmod 600 .vault-pass
ansible-vault view inventories/staging/group_vars/all/vault.yml > /dev/null && echo OK
```

(Cette dernière commande de vérification a été testée réellement — voir
section 9.)

### 3. Activer le hook de commit de l'infra

Contrairement aux deux autres dépôts (`logichain-api`, `LogiChainMobile`),
qui installent **Husky** et l'activent automatiquement au `npm install`,
`logichain-infra` est un dépôt Ansible pur sans `package.json` : le hook de
validation des messages de commit (`.githooks/commit-msg`) est un **script
shell natif versionné**, dont l'activation est **manuelle**, une fois par
clone :

```bash
git config core.hooksPath .githooks
```

**Testé réellement** (dans un dépôt Git jetable, avec une copie du même
hook et la même activation, pour ne prendre aucun risque sur l'historique
réel du dépôt) :

```
$ git commit -m "message invalide sans type"
✖ Message de commit invalide : « message invalide sans type »
  Format attendu : <type>(<portée optionnelle>): <résumé>
  ...
[rejeté, exit 1]

$ git commit -m "docs: test du hook commit-msg"
[main (root-commit) 774f6fc] docs: test du hook commit-msg
[accepté, exit 0]
```

Le hook rejette bien un message non conforme et accepte un message
conforme aux Conventional Commits.

### Procédure d'urgence — protections de branche bloquantes

Si un blocage opérationnel réel empêche toute fusion (ex. panne prolongée
de GitHub Actions, check `Lint et secrets` qui ne peut techniquement plus
se déclencher) : **aucun acteur de contournement n'est configuré** sur les
rulesets (`bypass_actors: []`, y compris pour la propriétaire du dépôt —
choix délibéré, voir `CONTRIBUTING.md` § 9). La seule sortie est de
désactiver temporairement le ruleset concerné, depuis **Settings → Rules →
Rulesets** du dépôt GitHub (`Enforcement status` : `Active` → `Disabled`),
ou en ligne de commande :

```bash
REPO="Fulkiaaa/logichain-infra"
ID=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="protection-main") | .id')
gh api "repos/$REPO/rulesets/$ID" \
  | jq '.enforcement = "disabled" | {name, target, enforcement, conditions, rules, bypass_actors}' \
  > /tmp/ruleset-disable.json
gh api -X PUT "repos/$REPO/rulesets/$ID" --input /tmp/ruleset-disable.json
```

À n'utiliser qu'en cas de réel blocage opérationnel, jamais pour contourner
un check qui échoue légitimement — et à **réactiver** (`enforcement:
"active"`) dès la situation résolue : tant que le ruleset est désactivé,
`main` accepte de nouveau les push directs, qui déclenchent `cd.yml` (donc
un déploiement réel) sans passer par une revue.

---

## Annexe — dette technique non traitée

Signalée explicitement plutôt que passée sous silence, conformément à la
règle d'or de ce document.

- **`npm audit` signale des vulnérabilités préexistantes** sur `logichain-api`
  et `LogiChainMobile`, non corrigées à ce jour. Non traité dans le
  périmètre de ce dépôt (`logichain-infra`) : à suivre dans les deux dépôts
  applicatifs concernés.
- **`/docs` non protégée** — voir section 1.
- **PM2 n'a aucun module Ansible officiel.** Le rôle `app_runtime`
  (`roles/app_runtime/tasks/main.yml`) contient donc les seules commandes
  du projet exécutées sans module dédié, chacune gardée selon sa nature
  plutôt que laissée « nue » :
  - `pm2 startup systemd` → gardée par `creates:` (n'agit que si l'unité
    systemd n'existe pas encore) ;
  - build (`npm run build`, `npm ci`, `npm prune`) → gardées par `when:`
    (rejouées seulement si le checkout Git a changé) et `changed_when:`
    explicite (jamais de faux `changed=0` silencieux) ;
  - `pm2 reload` / `pm2 save` → déclenchées uniquement via le `notify`
    d'un handler (jamais rejouées sans qu'un changement réel — `.env` ou
    configuration PM2 — l'exige) ;
  - `pm2 jlist` (lecture seule, utilisée pour décider si l'app est déjà
    gérée) → `changed_when: false` explicite.
