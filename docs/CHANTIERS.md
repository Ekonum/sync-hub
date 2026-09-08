# Chantiers — demandés le 2026-09-03

**Faits :** 1 à 14 (le 11 et le 14 attendent une action manuelle de Robin)

## Vérifications
1. **Catégories de projet** — ne remontent pas du local vers le distant ? À vérifier.
2. **Coûts dans le MCP** — l'info remonte-t-elle ? Objectif : dépense par projet / par tâche.
3. **Renommer un fil via le MCP** — possible aujourd'hui au-delà des projets et catégories ?

## Corrections
4. **Initiales du compte** — « RJ » déborde du rond.
5. **Chargement à l'ouverture** — plusieurs secondes en annonçant « aucun appareil connecté »,
   alors que tout arrive dès que l'arbre s'affiche. Message faux pendant le chargement.
6. **Échappement dans les fils** — `&#x20;`, antislashes parasites, entités HTML.
7. **Replier un prompt** — cliquer sur son en-tête quand il est ouvert doit le refermer.
8. **Cartes « réflexions »** — trop mises en avant ; doivent être plus discrètes que l'échange réel.
9. **Nom des fils** — si le premier message connu est technique, il est utilisé tel quel.
10. **Trop d'actions sur les projets** — à repenser.

## Fonctionnalités
11. **Connexion Google** — code côté sync-hub ; création du client OAuth = étape manuelle de Robin.
12. **Commande d'insertion du jeton Claude** — à fournir toute faite.
13. **Durée de frappe et durée de réflexion** — estimées à N frappes/minute (base basse,
    paramétrable sur le compte), tracées par date voire heure, au niveau fil / projet /
    catégorie / compte, et sur le tableau de bord.
    Finalité : facturation du temps au client, puis automatisation.
14. **Tutoriel dans le module Connaissances** — complet : retrouver les prompts d'un sujet,
    classer par projet, organiser en catégories.

---

## État au 2026-09-03

### Traités
- **1. Catégories** — `upsertProject` n'écrivait ni `category` ni `sort_order` : 44 projets sans
  catégorie sur le hub contre 21/14/3 en local. Corrigé, avec COALESCE pour qu'un rescan
  n'efface pas un classement manuel.
- **2. Coûts dans le MCP** — vérifié : **non exposés**. Aucun outil MCP ne renvoie de coût.
- **3. Renommer un fil via le MCP** — n'existait pas (`assign`/`archive`/`delete`/`unlink`
  seulement). Ajouté : `manage_thread` action `rename`, index de recherche mis à jour.
- **4. Initiales** — 2 initiales de 14px dans un rond de 20px. Rond passé à 32px.
- **5. « Aucun appareil connecté »** — la checklist lisait « pas encore répondu » comme
  « pas enrôlé ». Elle ne s'affiche plus avant la réponse.
- **6. Échappement** — entités et échappements markdown résolus à l'affichage, jamais dans le
  code ni dans le texte stocké. 7 tests sur des cas réels.
- **7. Repli d'un prompt** — bande « Replier » en haut ; pas toute la carte, sinon la sélection
  de texte casse.
- **8. Réflexions** — filet discret à gauche au lieu d'une carte accentuée.
- **12. Commande jeton** — forme sans écriture dans l'historique du shell.

### Restant
- **9. Nom des fils** — le renommage manuel existe maintenant ; reste à améliorer la dérivation
  automatique (ignorer un premier message technique).
- **10. Trop d'actions sur les projets.**
- **11. Connexion Google** — `gcloud` authentifié, 3 projets visibles. La création du client
  OAuth reste console-only.
- **13. Durée de frappe et de réflexion** — chantier à part entière (modèle de données,
  agrégation, réglage du rythme de frappe sur le compte, restitution).
- **14. Tutoriel Connaissances.**

---

## Clôture au 2026-09-03

- **9** dérivation revue et mesurée (11/32 titres réellement corrigés), renommage manuel protégé
  d'un réingestion par `title_custom`.
- **10** menu unique `⋯` groupé, destructif isolé.
- **11** code complet et testé ; **il reste à créer le client OAuth en console** (voir
  `docs/CONNEXION-GOOGLE.md`) — `gcloud` ne sait pas le faire.
- **13** calcul, agrégation, vue Temps et réglage du rythme. Ancré sur le temps écoulé :
  13 198 h → 2 012 h.
- **14** rubrique Connaissances rédigée (7 articles, 15 questions fréquentes, 6 captures) ;
  **il reste à déposer la clé API Odoo** puis à lancer `APPLY=1 python3
  docs/tuto-connaissances/publier.py`.

---

# Chantiers — demandés le 2026-09-08

## Facturation : fusionner le temps et les jetons

Une seule page de statistiques, **volontairement simple** : Robin insiste sur ce point, il ne veut
pas d'un tableau de bord touffu. Deux réglages, dans les paramètres :

- un **taux horaire** appliqué au temps de travail (par exemple 105 €/h) ;
- un **taux de marge** appliqué au coût des jetons, éventuellement **négatif** — il peut choisir de
  ne pas répercuter tout le coût, voire d'en absorber une partie.

Ce que ça donne : le **coût effectif d'une tâche**, temps et jetons ensemble, et donc de quoi la
refacturer sans la recalculer à la main.

Points à trancher avant d'écrire quoi que ce soit :

- la borne haute des archives (`isInferredModel`) ne doit jamais se retrouver mêlée à un montant
  refacturé — c'est une hypothèse, pas une dépense, et la règle du projet est qu'elle ne se
  confond avec rien ;
- le temps est une **estimation plafonnée** et l'attente de l'IA une **mesure** ; un montant
  facturable doit dire lequel des deux il additionne ;
