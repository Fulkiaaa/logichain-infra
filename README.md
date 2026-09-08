# logichain-infra

> Provisionnement et déploiement de l'infrastructure de la plateforme
> logistique événementielle **LogiChain** (Ansible + GitHub Actions).
> Projet noté — Module MP3 (Ops/Infra).

Ce dépôt provisionne et déploie l'API `logichain-api` sur une VM Ubuntu
24.04 : durcissement système, MongoDB en replica set, Node.js, proxy Nginx
(TLS), exécution de l'application sous PM2. La CI (`ci.yml`) linte et
vérifie la syntaxe du playbook à chaque Pull Request ; la CD (`cd.yml`)
provisionne un runner GitHub neuf à chaque push sur `main`, rejoue le
playbook deux fois (idempotence) et exécute des tests de fumée contre
l'API réellement déployée.

---

## 1. Prérequis

- Python 3.12
- Ansible (`pip install ansible`) + les collections listées dans
  `requirements.yml` (`community.general`, `community.mongodb`,
  `community.crypto`, `ansible.posix`)
- `ansible-lint` et `yamllint`, pour reproduire localement le check CI
  (`pip install ansible-lint yamllint`)
- Le mot de passe du vault Ansible du projet (`.vault-pass`, **jamais
  committé** — voir `.gitignore`), fourni hors dépôt
- Pour rejouer le provisionnement en local : [Multipass](https://multipass.run/)
  (VM Ubuntu 24.04) ou toute cible SSH équivalente
- `git`, et [`gh`](https://cli.github.com/) authentifié pour les commandes
  de passation (`CONTRIBUTING.md`, § 8)

## 2. Installation locale

```bash
git clone https://github.com/Fulkiaaa/logichain-infra.git
cd logichain-infra

ansible-galaxy collection install -r requirements.yml

# Mot de passe du vault, fourni hors dépôt (jamais dans git)
echo '<mot-de-passe-du-vault>' > .vault-pass
chmod 600 .vault-pass

# Vérification de syntaxe, sans toucher à une cible réelle
ansible-playbook site.yml -i inventories/staging --syntax-check
```

Provisionnement complet d'une cible (`inventories/staging/hosts.yml`,
IP à vérifier — voir commentaire du fichier, l'IP Multipass peut changer) :

```bash
ansible-playbook site.yml -i inventories/staging
```

Déploiement applicatif seul (plus rapide, ne rejoue que `app_runtime`) :

```bash
ansible-playbook playbooks/deploy.yml -i inventories/staging
```

## 3. Variables ("secrets" du vault et variables du provisionnement)

Ce dépôt n'expose pas de variables d'environnement d'application (ce n'est
pas un service Node.js) : la configuration se fait par variables Ansible,
définies par environnement dans `inventories/<env>/group_vars/all/`
(`vars.yml` en clair, `vault.yml` chiffré par `ansible-vault`).

### Secrets chiffrés (`vault.yml`, un par inventaire)

| Variable                          | Utilisée par                          | Description                                                        |
|-------------------------------------|------------------------------------------|-------------------------------------------------------------------------|
| `vault_jwt_secret`                   | `app_runtime` (fichier `.env` de l'API)  | `JWT_SECRET` injecté dans l'API déployée                                |
| `vault_mongodb_admin_password`       | `database`                                | Mot de passe de l'utilisateur admin MongoDB créé au provisionnement     |
| `vault_mongodb_app_password`         | `database`, `app_runtime`                 | Mot de passe applicatif MongoDB, injecté dans `MONGO_URI`               |

### Secret GitHub Actions (dépôt)

| Secret                       | Utilisé par         | Description                                                          |
|--------------------------------|------------------------|---------------------------------------------------------------------------|
| `ANSIBLE_VAULT_PASSWORD`        | `ci.yml`, `cd.yml`      | Mot de passe du vault ci-dessus, pour que les workflows puissent le lire |

### Variables de provisionnement notables (`vars.yml`, non secrètes)

| Variable                          | Défaut (staging)              | Description                                                    |
|-------------------------------------|----------------------------------|---------------------------------------------------------------------|
| `app_repo`                          | dépôt `logichain-api`             | Dépôt cloné par `app_runtime`                                        |
| `app_version`                       | `main`                            | Réf. git déployée                                                    |
| `mongodb_version`                   | `8.0`                             | Version MongoDB installée                                            |
| `web_proxy_server_name`             | `logichain.local` (staging)       | `server_name` Nginx / SAN du certificat                              |
| `system_security_ufw_enabled`       | `true` (staging) / `false` (CI)   | Pare-feu UFW — désactivé en CI (runner jetable, voir commentaire)    |

> Aucune valeur secrète n'est committée en clair — ce dépôt est **public**.
> Seuls les fichiers `vault.yml` (chiffrés) contiennent des identifiants,
> et `.vault-pass` est explicitement ignoré par git.

## 4. Commandes utiles

| Commande                                                              | Effet                                                        |
|--------------------------------------------------------------------------|------------------------------------------------------------------|
| `ansible-playbook site.yml -i inventories/staging`                        | Provisionnement complet (tous les rôles)                         |
| `ansible-playbook playbooks/deploy.yml -i inventories/staging`            | Déploiement applicatif seul (`app_runtime`)                      |
| `ansible-playbook site.yml -i inventories/staging --syntax-check`         | Vérification de syntaxe sans toucher à la cible                  |
| `yamllint .`                                                              | Lint YAML (reproduit le check CI)                                 |
| `ansible-lint`                                                            | Lint Ansible (reproduit le check CI)                               |
| `ansible-vault view inventories/staging/group_vars/all/vault.yml`         | Consulter le vault (nécessite `.vault-pass`)                       |
| `ansible-vault edit inventories/staging/group_vars/all/vault.yml`         | Éditer le vault                                                    |

## 5. Contribution & passation

Ce dépôt suit un modèle Gitflow (`main` ← `develop` ← `feature/*`), avec des
règles de protection GitHub actives sur `main` et `develop` (check CI
obligatoire `Lint et secrets`, historique linéaire sur `main`, pas
d'acteur de contournement).

Voir [`CONTRIBUTING.md`](./CONTRIBUTING.md) pour : le détail du modèle de
branches, la convention de commit (Conventional Commits) et son hook natif
(`.githooks/commit-msg` — ce dépôt n'a pas de `package.json`, donc pas de
Husky, voir § 3 bis), le cycle de vie d'une Pull Request, la checklist de
revue, et la **procédure de passation** à une future équipe (notamment le
passage de la revue obligatoire de 0 à 1 approbation).

Pour l'exploitation de l'infrastructure en production (sauvegardes,
rotation des secrets, procédures d'incident, astreinte), voir le
[`RUNBOOK.md`](./RUNBOOK.md) de ce dépôt — **à venir**, rédigé dans une
tâche ultérieure du plan d'industrialisation.

Les preuves de fonctionnement des règles de protection (Tâche 13) sont
conservées dans [`soutenance/preuves/`](./soutenance/preuves/).