- un taux horaire est une donnée de compte, pas une donnée de projet — sauf si un client a le sien,
  question à poser.

## Feuilles de temps automatiques

Plus loin : un outil qui lit tout ça par le MCP, plus les autres sources (les autres outils, et
l'historique du téléphone), et **remplit les feuilles de temps tout seul**. Le MCP expose déjà
`get_time_spent` (jour par jour, heure par heure) et les coûts ; ce qui manque est le rapprochement
avec les tâches Odoo et une source d'activité hors clavier.

## Le temps d'une journée peut dépasser 24 h

Constaté le 2026-09-08 : trois jours du corpus dépassent 24 h, dont le 31 août à **35,5 h**, et
onze jours dépassent 16 h.

Ce n'est pas une erreur de calcul, c'est le modèle. Les durées sont additionnées fil par fil ;
quand deux conversations tournent en parallèle — Claude Code et Codex ensemble, ou plusieurs
sessions du même outil — leurs attentes se chevauchent dans le temps réel et sont comptées deux
fois. La rédaction, plafonnée par l'écart écoulé, subit le même chevauchement.

Tant que ça reste un indicateur d'usage, c'est acceptable et ça se dit. Dès qu'on refacture au
taux horaire, ça ne l'est plus : personne ne facture 35,5 h pour un mardi.

Ce qu'il faudra : fusionner les intervalles au lieu d'additionner les durées. Chaque tour devient
un segment [début, fin] en temps réel, on prend l'union par jour, et on répartit ensuite entre
projets — la répartition étant elle-même une décision à prendre, puisqu'un instant couvert par deux
projets doit aller quelque part. À trancher avec Robin avant d'écrire quoi que ce soit, et à faire
**avant** le taux horaire décrit plus haut, sans quoi la première facture générée sera fausse.

## Se greffer sur les trois applications

Idée : afficher **discrètement**, dans les outils eux-mêmes, ce que sync-hub sait déjà — les
conversations liées à celle en cours, un bouton pour synchroniser ce fil tout de suite, la
différence de contexte avec un fil frère. Vraiment dans l'interface, pas sous forme de réponse
d'outil.

### La voie supportée existe, et elle passe par MCP

**MCP Apps** est une extension officielle du protocole (annoncée le 26 janvier 2026, donnée pour
prête en production). Un serveur MCP déclare, sur un outil, un `_meta.ui.resourceUri` pointant vers
une ressource `ui://` qui contient du HTML/JS ; l'hôte la charge dans une **iframe isolée** et rend
le composant dans la conversation, avec un dialogue bidirectionnel en JSON-RPC par `postMessage`.
C'est l'architecture de l'Apps SDK d'OpenAI, standardisée ensuite pour tous les hôtes.

Ce que ça change pour nous : sync-hub **expose déjà un serveur MCP**. Afficher une carte « 3 fils
liés · dernier écho il y a 12 min » avec un bouton, ce n'est pas écrire une extension par
application, c'est ajouter une ressource à ce qu'on a. Et l'isolation en iframe est exactement le
cadrage demandé : on ne peut pas casser l'interface hôte, au pire le composant ne s'affiche pas.

Hôtes annoncés comme le supportant : **Claude (web et bureau)**, **ChatGPT**, **VS Code**
(Insiders), **Goose**. Microsoft, JetBrains, AWS et Google DeepMind se sont dits intéressés sans
confirmer d'implémentation.

### Ce que ça donne pour les trois outils de Robin

- **ChatGPT — oui, directement.** C'est l'hôte de référence de cette architecture.
- **Claude Code — non, et c'est structurel.** Vérifié sur le binaire installé : aucune trace de
  `ui://` ni de `resourceUri`. C'est un programme de terminal, il n'a pas d'iframe. Sa seule
  surface d'affichage continue est la **ligne d'état** (`statusLine` dans les réglages, présent
  30 fois dans le binaire) : du texte, rafraîchi, suffisant pour « 3 fils liés · dernier écho il y
  a 12 min », pas pour un bouton. À noter : *Claude* (web et bureau) supporte MCP Apps, mais c'est
  une autre application que *Claude Code*.
- **Antigravity 2 — non aujourd'hui.** La documentation des plugins est explicite : un plugin
  contient des skills, des règles, un `mcp_config.json` et des hooks — **aucune contribution
  d'interface**. Le shell Electron fait 4,3 Mo et ne contient ni `ui://`, ni le vocabulaire de
  contribution de VS Code (`contributes`, `viewsContainers`, `webview`) ; il charge une interface
  web distante, donc cette dernière vérification n'est pas concluante à elle seule. Google DeepMind
  figure parmi les intéressés par MCP Apps : c'est la piste à resurveiller.

Piège à ne pas répéter : `/Applications/Antigravity.app` **est** un bundle Electron et
`~/.antigravity/extensions/` **contient** des extensions VS Code standard — mais ce dossier n'a pas
bougé depuis le 14 mai 2026. C'est l'ancien IDE. Le toolkit communautaire `antigravity-panel`, qui
ajoute un panneau latéral, est une extension VS Code pour cet IDE-là, pas pour Antigravity 2.

### Si on le fait

1. **Un seul composant, sur un seul outil MCP**, pour commencer : les fils liés, en lecture seule.
2. **ChatGPT en premier**, puisque c'est là que la voie est ouverte et éprouvée.
3. **Claude Code séparément**, par la ligne d'état, qui est un travail sans rapport — quelques
   dizaines de caractères, pas un composant.
4. **Échec silencieux partout** : hub injoignable, réponse lente, format inattendu, le composant ne
   montre rien plutôt qu'une erreur dans l'outil de quelqu'un qui travaille.
